import { isDeepStrictEqual } from "node:util";
import * as privacyKit from "privacy-kit";
import { parseEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { projectAutomationAccountCurrentnessWitnessV1 } from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import { resolveWorkflowRunVisibleTeamV1 } from '@happier-dev/protocol/workflows';
import type { WorkflowRunRecipientCensusInputV1, WorkflowRunRecipientCensusResponseV1, WorkflowRunRecipientKeyEnvelopeV1, WorkflowRunRecipientKeyEnvelopeCommitInputV1, WorkflowRunRecipientKeyEnvelopeCommitResponseV1 } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import type { Tx } from "@/storage/inTx";
import { resolveArtifactAccessInTx, resolveArtifactAudienceInTx } from "@/app/artifacts/artifactAccessService";
import { readAccessibleArtifactIdsInTx } from '@/app/artifacts/artifactGrantStorageAdapter';
import { resolveTeamMembershipContextsInTx } from "@/app/teams/memberships/effectiveMembership";
import { readTeamSummaryForActorInTx } from "@/app/teams/lifecycle";
import type { TeamOperationAuthenticationContext } from "@/app/teams/actorContext";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { acquireAccountEncryptionTransitionFenceInTx, deriveAccountEncryptionMigrationKeyFingerprints } from "@/app/encryption/accountEncryptionTransition";
import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { deriveAccountRecipientEnvelopeReadinessFromRow } from "@/app/encryption/accountRecipientEnvelopeReadiness";
import { projectRecipientContentKey, RECIPIENT_READINESS_SELECT, type RecipientReadinessRow } from "@/app/session/encryption/sessionDataKeyRecipientProjection";
import { markAccountsChanged } from "@/app/changes/markAccountChanged";
import { acquireWorkflowPublicationLocksInTx } from "./acquireWorkflowPublicationLocksInTx";
import type { WorkflowDiscussionOriginV1 } from '@happier-dev/protocol/workflows/workflowDestinationsV1';
import { resolveDiscussionContextInTx, discussionContextStorageAdapter } from '@/app/discussions/access';
import { readDiscussionMessageInTx } from '@/app/discussions/queries';
import { admitDiscussionSecondOpinionSourceInTx } from '@/app/discussions/secondOpinion';
import { mayInjectResourceContextInTx } from '@/app/session/access/sessionContextInjection';
import { backgroundDeliveryAuthentication, type SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import type { Prisma } from '@prisma/client';

/** Existing exact assigned-Machine authority for observing an interrupted Run's retained children. */
export function workflowInvocationObservationRunWhere(input: Readonly<{
    accountId: string; runId: string; machineId: string; expectedRevision: number;
}>): Prisma.AutomationRunWhereInput {
    return { id: input.runId, accountId: input.accountId, revision: input.expectedRevision, state: 'interrupted',
        workflowCustodyState: 'pending', assignments: { some: { machineId: input.machineId } } };
}

/** Workflow selection consumes C3's live grants, speaking policy, keys and disclosure owner. */
export async function assertWorkflowDiscussionAdmissionInTx(tx: Tx, input: Readonly<{
    accountId: string; origin: WorkflowDiscussionOriginV1; targetSessionIds: readonly string[];
    authentication: SessionAccessAuthentication | undefined; publishes: boolean;
}>): Promise<void> {
    if (!input.authentication) throw new WorkflowRunAccessError('run_access_denied');
    const discussionId = input.origin.discussion.discussionId;
    const context = await resolveDiscussionContextInTx(tx, { discussionId, accountId: input.accountId,
        authentication: input.authentication });
    const row = await tx.discussion.findUnique({ where: { id: discussionId }, select: { archivedAt: true, anchorV1: true } });
    if (!context || !row || row.archivedAt || input.publishes && context.access.level === 'view') {
        throw new WorkflowRunAccessError('run_access_denied');
    }
    if (!context.keyReadiness) throw new WorkflowRunAccessError('content_unavailable');
    const message = await readDiscussionMessageInTx(tx, { discussionId, messageId: input.origin.messageId,
        actorAccountId: input.accountId, authentication: input.authentication });
    if (!message.ok || message.value.seq !== input.origin.throughSeq) throw new WorkflowRunAccessError('invalid_input');
    for (const sessionId of new Set(input.targetSessionIds)) {
        const participant = await tx.discussionParticipant.findUnique({ where: { discussionId_sessionId: { discussionId, sessionId } },
            select: { removedAt: true, answerPolicy: true, session: { select: { accountId: true, archivedAt: true } } } });
        if (!participant?.session || participant.session.accountId !== input.accountId
            || participant.removedAt || participant.session.archivedAt || participant.answerPolicy === 'reads_only') {
            throw new WorkflowRunAccessError('run_access_denied');
        }
        const source = await admitDiscussionSecondOpinionSourceInTx(tx, { actorAccountId: input.accountId,
            authentication: input.authentication, anchor: row.anchorV1, destination: { kind: 'session', sessionId } });
        if (!source.ok) throw new WorkflowRunAccessError('run_access_denied');
        const disclosure = await mayInjectResourceContextInTx(tx, { configuringAccountId: input.accountId,
            authentication: input.authentication, source: { kind: 'resource', resourceId: discussionId, adapter: discussionContextStorageAdapter },
            destination: { kind: 'session', sessionId } });
        if (!disclosure.ok) throw new WorkflowRunAccessError('run_access_denied');
        const runtime = await resolveDiscussionContextInTx(tx, { discussionId, accountId: participant.session.accountId,
            authentication: backgroundDeliveryAuthentication() });
        if (!runtime?.keyReadiness) throw new WorkflowRunAccessError('content_unavailable');
    }
}

export type WorkflowRunAccessErrorCode = "run_not_found" | "run_access_denied" | "visible_team_not_granted"
    | "currentness_conflict" | "invalid_input" | "content_unavailable" | "data_key_not_required";
export class WorkflowRunAccessError extends Error {
    constructor(readonly code: WorkflowRunAccessErrorCode) { super(code); this.name = "WorkflowRunAccessError"; }
}
export interface WorkflowRunAccess {
    ownerAccountId: string;
    level: "owner" | "view" | "edit" | "admin";
    encryptionMode: "plain" | "e2ee" | null;
    visibleTeamId: string | null;
}
const runAccessFactsSelect = {
    accountId: true, sourceArtifactId: true, visibleTeamId: true,
    workflowCustodyState: true, account: { select: { encryptionMode: true } },
} as const;
const runFactsSelect = { ...runAccessFactsSelect, workflowAcceptedSnapshotEnvelope: true } as const;
async function readRunFactsInTx(tx: Tx, runId: string) {
    return tx.automationRun.findUnique({ where: { id: runId }, select: runFactsSelect });
}
type RunFacts = NonNullable<Awaited<ReturnType<typeof readRunFactsInTx>>>;

async function isLiveTeamMemberInTx(tx: Tx, teamId: string, accountId: string): Promise<boolean> {
    const memberships = await resolveTeamMembershipContextsInTx(tx, { where: { teamId, accountId } });
    return memberships.some(membership => membership.effective);
}

/** A Run's frozen Team remains an audience only while that exact source grant exists. */
async function readGrantedTeamIdsInTx(tx: Tx, sourceArtifactId: string, candidateTeamIds: readonly string[]): Promise<string[]> {
    if (candidateTeamIds.length === 0) return [];
    const grants = await tx.artifactTeamGrant.findMany({
        where: { artifactId: sourceArtifactId, teamId: { in: [...candidateTeamIds] } }, select: { teamId: true },
    });
    return grants.map(grant => grant.teamId);
}

/** Collection adapters consume these same source grants and live memberships. */
export async function resolveWorkflowRunVisibilityScopesInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; sourceArtifactIds?: readonly string[];
}>): Promise<ReadonlyArray<Readonly<{ sourceArtifactId: string; visibleTeamIds: readonly string[] }>>> {
    const memberships = await resolveTeamMembershipContextsInTx(tx, { where: {
        accountId: input.actorAccountId,
        ...(input.sourceArtifactIds === undefined ? {} : { team: {
            artifactGrants: { some: { artifactId: { in: [...input.sourceArtifactIds] } } },
        } }),
    } });
    const liveTeamIds = memberships.filter(membership => membership.effective).map(membership => membership.teamId);
    // Discover from live grants even when the caller filters by Run, trigger,
    // lifecycle or no source at all. A source filter narrows this same audience.
    const grants = await tx.artifactTeamGrant.findMany({ where: {
        teamId: { in: liveTeamIds },
        ...(input.sourceArtifactIds === undefined ? {} : { artifactId: { in: [...input.sourceArtifactIds] } }),
    }, select: { artifactId: true, teamId: true } });
    const teamsBySource = new Map<string, string[]>();
    for (const grant of grants) {
        const teams = teamsBySource.get(grant.artifactId) ?? [];
        teams.push(grant.teamId);
        teamsBySource.set(grant.artifactId, teams);
    }
    const accessibleIds = await readAccessibleArtifactIdsInTx(tx, {
        actorAccountId: input.actorAccountId, artifactIds: [...teamsBySource.keys()],
    });
    return [...teamsBySource].filter(([sourceArtifactId]) => accessibleIds.has(sourceArtifactId))
        .map(([sourceArtifactId, visibleTeamIds]) => ({ sourceArtifactId, visibleTeamIds }));
}
async function accessFromFactsInTx(tx: Tx, row: Omit<RunFacts, "workflowAcceptedSnapshotEnvelope">, actorAccountId: string): Promise<WorkflowRunAccess | null> {
    const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(row.account);
    const common = { ownerAccountId: row.accountId, encryptionMode: mode.status === "ready" ? mode.mode : null, visibleTeamId: row.visibleTeamId };
    if (row.accountId === actorAccountId) return { ...common, level: "owner" };
    if (row.workflowCustodyState === null) return null;
    if (!row.sourceArtifactId || !row.visibleTeamId || !await isLiveTeamMemberInTx(tx, row.visibleTeamId, actorAccountId)) return null;
    if ((await readGrantedTeamIdsInTx(tx, row.sourceArtifactId, [row.visibleTeamId])).length === 0) return null;
    const grant = await resolveArtifactAccessInTx(tx, { actorAccountId, artifactId: row.sourceArtifactId });
    return grant ? { ...common, level: grant.level === "owner" ? "admin" : grant.level } : null;
}

