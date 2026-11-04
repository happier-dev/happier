import type { RunnerArtifactPublicationFailureV1 } from '@happier-dev/protocol/ephemeralRunner/errors';
import { randomUUID } from 'node:crypto';
import {
    RunnerActivationBindingV1Schema,
    RunnerActivationCreateRequestV1Schema,
    type RunnerActivationBindingV1,
    type RunnerActivationCreateRequestV1,
} from '@happier-dev/protocol/ephemeralRunner/activation';
import { RunnerActivationProjectionV1Schema, type RunnerActivationProjectionV1 } from '@happier-dev/protocol/ephemeralRunner/projection';
import { AuthTokenAuthenticationEvidenceSnapshotV1Schema } from '@happier-dev/protocol/auth/authToken';
import { isStoredJsonContentEnvelopeModeCompatible } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { verifyRunnerEndpointFactsV1 } from '@happier-dev/protocol/ephemeralRunner/endpoint';
import { acquireSessionDraftLockInTx, readSessionDraftInTx } from '@/app/account/sessionDrafts/sessionDraftService';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { acquireAccountSessionOwnerMetadataFenceInTx, AccountSessionOwnerMetadataFenceAccountNotFoundError } from '@/app/encryption/accountSessionOwnerMetadataFence';
import { inTx, type Tx } from '@/storage/inTx';
import { isPrismaErrorCode } from '@/storage/prisma';
import { acquireRunnerActivationLockInTx } from './activationLock';
import { closeEphemeralRunnerActivationInTx, PREMATERIALIZED_RUNNER_ACTIVATION_STATES } from './activationLifecycle';
import { readRunnerCreatorCurrentnessInTx, reconcileRunnerActivationCurrentnessInTx, type RunnerCreatorCurrentness } from './activationCurrentness';
import {
    resolveRunnerArtifactAvailability,
    type RunnerArtifactSourceOptions,
    type RunnerArtifactUnavailableReasonV1,
} from './runnerArtifactAvailability';
import { resolveCurrentAuthenticationEvidenceInTx } from '@/app/auth/authenticationEvidence';

export type EphemeralRunnerActivationProjection = RunnerActivationProjectionV1;
export type CreateEphemeralRunnerActivationResult =
    | Readonly<{ status: 'created'; activation: EphemeralRunnerActivationProjection }>
    | Readonly<{ status: 'artifact_unavailable'; reason: RunnerArtifactUnavailableReasonV1;
        publicationFailure?: RunnerArtifactPublicationFailureV1 }>
    | Readonly<{ status: 'invalid_request' | 'creator_unavailable' | 'draft_unavailable' | 'recipient_mismatch' | 'conflict' | 'authentication_evidence_unavailable' }>;

export type ActivationRow = NonNullable<Awaited<ReturnType<Tx['ephemeralRunnerActivation']['findUnique']>>>;

export function runnerActivationBinding(row: ActivationRow): RunnerActivationBindingV1 {
    return RunnerActivationBindingV1Schema.parse({
        activationId: row.id, homeServerIdentityId: row.homeServerIdentityId,
        creatorAccountId: row.creatorAccountId, creatorTokenEpoch: row.creatorTokenEpoch,
        activationExpiresAt: row.activationExpiresAt?.getTime() ?? null,
        workspace: { kind: row.workspacePolicy },
        sessionId: row.sessionId, machineId: row.machineId,
        activationSigningPublicKey: row.activationSigningPublicKey,
        authoringCommitment: row.authoringCommitment,
        artifact: row.artifact, endpointFactsRecipient: row.endpointFactsRecipient,
    });
}

export function projectRunnerActivation(row: ActivationRow, current: RunnerCreatorCurrentness): EphemeralRunnerActivationProjection {
    let endpointFacts: EphemeralRunnerActivationProjection['endpointFacts'] = null;
    if (row.endpointFacts !== null) {
        if (current.status !== 'ready') {
            endpointFacts = { status: 'unavailable', reason: current.status };
        } else if (!pluginJsonValuesEqual(current.endpointFactsRecipient, row.endpointFactsRecipient)) {
            endpointFacts = { status: 'unavailable', reason: 'recipient_mismatch' };
        } else {
            const facts = verifyRunnerEndpointFactsV1({ endpointFacts: row.endpointFacts, claim: row.claim, expectedBinding: runnerActivationBinding(row) });
            endpointFacts = facts && isStoredJsonContentEnvelopeModeCompatible(current.endpointFactsRecipient.mode, facts.payload.content)
                ? { status: 'available', facts }
                : { status: 'unavailable', reason: 'invalid_content' };
        }
    }
    return RunnerActivationProjectionV1Schema.parse({
        ...runnerActivationBinding(row),
        draftId: row.draftId,
        state: row.state,
        closeReason: row.closeReason,
        progressPhase: row.progressPhase,
        claim: row.claim,
        endpointFacts,
        review: row.review,
        consent: row.consent,
        readiness: row.readiness,
        materialization: row.state === "materialized"
            ? { sessionId: row.sessionId, machineId: row.machineId }
            : null,
    });
}

