import {
    RunnerActivationBindingV1Schema,
    type RunnerActivationBindingV1,
} from '@happier-dev/protocol/ephemeralRunner/activation';
import {
    RunnerActivationProjectionV1Schema,
    runnerActivationProjectionBindingV1,
    type RunnerActivationProjectionV1,
} from '@happier-dev/protocol/ephemeralRunner/projection';
import {
    RunnerEndpointFactsContentV1Schema,
    verifyRunnerEndpointFactsV1,
} from '@happier-dev/protocol/ephemeralRunner/endpoint';
import {
    RunnerLaunchManifestV1Schema,
    RunnerPreparedAuthoringV1Schema,
    computeRunnerAuthoringCommitmentV1,
    computeRunnerLaunchManifestCommitmentV1,
    deriveRunnerLaunchManifestAgentTargetKeyV1,
    type RunnerLaunchManifestV1,
    type RunnerPreparedAuthoringV1,
} from '@happier-dev/protocol/ephemeralRunner/launchManifest';
import {
    computeRunnerMachineContentKeyFingerprintV1,
    sealRunnerMachineContentKeyVerifierFactV1,
    signRunnerMachineContentKeyBindingV1,
} from '@happier-dev/protocol/ephemeralRunner/machineContentKeyBinding';
import {
    RunnerMaterializationRequestV1Schema,
    type RunnerMaterializationRequestV1,
} from '@happier-dev/protocol/ephemeralRunner/materialization';
import {
    RunnerRuntimeBootstrapV1Schema,
} from '@happier-dev/protocol/ephemeralRunner/bootstrap';
import {
    RunnerActivationReviewV1Schema,
    type RunnerActivationReviewV1,
    type RunnerCredentialSelectionBindingV1,
} from '@happier-dev/protocol/ephemeralRunner/review';
import { runnerArtifactTargetPlatform } from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';
import { verifyRunnerConsentV1 } from '@happier-dev/protocol/ephemeralRunner/consent';
import { verifyRunnerReadinessV1 } from '@happier-dev/protocol/ephemeralRunner/readiness';
import { createPlainSessionOwnerMetadataEnvelopeV1, createSessionOwnerMetadataV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { parseMachinePublishedMetadataV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { sealBoxBundle } from '@happier-dev/protocol/crypto/boxBundle';
import { UserRecipientEnvelopeResponseSchema } from '@happier-dev/protocol/social/friends';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { decryptBox } from '@/encryption/libsodium';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { randomUUID } from '@/platform/randomUUID';
import {
    isDataKeyAuthCredentials,
    isLegacyAuthCredentials,
    type AuthCredentials,
} from '@/auth/storage/tokenStorage';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import {
    openRunnerActivationKeyCustody,
    readRunnerActivationSigningKey,
} from './runnerActivationKeyCustody';
import { retainRunnerCreatorMachineContentKeyTrust } from './runnerCreatorMachineContentKeyTrust';
import type { Encryption } from '@/sync/encryption/encryption';
import type { MachineMetadata } from '@/sync/domains/state/storageTypes';
import { MetadataSchema, type Metadata, type AgentState } from '@happier-dev/session-core/state';
import type { RunnerActivationClient } from '@/sync/api/ephemeralRunner/runnerActivationClient';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { verifyRecipientContentPublicKeyBinding } from '@/sync/encryption/directShareEncryption';

export class RunnerMaterializationPreparationError extends Error {
    constructor(readonly code:
        | 'runner_activation_not_ready'
        | 'runner_activation_binding_mismatch'
        | 'runner_endpoint_facts_unavailable'
        | 'runner_account_encryption_mismatch'
        | 'runner_activation_signing_custody_unavailable'
        | 'runner_review_mismatch'
        | 'runner_session_metadata_unsupported'
        | 'session_access_request_failed'
        | 'session_access_subject_not_found'
        | 'recipient_key_unavailable'
        | 'session_access_invalid_recipient_envelope') {
        super(code);
        this.name = 'RunnerMaterializationPreparationError';
    }
}

export type RunnerReviewCustodyV1 = Readonly<{
    binding: RunnerActivationBindingV1;
    preparedAuthoring: RunnerPreparedAuthoringV1;
    launchManifest: RunnerLaunchManifestV1;
    /** Exact randomized sealed publication retained for lost-response replay. */
    review: RunnerActivationReviewV1;
    machineContentKey: Uint8Array | null;
}>;

function exactJson(a: unknown, b: unknown): boolean {
    return createCanonicalJsonSigningInput(a) === createCanonicalJsonSigningInput(b);
}

/**
 * A consented activation whose signed claim, published review, consent and
 * readiness are all present. The currentness check is the only producer, so
 * downstream materialization reads those exact facts without re-asserting them.
 */
export type ConsentedRunnerActivationProjectionV1 = Omit<
    RunnerActivationProjectionV1,
    'claim' | 'review' | 'consent' | 'readiness'
> & Readonly<{
    claim: NonNullable<RunnerActivationProjectionV1['claim']>;
    review: NonNullable<RunnerActivationProjectionV1['review']>;
    consent: NonNullable<RunnerActivationProjectionV1['consent']>;
    readiness: NonNullable<RunnerActivationProjectionV1['readiness']>;
}>;

/** Rechecks that retained reviewed custody still describes the exact current activation. */
export function assertRunnerMaterializationCurrentnessV1(input: Readonly<{
    projection: unknown;
    custody: RunnerReviewCustodyV1;
}>): ConsentedRunnerActivationProjectionV1 {
    const projection = RunnerActivationProjectionV1Schema.parse(input.projection);
    const { binding, preparedAuthoring, launchManifest, review } = input.custody;
    if ((projection.state !== 'consented' && projection.state !== 'materialized') || !projection.claim
        || !projection.review || !projection.consent || !projection.readiness
        || !exactJson(runnerActivationProjectionBindingV1(projection), binding)
        || !exactJson(projection.review, review)
        || projection.review.agentTargetKey !== deriveRunnerLaunchManifestAgentTargetKeyV1(launchManifest)
        || !exactJson(projection.review.credentialSelectionBinding, launchManifest.credentialSelectionBinding)
        || !exactJson(projection.review.displayFacts, launchManifest.displayFacts)
        || !exactJson(projection.review.machineContentKeyBinding, launchManifest.machineContentKeyBinding)
        || projection.review.launchManifestCommitment !== computeRunnerLaunchManifestCommitmentV1(launchManifest)
        || !exactJson(preparedAuthoring, launchManifest.preparedAuthoring)
        || !exactJson(projection.readiness.payload.installation.agentTarget, launchManifest.preparedAuthoring.authoring.agentTarget)
        || !exactJson(projection.readiness.payload.credentialSelectionBinding, projection.review.credentialSelectionBinding)
        || !verifyRunnerConsentV1({ consent: projection.consent, claim: projection.claim, expectedBinding: binding, expectedLaunchManifestCommitment: projection.review.launchManifestCommitment })
        || !verifyRunnerReadinessV1({ readiness: projection.readiness, claim: projection.claim, expectedBinding: binding, expectedLaunchManifestCommitment: projection.review.launchManifestCommitment })) {
        throw new RunnerMaterializationPreparationError('runner_review_mismatch');
    }
    return {
        ...projection,
        claim: projection.claim,
        review: projection.review,
        consent: projection.consent,
        readiness: projection.readiness,
    };
}

/**
 * Opens the creator's device-local activation signing key for this exact
 * activation.
 *
 * The creator generated this identity at package creation and retains it
 * through proof publication, so the Machine-content-key proof needs no Account
 * signing private key and a DataKey or token-only creator produces the same
 * binding. Custody whose public half does not match the published activation
 * identity is refused rather than used.
 */
async function openRunnerActivationSigningSecretKeyV1(
    binding: RunnerActivationBindingV1,
): Promise<Uint8Array> {
    const scope = createServerAccountScope(binding.homeServerIdentityId, binding.creatorAccountId);
    if (!scope) throw new RunnerMaterializationPreparationError('runner_activation_signing_custody_unavailable');
    try {
        const custody = await openRunnerActivationKeyCustody(scope, binding.activationId);
        if (custody.activationSigningPublicKey !== binding.activationSigningPublicKey) {
            throw new RunnerMaterializationPreparationError('runner_activation_signing_custody_unavailable');
        }
        return decodeBase64(await readRunnerActivationSigningKey(scope, custody), 'base64url');
    } catch (error) {
        if (error instanceof RunnerMaterializationPreparationError) throw error;
        throw new RunnerMaterializationPreparationError('runner_activation_signing_custody_unavailable');
    }
}

function openEndpointFacts(input: Readonly<{
    projection: ReturnType<typeof RunnerActivationProjectionV1Schema.parse>;
    encryption: Encryption | null;
}>) {
    const endpointFacts = input.projection.endpointFacts;
    if (endpointFacts?.status !== 'available' || !input.projection.claim) {
        throw new RunnerMaterializationPreparationError('runner_endpoint_facts_unavailable');
    }
    const verified = verifyRunnerEndpointFactsV1({
        endpointFacts: endpointFacts.facts,
        claim: input.projection.claim,
        expectedBinding: runnerActivationProjectionBindingV1(input.projection),
    });
    if (!verified) throw new RunnerMaterializationPreparationError('runner_endpoint_facts_unavailable');
    const content = verified.payload.content;
    if (content.t === 'plain') return RunnerEndpointFactsContentV1Schema.parse(content.v);
    if (!input.encryption) throw new RunnerMaterializationPreparationError('runner_account_encryption_mismatch');
    const opened = decryptBox(decodeBase64(content.c, 'base64url'), input.encryption.getContentPrivateKey());
    if (!opened) throw new RunnerMaterializationPreparationError('runner_endpoint_facts_unavailable');
    try {
        return RunnerEndpointFactsContentV1Schema.parse(JSON.parse(new TextDecoder().decode(opened)));
    } catch {
        throw new RunnerMaterializationPreparationError('runner_endpoint_facts_unavailable');
    }
}

/** Creates the exact manifest/key custody that must exist before endpoint review. */
export async function prepareRunnerActivationReviewV1(input: Readonly<{
    projection: unknown;
    expectedBinding: RunnerActivationBindingV1;
    preparedAuthoring: RunnerPreparedAuthoringV1;
    credentialSelectionBinding: RunnerCredentialSelectionBindingV1;
    reviewedProviderModel: RunnerLaunchManifestV1['reviewedProviderModel'];
    displayFacts: RunnerLaunchManifestV1['displayFacts'];
    connectedServiceReviewBindings: RunnerLaunchManifestV1['connectedServiceReviewBindings'];
    credentials: AuthCredentials;
    encryption: Encryption | null;
}>): Promise<Readonly<{ review: RunnerActivationReviewV1; custody: RunnerReviewCustodyV1 }>> {
    const projection = RunnerActivationProjectionV1Schema.parse(input.projection);
    const expectedBinding = RunnerActivationBindingV1Schema.parse(input.expectedBinding);
    const preparedAuthoring = RunnerPreparedAuthoringV1Schema.parse(input.preparedAuthoring);
    if (projection.state !== 'claimed' || !projection.claim
        || !exactJson(runnerActivationProjectionBindingV1(projection), expectedBinding)
        || computeRunnerAuthoringCommitmentV1(preparedAuthoring) !== expectedBinding.authoringCommitment) {
        throw new RunnerMaterializationPreparationError('runner_activation_binding_mismatch');
    }
    if (projection.endpointFacts?.status !== 'available') {
        throw new RunnerMaterializationPreparationError('runner_endpoint_facts_unavailable');
    }
    const endpointFacts = openEndpointFacts({ projection, encryption: input.encryption });
    let machineContentKey: Uint8Array | null = null;
    let machineContentKeyBinding: RunnerLaunchManifestV1['machineContentKeyBinding'] = null;
    if (expectedBinding.endpointFactsRecipient.mode === 'e2ee') {
        if (!input.encryption) throw new RunnerMaterializationPreparationError('runner_account_encryption_mismatch');
        if (encodeBase64(input.encryption.contentDataKey, 'base64url') !== expectedBinding.endpointFactsRecipient.contentPublicKey) {
            throw new RunnerMaterializationPreparationError('runner_account_encryption_mismatch');
        }
        const secretKey = await openRunnerActivationSigningSecretKeyV1(expectedBinding);
        try {
            machineContentKey = getRandomBytes(32);
            machineContentKeyBinding = signRunnerMachineContentKeyBindingV1({
                payload: {
                    v: 1,
                    purpose: 'happier.ephemeral-runner.machine-content-key',
                    homeServerIdentityId: expectedBinding.homeServerIdentityId,
                    activationId: expectedBinding.activationId,
                    creatorAccountId: expectedBinding.creatorAccountId,
                    machineId: expectedBinding.machineId,
                    installationId: projection.claim.payload.installation.installationId,
                    machineContentKeyFingerprint: computeRunnerMachineContentKeyFingerprintV1(machineContentKey),
                },
                activationSigningSecretKey: secretKey,
            });
            // The same non-secret verifier, kept twice for the two reader
            // classes: device-local for this creator, and Account-sealed for
            // every other authorized device or daemon of the same Account. The
            // Home relays the sealed blob but holds no material to forge it.
            machineContentKeyBinding = {
                ...machineContentKeyBinding,
                creatorVerifierFactCiphertext: sealRunnerMachineContentKeyVerifierFactV1({
                    payload: {
                        v: 1,
                        activationId: expectedBinding.activationId,
                        machineId: expectedBinding.machineId,
                        activationSigningPublicKey: expectedBinding.activationSigningPublicKey,
                    },
                    material: resolveAccountScopedCryptoMaterialFromCredentials(input.credentials),
                    randomBytes: getRandomBytes,
                }),
            };
            await retainRunnerCreatorMachineContentKeyTrust({
                scope: expectedBinding,
                machineId: expectedBinding.machineId,
                activationId: expectedBinding.activationId,
                activationSigningPublicKey: expectedBinding.activationSigningPublicKey,
            });
        } catch (error) {
            machineContentKey?.fill(0);
            throw error;
        } finally {
            secretKey.fill(0);
        }
    }
    const launchManifest = RunnerLaunchManifestV1Schema.parse({
        v: 1,
        purpose: 'happier.ephemeral-session-runner.launch-manifest',
        binding: expectedBinding,
        preparedAuthoring,
        authoringCommitment: expectedBinding.authoringCommitment,
        endpointFacts,
        machineContentKeyBinding,
        credentialSelectionBinding: input.credentialSelectionBinding,
        reviewedProviderModel: input.reviewedProviderModel,
        displayFacts: input.displayFacts,
        connectedServiceReviewBindings: input.connectedServiceReviewBindings,
    });
    const launchManifestCommitment = computeRunnerLaunchManifestCommitmentV1(launchManifest);
    const sealedLaunchManifest = encodeBase64(sealBoxBundle({
        plaintext: new TextEncoder().encode(JSON.stringify(launchManifest)),
        recipientPublicKey: decodeBase64(projection.claim.payload.runnerBoxPublicKey, 'base64url'),
        randomBytes: getRandomBytes,
    }), 'base64url');
    const review = RunnerActivationReviewV1Schema.parse({
        sealedLaunchManifest,
        authoringCommitment: expectedBinding.authoringCommitment,
        launchManifestCommitment,
        endpointFactsProof: {
            activationSignature: projection.endpointFacts.facts.activationSignature,
            installationSignature: projection.endpointFacts.facts.installationSignature,
        },
        agentTargetKey: deriveRunnerLaunchManifestAgentTargetKeyV1(launchManifest),
        machineContentKeyBinding: launchManifest.machineContentKeyBinding,
        credentialSelectionBinding: input.credentialSelectionBinding,
        displayFacts: input.displayFacts,
    });
    return { review, custody: { binding: expectedBinding, preparedAuthoring, launchManifest, review, machineContentKey } };
}

export async function prepareAndStoreRunnerActivationReviewV1(input: Parameters<typeof prepareRunnerActivationReviewV1>[0] & Readonly<{
    client: RunnerActivationClient;
    readRetainedCustody?: () => Promise<RunnerReviewCustodyV1 | null>;
    retainPreparedCustody?: (custody: RunnerReviewCustodyV1) => Promise<void>;
}>): Promise<Readonly<{ review: RunnerActivationReviewV1; custody: RunnerReviewCustodyV1 }>> {
    const candidate = await input.readRetainedCustody?.() ?? null;
    const projection = RunnerActivationProjectionV1Schema.parse(input.projection);
    const retained = candidate !== null
        && projection.state === 'claimed'
        && projection.claim !== null
        && projection.endpointFacts?.status === 'available'
        && exactJson(candidate.binding, input.expectedBinding)
        && exactJson(candidate.preparedAuthoring, input.preparedAuthoring)
        && exactJson(candidate.review.credentialSelectionBinding, input.credentialSelectionBinding)
        && exactJson(candidate.review.displayFacts, input.displayFacts)
        && exactJson(candidate.launchManifest.reviewedProviderModel, input.reviewedProviderModel)
        && exactJson(candidate.launchManifest.connectedServiceReviewBindings, input.connectedServiceReviewBindings)
        && exactJson(candidate.review.endpointFactsProof, {
            activationSignature: projection.endpointFacts.facts.activationSignature,
            installationSignature: projection.endpointFacts.facts.installationSignature,
        })
        ? candidate
        : null;
    const prepared = retained
        ? { review: retained.review, custody: retained }
        : await prepareRunnerActivationReviewV1(input);
    if (!retained) await input.retainPreparedCustody?.(prepared.custody);
    await input.client.storeReview(prepared.custody.binding.activationId, prepared.review);
    return prepared;
}

/**
 * The sole adapter from endpoint-authenticated, creator-reviewed facts into the
 * incumbent Session and Machine metadata owners. Callers cannot substitute
 * host/platform/path values at materialization time.
 */
export function deriveRunnerMaterializationMetadataV1(input: Readonly<{
    binding: RunnerActivationBindingV1;
    endpointFacts: unknown;
}>): Readonly<{ metadata: Metadata; machineMetadata: MachineMetadata }> {
    const endpointFacts = RunnerEndpointFactsContentV1Schema.parse(input.endpointFacts);
    const artifactPlatform = runnerArtifactTargetPlatform(input.binding.artifact.target);
    const expectedPlatform = artifactPlatform.os === 'windows' ? 'win32' : artifactPlatform.os;
    if (endpointFacts.machine.platform !== expectedPlatform) {
        throw new RunnerMaterializationPreparationError('runner_review_mismatch');
    }
    const machineMetadata = parseMachinePublishedMetadataV1(endpointFacts.machine);
    const metadata = MetadataSchema.parse({
        path: endpointFacts.directory,
        host: machineMetadata.host,
        version: machineMetadata.happyCliVersion,
        os: machineMetadata.platform,
        machineId: input.binding.machineId,
        homeDir: machineMetadata.homeDir,
        happyHomeDir: machineMetadata.happyHomeDir,
    });
    return { metadata, machineMetadata };
}

/** Builds the final request only from the exact creator-retained reviewed custody. */
export async function buildRunnerMaterializationRequestV1(input: Readonly<{
    projection: unknown;
    custody: RunnerReviewCustodyV1;
    credentials: AuthCredentials;
    encryption: Encryption | null;
    tag: string;
    agentState: AgentState | null;
    initialAccess?: RunnerMaterializationRequestV1['session']['initialAccess'];
    requestRecipientEnvelopeProjection?: (accountId: string) => Promise<Response>;
    teamCredentialBindings?: RunnerMaterializationRequestV1['session']['teamCredentialBindings'];
}>): Promise<RunnerMaterializationRequestV1> {
    const projection = assertRunnerMaterializationCurrentnessV1({ projection: input.projection, custody: input.custody });
    const { binding, preparedAuthoring, launchManifest } = input.custody;
    const mode = binding.endpointFactsRecipient.mode;
    const reviewedMetadata = deriveRunnerMaterializationMetadataV1({
        binding,
        endpointFacts: launchManifest.endpointFacts,
    });
    const owner = createSessionOwnerMetadataV1({ metadata: reviewedMetadata.metadata });
    if (!owner.ok) throw new RunnerMaterializationPreparationError('runner_session_metadata_unsupported');
    const shared = projectSessionSharedMetadataV1({ metadata: reviewedMetadata.metadata, agentState: input.agentState });
    let sessionKey: Uint8Array | null = null;
    let sessionDataEncryptionKey: string | null = null;
    let metadata: string;
    let agentState: string | null;
    let ownerMetadata;
    let machineMetadata: string;
    let machineDataEncryptionKey = MACHINE_PLAIN_DATA_KEY_MARKER;
    // Reviewed authoring is always logical and key-free. Even if an internal
    // caller presents the private materialized shape, this physical creator
    // discards that material and derives any current recipient envelopes from
    // the fresh Session key and current Home projection below.
    let initialAccess = input.initialAccess === undefined ? undefined : {
        grants: input.initialAccess.grants.map((grant) => ({
            subject: grant.subject,
            accessLevel: grant.accessLevel,
            canApprovePermissions: grant.canApprovePermissions,
        })),
    };
    if (mode === 'plain') {
        metadata = JSON.stringify(shared);
        agentState = input.agentState === null ? null : JSON.stringify(input.agentState);
        ownerMetadata = createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata);
        machineMetadata = encodePlainMachineStoredContent(reviewedMetadata.machineMetadata);
    } else {
        if (!input.encryption || !input.custody.machineContentKey || !launchManifest.machineContentKeyBinding) {
            throw new RunnerMaterializationPreparationError('runner_account_encryption_mismatch');
        }
        if (encodeBase64(input.encryption.contentDataKey, 'base64url') !== binding.endpointFactsRecipient.contentPublicKey) {
            throw new RunnerMaterializationPreparationError('runner_account_encryption_mismatch');
        }
        if (!isDataKeyAuthCredentials(input.credentials) && !isLegacyAuthCredentials(input.credentials)) {
            throw new RunnerMaterializationPreparationError('runner_account_encryption_mismatch');
        }
        sessionKey = getRandomBytes(32);
        sessionDataEncryptionKey = encodeBase64(await input.encryption.encryptEncryptionKey(sessionKey), 'base64');
        if (initialAccess) {
            const grants = await Promise.all(initialAccess.grants.map(async (grant) => {
                const keyFreeGrant = {
                    subject: grant.subject,
                    accessLevel: grant.accessLevel,
                    canApprovePermissions: grant.canApprovePermissions,
                };
                if (grant.subject.kind !== 'account') return keyFreeGrant;
                if (!input.requestRecipientEnvelopeProjection) {
                    throw new RunnerMaterializationPreparationError('session_access_request_failed');
                }
                const response = await input.requestRecipientEnvelopeProjection(grant.subject.accountId);
                if (response.status === 404) {
                    throw new RunnerMaterializationPreparationError('session_access_subject_not_found');
                }
                if (!response.ok) {
                    throw new RunnerMaterializationPreparationError('session_access_request_failed');
                }
                let payload: unknown;
                try {
                    payload = await response.json();
                } catch {
                    throw new RunnerMaterializationPreparationError('session_access_invalid_recipient_envelope');
                }
                const parsed = UserRecipientEnvelopeResponseSchema.safeParse(payload);
                if (!parsed.success) {
                    throw new RunnerMaterializationPreparationError('session_access_invalid_recipient_envelope');
                }
                const recipient = parsed.data.user;
                if (recipient.recipientEnvelopeReadiness.status === 'unavailable') return keyFreeGrant;
                if (!recipient.publicKey || !recipient.contentPublicKey || !recipient.contentPublicKeySig) {
                    throw new RunnerMaterializationPreparationError('recipient_key_unavailable');
                }
                if (!verifyRecipientContentPublicKeyBinding({
                    signingPublicKeyHex: recipient.publicKey,
                    contentPublicKeyB64: recipient.contentPublicKey,
                    contentPublicKeySigB64: recipient.contentPublicKeySig,
                })) {
                    throw new RunnerMaterializationPreparationError('session_access_invalid_recipient_envelope');
                }
                return {
                    ...keyFreeGrant,
                    accountEnvelopeInput: {
                        v: 1 as const,
                        encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({
                            dataKey: sessionKey!,
                            recipientPublicKey: decodeBase64(recipient.contentPublicKey, 'base64'),
                            randomBytes: getRandomBytes,
                        }), 'base64'),
                    },
                };
            }));
            initialAccess = { grants };
        }
        await input.encryption.initializeSessions(new Map([[binding.sessionId, sessionKey]]));
        const sessionEncryption = input.encryption.getSessionEncryption(binding.sessionId);
        if (!sessionEncryption) throw new RunnerMaterializationPreparationError('runner_account_encryption_mismatch');
        metadata = await sessionEncryption.encryptRaw(shared);
        agentState = input.agentState === null ? null : await sessionEncryption.encryptRaw(input.agentState);
        ownerMetadata = sealSessionOwnerMetadataEnvelopeV1({
            material: isDataKeyAuthCredentials(input.credentials)
                ? { type: 'dataKey', machineKey: decodeBase64(input.credentials.encryption.machineKey, 'base64') }
                : { type: 'legacy', secret: decodeBase64(input.credentials.secret, 'base64url') },
            ownerMetadata: owner.ownerMetadata,
            randomBytes: getRandomBytes,
        });
        await input.encryption.initializeMachines(new Map([[binding.machineId, input.custody.machineContentKey]]));
        const machineEncryption = input.encryption.getMachineEncryption(binding.machineId);
        if (!machineEncryption) throw new RunnerMaterializationPreparationError('runner_account_encryption_mismatch');
        machineMetadata = await machineEncryption.encryptMetadata(reviewedMetadata.machineMetadata);
        machineDataEncryptionKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
            dataKey: input.custody.machineContentKey,
            recipientPublicKey: decodeBase64(binding.endpointFactsRecipient.contentPublicKey, 'base64url'),
            randomBytes: getRandomBytes,
        }), 'base64');
    }
    const bootstrap = RunnerRuntimeBootstrapV1Schema.parse(mode === 'plain' ? {
        v: 1, purpose: 'happier.ephemeral-session-runner.runtime',
        homeServerIdentityId: binding.homeServerIdentityId, activationId: binding.activationId,
        creatorAccountId: binding.creatorAccountId,
        sessionId: binding.sessionId, machineId: binding.machineId,
        installationId: projection.claim.payload.installation.installationId,
        launchManifestCommitment: projection.review.launchManifestCommitment,
        storedContent: { mode: 'plain' }, machineContent: { mode: 'plain' },
    } : {
        v: 1, purpose: 'happier.ephemeral-session-runner.runtime',
        homeServerIdentityId: binding.homeServerIdentityId, activationId: binding.activationId,
        creatorAccountId: binding.creatorAccountId,
        sessionId: binding.sessionId, machineId: binding.machineId,
        installationId: projection.claim.payload.installation.installationId,
        launchManifestCommitment: projection.review.launchManifestCommitment,
        storedContent: { mode: 'e2ee', sessionDataEncryptionKey: encodeBase64(sessionKey!, 'base64url') },
        machineContent: { mode: 'e2ee', machineContentKeyBase64Url: encodeBase64(input.custody.machineContentKey!, 'base64url'), binding: launchManifest.machineContentKeyBinding! },
    });
    const sealedBootstrap = encodeBase64(sealBoxBundle({
        plaintext: new TextEncoder().encode(JSON.stringify(bootstrap)),
        recipientPublicKey: decodeBase64(projection.claim.payload.runnerBoxPublicKey, 'base64url'),
        randomBytes: getRandomBytes,
    }), 'base64url');
    return RunnerMaterializationRequestV1Schema.parse({
        v: 1, activationId: binding.activationId,
        launchManifestCommitment: projection.review.launchManifestCommitment,
        consent: projection.consent, readiness: projection.readiness, sealedBootstrap,
        session: {
            tag: input.tag, metadata, ownerMetadata, agentState,
            dataEncryptionKey: sessionDataEncryptionKey, requestedEncryptionMode: mode,
            requestedStorageState: 'machine_only',
            ...(preparedAuthoring.authoring.organizationPlacement ? { organizationPlacement: preparedAuthoring.authoring.organizationPlacement } : {}),
            ...(initialAccess ? { initialAccess } : {}),
            primaryTeamId: preparedAuthoring.authoring.primaryTeamId,
            ...(input.teamCredentialBindings !== undefined ? { teamCredentialBindings: input.teamCredentialBindings } : {}),
        },
        machine: { metadata: machineMetadata, dataEncryptionKey: machineDataEncryptionKey, runnerContentKeyBinding: launchManifest.machineContentKeyBinding },
        accessKeyData: `session-machine-control:${randomUUID()}`,
    });
}