/** Run visibility consumes the frozen Team and the document's one live grant owner. */
export async function resolveWorkflowRunAccessInTx(tx: Tx, input: Readonly<{ actorAccountId: string; runId: string }>): Promise<WorkflowRunAccess | null> {
    const row = await readRunFactsInTx(tx, input.runId);
    return row ? accessFromFactsInTx(tx, row, input.actorAccountId) : null;
}

/** Only viewable granted Teams are eligible; several require the caller's choice. */
export async function resolveWorkflowRunAdmissionVisibilityInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; sourceArtifactId: string | null; visibleTeamId?: string | null;
    authentication?: TeamOperationAuthenticationContext;
}>): Promise<string | null> {
    if (input.sourceArtifactId && !await resolveArtifactAccessInTx(tx, { actorAccountId: input.actorAccountId, artifactId: input.sourceArtifactId })) {
        throw new WorkflowRunAccessError("run_not_found");
    }
    const grants = input.sourceArtifactId
        ? await tx.artifactTeamGrant.findMany({ where: { artifactId: input.sourceArtifactId }, select: { teamId: true } }) : [];
    const viewableTeamIds: string[] = [];
    for (const grant of grants) {
        const result = await readTeamSummaryForActorInTx(tx, { teamId: grant.teamId, actorAccountId: input.actorAccountId,
            authentication: input.authentication });
        if (result.ok) viewableTeamIds.push(grant.teamId);
        else if (result.error !== "team_not_found") throw new WorkflowRunAccessError("run_access_denied");
    }
    const visibility = resolveWorkflowRunVisibleTeamV1(viewableTeamIds, input.visibleTeamId);
    if (!visibility.ok) throw new WorkflowRunAccessError(visibility.code);
    return visibility.visibleTeamId;
}

