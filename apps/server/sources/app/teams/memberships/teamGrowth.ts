import type { TeamSeatsRequiredDetailsV1 } from "@happier-dev/protocol/teams/errors";

import { readPolarConfig } from "@/app/billing/polarClient";
import { readPlansFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { readPlansConfig } from "@/app/plans/plansConfig";
import type { Tx } from "@/storage/inTx";
import { activeTeamInvitationWhere } from "../invitations/invitationLifecycle";

export type TeamGrowthRefusal =
    | Readonly<{ ok: false; error: "team_member_limit_reached" }>
    | Readonly<{ ok: false; error: "team_seats_required"; details: TeamSeatsRequiredDetailsV1 }>;

export function readHostedTeamOffer(env: NodeJS.ProcessEnv) {
    if (!readPolarConfig(env)) return null;
    const read = readPlansConfig(env);
    const offer = read.ok ? read.config?.teams : null;
    return offer?.polarProductId ? { ...offer, polarProductId: offer.polarProductId } : null;
}

/** Capacity to admit new memberships ends at lapse. The entitlement owner applies history grace separately. */
export function hasActiveTeamPlan(
    team: Readonly<{ paidSeats: number; planEndsAt: Date | null }>,
    now: Date,
): boolean {
    return team.paidSeats > 0 && (team.planEndsAt === null || team.planEndsAt > now);
}

export async function assertTeamCanGrowInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        env: NodeJS.ProcessEnv;
        now: Date;
        countPending: boolean;
        teamPlan?: Readonly<{ paidSeats: number; planEndsAt: Date | null }>;
    }>,
): Promise<TeamGrowthRefusal | null> {
    const { teamsMaxMembers: max, plansEnabled } = readPlansFeatureEnv(input.env);
    const free = plansEnabled ? readHostedTeamOffer(input.env)?.freeSeats ?? null : null;
    if (max === null && free === null) return null;

    const team = free === null ? null : input.teamPlan ?? await tx.team.findUnique({
        where: { id: input.teamId },
        select: { paidSeats: true, planEndsAt: true },
    });
    const enforceFree = free !== null && team !== null && !hasActiveTeamPlan(team, input.now);
    if (max === null && !enforceFree) return null;

    const pending = input.countPending ? await tx.teamInvitation.count({
        where: { teamId: input.teamId, ...activeTeamInvitationWhere(input.now) },
    }) : 0;
    const memberships = await tx.teamMembership.groupBy({
        by: ["status"], where: { teamId: input.teamId }, _count: { _all: true },
    });
    // Retained memberships occupy the operator's slots even when suspended.
    const retained = memberships.reduce((sum, bucket) => sum + bucket._count._all, 0) + pending;
    if (max !== null && retained >= max) return { ok: false, error: "team_member_limit_reached" };
    const current = (memberships.find(bucket => bucket.status === "active")?._count._all ?? 0) + pending;
    if (enforceFree && current > 0 && current >= free) {
        return { ok: false, error: "team_seats_required", details: { current, free } };
    }
    return null;
}
