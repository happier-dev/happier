import type { Prisma } from "@prisma/client";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { SESSION_ORGANIZATION_MAX_PINNED_SESSIONS } from "@happier-dev/protocol";

import { readHomeEffectiveEnv } from "@/app/features/catalog/serverFeatureGate";
import { readAccountLimitsInTx } from "@/app/plans/accountPlanEntitlement";

import { createVisibleUnarchivedOrganizationSessionWhere } from "./sessionVisibility";
import type { SessionOrganizationTx } from "./types";

/**
 * The one pin count: pins on sessions the Account can see in its list (the same set the
 * organization snapshot publishes, so the count matches what a person can see and unpin).
 */
export async function countAccountPinsInTx(tx: SessionOrganizationTx, accountId: string, authentication: SessionAccessAuthentication,
    visibleSessionWhere?: Prisma.SessionWhereInput): Promise<number> {
    return await tx.sessionPin.count({
        where: {
            accountId,
            session: visibleSessionWhere ?? await createVisibleUnarchivedOrganizationSessionWhere(tx, accountId, authentication),
        },
    });
}

/**
 * The Account's pin limit: its plan limit, never above the structural ceiling that released
 * snapshot readers enforce (`SESSION_ORGANIZATION_MAX_PINNED_SESSIONS`). Read only when a request
 * would add a pin, so unpins and re-pins cost no extra query.
 */
export async function readSessionPinLimitInTx(tx: SessionOrganizationTx, accountId: string): Promise<number> {
    const limits = await readAccountLimitsInTx(tx, accountId, await readHomeEffectiveEnv({ tx }));
    return limits.pinnedSessions ?? SESSION_ORGANIZATION_MAX_PINNED_SESSIONS;
}