async function audienceFromFactsInTx(tx: Tx, row: Pick<RunFacts, "accountId" | "sourceArtifactId" | "visibleTeamId">): Promise<string[]> {
    if (!row.sourceArtifactId || !row.visibleTeamId) return [row.accountId];
    if ((await readGrantedTeamIdsInTx(tx, row.sourceArtifactId, [row.visibleTeamId])).length === 0) return [row.accountId];
    const candidates = await resolveArtifactAudienceInTx(tx, row.sourceArtifactId);
    const memberships = await resolveTeamMembershipContextsInTx(tx, { where: { teamId: row.visibleTeamId } });
    const liveAccountIds = new Set(memberships.filter(membership => membership.effective).map(membership => membership.accountId));
    return [row.accountId, ...candidates.filter(accountId => accountId !== row.accountId && liveAccountIds.has(accountId))].sort();
}
/** Admission uses the same audience before a physical Run exists. */
export async function resolveWorkflowRunAdmissionRecipientAccountIdsInTx(tx: Tx, input: Readonly<{
    accountId: string; sourceArtifactId: string | null; visibleTeamId: string | null;
}>): Promise<string[]> {
    return audienceFromFactsInTx(tx, input);
}
/** Key preparation and wake fan-out use the same live Run audience. */
export async function resolveWorkflowRunRecipientAccountIdsInTx(tx: Tx, runId: string): Promise<string[]> {
    const row = await readRunFactsInTx(tx, runId);
    return row && row.workflowCustodyState !== null ? audienceFromFactsInTx(tx, row) : [];
}

