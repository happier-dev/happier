import { randomUUID } from "node:crypto";

import { TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { acquireTeamMutationAccountAdmissionInTx, withTeamSessionAccessEffectsInTx, type TeamSessionAccessImpacts } from "./sessionAccessEffects";
import type { SessionAccessMembershipChange } from "@/app/session/access/sessionAccessMembershipImpact";
import type { AccountAdmissionIntent } from "@/app/encryption/accountSessionOwnerMetadataFence";
import {
    AccountStatus,
    type SessionHistoryAccess,
    type TeamMembershipStatus,
    type TeamRole,
} from "@/storage/enums.generated";
import { readTransactionDatabaseTime } from "@/storage/transactionDatabaseTime";
import { isServerFeatureEnabledForHome, type HomeConfigSource } from "@/app/features/catalog/serverFeatureGate";
import { mintSessionAccessStartsAt, sessionHistoryAccessOf } from "./sessionHistory";
import {
    isEffectiveTeamMembership,
    type TeamMembershipLifetimeContext,
    resolveTeamMembershipContextInTx,
} from "./effectiveMembership";
import { advanceBrokerJobRevisionsForMembershipInTx } from '../credentials/brokerJobWithdrawal';

export type TeamMemberAdmissionOutcome = "added" | "already_member";

export type TeamMemberAdmissionError =
    | "teams_unavailable"
    | "team_not_found"
    | "team_archived"
    | "account_not_found"
    | "account_ineligible";

export type TeamMemberAdmissionResult =
    | Readonly<{
        ok: true;
        outcome: TeamMemberAdmissionOutcome;
        membership: TeamMembershipLifetimeContext;
    }>
    | Readonly<{ ok: false; error: TeamMemberAdmissionError }>;

/** Discover current membership Account identities, then admit the complete
 * actor/target batch before callers reread current authority or mutate resources. */
export async function acquireTeamMembershipAccountAdmissionInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; accountIds: readonly string[]; membershipIds: readonly string[]; membershipChange?: SessionAccessMembershipChange; intent?: AccountAdmissionIntent }>,
): Promise<() => Promise<void>> {
    const memberships = input.membershipIds.length === 0 ? [] : await tx.teamMembership.findMany({
        where: { id: { in: [...input.membershipIds] } },
        select: { id: true, accountId: true },
    });
    const accountIds = [...input.accountIds, ...memberships.map(member => member.accountId)];
    const recheck = await acquireTeamMutationAccountAdmissionInTx(tx, {
        teamId: input.teamId, accountIds, membershipChange: input.membershipChange, affectedAccountIds: accountIds, intent: input.intent,
    });
    if (memberships.length > 0) {
        const current = await tx.teamMembership.findMany({
            where: { id: { in: memberships.map(member => member.id) } },
            select: { id: true, accountId: true },
        });
        const admitted = new Map(memberships.map(member => [member.id, member.accountId]));
        if (current.some(member => admitted.get(member.id) !== member.accountId)) {
            throw new TransactionReplayRequiredError("transaction-account-audience-changed");
        }
    }
    return recheck;
}

/**
 * Admit one Account to a Team, minting its membership lifetime and history horizon.
 *
 * This is the single admission entry. Team creation, direct add, invitation
 * acceptance, and the external-fact adapters all call it, which is what makes
 * "one membership produced exactly once per native, email, and directory path" a
 * property of the code rather than a convention each caller must remember.
 *
 * The actor or internal source is validated by the calling mutation service, which
 * also owns the capability decision; this function deliberately does not re-decide
 * authorization, so there is exactly one place that answers "may you do this".
 *
 * Admission is idempotent by design. An Account that is already a member is
 * reported as `already_member` with its current lifetime, and its role, status, and
 * horizon are left exactly as they are: a retried invitation acceptance or a
 * directory replay must never silently widen someone's history or restore a role an
 * administrator has since changed. Only the explicit role, status, and management
 * mutations change those facts.
 */
