import { isDeepStrictEqual } from "node:util";
import * as privacyKit from "privacy-kit";
import { parseEncryptedDataKeyEnvelopeV1, projectAutomationAccountCurrentnessWitnessV1, resolveWorkflowRunVisibleTeamV1 } from "@happier-dev/protocol";
import type {
    WorkflowRunRecipientCensusInputV1, WorkflowRunRecipientCensusResponseV1,
    WorkflowRunRecipientKeyEnvelopeV1, WorkflowRunRecipientKeyEnvelopeCommitInputV1,
    WorkflowRunRecipientKeyEnvelopeCommitResponseV1,
} from "@happier-dev/protocol/workflows";
import type { Tx } from "@/storage/inTx";
import { resolveArtifactAccessInTx, resolveArtifactAudienceInTx } from "@/app/artifacts/artifactAccessService";
import { resolveTeamMembershipContextInTx } from "@/app/teams/memberships/effectiveMembership";
import { readTeamSummaryForActorInTx } from "@/app/teams/lifecycle";
import type { TeamOperationAuthenticationContext } from "@/app/teams/actorContext";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import { acquireAccountEncryptionTransitionFenceInTx, deriveAccountEncryptionMigrationKeyFingerprints } from "@/app/encryption/accountEncryptionTransition";
import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { deriveAccountRecipientEnvelopeReadinessFromRow } from "@/app/encryption/accountRecipientEnvelopeReadiness";
import { projectRecipientContentKey, RECIPIENT_READINESS_SELECT } from "@/app/session/encryption/sessionDataKeyRecipientProjection";
import { markAccountChanged } from "@/app/changes/markAccountChanged";

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
const runFactsSelect = {
    accountId: true, sourceArtifactId: true, visibleTeamId: true, workflowAcceptedSnapshotEnvelope: true,
    workflowCustodyState: true, account: { select: { encryptionMode: true } },
} as const;
async function readRunFactsInTx(tx: Tx, runId: string) {
    return tx.automationRun.findUnique({ where: { id: runId }, select: runFactsSelect });
}
type RunFacts = NonNullable<Awaited<ReturnType<typeof readRunFactsInTx>>>;

async function isLiveTeamMemberInTx(tx: Tx, teamId: string, accountId: string): Promise<boolean> {
    const member = await tx.teamMembership.findUnique({ where: { teamId_accountId: { teamId, accountId } }, select: { id: true } });
    if (!member) return false;
    const resolved = await resolveTeamMembershipContextInTx(tx, { teamId, teamMembershipId: member.id, expectedAccountId: accountId });
    return resolved.ok && resolved.membership.effective;
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
    actorAccountId: string; sourceArtifactIds: readonly string[];
}>): Promise<ReadonlyArray<Readonly<{ sourceArtifactId: string; visibleTeamIds: readonly string[] }>>> {
    const memberships = await tx.teamMembership.findMany({ where: { accountId: input.actorAccountId }, select: { teamId: true } });
    const liveTeamIds: string[] = [];
    for (const membership of memberships) {
        if (await isLiveTeamMemberInTx(tx, membership.teamId, input.actorAccountId)) liveTeamIds.push(membership.teamId);
    }
    const scopes: Array<{ sourceArtifactId: string; visibleTeamIds: string[] }> = [];
    for (const sourceArtifactId of input.sourceArtifactIds) {
        const access = await resolveArtifactAccessInTx(tx, { actorAccountId: input.actorAccountId, artifactId: sourceArtifactId });
        if (access) scopes.push({ sourceArtifactId, visibleTeamIds: await readGrantedTeamIdsInTx(tx, sourceArtifactId, liveTeamIds) });
    }
    return scopes;
}
async function accessFromFactsInTx(tx: Tx, row: RunFacts, actorAccountId: string): Promise<WorkflowRunAccess | null> {
    if (row.workflowCustodyState === null) return null;
    const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(row.account);
    const common = { ownerAccountId: row.accountId, encryptionMode: mode.status === "ready" ? mode.mode : null, visibleTeamId: row.visibleTeamId };
    if (row.accountId === actorAccountId) return { ...common, level: "owner" };
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

async function audienceFromFactsInTx(tx: Tx, row: RunFacts): Promise<string[]> {
    if (!row.sourceArtifactId || !row.visibleTeamId) return [row.accountId];
    if ((await readGrantedTeamIdsInTx(tx, row.sourceArtifactId, [row.visibleTeamId])).length === 0) return [row.accountId];
    const candidates = await resolveArtifactAudienceInTx(tx, row.sourceArtifactId);
    const recipients = [row.accountId];
    for (const accountId of candidates) {
        if (accountId !== row.accountId && await isLiveTeamMemberInTx(tx, row.visibleTeamId, accountId)) recipients.push(accountId);
    }
    return recipients.sort();
}
/** Key preparation and wake fan-out use the same live Run audience. */
export async function resolveWorkflowRunRecipientAccountIdsInTx(tx: Tx, runId: string): Promise<string[]> {
    const row = await readRunFactsInTx(tx, runId);
    return row && row.workflowCustodyState !== null ? audienceFromFactsInTx(tx, row) : [];
}

async function projectKeysInTx(tx: Tx, input: Readonly<{ actorAccountId: string; runId: string }>, row: RunFacts, access: WorkflowRunAccess): Promise<WorkflowRunRecipientCensusResponseV1> {
    // A read projects a witness; only mutations acquire the Account writer fence.
    const account = await tx.account.findUnique({ where: { id: access.ownerAccountId }, select: {
        seq: true, encryptionMode: true, publicKey: true, contentPublicKey: true, contentPublicKeySig: true,
    } });
    if (!account) throw new WorkflowRunAccessError("content_unavailable");
    const currentness = deriveAccountEncryptionCurrentnessFromRow(account);
    if (currentness.status !== "ready") throw new WorkflowRunAccessError("content_unavailable");
    const ownerAccountCurrentness = projectAutomationAccountCurrentnessWitnessV1({ mode: currentness.currentness.encryptionMode,
        version: account.seq, contentKeyFingerprint: deriveAccountEncryptionMigrationKeyFingerprints(account).contentKeyFingerprint });
    if (!ownerAccountCurrentness) throw new WorkflowRunAccessError("content_unavailable");
    const audience = await audienceFromFactsInTx(tx, row);
    const [accounts, envelopes] = await Promise.all([
        tx.account.findMany({ where: { id: { in: audience } }, select: RECIPIENT_READINESS_SELECT, orderBy: { id: "asc" } }),
        tx.workflowRunDataKeyEnvelope.findMany({ where: { runId: input.runId } }),
    ]);
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

/** Authorized reads retain missing/stale keys as a truthful locked projection. */
export async function readWorkflowRunKeyProjectionInTx(tx: Tx, input: Readonly<{ actorAccountId: string; runId: string }>): Promise<WorkflowRunRecipientCensusResponseV1> {
    const row = await readRunFactsInTx(tx, input.runId);
    const access = row ? await accessFromFactsInTx(tx, row, input.actorAccountId) : null;
    if (!row || !access) throw new WorkflowRunAccessError("run_not_found");
    return projectKeysInTx(tx, input, row, access);
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
    const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, access.ownerAccountId);
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
    for (const accountId of result.appliedRecipientAccountIds) await markAccountChanged(tx, { accountId, kind: "account", entityId: `workflow-run:${input.runId}` });
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