type RunKeyOwnerAccount = Omit<RecipientReadinessRow, "id"> & Readonly<{ seq: number }>;
type RunKeyEnvelope = Readonly<{
    recipientAccountId: string; recipientContentPublicKeyFingerprint: string; encryptedDataKey: Uint8Array;
}>;

/** Single and collection reads share the exact currentness, recipient and envelope decision. */
function projectKeys(input: Readonly<{ actorAccountId: string; runId: string }>, access: WorkflowRunAccess,
    account: RunKeyOwnerAccount | null | undefined, accounts: readonly RecipientReadinessRow[],
    envelopes: readonly RunKeyEnvelope[]): WorkflowRunRecipientCensusResponseV1 {
    if (!account) throw new WorkflowRunAccessError("content_unavailable");
    const currentness = deriveAccountEncryptionCurrentnessFromRow(account);
    if (currentness.status !== "ready") throw new WorkflowRunAccessError("content_unavailable");
    const ownerAccountCurrentness = projectAutomationAccountCurrentnessWitnessV1({ mode: currentness.currentness.encryptionMode,
        version: account.seq, contentKeyFingerprint: deriveAccountEncryptionMigrationKeyFingerprints(account).contentKeyFingerprint });
    if (!ownerAccountCurrentness) throw new WorkflowRunAccessError("content_unavailable");
    const byAccount = new Map(envelopes.map(envelope => [envelope.recipientAccountId, envelope]));
    const plain = ownerAccountCurrentness.mode === "plain";
    const recipients = accounts.map(account => {
        const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(account);
        const fingerprint = readiness.status === "available" ? readiness.binding.contentPublicKeyFingerprint : null;
        const envelope = byAccount.get(account.id);
        const current = !plain && envelope && fingerprint !== null && fingerprint === envelope.recipientContentPublicKeyFingerprint
            && parseEncryptedDataKeyEnvelopeV1(envelope.encryptedDataKey) !== null;
        return { recipientAccountId: account.id, contentKey: projectRecipientContentKey(account, readiness), contentPublicKeyFingerprint: fingerprint,
            encryptedDataKey: current ? privacyKit.encodeBase64(new Uint8Array(envelope.encryptedDataKey)) : null,
            recipientContentPublicKeyFingerprint: plain ? null : envelope?.recipientContentPublicKeyFingerprint ?? null };
    });
    const ownerEnvelope = byAccount.get(access.ownerAccountId);
    const ownerKey = !plain && ownerEnvelope && parseEncryptedDataKeyEnvelopeV1(ownerEnvelope.encryptedDataKey) !== null
        ? privacyKit.encodeBase64(new Uint8Array(ownerEnvelope.encryptedDataKey)) : null;
    return { runId: input.runId, ownerAccountId: access.ownerAccountId, access: access.level, encryptionMode: ownerAccountCurrentness.mode,
        visibleTeamId: access.visibleTeamId, ownerAccountCurrentness, dataEncryptionKey: ownerKey,
        callerDataEncryptionKey: recipients.find(recipient => recipient.recipientAccountId === input.actorAccountId)?.encryptedDataKey ?? null,
        recipients };
}