function matchesCreate(row: ActivationRow, request: RunnerActivationCreateRequestV1): boolean {
    return row.id === request.activationId && row.draftId === request.draftId
        && row.homeServerIdentityId === request.homeServerIdentityId
        && row.activationSigningPublicKey === request.activationSigningPublicKey
        && (row.activationExpiresAt?.getTime() ?? null) === request.activationExpiresAt
        && row.workspacePolicy === request.workspace.kind
        && row.authoringCommitment === request.authoringCommitment
        && pluginJsonValuesEqual(row.artifact, request.artifact)
        && pluginJsonValuesEqual(row.endpointFactsRecipient, request.endpointFactsRecipient)
        && (row.authenticationEvidence !== null) === (request.authorizeUnattendedTeamAccess === true);
}

/** Reserves final identities under the Account/draft fence, without runtime resources. */
export async function createEphemeralRunnerActivation(
    params: Readonly<{
        creatorAccountId: string;
        request: unknown;
        /** Credential context of the operation reading the creator's draft. */
        authentication: SessionAccessAuthentication;
    }>,
    options: Readonly<{ artifactSource?: RunnerArtifactSourceOptions; homeServerIdentityId: string }>,
): Promise<CreateEphemeralRunnerActivationResult> {
    const parsed = RunnerActivationCreateRequestV1Schema.safeParse(params.request);
    if (!parsed.success || parsed.data.homeServerIdentityId !== options.homeServerIdentityId) return { status: 'invalid_request' };
    const request = parsed.data;
    if (request.endpointFactsRecipient.creatorAccountId !== params.creatorAccountId) return { status: 'recipient_mismatch' };
    const artifact = await resolveRunnerArtifactAvailability(request.artifact, options.artifactSource);
    if (!artifact.ok) return { status: 'artifact_unavailable', reason: artifact.reason,
        ...(artifact.publicationFailure ? { publicationFailure: artifact.publicationFailure } : {}) };
    return await inTx(async (tx): Promise<CreateEphemeralRunnerActivationResult> => {
        // Missing Accounts cannot acquire the existing Account fence.
        if (!await tx.account.findUnique({ where: { id: params.creatorAccountId }, select: { id: true } })) return { status: 'creator_unavailable' };
        await acquireAccountSessionOwnerMetadataFenceInTx(tx, params.creatorAccountId, "content");
        const current = await readRunnerCreatorCurrentnessInTx(tx, params.creatorAccountId);
        if (current.status !== 'ready') return current;
        const recipient = request.endpointFactsRecipient;
        if (!pluginJsonValuesEqual(current.endpointFactsRecipient, recipient)) return { status: 'recipient_mismatch' };
        await acquireRunnerActivationLockInTx(tx, request.activationId);
        let existing = await tx.ephemeralRunnerActivation.findUnique({ where: { id: request.activationId } });
        if (!existing) {
            // No activation row was locked above. The existing draft is the
            // creation resource; cancellation also writes KV before Activation.
            if (!await acquireSessionDraftLockInTx(tx, {
                accountId: params.creatorAccountId, address: { kind: 'newSession', draftId: request.draftId },
            })) return { status: 'draft_unavailable' };
            await acquireRunnerActivationLockInTx(tx, request.activationId);
            existing = await tx.ephemeralRunnerActivation.findUnique({ where: { id: request.activationId } });
        }
        if (existing) {
            return existing.creatorAccountId === params.creatorAccountId && existing.creatorTokenEpoch === current.creatorTokenEpoch && matchesCreate(existing, request)
                ? { status: 'created', activation: projectRunnerActivation(await reconcileRunnerActivationCurrentnessInTx(tx, existing, current), current) }
                : { status: 'conflict' };
        }
        if (request.activationExpiresAt !== null && request.activationExpiresAt <= Date.now()) return { status: 'invalid_request' };
        const authenticationEvidence = request.authorizeUnattendedTeamAccess === true
            && params.authentication.authority === 'present_user'
            ? await resolveCurrentAuthenticationEvidenceInTx(tx, {
                env: params.authentication.env,
                accountId: params.creatorAccountId,
                evidence: params.authentication.authenticationEvidence,
            })
            : [];
        if (request.authorizeUnattendedTeamAccess === true && authenticationEvidence.length === 0) {
            return { status: 'authentication_evidence_unavailable' };
        }
        const authenticationEvidenceSnapshot = authenticationEvidence.length > 0
            ? AuthTokenAuthenticationEvidenceSnapshotV1Schema.parse({ v: 1, evidence: authenticationEvidence })
            : null;
        const draft = await readSessionDraftInTx(tx, {
            accountId: params.creatorAccountId,
            address: { kind: 'newSession', draftId: request.draftId },
            authentication: params.authentication,
        });
        if (draft.status !== 'present') return { status: 'draft_unavailable' };
        const attachedIdentity = await tx.ephemeralRunnerActivation.findFirst({ where: {
            creatorAccountId: params.creatorAccountId, draftId: request.draftId, state: { in: PREMATERIALIZED_RUNNER_ACTIVATION_STATES },
        }, select: { id: true } });
        if (attachedIdentity) await acquireRunnerActivationLockInTx(tx, attachedIdentity.id);
        const attached = attachedIdentity
            ? await tx.ephemeralRunnerActivation.findUnique({ where: { id: attachedIdentity.id } })
            : null;
        if (attached && (await reconcileRunnerActivationCurrentnessInTx(tx, attached, current)).state !== 'closed') return { status: 'conflict' };
        const row = await tx.ephemeralRunnerActivation.create({ data: {
            id: request.activationId, creatorAccountId: params.creatorAccountId, creatorTokenEpoch: current.creatorTokenEpoch,
            draftId: request.draftId, sessionId: randomUUID(), machineId: randomUUID(), state: 'pending',
            activationExpiresAt: request.activationExpiresAt === null ? null : new Date(request.activationExpiresAt),
            workspacePolicy: request.workspace.kind,
            homeServerIdentityId: request.homeServerIdentityId, activationSigningPublicKey: request.activationSigningPublicKey,
            authoringCommitment: request.authoringCommitment, artifact: request.artifact, endpointFactsRecipient: recipient,
            authenticationEvidence: authenticationEvidenceSnapshot,
        } });
        return { status: 'created', activation: projectRunnerActivation(row, current) };
    }).catch((error: unknown): CreateEphemeralRunnerActivationResult => {
        // Different drafts may race for one submitted activation identity.
        // PostgreSQL must roll back its failed insert before returning conflict.
        if (isPrismaErrorCode(error, 'P2002')) return { status: 'conflict' };
        throw error;
    });
}

