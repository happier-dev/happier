import { acquireAccountChangePublicationLocksInTx } from "@/app/changes/markAccountChanged";
import { resolveDiscussionAudienceInTx } from "@/app/discussions/access";
import { readManagedWakePublicationAccountIdsInTx } from "@/app/machines/managed/managedWake";
import { readInitialSessionAccessAccountIdsInTx } from "@/app/session/access/sessionAccessGrantService";
import { fenceSessionAccountCursorAudienceInTx, readSessionAccountCursorAudienceInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { getSessionLifecycleAutomationPublicationAudienceInTx } from "@/app/workflows/workflowPublicationAudience";
import { inReadSnapshot, TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { getDbProviderFromEnv } from "@/storage/prisma";
import type { PreparedLayout1SessionCreate } from "./prepareLayout1SessionCreate";
import type { SessionCreationExecutionAuthorization } from "./apiTokenSessionCreationAuthorization";

export type SessionCreationPublicationInput = Pick<PreparedLayout1SessionCreate,
    "accountId" | "tag" | "initialAccess" | "primaryTeamId" | "manager"
    | "discussionParticipant" | "originSessionId" | "initialTriggers" | "teamCredentialBindings"> & Readonly<{
        sessionCreationAuthorization?: SessionCreationExecutionAuthorization;
    }>;

export interface SessionCreationPublicationAudience {
    readonly seedSessionIds: readonly string[];
    readonly sessionIds: readonly string[];
    readonly accountIds: readonly string[];
    readonly incumbentSessionId: string | null;
}

/** Pure census for ordinary and composed birth, before an Account or resource fence. */
export async function readLayout1SessionCreatePublicationAudienceInTx(tx: Tx, input: SessionCreationPublicationInput): Promise<SessionCreationPublicationAudience> {
    const incumbent = await tx.session.findUnique({
        where: { accountId_tag: { accountId: input.accountId, tag: input.tag } }, select: { id: true, active: true, archivedAt: true },
    });
    const accounts = new Set([input.accountId, ...await readInitialSessionAccessAccountIdsInTx(tx, input)]);
    if (input.discussionParticipant) {
        for (const accountId of await resolveDiscussionAudienceInTx(tx, input.discussionParticipant.discussionId)) accounts.add(accountId);
    }
    for (const accountId of await readManagedWakePublicationAccountIdsInTx(tx, {
        machineTargets: (input.initialTriggers ?? []).flatMap(trigger => (trigger.assignments ?? []).filter(assignment => assignment.enabled !== false).map(assignment => ({
            accountId: input.accountId, machineId: assignment.machineId,
        }))), sessionIds: [],
    })) accounts.add(accountId);
    const lifecycle = incumbent && (!incumbent.active || incumbent.archivedAt !== null)
        ? await getSessionLifecycleAutomationPublicationAudienceInTx(tx, [incumbent.id])
        : { sessionIds: [], accountIds: [] };
    const seedSessionIds = [
        ...(incumbent ? [incumbent.id] : []),
        ...(input.manager ? [input.manager.sessionId] : []),
        ...(input.originSessionId ? [input.originSessionId] : []),
        ...lifecycle.sessionIds,
    ];
    const audience = await readSessionAccountCursorAudienceInTx(tx, seedSessionIds, [...accounts, ...lifecycle.accountIds]);
    return { seedSessionIds, sessionIds: audience.projectionSessionIds, accountIds: audience.accountIds, incumbentSessionId: incumbent?.id ?? null };
}

async function validateCreationAudienceInTx(tx: Tx, input: SessionCreationPublicationInput, captured: SessionCreationPublicationAudience): Promise<void> {
    const current = await readLayout1SessionCreatePublicationAudienceInTx(tx, input);
    const accounts = new Set(captured.accountIds);
    const sessions = new Set(captured.sessionIds);
    if (current.incumbentSessionId !== captured.incumbentSessionId
        || current.accountIds.some(id => !accounts.has(id))
        || current.sessionIds.some(id => !sessions.has(id))) {
        throw new TransactionReplayRequiredError("session-account-audience-changed");
    }
}

async function fenceCreationAudienceInTx(tx: Tx, input: SessionCreationPublicationInput, captured: SessionCreationPublicationAudience): Promise<void> {
    // Entry content admission remains compatible with cursor writes.
    await acquireAccountChangePublicationLocksInTx(tx, captured.accountIds, {
        includeSingleAccount: true,
        intent: "content",
    });
    await validateCreationAudienceInTx(tx, input, captured);
    await fenceSessionAccountCursorAudienceInTx(tx,
        { projectionSessionIds: captured.sessionIds, accountIds: captured.accountIds },
        captured.seedSessionIds, captured.accountIds);
}

/** Direct composition entry; callers must invoke before their first resource fence. */
export async function acquireLayout1SessionCreatePublicationAdmissionInTx(tx: Tx, input: SessionCreationPublicationInput): Promise<void> {
    if (getDbProviderFromEnv(process.env, "postgres") === "sqlite") return;
    await fenceCreationAudienceInTx(tx, input, await readLayout1SessionCreatePublicationAudienceInTx(tx, input));
}

/** Prepare the complete birth/rejoin audience before a containing transaction starts. */
export async function prepareLayout1SessionCreatePublicationAdmission(input: SessionCreationPublicationInput): Promise<(tx: Tx) => Promise<void>> {
    if (getDbProviderFromEnv(process.env, "postgres") === "sqlite") return async () => {};
    const captured = await inReadSnapshot(tx => readLayout1SessionCreatePublicationAudienceInTx(tx, input));
    return tx => fenceCreationAudienceInTx(tx, input, captured);
}