async function projectKeysInTx(tx: Tx, input: Readonly<{ actorAccountId: string; runId: string }>, row: RunFacts, access: WorkflowRunAccess): Promise<WorkflowRunRecipientCensusResponseV1> {
    // A read projects a witness; only mutations acquire the Account writer fence.
    const audience = await audienceFromFactsInTx(tx, row);
    const [accounts, envelopes] = await Promise.all([
        tx.account.findMany({ where: { id: { in: audience } }, select: { ...RECIPIENT_READINESS_SELECT, seq: true }, orderBy: { id: "asc" } }),
        tx.workflowRunDataKeyEnvelope.findMany({ where: { runId: input.runId } }),
    ]);
    return projectKeys(input, access, accounts.find(account => account.id === access.ownerAccountId), accounts, envelopes);
}

/** Read one page's keys together, retaining each Run's canonical live audience admission. */
export async function readWorkflowRunKeyProjectionsInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; runIds: readonly string[];
}>): Promise<Map<string, WorkflowRunRecipientCensusResponseV1>> {
    return createWorkflowRunKeyProjectionReader(input.actorAccountId)(tx, input.runIds);
}

/** A finite read retains admitted authority and Account key identity across its SQL pages. */
export function createWorkflowRunKeyProjectionReader(actorAccountId: string):
    (tx: Tx, runIds: readonly string[]) => Promise<Map<string, WorkflowRunRecipientCensusResponseV1>> {
    const authorityByFacts = new Map<string, Promise<{ access: WorkflowRunAccess; audience: Set<string> }>>();
    const accountsById = new Map<string, RecipientReadinessRow & { seq: number }>();
    return async (tx, requestedRunIds) => {
        const runIds = [...new Set(requestedRunIds)];
        if (runIds.length === 0) return new Map();
        const rows = await tx.automationRun.findMany({ where: { id: { in: runIds } }, select: { id: true, ...runAccessFactsSelect } });
        if (rows.length !== runIds.length) throw new WorkflowRunAccessError("run_not_found");
        const admitted = await Promise.all(rows.map(async row => {
            if (row.workflowCustodyState === null) throw new WorkflowRunAccessError('run_not_found');
            // A later page is part of the same admitted read. Changed Account mode
            // cannot turn an already admitted authority into a new decision tuple.
            const key = JSON.stringify([row.accountId, row.sourceArtifactId, row.visibleTeamId]);
            let authority = authorityByFacts.get(key);
            if (!authority) {
                authority = (async () => {
                    const access = await accessFromFactsInTx(tx, row, actorAccountId);
                    if (!access) throw new WorkflowRunAccessError("run_not_found");
                    return { access, audience: new Set(await audienceFromFactsInTx(tx, row)) };
                })();
                authorityByFacts.set(key, authority);
            }
            return { row, ...await authority };
        }));
        const recipientIds = [...new Set(admitted.flatMap(item => [...item.audience]))];
        const unreadRecipientIds = recipientIds.filter(id => !accountsById.has(id));
        const [accounts, envelopes] = await Promise.all([
            unreadRecipientIds.length === 0 ? [] : tx.account.findMany({ where: { id: { in: unreadRecipientIds } },
                select: { ...RECIPIENT_READINESS_SELECT, seq: true }, orderBy: { id: "asc" } }),
            tx.workflowRunDataKeyEnvelope.findMany({ where: { runId: { in: runIds } } }),
        ]);
        for (const account of accounts) accountsById.set(account.id, account);
        const envelopesByRunId = new Map<string, typeof envelopes>();
        for (const envelope of envelopes) {
            const values = envelopesByRunId.get(envelope.runId) ?? [];
            values.push(envelope);
            envelopesByRunId.set(envelope.runId, values);
        }
        return new Map(admitted.map(({ row, access, audience }) => [row.id, projectKeys(
            { actorAccountId, runId: row.id }, access, accountsById.get(access.ownerAccountId),
            [...audience].flatMap(id => {
                const account = accountsById.get(id);
                return account ? [account] : [];
            }), envelopesByRunId.get(row.id) ?? [],
        )]));
    };
}

