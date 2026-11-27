import { writeTeamPlanStateInTx } from "@/app/plans/accountPlanState";
import { readHostedTeamOffer } from "@/app/teams/memberships/teamGrowth";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";

import { LIVE_SUBSCRIPTION_STATUSES } from "./billingFacts";
import { PolarRequestError, type PolarTeamClient } from "./polarClient";
import { countActiveTeamSeats } from "./teamSeats";

/** A verified event identifies the Team. Re-read Polar before granting any paid state. */
export async function reconcileTeamBilling(
    teamId: string,
    input: Readonly<{ env: NodeJS.ProcessEnv; polar: PolarTeamClient; membershipChanged?: boolean }>,
): Promise<void> {
    const offer = readHostedTeamOffer(input.env);
    if (!offer) return;
    const team = await db.team.findUnique({
        where: { id: teamId }, select: { paidSeats: true, planEndsAt: true },
    });
    if (!team || (input.membershipChanged && team.paidSeats === 0)) return;

    const subscriptions = await input.polar.listSubscriptionsForTeam(teamId);
    const subscription = subscriptions.find(candidate =>
        candidate.metadata?.team_id === teamId
        && candidate.product_id === offer.polarProductId
        && candidate.product?.metadata?.happier_kind === "team"
        && LIVE_SUBSCRIPTION_STATUSES.has(candidate.status));
    if (!subscription) {
        if (team.paidSeats === 0) return;
        const now = new Date();
        const planEndsAt = team.planEndsAt && team.planEndsAt < now ? team.planEndsAt : now;
        // Keep the last purchased quantity for Team history and storage grace.
        await inTx(tx => writeTeamPlanStateInTx(tx, teamId, { paidSeats: team.paidSeats, planEndsAt }));
        return;
    }

    const periodEnd = subscription.current_period_end ? new Date(subscription.current_period_end) : null;
    if (!subscription.units || (periodEnd && Number.isNaN(periodEnd.getTime()))) {
        throw new PolarRequestError("Invalid Polar Team subscription facts", null);
    }
    const desired = Math.max(1, await countActiveTeamSeats(db, teamId));
    const paidSeats = desired === subscription.units ? subscription.units
        : (await input.polar.changeTeamSubscriptionUnits(subscription.id, desired)).units;
    const planEndsAt = subscription.status === "past_due" && !subscription.cancel_at_period_end ? null : periodEnd;
    await inTx(tx => writeTeamPlanStateInTx(tx, teamId, { paidSeats, planEndsAt }));
}
