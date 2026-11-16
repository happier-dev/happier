import { decodeMachineStoredContent, decodeSessionStoredContent } from '@/storage/sessionMachineStoredContent';
import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { isPlainMachineDataKeyMarker } from '@happier-dev/protocol/machines/machineStoredContent';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { RunnerClaimV1Schema } from "@happier-dev/protocol/ephemeralRunner/endpoint";
import {
    RunnerMaterializationRequestV1Schema,
    type RunnerMaterializationRequestV1,
    type RunnerMaterializationResponseV1,
    type RunnerMaterializationResultV1,
} from "@happier-dev/protocol/ephemeralRunner/materialization";
import {
    verifyRunnerMachineContentKeyBindingV1,
} from "@happier-dev/protocol/ephemeralRunner/machineContentKeyBinding";
import { RunnerActivationReviewV1Schema } from "@happier-dev/protocol/ephemeralRunner/review";
import { z } from "zod/mini";

import { createSessionMachineAccessKeyInTx } from "@/app/accessKeys/sessionMachineAccessKeyMutations";
import { readSessionDraftInTx } from "@/app/account/sessionDrafts/sessionDraftService";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { acquireRunnerActivationLockInTx } from './activationLock';
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { validateMachineInstallationProof } from "@/app/machines/installationProof";
import { createMachineWithInstallationIdentityInTx } from "@/app/machines/machineMutations";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { classifyLayout1SessionCreateThrow, createFreshBoundLayout1SessionInTx } from "@/app/session/create/createFreshBoundLayout1Session";
import { prepareLayout1SessionCreatePublicationAdmission } from '@/app/session/create/sessionCreationPublicationAudience';
import {
    prepareLayout1SessionCreate,
    type FreshBoundLayout1SessionCreateRejection,
} from "@/app/session/create/prepareLayout1SessionCreate";
import { inTx } from "@/storage/inTx";
import { readRunnerBrokerReadinessProjectionInTx } from "@/app/teams/credentials/runnerBrokerReadinessAuthorization";
import {
    readRunnerCreatorCurrentnessInTx,
    reconcileRunnerActivationCurrentnessInTx,
} from "./activationCurrentness";
import {
    verifyRunnerBrokerReadinessCurrentnessInTx,
    verifyRunnerReadinessForActivation,
} from "./runnerBrokerReadinessVerification";
import { readRunnerActivationAuthentication } from "./activationAuthentication";

export type MaterializeEphemeralRunnerResult =
    | RunnerMaterializationResponseV1
    | Readonly<{ status: "invalid_request" }>;

class RunnerMaterializationRollback extends Error {
    constructor(readonly result: MaterializeEphemeralRunnerResult) {
        super(result.status);
        this.name = "RunnerMaterializationRollback";
    }
}

function exactResult(row: Readonly<{ id: string; sessionId: string; machineId: string }>): RunnerMaterializationResultV1 {
    return { v: 1, activationId: row.id, sessionId: row.sessionId, machineId: row.machineId };
}

function projectSessionCreateRejection(
    rejection: FreshBoundLayout1SessionCreateRejection,
): Exclude<RunnerMaterializationResponseV1, { status: "materialized" }> {
    if (rejection.reason === "session-id-taken" || rejection.reason === "session-tag-taken") {
        return { status: "conflict", reason: "identity_taken" };
    }
    if (rejection.reason === "account-disabled") {
        return { status: "unavailable", reason: "creator_unavailable" };
    }
    if (rejection.reason === "encryption-mode-not-allowed" || rejection.reason === "privacy-upgrade-required") {
        return { status: "conflict", reason: "encryption_mismatch" };
    }
    if (
        rejection.reason === "invalid-organization-placement"
        || rejection.reason === "invalid-params"
        || rejection.reason === "session-initial-access-invalid"
        || rejection.reason === "team-credential-binding-invalid"
    ) {
        return { status: "conflict", reason: "session_create_rejected" };
    }
    return { status: "conflict", reason: "binding_mismatch" };
}

const StoredRunnerBootstrapV1Schema = z.strictObject({
    v: z.literal(1),
    content: z.string().check(z.minLength(1), z.maxLength(1024 * 1024)),
    requestDigest: z.string().check(z.minLength(1)),
});

type StoredRunnerBootstrapV1 = z.infer<typeof StoredRunnerBootstrapV1Schema>;