export async function admitTeamMemberInTx(
    tx: Tx,
    params: Readonly<{
        teamId: string;
        accountId: string;
        role: TeamRole;
        historyAccess: SessionHistoryAccess;
        sessionAccessImpacts?: TeamSessionAccessImpacts;
        env?: NodeJS.ProcessEnv;
    }>,
): Promise<TeamMemberAdmissionResult> {
    await acquireTeamMutationAccountAdmissionInTx(tx, { teamId: params.teamId, accountIds: [params.accountId],
        affectedAccountIds: [params.accountId], membershipChange: { kind: "teamMembership", teamId: params.teamId } });
    // This membership leaf is the effect-time feature boundary shared by native,
    // invitation, directory, OAuth, and mTLS admission. Callers may also use the
    // same function below as a cheap preflight before starting an external flow,
    // but this final check is what prevents a feature change between start and
    // commit from creating membership or consuming its enclosing transaction.
    if (!await isTeamMembershipAdmissionEnabled({ tx, env: params.env })) {
        return { ok: false, error: "teams_unavailable" };
    }
    const team = await tx.team.findUnique({
        where: { id: params.teamId },
        select: { id: true, archivedAt: true },
    });
    if (!team) return { ok: false, error: "team_not_found" };
    // An archived Team accepts no new members; its retained rows exist for restoration.
    if (team.archivedAt !== null) return { ok: false, error: "team_archived" };

    const account = await tx.account.findUnique({
        where: { id: params.accountId },
        select: { id: true, status: true },
    });
    if (!account) return { ok: false, error: "account_not_found" };
    if (account.status !== AccountStatus.active) {
        return { ok: false, error: "account_ineligible" };
    }

    const existing = await readCurrentMembershipInTx(tx, params);
    if (existing) return { ok: true, outcome: "already_member", membership: existing };

    // The horizon must come from the database clock of this transaction attempt, read
    // after admission checks. A process clock on a skewed replica would mint a cutoff
    // that disagrees with the grant timestamps it is later compared against, and a
    // value captured before a retry would no longer belong to the committing attempt.
    const activationNow = await readTransactionDatabaseTime(tx);
    // Guest is an access boundary, not merely a display role. Even a stale or
    // bypassing caller that submits all_existing cannot mint pre-membership
    // history for a Guest through the canonical admission owner.
    const historyAccess = params.role === "guest" ? "from_membership" : params.historyAccess;
    const sessionAccessStartsAt = mintSessionAccessStartsAt(historyAccess, activationNow);

    return withTeamSessionAccessEffectsInTx(tx, {
        teamId: params.teamId, accountIds: [params.accountId], sessionAccessImpacts: params.sessionAccessImpacts,
    }, async () => {
        // Upsert is the provider-safe conditional create. In particular, it
        // never catches a PostgreSQL uniqueness error and then tries to keep
        // using the transaction that PostgreSQL has already aborted.
        const proposedId = randomUUID();
        const created = await tx.teamMembership.upsert({
            where: { teamId_accountId: { teamId: params.teamId, accountId: params.accountId } },
            create: {
                id: proposedId,
                teamId: params.teamId,
                accountId: params.accountId,
                role: params.role,
                sessionAccessStartsAt,
            },
            update: {},
            select: {
                id: true, teamId: true, accountId: true, role: true, status: true,
                sessionAccessStartsAt: true,
                account: { select: { status: true } },
            },
        });
        return {
            ok: true,
            outcome: created.id === proposedId ? "added" : "already_member",
            membership: {
                teamMembershipId: created.id,
                teamId: created.teamId,
                accountId: created.accountId,
                role: created.role,
                status: created.status,
                sessionAccessStartsAt: created.sessionAccessStartsAt,
                historyAccess: sessionHistoryAccessOf(created.sessionAccessStartsAt),
                effective: isEffectiveTeamMembership({
                    accountStatus: created.account.status,
                    membershipStatus: created.status,
                    teamArchivedAt: null,
                }),
            },
        };
    });
}

/**
 * The single Teams feature decision used by admission preflight and effect time, on the Home-effective
 * configuration: pass the transaction when inside one, the request overlay otherwise.
 */
export async function isTeamMembershipAdmissionEnabled(source: HomeConfigSource): Promise<boolean> {
    return await isServerFeatureEnabledForHome("teams", source);
}

/**
 * Change the reversible status of one retained Team-membership lifetime.
 *
 * Actor capability and external-source ownership stay with their respective
 * adapters. This leaf owns the shared status write and its retained-lifecycle
 * Session effects, preserving the membership ID, role, history horizon, Group
 * rows, and membership-scoped grants.
 */
export async function setTeamMembershipStatusInTx(
    tx: Tx,
    params: Readonly<{
        teamId: string;
        membershipId: string;
        accountId: string;
        status: TeamMembershipStatus;
        sessionAccessImpacts?: TeamSessionAccessImpacts;
    }>,
): Promise<void> {
    await acquireTeamMutationAccountAdmissionInTx(tx, { teamId: params.teamId, accountIds: [params.accountId],
        affectedAccountIds: [params.accountId], membershipChange: { kind: "teamMembership", teamId: params.teamId } });
    await withTeamSessionAccessEffectsInTx(tx, {
        teamId: params.teamId,
        accountIds: [params.accountId],
        change: { kind: "teamMembership", teamId: params.teamId },
        sessionAccessImpacts: params.sessionAccessImpacts,
    }, async () => {
        const current = await tx.teamMembership.findUniqueOrThrow({
            where: { id: params.membershipId }, select: { status: true },
        });
        await tx.teamMembership.update({
            where: { id: params.membershipId },
            data: { status: params.status },
        });
        if (current.status === 'active' && params.status === 'suspended') {
            await advanceBrokerJobRevisionsForMembershipInTx(tx, {
                teamId: params.teamId, teamMembershipId: params.membershipId,
            });
        }
    });
}

async function readCurrentMembershipInTx(
    tx: Tx,
    params: Readonly<{ teamId: string; accountId: string }>,
): Promise<TeamMembershipLifetimeContext | null> {
    const current = await tx.teamMembership.findUnique({
        where: { teamId_accountId: { teamId: params.teamId, accountId: params.accountId } },
        select: { id: true },
    });
    if (!current) return null;

    const resolved = await resolveTeamMembershipContextInTx(tx, {
        teamId: params.teamId,
        teamMembershipId: current.id,
        expectedAccountId: params.accountId,
    });
    return resolved.ok ? resolved.membership : null;
}