/** Authorized reads retain missing/stale keys as a truthful locked projection. */
export async function readWorkflowRunKeyProjectionInTx(tx: Tx, input: Readonly<{ actorAccountId: string; runId: string }>): Promise<WorkflowRunRecipientCensusResponseV1> {
    const projection = (await readWorkflowRunKeyProjectionsInTx(tx, { actorAccountId: input.actorAccountId, runIds: [input.runId] })).get(input.runId);
    if (!projection) throw new WorkflowRunAccessError("run_not_found");
    return projection;
}

/** Before first sealing, the starter can census the chosen saved-source audience. */
export async function readWorkflowRunRecipientCensusInTx(tx: Tx, input: WorkflowRunRecipientCensusInputV1 & {
    actorAccountId: string; authentication?: TeamOperationAuthenticationContext;
}): Promise<WorkflowRunRecipientCensusResponseV1> {
    const row = await readRunFactsInTx(tx, input.runId);
    if (row && row.workflowAcceptedSnapshotEnvelope !== null) return readWorkflowRunKeyProjectionInTx(tx, input);
    if (row && row.accountId !== input.actorAccountId) throw new WorkflowRunAccessError("run_not_found");
    const sourceArtifactId = input.sourceArtifactId ?? null;
    const visibleTeamId = await resolveWorkflowRunAdmissionVisibilityInTx(tx, { actorAccountId: input.actorAccountId, sourceArtifactId,
        visibleTeamId: input.visibleTeamId, authentication: input.authentication });
    const account = await tx.account.findUnique({ where: { id: input.actorAccountId }, select: { encryptionMode: true } });
    if (!account) throw new WorkflowRunAccessError("run_not_found");
    const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(account);
    const facts: RunFacts = { accountId: input.actorAccountId, account, sourceArtifactId, visibleTeamId,
        workflowAcceptedSnapshotEnvelope: null, workflowCustodyState: "pending" };
    return projectKeysInTx(tx, input, facts, { ownerAccountId: input.actorAccountId, level: "owner", visibleTeamId,
        encryptionMode: mode.status === "ready" ? mode.mode : null });
}

