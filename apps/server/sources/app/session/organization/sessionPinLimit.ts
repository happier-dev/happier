import { SESSION_ORGANIZATION_MAX_PINNED_SESSIONS } from "@happier-dev/protocol";

import { readAccountLimitsInTx } from "@/app/plans/accountLimits";

import { createVisibleUnarchivedOrganizationSessionWhere } from "./sessionVisibility";
import type { SessionOrganizationTx } from "./types";

/**
 * The one pin count: pins on sessions the Account can see in its list (the same set the
 * organization snapshot publishes, so the count matches what a person can see and unpin).
 */
export async function countAccountPinsInTx(tx: SessionOrganizationTx, accountId: string): Promise<number> {
    return await tx.sessionPin.count({
        where: {
            accountId,
            session: createVisibleUnarchivedOrganizationSessionWhere(accountId),
        },
    });
}

/**
 * The Account's pin limit: its plan limit, never above the structural ceiling that released
 * snapshot readers enforce (`SESSION_ORGANIZATION_MAX_PINNED_SESSIONS`). Read only when a request
 * would add a pin, so unpins and re-pins cost no extra query.
 */
export async function readSessionPinLimitInTx(tx: SessionOrganizationTx, accountId: string): Promise<number> {
    const limits = await readAccountLimitsInTx(tx, accountId, process.env);
    return limits.pinnedSessions ?? SESSION_ORGANIZATION_MAX_PINNED_SESSIONS;
}