function materializationRequestDigest(request: RunnerMaterializationRequestV1): string {
    return computeCanonicalDomainSeparatedDigest(
        "happier.ephemeral-session-runner.materialization-request.v1",
        [createCanonicalJsonSigningInput(request)],
    );
}

function storedRunnerBootstrap(request: RunnerMaterializationRequestV1): StoredRunnerBootstrapV1 {
    return {
        v: 1,
        content: request.sealedBootstrap,
        requestDigest: materializationRequestDigest(request),
    };
}

/**
 * Reads the materialized endpoint bootstrap from the activation-owned record.
 * The digest binds exact materialization replay without introducing another
 * receipt, table or idempotency identity.
 */
export function readStoredRunnerBootstrap(value: unknown): StoredRunnerBootstrapV1 | null {
    const parsed = StoredRunnerBootstrapV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

/**
 * Composes the canonical Session, Machine and AccessKey owners in one transaction.
 * Live Agent/broker reachability is deliberately established by the caller before
 * this durable boundary and is never probed while database locks are held.
 */
export async function materializeEphemeralRunner(params: Readonly<{
    creatorAccountId: string;
    request: unknown;
    authentication: SessionAccessAuthentication;
    env: NodeJS.ProcessEnv;
}>): Promise<MaterializeEphemeralRunnerResult> {
    const parsed = RunnerMaterializationRequestV1Schema.safeParse(params.request);
    if (!parsed.success) return { status: "invalid_request" };
    const request = parsed.data;
    const bootstrap = storedRunnerBootstrap(request);
    try {
        return await inTx(async (tx): Promise<MaterializeEphemeralRunnerResult> => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, params.creatorAccountId, "content");
            await acquireRunnerActivationLockInTx(tx, request.activationId);
            const initial = await tx.ephemeralRunnerActivation.findFirst({
                where: { id: request.activationId, creatorAccountId: params.creatorAccountId },
            });
            if (!initial) return { status: "unavailable", reason: "creator_unavailable" };
            const current = await readRunnerCreatorCurrentnessInTx(tx, initial.creatorAccountId);
            const row = await reconcileRunnerActivationCurrentnessInTx(tx, initial, current);
            if (row.state === "closed") {
                return {
                    status: "unavailable",
                    reason: row.closeReason === "expired" ? "activation_expired" : "activation_closed",
                };
            }
            if (current.status !== "ready") return { status: "unavailable", reason: "creator_unavailable" };

            const storedReview = row.review === null
                ? null
                : RunnerActivationReviewV1Schema.safeParse(row.review);
            if (storedReview !== null
                && (!storedReview.success || storedReview.data.authoringCommitment !== row.authoringCommitment)) {
                return { status: "conflict", reason: "manifest_mismatch" };
            }

            if (row.state === "materialized") {
                const [session, machine, accessKey] = await Promise.all([
                    tx.session.findFirst({ where: { id: row.sessionId, accountId: row.creatorAccountId } }).then(decodeSessionStoredContent),
                    tx.machine.findFirst({ where: { id: row.machineId, accountId: row.creatorAccountId, kind: "ephemeral_session_runner" } }).then(decodeMachineStoredContent),
                    tx.accessKey.findUnique({ where: { accountId_machineId_sessionId: {
                        accountId: row.creatorAccountId, machineId: row.machineId, sessionId: row.sessionId,
                    } } }),
                ]);
                const persistedBootstrap = readStoredRunnerBootstrap(row.sealedBootstrap);
                const exact = session !== null && machine !== null && accessKey !== null
                    && accessKey.data === request.accessKeyData
                    && pluginJsonValuesEqual(row.consent, request.consent)
                    && pluginJsonValuesEqual(row.readiness, request.readiness)
                    && persistedBootstrap?.requestDigest === bootstrap.requestDigest;
                return exact
                    ? { status: "materialized", result: exactResult(row) }
                    : { status: "conflict", reason: "binding_mismatch" };
            }
            if (storedReview === null || row.claim === null) return { status: "unavailable", reason: "consent_required" };
            if (row.consent === null || !pluginJsonValuesEqual(row.consent, request.consent)) {
                return { status: "unavailable", reason: "consent_required" };
            }
            if (row.readiness === null || !pluginJsonValuesEqual(row.readiness, request.readiness)) {
                return { status: "unavailable", reason: "readiness_required" };
            }
            if (!storedReview.success) return { status: "conflict", reason: "manifest_mismatch" };
            const review = storedReview.data;
            if (request.launchManifestCommitment !== review.launchManifestCommitment
                || request.consent.payload.launchManifestCommitment !== review.launchManifestCommitment
                || request.readiness.payload.launchManifestCommitment !== review.launchManifestCommitment) {
                return { status: "conflict", reason: "manifest_mismatch" };
            }
            if (!pluginJsonValuesEqual(
                request.machine.runnerContentKeyBinding,
                review.machineContentKeyBinding,
            )) {
                return { status: "conflict", reason: "encryption_mismatch" };
            }

            const verifiedReadiness = verifyRunnerReadinessForActivation(row, request.readiness);
            if (!verifiedReadiness) return { status: "unavailable", reason: "readiness_required" };

            // The endpoint proves non-inference readiness before this transaction,
            // while the canonical Lane 10 owner revalidates every durable fact at
            // the effect boundary. Retaining the exact dual-signed request inside
            // the readiness proof lets this check reject stale resources, grants,
            // sources, Machines and endpoint identities without another receipt or
            // a network call while database locks are held.
            const brokerRequest = verifiedReadiness.payload.brokerReadinessRequest;
            const verifiedBroker = await verifyRunnerBrokerReadinessCurrentnessInTx(tx, {
                activationId: row.id,
                request: brokerRequest,
            });
            if (!verifiedBroker
                || verifiedBroker.creatorAccountId !== row.creatorAccountId
                || verifiedBroker.resourceId !== review.credentialSelectionBinding.resourceId
                || verifiedBroker.brokerMachineId !== review.credentialSelectionBinding.brokerMachineId
                || verifiedBroker.resourceRevision !== review.credentialSelectionBinding.revision
                || brokerRequest.agentTargetKey !== review.agentTargetKey
                || !pluginJsonValuesEqual(
                    request.readiness.payload.credentialSelectionBinding,
                    review.credentialSelectionBinding,
                )) {
                return { status: "unavailable", reason: "readiness_required" };
            }
            const currentBroker = await readRunnerBrokerReadinessProjectionInTx(tx, {
                activationId: row.id,
                selection: review.credentialSelectionBinding,
                env: params.env,
            });
            if (!currentBroker
                || currentBroker.readiness.kind !== "available"
                || !pluginJsonValuesEqual(
                    currentBroker.credentialSelectionBinding,
                    review.credentialSelectionBinding,
                )
                || brokerRequest.target.machineId !== currentBroker.credentialSelectionBinding.brokerMachineId
                || brokerRequest.target.endpointId !== currentBroker.target.endpointId) {
                return { status: "unavailable", reason: "readiness_required" };
            }

            const draft = await readSessionDraftInTx(tx, {
                accountId: row.creatorAccountId,
                address: { kind: "newSession", draftId: row.draftId },
                authentication: params.authentication,
            });
            if (draft.status !== "present") return { status: "unavailable", reason: "creator_unavailable" };

            const policy = readEncryptionFeatureEnv(params.env);
            const prepared = prepareLayout1SessionCreate({
                accountId: row.creatorAccountId,
                tag: request.session.tag,
                metadata: request.session.metadata,
                ownerMetadata: request.session.ownerMetadata,
                displayProjectionV1: request.session.displayProjectionV1,
                agentState: request.session.agentState,
                dataEncryptionKey: request.session.dataEncryptionKey,
                requestedEncryptionMode: request.session.requestedEncryptionMode,
                requestedStorageState: request.session.requestedStorageState,
                organizationPlacement: request.session.organizationPlacement,
                initialAccess: request.session.initialAccess,
                primaryTeamId: request.session.primaryTeamId,
                teamCredentialBindings: request.session.teamCredentialBindings,
                accountEncryptionMode: current.endpointFactsRecipient.mode,
                storagePolicy: policy.storagePolicy,
                defaultAccountMode: policy.defaultAccountMode,
            });
            if (!prepared.ok) return projectSessionCreateRejection(prepared.rejection);

            const claim = RunnerClaimV1Schema.safeParse(row.claim);
            if (!claim.success) return { status: "conflict", reason: "binding_mismatch" };
            const installation = validateMachineInstallationProof({
                accountId: row.creatorAccountId,
                machineId: row.machineId,
                installationId: claim.data.payload.installation.installationId,
                installationPublicKey: claim.data.payload.installation.publicKey,
                installationProof: claim.data.payload.installation.proof,
                replacesMachineId: null,
                replacementReason: null,
                contentPublicKeyFingerprint: null,
            });
            if (!installation.ok || installation.identity === null) return { status: "conflict", reason: "encryption_mismatch" };

            if (current.endpointFactsRecipient.mode === "plain") {
                if (!isPlainMachineDataKeyMarker(request.machine.dataEncryptionKey)
                    || request.machine.runnerContentKeyBinding !== null) {
                    return { status: "conflict", reason: "encryption_mismatch" };
                }
            } else {
                const binding = request.machine.runnerContentKeyBinding;
                if (binding === null || isPlainMachineDataKeyMarker(request.machine.dataEncryptionKey)) {
                    return { status: "conflict", reason: "encryption_mismatch" };
                }
                const verified = verifyRunnerMachineContentKeyBindingV1({
                    binding,
                    expectedPayload: {
                        v: 1,
                        purpose: "happier.ephemeral-runner.machine-content-key",
                        homeServerIdentityId: row.homeServerIdentityId,
                        activationId: row.id,
                        creatorAccountId: row.creatorAccountId,
                        machineId: row.machineId,
                        installationId: claim.data.payload.installation.installationId,
                        machineContentKeyFingerprint: binding.machineContentKeyFingerprint,
                    },
                    // The creator-generated activation signing identity is the
                    // proof root, so a DataKey or token-only creator needs no
                    // Account signing authority. The public half is the value
                    // this Home recorded when the creator created the
                    // activation, never a field of the submitted request.
                    expectedAccountSigningPublicKey: row.activationSigningPublicKey,
                });
                if (!verified) return { status: "conflict", reason: "encryption_mismatch" };
            }

            const session = await createFreshBoundLayout1SessionInTx(tx, {
                prepared: prepared.prepared,
                sessionId: row.sessionId,
                authentication: readRunnerActivationAuthentication(row, params.env),
            });
            if (session.kind !== "created") return projectSessionCreateRejection(session.rejection);

            await createMachineWithInstallationIdentityInTx(tx, {
                accountId: row.creatorAccountId,
                machineId: row.machineId,
                kind: "ephemeral_session_runner",
                metadata: request.machine.metadata,
                daemonState: null,
                dataEncryptionKey: request.machine.dataEncryptionKey,
                runnerContentKeyBinding: request.machine.runnerContentKeyBinding,
                installationIdentity: installation.identity,
                contentPublicKeyFingerprint: null,
                replacementReason: "machine_rotation",
            });
            const accessKey = await createSessionMachineAccessKeyInTx(tx, {
                accountId: row.creatorAccountId,
                machineId: row.machineId,
                sessionId: row.sessionId,
                data: request.accessKeyData,
            });
            if (!accessKey.ok) throw new RunnerMaterializationRollback({ status: "conflict", reason: "binding_mismatch" });

            const transitioned = await tx.ephemeralRunnerActivation.updateMany({
                where: { id: row.id, creatorAccountId: row.creatorAccountId, state: "consented" },
                data: { state: "materialized", sealedBootstrap: bootstrap },
            });
            if (transitioned.count !== 1) {
                throw new RunnerMaterializationRollback({ status: "conflict", reason: "binding_mismatch" });
            }
            return { status: "materialized", result: exactResult(row) };
        }, {
            // Session creation may publish initial grants to other Accounts.
            // Admit that complete audience before touching the activation row.
            prepare: () => prepareLayout1SessionCreatePublicationAdmission({
                accountId: params.creatorAccountId,
                tag: request.session.tag,
                initialAccess: request.session.initialAccess,
                primaryTeamId: request.session.primaryTeamId,
                teamCredentialBindings: request.session.teamCredentialBindings,
            }),
            // Materialization revalidates foreign Team/resource/broker facts outside the creator fence.
            isolationLevel: "Serializable",
        });
    } catch (error) {
        if (error instanceof RunnerMaterializationRollback) return error.result;
        // The shared constructor throws its domain refusals so the caller's own
        // transaction rolls back with the Session row; classifying them here is
        // what keeps a folder removed between review and submit from surfacing
        // as an unexpected 500 to the endpoint.
        const rejection = classifyLayout1SessionCreateThrow(error);
        if (rejection) return projectSessionCreateRejection(rejection);
        throw error;
    }
}