function validateEnvelopeInputs(envelopes: readonly WorkflowRunRecipientKeyEnvelopeV1[]): void {
    if (new Set(envelopes.map(envelope => envelope.recipientAccountId)).size !== envelopes.length) throw new WorkflowRunAccessError("invalid_input");
    for (const envelope of envelopes) {
        if (!parseEncryptedDataKeyEnvelopeV1(privacyKit.decodeBase64(envelope.encryptedDataKey))) throw new WorkflowRunAccessError("invalid_input");
    }
}
async function applyPreparedEnvelopesInTx(tx: Tx, input: Readonly<{
    row: RunFacts; runId: string; recipientKeyEnvelopes: readonly WorkflowRunRecipientKeyEnvelopeV1[]; ownerContentPublicKeyFingerprint?: string;
}>): Promise<WorkflowRunRecipientKeyEnvelopeCommitResponseV1> {
    const audience = new Set(await audienceFromFactsInTx(tx, input.row));
    const appliedRecipientAccountIds: string[] = [];
    const skippedRecipientAccountIds: string[] = [];
    for (const envelope of input.recipientKeyEnvelopes) {
        const account = await tx.account.findUnique({ where: { id: envelope.recipientAccountId }, select: RECIPIENT_READINESS_SELECT });
        const readiness = account ? deriveAccountRecipientEnvelopeReadinessFromRow(account) : null;
        const fingerprint = envelope.recipientAccountId === input.row.accountId && input.ownerContentPublicKeyFingerprint !== undefined
            ? input.ownerContentPublicKeyFingerprint : readiness?.status === "available" ? readiness.binding.contentPublicKeyFingerprint : null;
        if (!audience.has(envelope.recipientAccountId) || fingerprint === null || fingerprint !== envelope.recipientContentPublicKeyFingerprint) {
            skippedRecipientAccountIds.push(envelope.recipientAccountId);
            continue;
        }
        const data = { encryptedDataKey: new Uint8Array(privacyKit.decodeBase64(envelope.encryptedDataKey)),
            recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint };
        await tx.workflowRunDataKeyEnvelope.upsert({ where: { runId_recipientAccountId: { runId: input.runId, recipientAccountId: envelope.recipientAccountId } },
            create: { runId: input.runId, recipientAccountId: envelope.recipientAccountId, ...data }, update: data });
        appliedRecipientAccountIds.push(envelope.recipientAccountId);
    }
    return { appliedRecipientAccountIds, skippedRecipientAccountIds };
}

export async function storeWorkflowRunInitialKeyEnvelopesInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; runId: string; sourceArtifactId: string | null; visibleTeamId: string | null;
    encryptionMode: "plain" | "e2ee"; recipientKeyEnvelopes: readonly WorkflowRunRecipientKeyEnvelopeV1[];
}>): Promise<void> {
    validateEnvelopeInputs(input.recipientKeyEnvelopes);
    if (input.encryptionMode === "plain") {
        if (input.recipientKeyEnvelopes.length > 0) throw new WorkflowRunAccessError("data_key_not_required");
        return;
    }
    const row = await readRunFactsInTx(tx, input.runId);
    if (!row || row.accountId !== input.actorAccountId || row.sourceArtifactId !== input.sourceArtifactId || row.visibleTeamId !== input.visibleTeamId) throw new WorkflowRunAccessError("currentness_conflict");
    const owner = input.recipientKeyEnvelopes.find(envelope => envelope.recipientAccountId === row.accountId);
    if (!owner) throw new WorkflowRunAccessError("content_unavailable");
    const applied = await applyPreparedEnvelopesInTx(tx, { row, runId: input.runId, recipientKeyEnvelopes: input.recipientKeyEnvelopes });
    if (!applied.appliedRecipientAccountIds.includes(row.accountId)) throw new WorkflowRunAccessError("content_unavailable");
}