/** Exact creator-owned recovery; no listing or runtime state projection. */
export async function readEphemeralRunnerActivation(params: Readonly<{ creatorAccountId: string; activationId: string }>): Promise<EphemeralRunnerActivationProjection | null> {
    return await readCreatorActivation(params.creatorAccountId, { id: params.activationId });
}

/** Recovers the one waiting attempt even when an opaque draft rewrite dropped its reference. */
export async function readDraftEphemeralRunnerActivation(params: Readonly<{ creatorAccountId: string; draftId: string }>): Promise<EphemeralRunnerActivationProjection | null> {
    return await readCreatorActivation(params.creatorAccountId, { draftId: params.draftId });
}

async function readCreatorActivation(creatorAccountId: string, identity: { id: string } | { draftId: string }): Promise<EphemeralRunnerActivationProjection | null> {
    return await inTx(async (tx) => {
        try {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, creatorAccountId, "content");
        } catch (error) {
            if (error instanceof AccountSessionOwnerMetadataFenceAccountNotFoundError) return null;
            throw error;
        }
        const initial = await tx.ephemeralRunnerActivation.findFirst({ where: {
            creatorAccountId, ...identity,
            ...('draftId' in identity ? { state: { in: PREMATERIALIZED_RUNNER_ACTIVATION_STATES } } : {}),
        }, select: { id: true } });
        if (!initial) return null;
        await acquireRunnerActivationLockInTx(tx, initial.id);
        const row = await tx.ephemeralRunnerActivation.findFirst({ where: {
            id: initial.id, creatorAccountId,
            ...('draftId' in identity ? { state: { in: PREMATERIALIZED_RUNNER_ACTIVATION_STATES } } : {}),
        } });
        if (!row) return null;
        const current = await readRunnerCreatorCurrentnessInTx(tx, creatorAccountId);
        return projectRunnerActivation(await reconcileRunnerActivationCurrentnessInTx(tx, row, current), current);
    });
}

/** Closes only the exact creator-owned pre-Session attempt; the draft and runtime remain independently owned. */
export async function cancelEphemeralRunnerActivation(params: Readonly<{ creatorAccountId: string; activationId: string }>): Promise<EphemeralRunnerActivationProjection | null> {
    return await inTx(async (tx) => {
        try {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, params.creatorAccountId, "content");
        } catch (error) {
            if (error instanceof AccountSessionOwnerMetadataFenceAccountNotFoundError) return null;
            throw error;
        }
        await closeEphemeralRunnerActivationInTx(tx, { ...params, reason: 'canceled' });
        const current = await tx.ephemeralRunnerActivation.findFirst({ where: { id: params.activationId, creatorAccountId: params.creatorAccountId } });
        // A materialized winner or an earlier close is returned truthfully, never recast as cancellation.
        return current ? projectRunnerActivation(current, await readRunnerCreatorCurrentnessInTx(tx, params.creatorAccountId)) : null;
    });
}
