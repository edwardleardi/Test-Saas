import prisma from "@/app/lib/db";
import { stripe } from "@/app/lib/stripe";
import { headers } from "next/headers";
import Stripe from "stripe";

// TODO: create more events, like listening for abandoned checkouts

export async function POST(req: Request) {
  const body = await req.text();
  const headersList = await headers();
  const signature = headersList.get("Stripe-Signature") as string;

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET as string
    );
    console.log("Stripe webhook event constructed:", event.type);
  } catch {
    return new Response("Webhook error", { status: 400 });
  }

  const session = event.data.object as Stripe.Checkout.Session;

  // Handles subscriptions, happens only once per subscription
  // Create new subscription in our db
  if (event.type === "checkout.session.completed") {
    try {
      const subscription = await stripe.subscriptions.retrieve(
        session.subscription as string
      );
      const customerId = String(session.customer);

      const user = await prisma.user.findUnique({
        where: {
          stripeCustomerId: customerId,
        },
      });

      if (!user) throw new Error("User not found...");

      await prisma.subscription.create({
        data: {
          stripeSubscriptionId: subscription.id,
          userId: user.id,
          currentPeriodStart: subscription.current_period_start,
          currentPeriodEnd: subscription.current_period_end,
          status: subscription.status,
          planId: subscription.items.data[0].plan.id,
          interval: String(subscription.items.data[0].plan.interval),
        },
      });
    } catch (error) {
      throw error;
    }
  }

  // Handles payments (which can be recurring)
  if (event.type === "invoice.payment_succeeded") {
    try {
      const subscription = await stripe.subscriptions.retrieve(
        session.subscription as string
      );
      console.log("subscription.items.data[0].price.id", subscription.items.data[0].price.id);

      // Add retry logic with delay
      let retries = 3;
      let existingSub = null;
      while (retries > 0) {
        existingSub = await prisma.subscription.findUnique({
          where: {
            stripeSubscriptionId: subscription.id,
          },
        });
        if (existingSub) break;
        console.log(`Subscription not found, retrying... (${retries} attempts left)`);
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second
        retries--;
      }
      if (!existingSub) {
        console.log("Subscription not found after retries:", subscription.id);
        return new Response(null, { status: 200 });
      }

      console.log("Subscription found in prisma db", subscription.id);
      await prisma.subscription.update({
        where: {
          stripeSubscriptionId: subscription.id,
        },
        data: {
          planId: subscription.items.data[0].price.id,
          currentPeriodStart: subscription.current_period_start,
          currentPeriodEnd: subscription.current_period_end,
          status: subscription.status,
        },
      });
    } catch (error) {
      console.error("Error in payment handling:", String(error));
      throw error;
    }
  }

  return new Response(null, { status: 200 });
}