/** Opaque preparation is a key-holder operation, not edit authority on Run content. */
export async function commitWorkflowRunRecipientKeyEnvelopesInTx(tx: Tx, input: WorkflowRunRecipientKeyEnvelopeCommitInputV1 & { actorAccountId: string }): Promise<WorkflowRunRecipientKeyEnvelopeCommitResponseV1> {
    validateEnvelopeInputs(input.recipientKeyEnvelopes);
    const access = await resolveWorkflowRunAccessInTx(tx, input);
    if (!access) throw new WorkflowRunAccessError("run_not_found");
    await acquireWorkflowPublicationLocksInTx(tx, { accountId: access.ownerAccountId, runIds: [input.runId] });
    const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, access.ownerAccountId, "content");
    if (fence.status !== "ready") throw new WorkflowRunAccessError("content_unavailable");
    const census = await readWorkflowRunKeyProjectionInTx(tx, input);
    if (census.encryptionMode === "plain") throw new WorkflowRunAccessError("data_key_not_required");
    if (!census.callerDataEncryptionKey || !census.dataEncryptionKey) throw new WorkflowRunAccessError("content_unavailable");
    if (!isDeepStrictEqual(privacyKit.decodeBase64(census.dataEncryptionKey), privacyKit.decodeBase64(input.expectedDataEncryptionKey))) throw new WorkflowRunAccessError("currentness_conflict");
    const row = await readRunFactsInTx(tx, input.runId);
    if (!row) throw new WorkflowRunAccessError("run_not_found");
    // Preparation cannot replace the owner token; Account transitions own key replacement.
    const envelopes = input.recipientKeyEnvelopes.filter(envelope => envelope.recipientAccountId !== row.accountId);
    const result = await applyPreparedEnvelopesInTx(tx, { row, runId: input.runId, recipientKeyEnvelopes: envelopes });
    await markAccountsChanged(tx, { accountIds: result.appliedRecipientAccountIds, kind: "account", entityId: `workflow-run:${input.runId}` });
    return { ...result, skippedRecipientAccountIds: [...result.skippedRecipientAccountIds,
        ...input.recipientKeyEnvelopes.filter(envelope => envelope.recipientAccountId === row.accountId).map(envelope => envelope.recipientAccountId)] };
}

/** The existing Account transition atomically replaces keys beside re-sealed Run content. */
export async function replaceWorkflowRunKeyEnvelopesInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; runId: string; encryptionMode: "plain" | "e2ee";
    expectedDataEncryptionKey?: string | null; recipientKeyEnvelopes: readonly WorkflowRunRecipientKeyEnvelopeV1[];
    ownerContentPublicKeyFingerprint?: string;
}>): Promise<void> {
    validateEnvelopeInputs(input.recipientKeyEnvelopes);
    const row = await readRunFactsInTx(tx, input.runId);
    if (!row || row.accountId !== input.actorAccountId) throw new WorkflowRunAccessError("currentness_conflict");
    const owner = await tx.workflowRunDataKeyEnvelope.findUnique({ where: { runId_recipientAccountId: { runId: input.runId, recipientAccountId: row.accountId } } });
    const sourceMode = resolveEffectiveAccountEncryptionModeFromAccountRow(row.account);
    if (sourceMode.status !== "ready" || sourceMode.mode === "e2ee" && !owner) throw new WorkflowRunAccessError("content_unavailable");
    if (owner ? input.expectedDataEncryptionKey == null || !isDeepStrictEqual(new Uint8Array(owner.encryptedDataKey), privacyKit.decodeBase64(input.expectedDataEncryptionKey)) : input.expectedDataEncryptionKey != null) {
        throw new WorkflowRunAccessError("currentness_conflict");
    }
    if (input.encryptionMode === "plain" && input.recipientKeyEnvelopes.length > 0) throw new WorkflowRunAccessError("data_key_not_required");
    if (input.encryptionMode === "e2ee" && !input.recipientKeyEnvelopes.some(envelope => envelope.recipientAccountId === row.accountId)) throw new WorkflowRunAccessError("content_unavailable");
    await tx.workflowRunDataKeyEnvelope.deleteMany({ where: { runId: input.runId } });
    if (input.encryptionMode === "e2ee") {
        const applied = await applyPreparedEnvelopesInTx(tx, { row, runId: input.runId,
            recipientKeyEnvelopes: input.recipientKeyEnvelopes, ownerContentPublicKeyFingerprint: input.ownerContentPublicKeyFingerprint });
        if (!applied.appliedRecipientAccountIds.includes(row.accountId)) throw new WorkflowRunAccessError("content_unavailable");
    }
}
