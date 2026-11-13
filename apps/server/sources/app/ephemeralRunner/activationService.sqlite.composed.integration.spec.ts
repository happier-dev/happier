import { randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runnerActivationProjectionBindingV1 } from '@happier-dev/protocol/ephemeralRunner/projection';
import { projectSessionDisplayV1, sealSessionOwnerDisplayEnvelopeV1, sealSessionSharedDisplayEnvelopeV1Sync } from '@happier-dev/protocol';
import { signRunnerClaimV1, signRunnerEndpointFactsV1 } from '@happier-dev/protocol/ephemeralRunner/endpoint';
import { signRunnerConsentV1 } from '@happier-dev/protocol/ephemeralRunner/consent';
import { signRunnerReadinessV1 } from '@happier-dev/protocol/ephemeralRunner/readiness';
import { signRunnerBrokerReadinessRequestV1 } from '@happier-dev/protocol/teams';
import { signRunnerEndpointProjectionProofV1 } from '@happier-dev/protocol/ephemeralRunner/endpointProjection';
import { signRunnerActivationProgressUpdateV1 } from '@happier-dev/protocol/ephemeralRunner/progressProof';
import type { RunnerActivationProgressPhaseV1 } from '@happier-dev/protocol/ephemeralRunner/progress';
import { claimEphemeralRunnerActivation } from './activationClaim';
import { MACHINE_PLAIN_DATA_KEY_MARKER, computeContentPublicKeyFingerprint, decodeBase64, encodeBase64, encodePlainMachineStoredContent, openBoxBundleWithSecretKey, sealBoxBundle, sealEncryptedDataKeyEnvelopeV1, signAccountContentKeyBindingV1, signMachineInstallationProof } from '@happier-dev/protocol';
import { computeRunnerMachineContentKeyFingerprintV1, signRunnerMachineContentKeyBindingV1 } from '@happier-dev/protocol/ephemeralRunner/machineContentKeyBinding';
import zipVector from '../../../../../packages/release-runtime/tests/fixtures/runnerZipMinisign.json';
import {
    mutateSessionDraft as mutateSessionDraftWithAuthentication,
    readSessionDraft as readSessionDraftWithAuthentication,
} from '@/app/account/sessionDrafts/sessionDraftService';
import { db, initDbPostgres } from '@/storage/db';
import { snapshotEnv, restoreEnv } from '@/testkit/env';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import {
    createEphemeralRunnerActivation as createEphemeralRunnerActivationWithAuthentication,
    readDraftEphemeralRunnerActivation,
    readEphemeralRunnerActivation,
} from './activationService';
import { registerEphemeralRunnerRoutes } from './routes';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { enableErrorHandlers } from '@/app/api/utils/enableErrorHandlers';
import { auth } from '@/app/auth/auth';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { readRunnerCreatorCurrentnessInTx } from './activationCurrentness';
import { inTx } from '@/storage/inTx';
import { RunnerEndpointFactsRecipientV1Schema, type RunnerActivationBindingV1 } from '@happier-dev/protocol/ephemeralRunner/activation';
import type { VerifiedRunnerArtifactV1 } from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';
import { storeRunnerActivationConsent, storeRunnerActivationPhase, storeRunnerActivationReadiness, storeRunnerActivationReview } from './activationProgress';
import { materializeEphemeralRunner } from './materializeEphemeralRunner';
import { verifyRunnerBrokerReadinessCurrentnessInTx } from './runnerBrokerReadinessVerification';
import { readRunnerBrokerReadinessProjectionInTx } from '@/app/teams/credentials/runnerBrokerReadinessAuthorization';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { resolveRunnerCredentialSelection } from './credentialSelection';
import { readEphemeralRunnerEndpointProjection } from './endpointProjection';
import { storeRunnerEndpointFacts } from './activationFacts';
import { createRunnerArtifactPublicationSnapshotStore, runnerArtifactPublicationSnapshots } from './runnerArtifactAvailability';
import { resolveAuthPolicyFromEnv } from '@/app/auth/authPolicy';
import { resolveJoinScreenHomeDisplayName } from '@/app/teams/invitations/joinScreenHome';
import { revokeMaterializedEphemeralRunnerBindingInTx } from './materializedTeardown';

type RunnerControlClientFixtureModule = Readonly<{
    createEphemeralRunnerHttpControlConnection: (input: Readonly<{
        activationId: string;
        pollIntervalMs: number;
        createProjectionProof: () => unknown;
        request: (path: string, init: Readonly<RequestInit>, signal: AbortSignal) => Promise<unknown>;
    }>) => Readonly<{
        submitReadiness: (args: Readonly<{ readiness: ReturnType<typeof signRunnerReadinessV1>; signal: AbortSignal }>) => Promise<unknown>;
        waitForMaterialization: (args: Readonly<{ launchManifestCommitment: string; signal: AbortSignal }>) => Promise<unknown>;
        decline: (args: Readonly<{ claim: ReturnType<typeof signRunnerClaimV1>; signal: AbortSignal }>) => Promise<unknown>;
        close: () => Promise<void>;
    }>;
    EphemeralRunnerControlHttpError: new (status: number) => Error;
}>;

function expectedRunnerHomeName(): string {
    return resolveAuthPolicyFromEnv(process.env).accountServicePresentation?.displayName
        ?? resolveJoinScreenHomeDisplayName(process.env)
        ?? 'Happier Home';
}

function runnerOpenAiProviderProjection(
    application: Readonly<{
        agentTargetKey: string;
        implementationIdentity: Readonly<{ pluginId: string; localId: string }>;
        endpointTemplateId: string;
        protocol: 'openai-responses';
    }>,
    sourceRevision: string,
) {
    return {
        status: 'success' as const,
        agentTargetKey: application.agentTargetKey,
        groups: [{
            connectionId: 'runner-materialization-provider',
            providerName: 'OpenAI', connectionName: 'Runner', connectionRole: 'named' as const,
            connectionDisplayNameMode: 'custom' as const, connectionRevision: 1,
            sourceAuthority: {
                provider: { identity: application.implementationIdentity, definitionRevision: 1 as const },
                connectionSecurityFingerprint: `connection-security:v1:${'a'.repeat(43)}`,
            },
            sourceRevision,
            modelLoadAction: 'available' as const, modelLoadPreflightPolicy: null,
            authorization: { authorized: true }, manualModelPolicy: 'allowed' as const,
            supportsFreeformModelIds: false, suppressedConnectedServiceIds: [],
            rows: [{
                ref: {
                    agentTargetKey: application.agentTargetKey,
                    providerConnectionId: 'runner-materialization-provider',
                    modelId: 'gpt-5',
                },
                descriptor: { id: 'gpt-5', name: 'GPT-5' },
                application,
                sources: { manual: false, static: true, probe: false },
                confidence: 'verified_static' as const,
                compatibility: {
                    result: {
                        status: 'verified' as const,
                        selectedProtocol: application.protocol,
                        evidence: { sourceUrls: ['https://docs.example.test/openai'], verifiedAt: '2026-09-10' },
                    },
                    compatibilityFingerprint: 'compatibility:v1:runner-selection', confirmed: false,
                },
                endpointHealth: 'not_checked' as const,
                catalog: { stale: false },
                loadState: 'unknown' as const,
                visibility: 'visible' as const,
            }],
        }],
    };
}

/** Stands in for the credential context the authenticated route stamps on the request. */
const presentUserAuthentication = {
    env: process.env,
    authority: 'present_user' as const,
    authenticationEvidence: undefined,
};

type CreateActivationParams = Parameters<typeof createEphemeralRunnerActivationWithAuthentication>[0];
function createEphemeralRunnerActivation(
    params: Omit<CreateActivationParams, 'authentication'> & Partial<Pick<CreateActivationParams, 'authentication'>>,
    options: Parameters<typeof createEphemeralRunnerActivationWithAuthentication>[1],
) {
    return createEphemeralRunnerActivationWithAuthentication(
        { ...params, authentication: params.authentication ?? presentUserAuthentication },
        options,
    );
}

type MutateSessionDraftParams = Parameters<typeof mutateSessionDraftWithAuthentication>[0];
function mutateSessionDraft(params: Omit<MutateSessionDraftParams, 'authentication'>) {
    return mutateSessionDraftWithAuthentication({ ...params, authentication: presentUserAuthentication });
}

type ReadSessionDraftParams = Parameters<typeof readSessionDraftWithAuthentication>[0];
function readSessionDraft(params: Omit<ReadSessionDraftParams, 'authentication'>) {
    return readSessionDraftWithAuthentication({ ...params, authentication: presentUserAuthentication });
}

function artifactNetwork() {
    const base = 'https://github.com/happier-dev/happier/releases/download/runner-v0.3.0';
    const checksums = 'checksums-happier-runner-v0.3.0.txt';
    const files = new Map([
        [`${base}/${checksums}`, zipVector.checksumsText],
        [`${base}/${checksums}.minisig`, zipVector.signatureFile],
        [`${base}/latest.json`, JSON.stringify({
            schemaVersion: 'v1', product: 'happier-runner', channel: 'stable', version: '0.3.0',
            publishedAt: '2026-09-08T00:00:00.000Z',
            records: [{ schemaVersion: 'v1', product: 'happier-runner', channel: 'stable', version: '0.3.0', os: 'linux', arch: 'x64',
                url: `${base}/${zipVector.artifactName}`, sha256: zipVector.artifactSha256, signature: `${base}/${checksums}.minisig`,
                publishedAt: '2026-09-08T00:00:00.000Z', minSupportedVersion: null, rolloutPercent: 100,
                critical: false, notesUrl: null, build: { commitSha: 'b'.repeat(40), workflowRunId: '123' },
                publication: { workflowRunId: '456' } }],
        })],
    ]);
    // HTTP acquisition and trusted release key are test boundaries; verifier stays real.
    const fetchImpl: typeof fetch = async (input) => {
        const url = String(input);
        if (url === 'https://api.github.com/repos/happier-dev/happier/releases/tags/runner-v0.3.0') {
            return Response.json({ tag_name: 'runner-v0.3.0', draft: false,
                assets: [...files.keys(), `${base}/${zipVector.artifactName}`].map((url) => ({ name: url.slice(url.lastIndexOf('/') + 1), browser_download_url: url })),
            });
        }
        const body = files.get(url);
        return new Response(body ?? '', { status: body === undefined ? 404 : 200 });
    };
    // Artifact verification has its own focused owner tests. Activation tests
    // consume the canonical cache only after seeding an already-verified exact
    // immutable artifact, so changes to release-fixture signing do not turn
    // every activation assertion into a publication test.
    const publicationSnapshots = createRunnerArtifactPublicationSnapshotStore();
    publicationSnapshots.write('happier-dev/happier\u0000stable\u00000.3.0', [{
        identity: {
            product: 'happier-runner',
            version: '0.3.0',
            target: 'linux-x64',
            sha256: zipVector.artifactSha256,
        },
        channel: 'stable',
        url: `${base}/${zipVector.artifactName}`,
        checksumsUrl: `${base}/${checksums}`,
        checksumsSignatureUrl: `${base}/${checksums}.minisig`,
        sizeBytes: 123,
        entries: [{ path: 'happier-runner', kind: 'file', sizeBytes: 100, mode: 0o755 }],
    }]);
    return { fetchImpl, minisignPublicKeyFile: zipVector.publicKeyFile, publicationSnapshots };
}

async function activationFixture(encryptionMode: 'plain' | 'e2ee' = 'plain', recipientPublicKey?: Uint8Array) {
        const accountSigningKey = encryptionMode === 'e2ee' ? tweetnacl.sign.keyPair() : null;
        const contentPublicKey = new Uint8Array(recipientPublicKey ?? tweetnacl.box.keyPair().publicKey);
        const accountContentBinding = accountSigningKey === null ? null : {
            publicKey: Buffer.from(accountSigningKey.publicKey).toString('hex'),
            contentPublicKey,
            contentPublicKeySig: signAccountContentKeyBindingV1({
                accountSigningSecretKey: accountSigningKey.secretKey,
                contentPublicKey,
            }),
        };
        const account = await db.account.create({
            data: accountContentBinding === null
                ? { encryptionMode, name: 'Alice Example', firstName: 'Alice', lastName: 'Example', username: `alice-${randomUUID()}` }
                : { encryptionMode, ...accountContentBinding, name: 'Alice Example', firstName: 'Alice', lastName: 'Example', username: `alice-${randomUUID()}` },
        });
        const draftId = randomUUID();
        const mutationId = randomUUID();
        const draft = await mutateSessionDraft({ accountId: account.id, address: { kind: 'newSession', draftId }, expectedRevision: 'absent',
            content: encryptionMode === 'e2ee' ? { t: 'encrypted', c: 'opaque-original-draft' } : { t: 'plain', v: { v: 1, address: { kind: 'newSession', draftId }, document: {
                v: 1, composer: { text: { mutationId, value: 'Inspect this project' }, mentions: { mutationId, value: [] }, attachments: { mutationId, value: [] } },
                target: { kind: 'newSession', authoring: {} }, extensions: {},
            } } },
        });
        if (draft.status !== 'updated') throw new Error('Draft setup failed');
        const activationKey = tweetnacl.sign.keyPair();
        const request = {
            v: 1, activationId: randomUUID(), draftId, homeServerIdentityId: 'srv_activation_service',
            activationSigningPublicKey: encodeBase64(activationKey.publicKey, 'base64url'),
            activationExpiresAt: null, workspace: { kind: 'choose_on_endpoint' as const }, authoringCommitment: encodeBase64(tweetnacl.randomBytes(32), 'base64url'),
            artifact: { product: 'happier-runner', version: '0.3.0', target: 'linux-x64', sha256: zipVector.artifactSha256 },
            endpointFactsRecipient: accountContentBinding === null ? { mode: 'plain', creatorAccountId: account.id } : {
                mode: 'e2ee', creatorAccountId: account.id,
                accountSigningPublicKey: encodeBase64(Buffer.from(accountContentBinding.publicKey, 'hex'), 'base64url'),
                contentPublicKey: encodeBase64(accountContentBinding.contentPublicKey, 'base64url'),
                contentPublicKeySignature: encodeBase64(accountContentBinding.contentPublicKeySig, 'base64url'),
                contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(accountContentBinding.contentPublicKey),
            },
        };
        const options = { artifactSource: artifactNetwork(), homeServerIdentityId: 'srv_activation_service' };
        return { account, draftId, draft, request, options, activationKey, accountSigningKey, contentPublicKey };
}

async function activationRouteApp(env: NodeJS.ProcessEnv = process.env) {
    const app = Fastify({ logger: false });
    app.register(rateLimit, { global: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>();
    enableAuthentication(typed);
    enableErrorHandlers(typed);
    registerEphemeralRunnerRoutes(typed, env);
    await app.ready();
    return app;
}

function runnerClaimPayload(binding: RunnerActivationBindingV1, installationKey = tweetnacl.sign.keyPair()) {
    const installationId = randomUUID();
    return {
        v: 1 as const, purpose: 'happier.ephemeral-session-runner.claim' as const, binding,
        runnerBoxPublicKey: encodeBase64(tweetnacl.box.keyPair().publicKey, 'base64url'), protocolEpoch: 1 as const,
        installation: { installationId, publicKey: encodeBase64(installationKey.publicKey, 'base64url'),
            proof: signMachineInstallationProof({ payload: { version: 1, installationId, machineId: binding.machineId, accountId: binding.creatorAccountId }, privateKey: installationKey.secretKey }),
        },
    };
}

async function materializationCredentialFixture(accountId: string, scope: string) {
    const team = await db.team.create({ data: { name: `Runner materialization ${scope}` } });
    await db.teamMembership.create({ data: { teamId: team.id, accountId, role: 'owner' } });
    const brokerEndpointId = 'b'.repeat(64);
    const brokerMachine = await db.machine.create({ data: {
        id: `broker-${scope}`,
        accountId,
        metadata: '{}',
        kind: 'persistent',
        operationProtocolCapabilities: {
            providerBrokerIngress: { protocolVersions: [1] },
            irohMachineEndpoint: { protocolVersions: [1], endpointId: brokerEndpointId },
        },
        operationProtocolCapabilitiesRevision: 1,
    } });
    const resource = await db.teamCredentialResource.create({ data: {
        teamId: team.id,
        custodianAccountId: accountId,
        displayName: 'Runner materialization resource',
        disclosureCeiling: 'brokered_only',
        sessionUsePolicy: 'personal_allowed',
        allMembersDeliveryMode: 'brokered',
        sourceBindingJson: JSON.stringify({
            v: 1,
            kind: 'provider_connection',
            connectionId: 'runner-materialization-provider',
            connectionSecurityFingerprint: `connection-security:v1:${'a'.repeat(43)}`,
            credentialSlotId: 'apiKey',
        }),
        brokerMachineId: brokerMachine.id,
    } });
    return { team, resource, brokerMachine, brokerEndpointId };
}

/** Scoped Runner Machine content key; never the Account-wide key or the Session DEK. */
const RUNNER_MACHINE_CONTENT_KEY = new Uint8Array(32).fill(29);
/** Opaque Layout-1 owner envelope an E2EE creator seals locally. */
const ENCRYPTED_OWNER_METADATA = {
    t: 'encrypted' as const,
    c: 'oRoBAgMEBQYHCAkKCwwNDg8QERITFBUWFxh8aC0+8+YDECLScN6uQTItPyWVR7XbQA==',
};

function runnerMachineContentKeyBindingPayload(input: Readonly<{
    homeServerIdentityId: string;
    activationId: string;
    creatorAccountId: string;
    machineId: string;
    installationId: string;
    machineContentKey: Uint8Array;
}>) {
    return {
        v: 1 as const,
        purpose: 'happier.ephemeral-runner.machine-content-key' as const,
        homeServerIdentityId: input.homeServerIdentityId,
        activationId: input.activationId,
        creatorAccountId: input.creatorAccountId,
        machineId: input.machineId,
        installationId: input.installationId,
        machineContentKeyFingerprint: computeRunnerMachineContentKeyFingerprintV1(input.machineContentKey),
    };
}

function sealedDataKeyEnvelopeBase64(dataKey: Uint8Array, recipientPublicKey: Uint8Array): string {
    return Buffer.from(sealEncryptedDataKeyEnvelopeV1({
        dataKey,
        recipientPublicKey,
        randomBytes: (length) => tweetnacl.randomBytes(length),
    })).toString('base64');
}

async function materializationFixture(
    mode: 'plain' | 'e2ee' = 'plain',
    authorizeRestrictedTeamAccess = false,
) {
    const { account, draftId, draft, request: activationRequest, options, activationKey, accountSigningKey, contentPublicKey } = await activationFixture(mode);
    const created = await createEphemeralRunnerActivation({
        creatorAccountId: account.id,
        request: {
            ...activationRequest,
            ...(authorizeRestrictedTeamAccess ? { authorizeUnattendedTeamAccess: true as const } : {}),
        },
        ...(authorizeRestrictedTeamAccess ? { authentication: {
            ...presentUserAuthentication,
            authenticationEvidence: [{ kind: 'home_method' as const, methodId: 'key_challenge' }],
        } } : {}),
    }, options);
    if (created.status !== 'created') throw new Error('Activation setup failed');
    const installationKey = tweetnacl.sign.keyPair();
    const claim = signRunnerClaimV1({
        payload: runnerClaimPayload(runnerActivationProjectionBindingV1(created.activation), installationKey),
        activationSecretKey: activationKey.secretKey,
    });
    if ((await claimEphemeralRunnerActivation({ activationId: activationRequest.activationId, claim }, options)).status !== 'claimed') {
        throw new Error('Claim setup failed');
    }
    const endpointFactsContent = {
        v: 1 as const,
        directory: '/work/materialized-runner',
        machine: {
            host: 'runner.example.test',
            platform: 'linux' as const,
            happyCliVersion: '0.3.0',
            happyHomeDir: '/runner/home',
            homeDir: '/runner/home',
        },
    };
    const endpointFacts = signRunnerEndpointFactsV1({
        payload: {
            v: 1,
            purpose: 'happier.ephemeral-session-runner.endpoint-facts',
            claim: claim.payload,
            content: mode === 'plain'
                ? { t: 'plain', v: endpointFactsContent }
                : {
                    t: 'encrypted',
                    c: encodeBase64(sealBoxBundle({
                        plaintext: new TextEncoder().encode(JSON.stringify(endpointFactsContent)),
                        recipientPublicKey: contentPublicKey,
                        randomBytes: tweetnacl.randomBytes,
                    }), 'base64url'),
                },
        },
        activationSecretKey: activationKey.secretKey,
        installationSecretKey: installationKey.secretKey,
    });
    expect(await storeRunnerEndpointFacts(
        { activationId: activationRequest.activationId, endpointFacts },
        { homeServerIdentityId: options.homeServerIdentityId },
    )).toMatchObject({ status: 'stored' });
    const { team, resource, brokerMachine, brokerEndpointId } = await materializationCredentialFixture(
        account.id,
        activationRequest.activationId,
    );
    if (authorizeRestrictedTeamAccess) {
        await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: {
            v: 1,
            mode: 'restricted',
            accepted: [{ kind: 'home_method', methodId: 'key_challenge' }],
        } } });
    }
    const machineContentKeyBindingPayload = runnerMachineContentKeyBindingPayload({
        homeServerIdentityId: activationRequest.homeServerIdentityId,
        activationId: activationRequest.activationId,
        creatorAccountId: account.id,
        machineId: created.activation.machineId,
        installationId: claim.payload.installation.installationId,
        machineContentKey: RUNNER_MACHINE_CONTENT_KEY,
    });
    const review = {
        sealedLaunchManifest: 'sealed-materialization-manifest',
        authoringCommitment: activationRequest.authoringCommitment,
        launchManifestCommitment: encodeBase64(new Uint8Array(32).fill(61), 'base64url'),
        endpointFactsProof: {
            activationSignature: endpointFacts.activationSignature,
            installationSignature: endpointFacts.installationSignature,
        },
        agentTargetKey: 'agent:happier.agent.codex/codex',
        machineContentKeyBinding: mode === 'plain' ? null : signRunnerMachineContentKeyBindingV1({
            payload: machineContentKeyBindingPayload,
            activationSigningSecretKey: activationKey.secretKey,
        }),
        credentialSelectionBinding: { v: 1 as const, resourceId: resource.id, brokerMachineId: brokerMachine.id, revision: resource.revision,
            application: { agentTargetKey: 'agent:happier.agent.codex/codex', implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' }, endpointTemplateId: 'responses', protocol: 'openai-responses' as const },
            sourceRevision: 'source-revision-1' },
        displayFacts: {
            v: 1 as const,
            homeId: activationRequest.homeServerIdentityId,
            homeName: expectedRunnerHomeName(),
            requesterId: account.id,
            requesterName: 'Alice Example',
            teamId: team.id,
            teamName: team.name,
        },
    };
    const selectionRequest = {
        v: 1 as const,
        selection: {
            kind: 'team_credential_provider_model' as const,
            resourceId: resource.id,
            teamId: team.id,
            expectedResourceRevision: resource.revision,
            agentTargetKey: review.credentialSelectionBinding.application.agentTargetKey,
            modelId: 'gpt-5',
            // Runner only ever reviews a brokered route: the endpoint must never
            // receive Provider material directly. The canonical selection carries
            // that route, so the fixture states it rather than leaving the strict
            // schema to reject the whole request as malformed.
            deliveryMode: 'brokered' as const,
        },
        application: review.credentialSelectionBinding.application,
        sourceRevision: review.credentialSelectionBinding.sourceRevision,
        plannedSession: { primaryTeamId: null, teamVisibilityTeamIds: [] },
    };
    expect(await resolveRunnerCredentialSelection({
        creatorAccountId: account.id,
        activationId: activationRequest.activationId,
        request: selectionRequest,
        authentication: presentUserAuthentication,
        signal: new AbortController().signal,
        readCurrentPresence: async () => ({ state: 'known', machineIds: new Set<string>() }),
        readPoolSourceEligibility: async () => { throw new Error('An exact broker placement selects no Pool member'); },
        readProviderProjection: async () => runnerOpenAiProviderProjection(
            review.credentialSelectionBinding.application,
            review.credentialSelectionBinding.sourceRevision,
        ),
    })).toEqual({
        v: 1,
        status: 'resolved',
        credentialSelectionBinding: review.credentialSelectionBinding,
        displayFacts: review.displayFacts,
    });
    expect(await storeRunnerActivationReview({ creatorAccountId: account.id, activationId: activationRequest.activationId, review }))
        .toMatchObject({ status: 'stored' });
    const consent = signRunnerConsentV1({
        payload: { v: 1, purpose: 'happier.ephemeral-session-runner.consent', allow: true, claim: claim.payload, launchManifestCommitment: review.launchManifestCommitment },
        activationSecretKey: activationKey.secretKey,
        installationSecretKey: installationKey.secretKey,
    });
    expect(await storeRunnerActivationConsent({ activationId: activationRequest.activationId, consent })).toMatchObject({ status: 'stored' });
    const readiness = signRunnerReadinessV1({
        payload: {
            v: 1, purpose: 'happier.ephemeral-session-runner.readiness', claim: claim.payload,
            launchManifestCommitment: review.launchManifestCommitment,
            credentialSelectionBinding: review.credentialSelectionBinding,
            installation: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                agentRuntimeId: 'codex', executablePath: '/managed/codex', authoritativeVersion: '1.0.0' },
            brokerReadinessRequest: signRunnerBrokerReadinessRequestV1({
                facts: {
                    v: 1,
                    kind: 'provider_broker_readiness',
                    homeServerIdentityId: activationRequest.homeServerIdentityId,
                    activationId: activationRequest.activationId,
                    launchManifestCommitment: review.launchManifestCommitment,
                    resourceId: resource.id,
                    agentTargetKey: review.agentTargetKey,
                    modelId: selectionRequest.selection.modelId,
                    protocol: 'openai-responses',
                    initiator: {
                        installationId: claim.payload.installation.installationId,
                        endpointId: 'a'.repeat(64),
                    },
                    target: {
                        machineId: brokerMachine.id,
                        endpointId: brokerEndpointId,
                    },
                },
                claim,
                activationSecretKey: activationKey.secretKey,
                installationSecretKey: installationKey.secretKey,
            }),
        },
        activationSecretKey: activationKey.secretKey,
        installationSecretKey: installationKey.secretKey,
    });
    expect(await storeRunnerActivationReadiness({ activationId: activationRequest.activationId, readiness })).toMatchObject({ status: 'stored' });
    expect(await inTx(tx => verifyRunnerBrokerReadinessCurrentnessInTx(tx, {
        activationId: activationRequest.activationId,
        request: readiness.payload.brokerReadinessRequest,
    }))).not.toBeNull();
    expect(await inTx(tx => readRunnerBrokerReadinessProjectionInTx(tx, {
        activationId: activationRequest.activationId,
        selection: review.credentialSelectionBinding,
    }))).toMatchObject({
        credentialSelectionBinding: review.credentialSelectionBinding,
        target: { endpointId: brokerEndpointId },
        provider: { identity: review.credentialSelectionBinding.application.implementationIdentity, definitionRevision: 1 },
        readiness: { kind: 'available' },
    });
    return { mode, account, accountSigningKey, contentPublicKey, draftId, draft, activationRequest, created, activationKey, installationKey, claim,
        review, consent, readiness, machineContentKeyBindingPayload,
        team, resource, brokerMachine, brokerEndpointId };
}

function materializationRequest(fixture: Awaited<ReturnType<typeof materializationFixture>>) {
    const e2ee = fixture.mode === 'e2ee';
    return {
        v: 1 as const,
        activationId: fixture.activationRequest.activationId,
        launchManifestCommitment: fixture.review.launchManifestCommitment,
        consent: fixture.consent,
        readiness: fixture.readiness,
        sealedBootstrap: 'sealed-bootstrap-materialize',
        session: {
            tag: `runner-${fixture.activationRequest.activationId}`,
            metadata: e2ee ? 'opaque-session-metadata-ciphertext' : JSON.stringify({ v: 1 }),
            ownerMetadata: e2ee ? ENCRYPTED_OWNER_METADATA : { t: 'plain' as const, v: { v: 1 } },
            agentState: null,
            // The creator seals the Session key to its own current content key; the
            // Home stores that owner envelope and never opens it.
            dataEncryptionKey: e2ee
                ? sealedDataKeyEnvelopeBase64(tweetnacl.randomBytes(32), fixture.contentPublicKey)
                : null,
            requestedEncryptionMode: e2ee ? 'e2ee' as const : 'plain' as const,
        },
        machine: {
            metadata: e2ee ? 'opaque-machine-metadata-ciphertext' : encodePlainMachineStoredContent({ v: 1 }),
            // The fresh Runner-only Machine key travels to the endpoint's box key,
            // never through the Account-wide Machine key resolver.
            dataEncryptionKey: e2ee
                ? sealedDataKeyEnvelopeBase64(
                    RUNNER_MACHINE_CONTENT_KEY,
                    decodeBase64(fixture.claim.payload.runnerBoxPublicKey, 'base64url'),
                )
                : MACHINE_PLAIN_DATA_KEY_MARKER,
            runnerContentKeyBinding: fixture.review.machineContentKeyBinding,
        },
        accessKeyData: 'sealed-runner-access-key',
    };
}

describe('Runner activation and draft lifecycle', () => {
    let harness: LightSqliteHarness | undefined;
    const initialEnv = snapshotEnv();
    beforeAll(async () => {
        const env = {
            HAPPIER_FEATURE_SESSIONS_EPHEMERAL_RUNNER__ENABLED: '1',
            HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        };
        if (process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            if (process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
                throw new Error('Use only the disposable PostgreSQL DB-contract harness');
            }
            Object.assign(process.env, env);
            process.env.HAPPIER_DB_TX_MAX_RETRIES = '0';
            process.env.HANDY_MASTER_SECRET ??= randomUUID();
            initDbPostgres();
            await db.$connect();
            await auth.init();
        } else {
            harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-activation-service-', initAuth: true, env });
        }
    }, 120_000);
    afterAll(async () => {
        try { if (harness) await harness.close(); else await db.$disconnect(); }
        finally { restoreEnv(initialEnv); }
    });

    it('materializes a fresh Runner through its existing content admission', async () => {
        const fixture = await materializationFixture();
        const base = materializationRequest(fixture);
        const sessionId = fixture.created.activation.sessionId;
        const sharedMetadata = { v: 1 as const, summary: { text: 'Runner shared display', updatedAt: 1 } };
        const ownerMetadata = { v: 1 as const, workspace: { name: 'Runner owner display', path: '/private/runner' } };
        const display = projectSessionDisplayV1({ sharedMetadata, ownerMetadata });
        const shared = sealSessionSharedDisplayEnvelopeV1Sync({ sessionMode: 'plain', display: display.shared });
        const owner = sealSessionOwnerDisplayEnvelopeV1({ accountMode: 'plain', display: display.owner! });
        if (!shared.ok || !owner.ok) throw new Error('Canonical plain display producer failed');
        const displayProjectionV1 = { v: 1 as const, sourceMetadataVersion: 0, metadataLayoutVersion: 1 as const,
            shared: shared.envelope, owner: owner.envelope };
        const request = { ...base, session: { ...base.session,
            metadata: JSON.stringify(sharedMetadata), ownerMetadata: { t: 'plain' as const, v: ownerMetadata }, displayProjectionV1 } };
        const result = await materializeEphemeralRunner({ creatorAccountId: fixture.account.id, request,
            authentication: presentUserAuthentication, env: process.env });
        expect(result).toMatchObject({ status: 'materialized', result: {
            sessionId: fixture.created.activation.sessionId, machineId: fixture.created.activation.machineId,
        } });
        expect(await db.machine.findUniqueOrThrow({ where: { id: fixture.created.activation.machineId } }))
            .toMatchObject({ kind: 'ephemeral_session_runner', installationId: fixture.claim.payload.installation.installationId });
        const stored = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
        expect(stored.metadataVersion).toBe(0);
        expect(JSON.parse(stored.displayProjectionV1 ?? 'null')).toEqual(displayProjectionV1);
        expect(await materializeEphemeralRunner({ creatorAccountId: fixture.account.id, request,
            authentication: presentUserAuthentication, env: process.env })).toEqual(result);
    });

    // The PostgreSQL entry point consumes the materialization admission contract
    // above; the remaining cases retain their SQLite-specific lifecycle harness.
    if (process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) return;

    it('uses the Home release ring for both artifact availability and activation admission', async () => {
        const fixture = await activationFixture();
        const artifact = {
            identity: {
                product: 'happier-runner',
                version: fixture.request.artifact.version,
                target: 'linux-x64',
                sha256: fixture.request.artifact.sha256,
            },
            channel: 'publicdev' as const,
            url: `https://github.com/happier-dev/happier/releases/download/runner-v0.3.0/${zipVector.artifactName}`,
            checksumsUrl: 'https://github.com/happier-dev/happier/releases/download/runner-v0.3.0/checksums-happier-runner-v0.3.0.txt',
            checksumsSignatureUrl: 'https://github.com/happier-dev/happier/releases/download/runner-v0.3.0/checksums-happier-runner-v0.3.0.txt.minisig',
            sizeBytes: 123,
            entries: [{ path: 'happier-runner', kind: 'file' as const, sizeBytes: 100, mode: 0o755 }],
        } satisfies VerifiedRunnerArtifactV1;
        runnerArtifactPublicationSnapshots.write('happier-dev/happier\u0000publicdev\u00000.3.0', [artifact]);
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = await activationRouteApp({
            ...process.env,
            HAPPIER_SERVER_IDENTITY_ID: fixture.options.homeServerIdentityId,
            HAPPIER_PUBLIC_RELEASE_CHANNEL: 'dev',
        });
        const headers = { authorization: `Bearer ${token}` };
        vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
        try {
            const available = await app.inject({
                method: 'GET',
                url: '/v1/ephemeral-runners/artifacts?version=0.3.0',
                headers,
            });
            expect(available.statusCode).toBe(200);
            expect(available.json()).toEqual({ status: 'available', artifacts: [artifact] });

            const created = await app.inject({
                method: 'POST',
                url: '/v1/ephemeral-runners/activations',
                headers,
                payload: fixture.request,
            });
            expect(created.statusCode).toBe(200);
            expect(created.json()).toMatchObject({
                status: 'created',
                activation: { activationId: fixture.request.activationId, artifact: fixture.request.artifact },
            });
        } finally {
            vi.unstubAllGlobals();
            await app.close();
        }
    });

    it('stores authentication evidence only for an explicit present-user unattended-Team authorization', async () => {
        const omitted = await activationFixture();
        expect(await createEphemeralRunnerActivation({
            creatorAccountId: omitted.account.id,
            request: omitted.request,
            authentication: {
                ...presentUserAuthentication,
                authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }],
            },
        }, omitted.options)).toMatchObject({ status: 'created' });
        const omittedRow = await db.ephemeralRunnerActivation.findUniqueOrThrow({ where: { id: omitted.request.activationId } });
        expect((omittedRow as typeof omittedRow & { authenticationEvidence?: unknown }).authenticationEvidence).toBeNull();

        const authorized = await activationFixture('e2ee');
        const authorizedResult = await createEphemeralRunnerActivation({
            creatorAccountId: authorized.account.id,
            request: { ...authorized.request, authorizeUnattendedTeamAccess: true },
            authentication: {
                ...presentUserAuthentication,
                authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }],
            },
        }, authorized.options);
        expect(authorizedResult).toMatchObject({ status: 'created' });
        if (authorizedResult.status !== 'created') throw new Error('Expected authorized activation');
        expect(authorizedResult.activation).not.toHaveProperty('authenticationEvidence');
        const authorizedRow = await db.ephemeralRunnerActivation.findUniqueOrThrow({ where: { id: authorized.request.activationId } });
        expect((authorizedRow as typeof authorizedRow & { authenticationEvidence?: unknown }).authenticationEvidence).toEqual({
            v: 1,
            evidence: [{ kind: 'home_method', methodId: 'key_challenge' }],
        });

        const siblingDraftId = randomUUID();
        const siblingDraftMutationId = randomUUID();
        await mutateSessionDraft({
            accountId: authorized.account.id,
            address: { kind: 'newSession', draftId: siblingDraftId },
            expectedRevision: 'absent',
            content: { t: 'encrypted', c: `opaque-sibling-draft-${siblingDraftMutationId}` },
        });
        const siblingRequest = {
            ...authorized.request,
            activationId: randomUUID(),
            draftId: siblingDraftId,
            authoringCommitment: encodeBase64(tweetnacl.randomBytes(32), 'base64url'),
        };
        expect(await createEphemeralRunnerActivation({
            creatorAccountId: authorized.account.id,
            request: siblingRequest,
            authentication: {
                ...presentUserAuthentication,
                authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }],
            },
        }, authorized.options)).toMatchObject({ status: 'created' });
        await expect(db.ephemeralRunnerActivation.findUniqueOrThrow({
            where: { id: siblingRequest.activationId },
            select: { authenticationEvidence: true },
        })).resolves.toEqual({ authenticationEvidence: null });

        const unavailable = await activationFixture();
        expect(await createEphemeralRunnerActivation({
            creatorAccountId: unavailable.account.id,
            request: { ...unavailable.request, authorizeUnattendedTeamAccess: true },
            authentication: presentUserAuthentication,
        }, unavailable.options)).toEqual({ status: 'authentication_evidence_unavailable' });

        const automation = await activationFixture();
        expect(await createEphemeralRunnerActivation({
            creatorAccountId: automation.account.id,
            request: { ...automation.request, authorizeUnattendedTeamAccess: true },
            authentication: {
                env: process.env,
                authority: 'account_automation',
                authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }],
            },
        }, automation.options)).toEqual({ status: 'authentication_evidence_unavailable' });
    });

    it('resolves an exact reviewed Provider model into the content-free resource binding and rechecks currentness after projection', async () => {
        const fixture = await activationFixture();
        const created = await createEphemeralRunnerActivation({
            creatorAccountId: fixture.account.id,
            request: fixture.request,
        }, fixture.options);
        if (created.status !== 'created') throw new Error('Activation setup failed');
        const installationKey = tweetnacl.sign.keyPair();
        const claim = signRunnerClaimV1({
            payload: runnerClaimPayload(runnerActivationProjectionBindingV1(created.activation), installationKey),
            activationSecretKey: fixture.activationKey.secretKey,
        });
        expect(await claimEphemeralRunnerActivation({
            activationId: fixture.request.activationId,
            claim,
        }, fixture.options)).toMatchObject({ status: 'claimed' });
        const endpointFacts = signRunnerEndpointFactsV1({
            payload: {
                v: 1,
                purpose: 'happier.ephemeral-session-runner.endpoint-facts',
                claim: claim.payload,
                content: { t: 'plain', v: { v: 1, directory: '/work/pool-selection', machine: {
                    host: 'runner.example.test', platform: 'linux', happyCliVersion: '0.3.0',
                    happyHomeDir: '/runner/home', homeDir: '/runner/home',
                } } },
            },
            activationSecretKey: fixture.activationKey.secretKey,
            installationSecretKey: installationKey.secretKey,
        });
        await db.ephemeralRunnerActivation.update({
            where: { id: fixture.request.activationId },
            data: { endpointFacts },
        });
        const credential = await materializationCredentialFixture(fixture.account.id, `selection-${fixture.request.activationId}`);
        const application = {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' },
            endpointTemplateId: 'responses',
            protocol: 'openai-responses' as const,
        };
        const request = {
            v: 1 as const,
            selection: {
                kind: 'team_credential_provider_model' as const,
                resourceId: credential.resource.id,
                teamId: credential.team.id,
                expectedResourceRevision: credential.resource.revision,
                agentTargetKey: application.agentTargetKey,
                modelId: 'gpt-5',
                deliveryMode: 'brokered' as const,
            },
            application,
            sourceRevision: 'source-revision-1',
            plannedSession: { primaryTeamId: null, teamVisibilityTeamIds: [] },
        };
        const providerProjection = {
            status: 'success' as const,
            agentTargetKey: application.agentTargetKey,
            groups: [{
                connectionId: 'runner-materialization-provider',
                providerName: 'OpenAI', connectionName: 'Runner', connectionRole: 'named' as const,
                connectionDisplayNameMode: 'custom' as const, connectionRevision: 1,
                sourceAuthority: {
                    provider: { identity: application.implementationIdentity, definitionRevision: 1 as const },
                    connectionSecurityFingerprint: `connection-security:v1:${'a'.repeat(43)}`,
                },
                sourceRevision: request.sourceRevision,
                modelLoadAction: 'available' as const, modelLoadPreflightPolicy: null,
                authorization: { authorized: true }, manualModelPolicy: 'allowed' as const,
                supportsFreeformModelIds: false, suppressedConnectedServiceIds: [],
                rows: [{
                    ref: { agentTargetKey: application.agentTargetKey, providerConnectionId: 'runner-materialization-provider', modelId: 'gpt-5' },
                    descriptor: { id: 'gpt-5', name: 'GPT-5' }, application,
                    sources: { manual: false, static: true, probe: false }, confidence: 'verified_static' as const,
                    compatibility: {
                        result: { status: 'verified' as const, selectedProtocol: application.protocol,
                            evidence: { sourceUrls: ['https://docs.example.test/openai'], verifiedAt: '2026-09-10' } },
                        compatibilityFingerprint: 'compatibility:v1:runner-selection', confirmed: false,
                    },
                    endpointHealth: 'not_checked' as const, catalog: { stale: false }, loadState: 'unknown' as const,
                    visibility: 'visible' as const,
                }],
            }],
        };
        const resolve = (
            selectionRequest: typeof request,
            readProviderProjection: () => Promise<unknown>,
        ) =>
            resolveRunnerCredentialSelection({
                creatorAccountId: fixture.account.id,
                activationId: fixture.request.activationId,
                request: selectionRequest,
                authentication: presentUserAuthentication,
                signal: new AbortController().signal,
                readCurrentPresence: async () => ({ state: 'known', machineIds: new Set<string>() }),
                readPoolSourceEligibility: async () => { throw new Error('An exact broker placement selects no Pool member'); },
                readProviderProjection,
            });

        await expect(resolve(request, async () => providerProjection)).resolves.toMatchObject({
            v: 1,
            status: 'resolved',
            credentialSelectionBinding: {
                v: 1,
                resourceId: credential.resource.id,
                brokerMachineId: credential.brokerMachine.id,
                revision: credential.resource.revision,
                application,
                sourceRevision: request.sourceRevision,
            },
            displayFacts: {
                requesterName: 'Alice Example',
                teamName: credential.team.name,
            },
        });
        await expect(resolve({
            ...request,
            selection: { ...request.selection, modelId: 'substituted-model' },
        }, async () => providerProjection)).resolves.toEqual({
            v: 1, status: 'unavailable', reason: 'activation_conflict',
        });
        // Once the server-owned selection is frozen, retries deliberately skip
        // provider projection and revalidate the persisted binding directly.
        // Mutate the resource before retry so this assertion continues to
        // exercise that currentness boundary rather than relying on a callback
        // that a correct frozen-selection retry must never invoke.
        await db.teamCredentialResource.update({
            where: { id: credential.resource.id },
            data: { revision: { increment: 1 } },
        });
        await expect(resolve(request, async () => {
            throw new Error('frozen selection must not reproject');
        })).resolves.toEqual({ v: 1, status: 'unavailable', reason: 'resource_changed' });
        expect(await db.session.count({ where: { accountId: fixture.account.id } })).toBe(0);
    });

    // A Pool placement is a real broker location for a Runner: the server
    // selects one present, source-eligible member before review and freezes it.
    it('selects and freezes one present, source-eligible Pool member for a Runner selection', async () => {
        const fixture = await activationFixture();
        const created = await createEphemeralRunnerActivation({
            creatorAccountId: fixture.account.id,
            request: fixture.request,
        }, fixture.options);
        expect(created).toMatchObject({ status: 'created' });
        if (created.status !== 'created') throw new Error('Activation setup failed');
        const installationKey = tweetnacl.sign.keyPair();
        const claim = signRunnerClaimV1({
            payload: runnerClaimPayload(runnerActivationProjectionBindingV1(created.activation), installationKey),
            activationSecretKey: fixture.activationKey.secretKey,
        });
        expect(await claimEphemeralRunnerActivation({
            activationId: fixture.request.activationId,
            claim,
        }, fixture.options)).toMatchObject({ status: 'claimed' });
        const endpointFacts = signRunnerEndpointFactsV1({
            payload: {
                v: 1,
                purpose: 'happier.ephemeral-session-runner.endpoint-facts',
                claim: claim.payload,
                content: { t: 'plain', v: { v: 1, directory: '/work/pool-selection', machine: {
                    host: 'runner.example.test', platform: 'linux', happyCliVersion: '0.3.0',
                    happyHomeDir: '/runner/home', homeDir: '/runner/home',
                } } },
            },
            activationSecretKey: fixture.activationKey.secretKey,
            installationSecretKey: installationKey.secretKey,
        });
        await db.ephemeralRunnerActivation.update({
            where: { id: fixture.request.activationId },
            data: { endpointFacts },
        });
        const credential = await materializationCredentialFixture(fixture.account.id, `pool-selection-${fixture.request.activationId}`);
        const fallback = await db.machine.create({ data: {
            id: `pool-fallback-${fixture.request.activationId}`,
            accountId: fixture.account.id,
            metadata: '{}',
            kind: 'persistent',
            operationProtocolCapabilities: {
                providerBrokerIngress: { protocolVersions: [1] },
                irohMachineEndpoint: { protocolVersions: [1], endpointId: 'c'.repeat(64) },
            },
            operationProtocolCapabilitiesRevision: 1,
        } });
        const pool = await db.machinePool.create({ data: {
            id: randomUUID(),
            accountId: fixture.account.id,
            name: 'Runner brokers',
            members: { create: [
                { machineId: credential.brokerMachine.id, priorityTier: 0, enabled: true },
                { machineId: fallback.id, priorityTier: 1, enabled: true },
            ] },
        } });
        await db.teamCredentialResource.update({
            where: { id: credential.resource.id },
            data: { brokerMachineId: null, brokerPoolId: pool.id },
        });
        const application = {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' },
            endpointTemplateId: 'responses',
            protocol: 'openai-responses' as const,
        };
        const request = {
            v: 1 as const,
            selection: {
                kind: 'team_credential_provider_model' as const,
                resourceId: credential.resource.id,
                teamId: credential.team.id,
                expectedResourceRevision: credential.resource.revision,
                agentTargetKey: application.agentTargetKey,
                modelId: 'gpt-5',
                deliveryMode: 'brokered' as const,
            },
            application,
            sourceRevision: 'source-revision-1',
            plannedSession: { primaryTeamId: null, teamVisibilityTeamIds: [] },
        };
        // Only the tier-1 member is online and able to run this source, so the
        // tier-0 member must not be selected merely for ranking ahead of it.
        const projectedFor: string[] = [];
        const resolved = await resolveRunnerCredentialSelection({
            creatorAccountId: fixture.account.id,
            activationId: fixture.request.activationId,
            request,
            authentication: presentUserAuthentication,
            signal: new AbortController().signal,
            readCurrentPresence: async () => ({ state: 'known', machineIds: new Set([fallback.id]) }),
            readPoolSourceEligibility: async eligibility => ({
                eligibleMachineIds: new Set(eligibility.machineIds.filter(id => id === fallback.id)),
                reasons: new Map(),
            }),
            readProviderProjection: async projection => {
                projectedFor.push(projection.brokerMachineId);
                return runnerOpenAiProviderProjection(application, 'source-revision-1');
            },
        });
        expect(resolved).toMatchObject({
            v: 1,
            status: 'resolved',
            credentialSelectionBinding: {
                v: 1,
                resourceId: credential.resource.id,
                brokerMachineId: fallback.id,
                revision: credential.resource.revision,
            },
        });
        expect(projectedFor).toEqual([fallback.id]);

        // The frozen member stays this activation's broker: a later membership
        // edit is revalidated, never reranked onto the other member.
        await db.machinePoolMember.updateMany({
            where: { poolId: pool.id, machineId: fallback.id },
            data: { priorityTier: 2 },
        });
        const rereadEstablished = async () => await resolveRunnerCredentialSelection({
            creatorAccountId: fixture.account.id,
            activationId: fixture.request.activationId,
            request,
            authentication: presentUserAuthentication,
            signal: new AbortController().signal,
            readCurrentPresence: async () => ({ state: 'known', machineIds: new Set([fallback.id]) }),
            readPoolSourceEligibility: async () => { throw new Error('A frozen Runner selection must not re-rank its Pool'); },
            readProviderProjection: async () => { throw new Error('A frozen Runner selection must not re-project'); },
        });
        expect(await rereadEstablished()).toMatchObject({
            v: 1,
            status: 'resolved',
            credentialSelectionBinding: { brokerMachineId: fallback.id },
        });

        // Pool membership governs future selection only. Disabling the frozen
        // member must not revoke an activation whose broker was already
        // selected and reviewed.
        await db.machinePoolMember.updateMany({
            where: { poolId: pool.id, machineId: fallback.id },
            data: { enabled: false },
        });
        expect(await rereadEstablished()).toMatchObject({
            v: 1,
            status: 'resolved',
            credentialSelectionBinding: { brokerMachineId: fallback.id },
        });

        // Current Machine, resource, source and endpoint authority stay with the
        // readiness owner, which revalidates them before any effect.
    });

    // Reading a foreign custodian's Machine presence and asking their daemon
    // whether it can run a source are real effects on someone else's computer.
    // An unentitled caller must reach neither, and must not be able to tell a
    // resource that does not exist from one they simply cannot use.
    it('authorizes the named resource before it discovers a broker, and refuses missing and unauthorized alike', async () => {
        const fixture = await activationFixture();
        const created = await createEphemeralRunnerActivation({
            creatorAccountId: fixture.account.id,
            request: fixture.request,
        }, fixture.options);
        if (created.status !== 'created') throw new Error('Activation setup failed');
        const installationKey = tweetnacl.sign.keyPair();
        const claim = signRunnerClaimV1({
            payload: runnerClaimPayload(runnerActivationProjectionBindingV1(created.activation), installationKey),
            activationSecretKey: fixture.activationKey.secretKey,
        });
        expect(await claimEphemeralRunnerActivation({
            activationId: fixture.request.activationId,
            claim,
        }, fixture.options)).toMatchObject({ status: 'claimed' });
        await db.ephemeralRunnerActivation.update({
            where: { id: fixture.request.activationId },
            data: {
                endpointFacts: signRunnerEndpointFactsV1({
                    payload: {
                        v: 1,
                        purpose: 'happier.ephemeral-session-runner.endpoint-facts',
                        claim: claim.payload,
                        content: { t: 'plain', v: { v: 1, directory: '/work/foreign-resource', machine: {
                            host: 'runner.example.test', platform: 'linux', happyCliVersion: '0.3.0',
                            happyHomeDir: '/runner/home', homeDir: '/runner/home',
                        } } },
                    },
                    activationSecretKey: fixture.activationKey.secretKey,
                    installationSecretKey: installationKey.secretKey,
                }),
            },
        });

        // A Pool-backed resource of a Team the activation creator has no
        // standing in: it exists, its revision matches, and it would rank.
        const stranger = await db.account.create({ data: { encryptionMode: 'plain', username: `stranger-${randomUUID()}` } });
        const foreign = await materializationCredentialFixture(stranger.id, `foreign-${fixture.request.activationId}`);
        const foreignPool = await db.machinePool.create({ data: {
            id: randomUUID(),
            accountId: stranger.id,
            name: 'Foreign brokers',
            members: { create: [{ machineId: foreign.brokerMachine.id, priorityTier: 0, enabled: true }] },
        } });
        await db.teamCredentialResource.update({
            where: { id: foreign.resource.id },
            data: { brokerMachineId: null, brokerPoolId: foreignPool.id },
        });

        const application = {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' },
            endpointTemplateId: 'responses',
            protocol: 'openai-responses' as const,
        };
        const presenceReads: string[] = [];
        const eligibilityReads: string[] = [];
        const resolveFor = (selection: Readonly<{ resourceId: string; teamId: string; expectedResourceRevision: number }>) =>
            resolveRunnerCredentialSelection({
                creatorAccountId: fixture.account.id,
                activationId: fixture.request.activationId,
                request: {
                    v: 1 as const,
                    selection: {
                        kind: 'team_credential_provider_model' as const,
                        ...selection,
                        agentTargetKey: application.agentTargetKey,
                        modelId: 'gpt-5',
                        deliveryMode: 'brokered' as const,
                    },
                    application,
                    sourceRevision: 'source-revision-1',
                    plannedSession: { primaryTeamId: null, teamVisibilityTeamIds: [] },
                },
                authentication: presentUserAuthentication,
                signal: new AbortController().signal,
                readCurrentPresence: async (custodianAccountId) => {
                    presenceReads.push(custodianAccountId);
                    return { state: 'known', machineIds: new Set([foreign.brokerMachine.id]) };
                },
                readPoolSourceEligibility: async (eligibility) => {
                    eligibilityReads.push(eligibility.resourceId);
                    return { eligibleMachineIds: new Set(eligibility.machineIds), reasons: new Map() };
                },
                readProviderProjection: async () => { throw new Error('An unauthorized selection must not project a Provider'); },
            });

        const unauthorized = await resolveFor({
            resourceId: foreign.resource.id,
            teamId: foreign.team.id,
            expectedResourceRevision: foreign.resource.revision,
        });
        const missing = await resolveFor({
            resourceId: randomUUID(),
            teamId: foreign.team.id,
            expectedResourceRevision: foreign.resource.revision,
        });
        expect(unauthorized).toEqual({ v: 1, status: 'unavailable', reason: 'access_removed' });
        expect(missing).toEqual(unauthorized);
        expect(presenceReads).toEqual([]);
        expect(eligibilityReads).toEqual([]);
        await expect(db.ephemeralRunnerActivation.findUniqueOrThrow({
            where: { id: fixture.request.activationId },
            select: { credentialSelection: true },
        })).resolves.toEqual({ credentialSelection: null });
    });

    it('rejects dual-signed broker readiness facts that differ from the creator-reviewed application or model', async () => {
        const fixture = await materializationFixture();
        const facts = {
                v: 1,
                kind: 'provider_broker_readiness' as const,
                homeServerIdentityId: fixture.activationRequest.homeServerIdentityId,
                activationId: fixture.activationRequest.activationId,
                launchManifestCommitment: fixture.review.launchManifestCommitment,
                resourceId: fixture.review.credentialSelectionBinding.resourceId,
                agentTargetKey: 'agent:happier.agent.opencode/opencode',
                modelId: 'gpt-5',
                protocol: 'openai-responses' as const,
                initiator: {
                    installationId: fixture.claim.payload.installation.installationId,
                    endpointId: 'a'.repeat(64),
                },
                target: {
                    machineId: fixture.review.credentialSelectionBinding.brokerMachineId,
                    endpointId: 'b'.repeat(64),
                },
            } as const;
        const request = signRunnerBrokerReadinessRequestV1({
            facts,
            claim: fixture.claim,
            activationSecretKey: fixture.activationKey.secretKey,
            installationSecretKey: fixture.installationKey.secretKey,
        });

        await expect(inTx(tx => verifyRunnerBrokerReadinessCurrentnessInTx(tx, {
            activationId: fixture.activationRequest.activationId,
            request,
        }))).resolves.toBeNull();

        const wrongProtocol = signRunnerBrokerReadinessRequestV1({
            facts: {
                ...facts,
                agentTargetKey: fixture.review.credentialSelectionBinding.application.agentTargetKey,
                protocol: 'openai-chat',
            },
            claim: fixture.claim,
            activationSecretKey: fixture.activationKey.secretKey,
            installationSecretKey: fixture.installationKey.secretKey,
        });
        await expect(inTx(tx => verifyRunnerBrokerReadinessCurrentnessInTx(tx, {
            activationId: fixture.activationRequest.activationId,
            request: wrongProtocol,
        }))).resolves.toBeNull();

        const wrongModel = signRunnerBrokerReadinessRequestV1({
            facts: {
                ...facts,
                agentTargetKey: fixture.review.credentialSelectionBinding.application.agentTargetKey,
                modelId: 'substituted-model',
            },
            claim: fixture.claim,
            activationSecretKey: fixture.activationKey.secretKey,
            installationSecretKey: fixture.installationKey.secretKey,
        });
        await expect(inTx(tx => verifyRunnerBrokerReadinessCurrentnessInTx(tx, {
            activationId: fixture.activationRequest.activationId,
            request: wrongModel,
        }))).resolves.toBeNull();
    });

    it('rejects an absent Plain Runner Machine marker before writing materialized rows', async () => {
        const fixture = await materializationFixture();
        const validRequest = materializationRequest(fixture);

        await expect(materializeEphemeralRunner({
            creatorAccountId: fixture.account.id,
            request: {
                ...validRequest,
                machine: { ...validRequest.machine, dataEncryptionKey: null },
            },
            authentication: presentUserAuthentication,
            env: process.env,
        })).resolves.toEqual({ status: 'invalid_request' });
        await expect(db.session.count({ where: { id: fixture.created.activation.sessionId } })).resolves.toBe(0);
        await expect(db.machine.count({ where: { id: fixture.created.activation.machineId } })).resolves.toBe(0);
        await expect(db.accessKey.count({ where: { accountId: fixture.account.id } })).resolves.toBe(0);
    });

    it('materializes the reserved plain Session atomically and returns the exact result on retry', async () => {
        const fixture = await materializationFixture();
        const request = materializationRequest(fixture);
        await db.$executeRawUnsafe(`CREATE TRIGGER fail_runner_access_key BEFORE INSERT ON "AccessKey"
            BEGIN SELECT RAISE(ABORT, 'injected Runner AccessKey failure'); END`);
        try {
            await expect(materializeEphemeralRunner({ creatorAccountId: fixture.account.id, request, authentication: presentUserAuthentication, env: process.env }))
                .rejects.toThrow();
            await expect(db.session.count({ where: { accountId: fixture.account.id } })).resolves.toBe(0);
            await expect(db.machine.count({ where: { id: fixture.created.activation.machineId,
                accountId: fixture.account.id, kind: 'ephemeral_session_runner' } })).resolves.toBe(0);
            await expect(db.accessKey.count({ where: { accountId: fixture.account.id } })).resolves.toBe(0);
            await expect(db.ephemeralRunnerActivation.findUnique({ where: { id: request.activationId } }))
                .resolves.toMatchObject({ state: 'consented', sealedBootstrap: null });
        } finally {
            await db.$executeRawUnsafe('DROP TRIGGER fail_runner_access_key');
        }
        const first = await materializeEphemeralRunner({ creatorAccountId: fixture.account.id, request, authentication: presentUserAuthentication, env: process.env });
        expect(first).toEqual({ status: 'materialized', result: {
            v: 1, activationId: request.activationId,
            sessionId: fixture.created.activation.sessionId,
            machineId: fixture.created.activation.machineId,
        } });
        await expect(materializeEphemeralRunner({ creatorAccountId: fixture.account.id, request, authentication: presentUserAuthentication, env: process.env }))
            .resolves.toEqual(first);
        await expect(materializeEphemeralRunner({
            creatorAccountId: fixture.account.id,
            request: {
                ...request,
                session: {
                    ...request.session,
                    metadata: JSON.stringify({ v: 1, substitutedAfterMaterialization: true }),
                },
            },
            authentication: presentUserAuthentication,
            env: process.env,
        })).resolves.toEqual({ status: 'conflict', reason: 'binding_mismatch' });
        await expect(db.session.count({ where: { accountId: fixture.account.id } })).resolves.toBe(1);
        await expect(db.machine.count({ where: { accountId: fixture.account.id, kind: 'ephemeral_session_runner' } })).resolves.toBe(1);
        const machine = await db.machine.findFirst({
            where: { accountId: fixture.account.id, kind: 'ephemeral_session_runner' },
        });
        if (!machine) throw new Error('Expected the materialized Runner Machine');
        expect(machine.dataEncryptionKey === null
            ? null
            : Buffer.from(machine.dataEncryptionKey).toString('base64'))
            .toBe(MACHINE_PLAIN_DATA_KEY_MARKER);
        expect(machine.runnerContentKeyBinding).toBeNull();
        await expect(db.accessKey.count({ where: { accountId: fixture.account.id } })).resolves.toBe(1);

        // Continue through the ordinary runtime/presence owner instead of
        // treating committed rows as completion. A Runner Session must publish
        // normally, then explicit Stop atomically makes the Session inactive
        // and revokes only its ephemeral Machine credential. The ordinary
        // Session row remains readable after the endpoint is gone.
        const presence = createSessionPublisherPresence();
        const publisherSocket = {};
        const binding = {
            accountId: fixture.account.id,
            sessionId: fixture.created.activation.sessionId,
            machineId: fixture.created.activation.machineId,
        };
        const registered = await presence.registerPublisher({
            socket: publisherSocket,
            binding,
            completeActivitySnapshot: { state: 'active', activeCount: 1 },
        });
        expect(registered.status).toBe('registered');
        const captured = await presence.captureExplicitMachineStop({ binding });
        expect(captured.status).toBe('captured');
        if (captured.status !== 'captured') throw new Error('Expected Runner publisher Stop capture');
        await expect(presence.finalizeExplicitMachineStop({ target: captured.target }))
            .resolves.toMatchObject({ status: 'closed' });
        await expect(presence.finalizeExplicitMachineStop({ target: captured.target }))
            .resolves.toEqual({ status: 'already_inactive' });
        await expect(db.session.findUnique({ where: { id: binding.sessionId } }))
            .resolves.toMatchObject({ id: binding.sessionId, active: false, archivedAt: null });
        await expect(db.machine.findUnique({ where: { id: binding.machineId } }))
            .resolves.toMatchObject({ id: binding.machineId, active: false, revokedAt: expect.any(Date) });
        await expect(db.accessKey.count({ where: binding })).resolves.toBe(0);
    });

    it('acknowledges exact readiness after its lost response races materialization through the real endpoint client', async () => {
        // Load the real CLI client at runtime without pulling CLI source and its
        // private path aliases into the server TypeScript program.
        const controlClientPath = '../../../../cli/src/ephemeralRunner/controlClient';
        const { createEphemeralRunnerHttpControlConnection, EphemeralRunnerControlHttpError } =
            await import(controlClientPath) as RunnerControlClientFixtureModule;
        const fixture = await materializationFixture();
        const activationId = fixture.activationRequest.activationId;
        const app = await activationRouteApp();
        const readinessStatuses: number[] = [];
        const connection = createEphemeralRunnerHttpControlConnection({
            activationId,
            pollIntervalMs: 0,
            createProjectionProof: () => signRunnerEndpointProjectionProofV1({
                payload: {
                    v: 1, purpose: 'happier.ephemeral-session-runner.endpoint-projection',
                    activationId, sessionId: fixture.created.activation.sessionId,
                    machineId: fixture.created.activation.machineId,
                    creatorTokenEpoch: fixture.account.tokenEpoch,
                    launchManifestCommitment: fixture.review.launchManifestCommitment,
                },
                activationSecretKey: fixture.activationKey.secretKey,
                installationSecretKey: fixture.installationKey.secretKey,
            }),
            // HTTP delivery is the boundary: all schemas, signatures, routes,
            // row owners and the endpoint's retry logic remain real.
            request: async (path, init) => {
                const method = init.method;
                if (method !== 'PUT' && method !== 'POST' && method !== 'DELETE') throw new Error('Unexpected endpoint method');
                if (typeof init.body !== 'string') throw new Error('Expected endpoint JSON body');
                const response = await app.inject({
                    method, url: path, headers: { 'content-type': 'application/json' }, payload: init.body,
                });
                if (path.endsWith('/readiness')) {
                    readinessStatuses.push(response.statusCode);
                    if (readinessStatuses.length === 1) {
                        expect(response.statusCode).toBe(200);
                        expect(await materializeEphemeralRunner({
                            creatorAccountId: fixture.account.id, request: materializationRequest(fixture),
                            authentication: presentUserAuthentication, env: process.env,
                        })).toMatchObject({ status: 'materialized' });
                        throw new Error('Response lost after the readiness commit');
                    }
                }
                if (response.statusCode >= 400) throw new EphemeralRunnerControlHttpError(response.statusCode);
                return response.json();
            },
        });
        try {
            await expect(connection.submitReadiness({ readiness: fixture.readiness, signal: new AbortController().signal }))
                .resolves.toBeUndefined();
            expect(readinessStatuses).toEqual([200, 200]);
            await expect(connection.waitForMaterialization({
                launchManifestCommitment: fixture.review.launchManifestCommitment,
                signal: new AbortController().signal,
            })).resolves.toMatchObject({ status: 'materialized', sealedBootstrap: 'sealed-bootstrap-materialize' });
            const differentReadiness = signRunnerReadinessV1({
                payload: {
                    ...fixture.readiness.payload,
                    installation: { ...fixture.readiness.payload.installation, agentRuntimeId: 'different-runtime' },
                },
                activationSecretKey: fixture.activationKey.secretKey,
                installationSecretKey: fixture.installationKey.secretKey,
            });
            await expect(storeRunnerActivationReadiness({ activationId, readiness: differentReadiness }))
                .resolves.toEqual({ status: 'conflict' });
            await expect(connection.decline({ claim: fixture.claim, signal: new AbortController().signal }))
                .resolves.toEqual({ status: 'unavailable', reason: 'already_materialized' });

            await inTx(tx => revokeMaterializedEphemeralRunnerBindingInTx(tx, {
                accountId: fixture.account.id, sessionId: fixture.created.activation.sessionId,
                machineId: fixture.created.activation.machineId,
            }));
            await expect(storeRunnerActivationReadiness({ activationId, readiness: fixture.readiness }))
                .resolves.toEqual({ status: 'unavailable' });
            await expect(connection.waitForMaterialization({
                launchManifestCommitment: fixture.review.launchManifestCommitment,
                signal: new AbortController().signal,
            })).rejects.toThrow('runner_projection_unavailable:not_materialized');
        } finally {
            await connection.close();
            await app.close();
        }
    });

    it('does not acknowledge materialized readiness after creator credential revocation', async () => {
        const fixture = await materializationFixture();
        expect(await materializeEphemeralRunner({
            creatorAccountId: fixture.account.id, request: materializationRequest(fixture),
            authentication: presentUserAuthentication, env: process.env,
        })).toMatchObject({ status: 'materialized' });
        await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: { increment: 1 } } });
        await expect(storeRunnerActivationReadiness({
            activationId: fixture.activationRequest.activationId, readiness: fixture.readiness,
        })).resolves.toEqual({ status: 'unavailable' });
    });

    it('serializes creator cancellation against materialization without partial resources', async () => {
        const fixture = await materializationFixture();
        const request = materializationRequest(fixture);
        const token = await auth.createToken(fixture.account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = await activationRouteApp();
        try {
            const [canceled, materialized] = await Promise.all([
                app.inject({
                    method: 'DELETE',
                    url: `/v1/ephemeral-runners/activations/${request.activationId}`,
                    headers: { authorization: `Bearer ${token}` },
                }),
                materializeEphemeralRunner({
                    creatorAccountId: fixture.account.id,
                    request,
                    authentication: presentUserAuthentication,
                    env: process.env,
                }),
            ]);
            expect(canceled.statusCode).toBe(200);
            const activation = await db.ephemeralRunnerActivation.findUniqueOrThrow({ where: { id: request.activationId } });
            const resources = await Promise.all([
                db.session.count({ where: { id: fixture.created.activation.sessionId } }),
                db.machine.count({ where: { id: fixture.created.activation.machineId } }),
                db.accessKey.count({ where: {
                    accountId: fixture.account.id,
                    sessionId: fixture.created.activation.sessionId,
                    machineId: fixture.created.activation.machineId,
                } }),
            ]);
            if (activation.state === 'materialized') {
                expect(materialized).toMatchObject({ status: 'materialized' });
                expect(canceled.json()).toMatchObject({ state: 'materialized', closeReason: null });
                expect(resources).toEqual([1, 1, 1]);
            } else {
                expect(activation).toMatchObject({ state: 'closed', closeReason: 'canceled' });
                expect(materialized).toEqual({ status: 'unavailable', reason: 'activation_closed' });
                expect(canceled.json()).toMatchObject({ state: 'closed', closeReason: 'canceled' });
                expect(resources).toEqual([0, 0, 0]);
            }
        } finally {
            await app.close();
        }
    });

    it('materializes initial access for another Account through the canonical Session audience', async () => {
        const fixture = await materializationFixture('plain');
        const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.teamMembership.create({ data: { teamId: fixture.team.id, accountId: viewer.id, role: 'member' } });
        const baseRequest = materializationRequest(fixture);
        const request = { ...baseRequest, session: { ...baseRequest.session, initialAccess: { grants: [{
            subject: { kind: 'account' as const, accountId: viewer.id }, accessLevel: 'view' as const,
            canApprovePermissions: false,
        }] } } };
        expect(await materializeEphemeralRunner({ creatorAccountId: fixture.account.id, request,
            authentication: presentUserAuthentication, env: process.env })).toMatchObject({ status: 'materialized' });
        expect(await db.sessionGrant.findFirst({ where: { principalKind: 'account',
            sessionId: fixture.created.activation.sessionId, accountId: viewer.id,
        } })).toMatchObject({ accessLevel: 'view' });
        expect(await db.accountChange.findFirst({ where: { accountId: viewer.id,
            kind: 'session', entityId: fixture.created.activation.sessionId } })).toMatchObject({ accountId: viewer.id });
    });

    it.each([
        ['Session row', 'AFTER INSERT ON "Session"'],
        ['owner DEK tuple', 'AFTER INSERT ON "SessionDataKeyEnvelope"'],
        ['owner read state', 'AFTER INSERT ON "AccountSessionReadState"'],
        ['required Team access', `AFTER INSERT ON "SessionShare" WHEN NEW."principalKind" = 'team'`],
        ['Session publication', 'AFTER INSERT ON "AccountChange" WHEN NEW."kind" = \'session\''],
        ['Runner Machine', 'AFTER INSERT ON "Machine" WHEN NEW."kind" = \'ephemeral_session_runner\''],
        ['Machine publication', 'AFTER INSERT ON "AccountChange" WHEN NEW."kind" = \'machine\''],
        ['AccessKey tuple', 'AFTER INSERT ON "AccessKey"'],
        ['activation transition', 'AFTER UPDATE OF "state" ON "EphemeralRunnerActivation" WHEN NEW."state" = \'materialized\''],
    ] as const)('rolls the complete materialization tuple back after an injected %s mutation failure', async (_boundary, triggerTarget) => {
        const fixture = await materializationFixture('e2ee');
        await db.team.update({
            where: { id: fixture.team.id },
            data: { sessionCreationPolicy: 'team_required' },
        });
        const baseRequest = materializationRequest(fixture);
        const request = {
            ...baseRequest,
            session: { ...baseRequest.session, primaryTeamId: fixture.team.id },
        };
        const triggerName = `fail_runner_boundary_${randomUUID().replace(/-/g, '_')}`;
        await db.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" ${triggerTarget}
            BEGIN SELECT RAISE(ABORT, 'injected Runner materialization boundary failure'); END`);
        try {
            await expect(materializeEphemeralRunner({
                creatorAccountId: fixture.account.id,
                request,
                authentication: presentUserAuthentication,
                env: process.env,
            })).rejects.toThrow();
        } finally {
            await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}"`);
        }

        const binding = {
            accountId: fixture.account.id,
            sessionId: fixture.created.activation.sessionId,
            machineId: fixture.created.activation.machineId,
        };
        await expect(db.session.count({ where: { id: binding.sessionId } })).resolves.toBe(0);
        await expect(db.sessionDataKeyEnvelope.count({ where: { sessionId: binding.sessionId } })).resolves.toBe(0);
        await expect(db.accountSessionReadState.count({ where: { sessionId: binding.sessionId } })).resolves.toBe(0);
        await expect(db.sessionGrant.count({ where: { principalKind: 'team', sessionId: binding.sessionId } })).resolves.toBe(0);
        await expect(db.machine.count({ where: { id: binding.machineId } })).resolves.toBe(0);
        await expect(db.accessKey.count({ where: binding })).resolves.toBe(0);
        await expect(db.ephemeralRunnerActivation.findUnique({ where: { id: request.activationId } }))
            .resolves.toMatchObject({ state: 'consented', sealedBootstrap: null });
    });

    it('refuses an E2EE materialization with no Session owner envelope, before any row exists', async () => {
        const fixture = await materializationFixture('e2ee');
        const baseRequest = materializationRequest(fixture);

        // Runner bootstrap always mints a fresh Session key, so no legitimate
        // Runner producer can ask for E2EE without its owner envelope. Admitting
        // it would create a Session whose transcript nobody can ever read.
        await expect(materializeEphemeralRunner({
            creatorAccountId: fixture.account.id,
            request: { ...baseRequest, session: { ...baseRequest.session, dataEncryptionKey: null } },
            authentication: presentUserAuthentication,
            env: process.env,
        })).resolves.toEqual({ status: 'invalid_request' });

        const binding = {
            accountId: fixture.account.id,
            sessionId: fixture.created.activation.sessionId,
            machineId: fixture.created.activation.machineId,
        };
        await expect(db.session.count({ where: { id: binding.sessionId } })).resolves.toBe(0);
        await expect(db.sessionDataKeyEnvelope.count({ where: { sessionId: binding.sessionId } })).resolves.toBe(0);
        await expect(db.machine.count({ where: { id: binding.machineId } })).resolves.toBe(0);
        await expect(db.accessKey.count({ where: binding })).resolves.toBe(0);

        // The released Plain keyless path is untouched.
        const plain = await materializationFixture();
        await expect(materializeEphemeralRunner({
            creatorAccountId: plain.account.id,
            request: materializationRequest(plain),
            authentication: presentUserAuthentication,
            env: process.env,
        })).resolves.toMatchObject({ status: 'materialized' });
    });

    it('answers a constructor refusal with a typed conflict instead of an unexpected failure', async () => {
        const fixture = await materializationFixture('e2ee');
        const baseRequest = materializationRequest(fixture);

        // The folder was reviewed but removed before the endpoint submitted. The
        // shared constructor throws that refusal so its own transaction rolls
        // back; the Runner route must classify it, not surface it as a 500.
        await expect(materializeEphemeralRunner({
            creatorAccountId: fixture.account.id,
            request: {
                ...baseRequest,
                session: {
                    ...baseRequest.session,
                    organizationPlacement: { folderId: '00000000-0000-4000-8000-0000000000f0', tagIds: [] },
                },
            },
            authentication: presentUserAuthentication,
            env: process.env,
        })).resolves.toEqual({ status: 'conflict', reason: 'session_create_rejected' });

        const binding = {
            accountId: fixture.account.id,
            sessionId: fixture.created.activation.sessionId,
            machineId: fixture.created.activation.machineId,
        };
        await expect(db.session.count({ where: { id: binding.sessionId } })).resolves.toBe(0);
        await expect(db.machine.count({ where: { id: binding.machineId } })).resolves.toBe(0);
        await expect(db.accessKey.count({ where: binding })).resolves.toBe(0);
    });

    it('materializes the canonical team_required edit grant without permission delegation', async () => {
        const fixture = await materializationFixture('e2ee');
        await db.team.update({
            where: { id: fixture.team.id },
            data: { sessionCreationPolicy: 'team_required' },
        });
        const baseRequest = materializationRequest(fixture);
        const request = {
            ...baseRequest,
            session: { ...baseRequest.session, primaryTeamId: fixture.team.id },
        };

        await expect(materializeEphemeralRunner({
            creatorAccountId: fixture.account.id,
            request,
            authentication: presentUserAuthentication,
            env: process.env,
        })).resolves.toMatchObject({ status: 'materialized' });
        await expect(db.sessionGrant.findUniqueOrThrow({
            where: { principalKind: 'team',
                sessionId_teamId: {
                    sessionId: fixture.created.activation.sessionId,
                    teamId: fixture.team.id,
                },
            },
        })).resolves.toMatchObject({
            accessLevel: 'edit',
            canApprovePermissions: false,
            requiredByTeamPolicy: true,
        });
    });

    it('discloses a published review to the proof the endpoint can actually sign, and never a materialized secret', async () => {
        const fixture = await materializationFixture();
        const activationId = fixture.activationRequest.activationId;
        const proof = (launchManifestCommitment: string | null) => signRunnerEndpointProjectionProofV1({
            payload: {
                v: 1,
                purpose: 'happier.ephemeral-session-runner.endpoint-projection',
                activationId,
                sessionId: fixture.created.activation.sessionId,
                machineId: fixture.created.activation.machineId,
                launchManifestCommitment,
                creatorTokenEpoch: fixture.account.tokenEpoch,
            },
            activationSecretKey: fixture.activationKey.secretKey,
            installationSecretKey: fixture.installationKey.secretKey,
        });

        // The endpoint learns the commitment only by opening the sealed manifest
        // carried inside this very response, so its first poll after the creator
        // publishes a review necessarily carries none.
        await db.ephemeralRunnerActivation.update({ where: { id: activationId }, data: { state: 'claimed', consent: null, readiness: null } });
        const discovered = await readEphemeralRunnerEndpointProjection({ activationId, request: proof(null) });
        expect(discovered).toMatchObject({ status: 'pending' });
        if (discovered.status !== 'pending') throw new Error('Expected a pending Runner endpoint projection');
        expect(discovered.activation.review).not.toBeNull();
        await expect(readEphemeralRunnerEndpointProjection({
            activationId,
            request: proof(encodeBase64(new Uint8Array(32).fill(7), 'base64url')),
        })).resolves.toEqual({ status: 'conflict', reason: 'proof_mismatch' });

        // Once the endpoint has consented it knows the commitment, so the exact
        // commitment is mandatory again for every later disclosure.
        expect(await storeRunnerActivationConsent({ activationId, consent: fixture.consent })).toMatchObject({ status: 'stored' });
        expect(await storeRunnerActivationReadiness({ activationId, readiness: fixture.readiness })).toMatchObject({ status: 'stored' });
        await expect(readEphemeralRunnerEndpointProjection({ activationId, request: proof(null) }))
            .resolves.toEqual({ status: 'conflict', reason: 'proof_mismatch' });

        await expect(materializeEphemeralRunner({
            creatorAccountId: fixture.account.id,
            request: materializationRequest(fixture),
            authentication: presentUserAuthentication,
            env: process.env,
        })).resolves.toMatchObject({ status: 'materialized' });
        await expect(readEphemeralRunnerEndpointProjection({ activationId, request: proof(null) }))
            .resolves.toEqual({ status: 'conflict', reason: 'proof_mismatch' });
        await expect(readEphemeralRunnerEndpointProjection({
            activationId,
            request: proof(fixture.review.launchManifestCommitment),
        })).resolves.toMatchObject({ status: 'materialized' });
    });

    it('materializes restricted Team work only from the exact explicitly authorized activation snapshot', async () => {
        const authorized = await materializationFixture('e2ee', true);
        await expect(materializeEphemeralRunner({
            creatorAccountId: authorized.account.id,
            request: materializationRequest(authorized),
            authentication: presentUserAuthentication,
            env: process.env,
        })).resolves.toMatchObject({ status: 'materialized' });
        const projection = await readEphemeralRunnerEndpointProjection({
            activationId: authorized.activationRequest.activationId,
            request: signRunnerEndpointProjectionProofV1({
                payload: {
                    v: 1,
                    purpose: 'happier.ephemeral-session-runner.endpoint-projection',
                    activationId: authorized.activationRequest.activationId,
                    sessionId: authorized.created.activation.sessionId,
                    machineId: authorized.created.activation.machineId,
                    launchManifestCommitment: authorized.review.launchManifestCommitment,
                    creatorTokenEpoch: authorized.account.tokenEpoch,
                },
                activationSecretKey: authorized.activationKey.secretKey,
                installationSecretKey: authorized.installationKey.secretKey,
            }),
        });
        expect(projection).toMatchObject({ status: 'materialized' });
        if (projection.status !== 'materialized') throw new Error('Expected materialized Runner endpoint projection');
        await expect(auth.verifyToken(projection.runtimeToken)).resolves.toMatchObject({
            authTokenKind: 'ephemeral_session_runner',
            authority: 'session_runtime',
            authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }],
            ephemeralSessionRunnerPrincipal: {
                activationId: authorized.activationRequest.activationId,
                sessionId: authorized.created.activation.sessionId,
                machineId: authorized.created.activation.machineId,
                installationId: authorized.claim.payload.installation.installationId,
            },
        });
        await db.ephemeralRunnerActivation.update({
            where: { id: authorized.activationRequest.activationId },
            data: { authenticationEvidence: {
                v: 1,
                evidence: [{ kind: 'home_method', methodId: 'email_password' }],
            } },
        });
        const personalOnlyProjection = await readEphemeralRunnerEndpointProjection({
            activationId: authorized.activationRequest.activationId,
            request: signRunnerEndpointProjectionProofV1({
                payload: {
                    v: 1,
                    purpose: 'happier.ephemeral-session-runner.endpoint-projection',
                    activationId: authorized.activationRequest.activationId,
                    sessionId: authorized.created.activation.sessionId,
                    machineId: authorized.created.activation.machineId,
                    launchManifestCommitment: authorized.review.launchManifestCommitment,
                    creatorTokenEpoch: authorized.account.tokenEpoch,
                },
                activationSecretKey: authorized.activationKey.secretKey,
                installationSecretKey: authorized.installationKey.secretKey,
            }),
        });
        expect(personalOnlyProjection).toMatchObject({ status: 'materialized' });
        if (personalOnlyProjection.status !== 'materialized') throw new Error('Expected personal-only Runner endpoint projection');
        await expect(auth.verifyToken(personalOnlyProjection.runtimeToken)).resolves.not.toHaveProperty('authenticationEvidence');

        const omitted = await materializationFixture();
        await db.team.update({ where: { id: omitted.team.id }, data: { authenticationPolicy: {
            v: 1,
            mode: 'restricted',
            accepted: [{ kind: 'home_method', methodId: 'key_challenge' }],
        } } });
        await expect(materializeEphemeralRunner({
            creatorAccountId: omitted.account.id,
            request: materializationRequest(omitted),
            authentication: {
                ...presentUserAuthentication,
                authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }],
            },
            env: process.env,
        })).resolves.toEqual({ status: 'unavailable', reason: 'readiness_required' });
        await expect(db.session.count({ where: { id: omitted.created.activation.sessionId } })).resolves.toBe(0);
    });

    it.each([
        ['resource revision', async (fixture: Awaited<ReturnType<typeof materializationFixture>>) => {
            await db.teamCredentialResource.update({ where: { id: fixture.resource.id }, data: { revision: { increment: 1 } } });
        }],
        ['creator entitlement', async (fixture: Awaited<ReturnType<typeof materializationFixture>>) => {
            await db.teamMembership.deleteMany({ where: { teamId: fixture.team.id, accountId: fixture.account.id } });
        }],
        ['source currentness', async (fixture: Awaited<ReturnType<typeof materializationFixture>>) => {
            await db.teamCredentialResource.update({ where: { id: fixture.resource.id }, data: { sourceBindingJson: '{}' } });
        }],
        ['broker Machine lifetime', async (fixture: Awaited<ReturnType<typeof materializationFixture>>) => {
            await db.machine.update({ where: { id: fixture.brokerMachine.id }, data: { revokedAt: new Date() } });
        }],
        ['broker capability', async (fixture: Awaited<ReturnType<typeof materializationFixture>>) => {
            await db.machine.update({ where: { id: fixture.brokerMachine.id }, data: {
                operationProtocolCapabilities: {
                    irohMachineEndpoint: { protocolVersions: [1], endpointId: fixture.brokerEndpointId },
                },
                operationProtocolCapabilitiesRevision: { increment: 1 },
            } });
        }],
        ['broker endpoint identity', async (fixture: Awaited<ReturnType<typeof materializationFixture>>) => {
            await db.machine.update({ where: { id: fixture.brokerMachine.id }, data: {
                operationProtocolCapabilities: {
                    providerBrokerIngress: { protocolVersions: [1] },
                    irohMachineEndpoint: { protocolVersions: [1], endpointId: 'c'.repeat(64) },
                },
                operationProtocolCapabilitiesRevision: { increment: 1 },
            } });
        }],
    ] as const)('revalidates %s before writing any materialized rows', async (_name, change) => {
        const fixture = await materializationFixture();
        const request = materializationRequest(fixture);
        await change(fixture);

        await expect(materializeEphemeralRunner({
            creatorAccountId: fixture.account.id,
            request,
            authentication: presentUserAuthentication,
            env: process.env,
        })).resolves.toEqual({ status: 'unavailable', reason: 'readiness_required' });
        await expect(db.session.count({ where: { id: fixture.created.activation.sessionId } })).resolves.toBe(0);
        await expect(db.machine.count({ where: { id: fixture.created.activation.machineId } })).resolves.toBe(0);
        await expect(db.accessKey.count({ where: {
            accountId: fixture.account.id,
            sessionId: fixture.created.activation.sessionId,
            machineId: fixture.created.activation.machineId,
        } })).resolves.toBe(0);
        await expect(db.ephemeralRunnerActivation.findUnique({ where: { id: request.activationId } }))
            .resolves.toMatchObject({ state: 'consented', sealedBootstrap: null });
    });

    it('materializes an E2EE Runner Session with its owner envelope and reviewed scoped Machine key', async () => {
        const fixture = await materializationFixture('e2ee');
        const request = materializationRequest(fixture);
        const { sessionId, machineId } = fixture.created.activation;

        await expect(materializeEphemeralRunner({
            creatorAccountId: fixture.account.id,
            request,
            authentication: presentUserAuthentication,
            env: process.env,
        })).resolves.toEqual({ status: 'materialized', result: {
            v: 1, activationId: request.activationId, sessionId, machineId,
        } });

        // The shared Session constructor owns the Session row, its canonical owner
        // DEK tuple and owner read state; Runner adds no second envelope writer.
        await expect(db.session.findUnique({ where: { id: sessionId } }))
            .resolves.toMatchObject({ accountId: fixture.account.id, encryptionMode: 'e2ee' });
        await expect(db.sessionDataKeyEnvelope.count({
            where: { sessionId, recipientAccountId: fixture.account.id },
        })).resolves.toBe(1);
        const machine = await db.machine.findUnique({ where: { id: machineId } });
        expect(machine).toMatchObject({ accountId: fixture.account.id, kind: 'ephemeral_session_runner' });
        expect(machine?.runnerContentKeyBinding).toEqual(fixture.review.machineContentKeyBinding);
        expect(machine?.dataEncryptionKey).not.toBeNull();
        await expect(db.accessKey.count({ where: { accountId: fixture.account.id, sessionId, machineId } })).resolves.toBe(1);
        await expect(db.ephemeralRunnerActivation.findUnique({ where: { id: request.activationId } }))
            .resolves.toMatchObject({ state: 'materialized' });
    });

    it('refuses a scoped Machine content key the creator never reviewed and writes no rows', async () => {
        const fixture = await materializationFixture('e2ee');
        const substituted = signRunnerMachineContentKeyBindingV1({
            payload: {
                ...fixture.machineContentKeyBindingPayload,
                machineContentKeyFingerprint: computeRunnerMachineContentKeyFingerprintV1(new Uint8Array(32).fill(77)),
            },
            activationSigningSecretKey: fixture.activationKey.secretKey,
        });
        const base = materializationRequest(fixture);
        const request = { ...base, machine: { ...base.machine, runnerContentKeyBinding: substituted } };

        // A correctly creator-signed binding is still not the reviewed one.
        await expect(materializeEphemeralRunner({
            creatorAccountId: fixture.account.id,
            request,
            authentication: presentUserAuthentication,
            env: process.env,
        })).resolves.toEqual({ status: 'conflict', reason: 'encryption_mismatch' });
        await expect(db.session.count({ where: { id: fixture.created.activation.sessionId } })).resolves.toBe(0);
        await expect(db.machine.count({ where: { id: fixture.created.activation.machineId } })).resolves.toBe(0);
        await expect(db.accessKey.count({ where: { accountId: fixture.account.id } })).resolves.toBe(0);
    });

    it.each([
        ['creator token epoch revocation', 'revoked', 'activation_closed', async (fixture: Awaited<ReturnType<typeof materializationFixture>>) => {
            await db.account.update({ where: { id: fixture.account.id }, data: { tokenEpoch: { increment: 1 } } });
        }],
        ['elapsed optional activation expiry', 'expired', 'activation_expired', async (fixture: Awaited<ReturnType<typeof materializationFixture>>) => {
            await db.ephemeralRunnerActivation.update({
                where: { id: fixture.activationRequest.activationId },
                data: { activationExpiresAt: new Date(Date.now() - 1_000) },
            });
        }],
    ] as const)('acknowledges %s at materialization and writes no rows', async (_name, closeReason, expectedReason, change) => {
        const fixture = await materializationFixture();
        const request = materializationRequest(fixture);
        await change(fixture);

        await expect(materializeEphemeralRunner({
            creatorAccountId: fixture.account.id,
            request,
            authentication: presentUserAuthentication,
            env: process.env,
        })).resolves.toEqual({ status: 'unavailable', reason: expectedReason });
        await expect(db.ephemeralRunnerActivation.findUnique({ where: { id: request.activationId } }))
            .resolves.toMatchObject({ state: 'closed', closeReason, sealedBootstrap: null });
        await expect(db.session.count({ where: { id: fixture.created.activation.sessionId } })).resolves.toBe(0);
        await expect(db.machine.count({ where: { id: fixture.created.activation.machineId } })).resolves.toBe(0);
        await expect(db.accessKey.count({ where: { accountId: fixture.account.id } })).resolves.toBe(0);
    });

    it.each([
        ['consent', 'consent_required', (request: ReturnType<typeof materializationRequest>) => ({
            ...request,
            consent: { ...request.consent, activationSignature: encodeBase64(new Uint8Array(64).fill(9), 'base64url') },
        })],
        ['readiness', 'readiness_required', (request: ReturnType<typeof materializationRequest>) => ({
            ...request,
            readiness: { ...request.readiness, installationSignature: encodeBase64(new Uint8Array(64).fill(9), 'base64url') },
        })],
    ] as const)('refuses a substituted %s proof before writing any materialized rows', async (_name, expectedReason, substitute) => {
        const fixture = await materializationFixture();

        await expect(materializeEphemeralRunner({
            creatorAccountId: fixture.account.id,
            request: substitute(materializationRequest(fixture)),
            authentication: presentUserAuthentication,
            env: process.env,
        })).resolves.toEqual({ status: 'unavailable', reason: expectedReason });
        await expect(db.session.count({ where: { id: fixture.created.activation.sessionId } })).resolves.toBe(0);
        await expect(db.machine.count({ where: { id: fixture.created.activation.machineId } })).resolves.toBe(0);
        await expect(db.accessKey.count({ where: { accountId: fixture.account.id } })).resolves.toBe(0);
        await expect(db.ephemeralRunnerActivation.findUnique({ where: { id: fixture.activationRequest.activationId } }))
            .resolves.toMatchObject({ state: 'consented', sealedBootstrap: null });
    });

    it('revalidates the signed installed Agent target from durable readiness immediately before materialization', async () => {
        const fixture = await materializationFixture();
        const readiness = signRunnerReadinessV1({
            payload: {
                ...fixture.readiness.payload,
                installation: {
                    ...fixture.readiness.payload.installation,
                    agentTarget: {
                        kind: 'agent',
                        identity: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
                    },
                },
            },
            activationSecretKey: fixture.activationKey.secretKey,
            installationSecretKey: fixture.installationKey.secretKey,
        });
        await db.ephemeralRunnerActivation.update({
            where: { id: fixture.activationRequest.activationId },
            data: { readiness },
        });

        await expect(materializeEphemeralRunner({
            creatorAccountId: fixture.account.id,
            request: { ...materializationRequest(fixture), readiness },
            authentication: presentUserAuthentication,
            env: process.env,
        })).resolves.toEqual({ status: 'unavailable', reason: 'readiness_required' });
        await expect(db.session.count({ where: { id: fixture.created.activation.sessionId } })).resolves.toBe(0);
        await expect(db.machine.count({ where: { id: fixture.created.activation.machineId } })).resolves.toBe(0);
        await expect(db.accessKey.count({ where: { accountId: fixture.account.id } })).resolves.toBe(0);
        await expect(db.ephemeralRunnerActivation.findUnique({ where: { id: fixture.activationRequest.activationId } }))
            .resolves.toMatchObject({ state: 'consented', sealedBootstrap: null });
    });

    it('refuses a substituted launch manifest commitment before writing any materialized rows', async () => {
        const fixture = await materializationFixture();
        const request = {
            ...materializationRequest(fixture),
            launchManifestCommitment: encodeBase64(new Uint8Array(32).fill(62), 'base64url'),
        };

        await expect(materializeEphemeralRunner({
            creatorAccountId: fixture.account.id,
            request,
            authentication: presentUserAuthentication,
            env: process.env,
        })).resolves.toEqual({ status: 'conflict', reason: 'manifest_mismatch' });
        await expect(db.session.count({ where: { id: fixture.created.activation.sessionId } })).resolves.toBe(0);
        await expect(db.machine.count({ where: { id: fixture.created.activation.machineId } })).resolves.toBe(0);
        await expect(db.accessKey.count({ where: { accountId: fixture.account.id } })).resolves.toBe(0);
    });

    it('refuses materialization when the stored review no longer matches the activation authoring commitment', async () => {
        const fixture = await materializationFixture();
        await db.ephemeralRunnerActivation.update({
            where: { id: fixture.activationRequest.activationId },
            data: {
                review: {
                    ...fixture.review,
                    authoringCommitment: encodeBase64(new Uint8Array(32).fill(62), 'base64url'),
                },
            },
        });

        await expect(materializeEphemeralRunner({
            creatorAccountId: fixture.account.id,
            request: materializationRequest(fixture),
            authentication: presentUserAuthentication,
            env: process.env,
        })).resolves.toEqual({ status: 'conflict', reason: 'manifest_mismatch' });
        await expect(db.session.count({ where: { id: fixture.created.activation.sessionId } })).resolves.toBe(0);
        await expect(db.machine.count({ where: { id: fixture.created.activation.machineId } })).resolves.toBe(0);
        await expect(db.accessKey.count({ where: { accountId: fixture.account.id } })).resolves.toBe(0);
    });

    it('projects the one endpoint-reported phase and refuses substituted or terminal updates', async () => {
        const fixture = await materializationFixture();
        const update = (phase: RunnerActivationProgressPhaseV1) =>
            signRunnerActivationProgressUpdateV1({
                payload: {
                    v: 1,
                    purpose: 'happier.ephemeral-session-runner.activation-progress',
                    activationId: fixture.activationRequest.activationId,
                    sessionId: fixture.created.activation.sessionId,
                    machineId: fixture.created.activation.machineId,
                    creatorTokenEpoch: fixture.created.activation.creatorTokenEpoch,
                    phase,
                },
                activationSecretKey: fixture.activationKey.secretKey,
                installationSecretKey: fixture.installationKey.secretKey,
            });

        await expect(storeRunnerActivationPhase({
            activationId: fixture.activationRequest.activationId,
            update: update('checking_ai_access'),
        })).resolves.toEqual({ status: 'stored', value: 'checking_ai_access' });
        await expect(readEphemeralRunnerActivation({
            creatorAccountId: fixture.account.id,
            activationId: fixture.activationRequest.activationId,
        })).resolves.toMatchObject({ progressPhase: 'checking_ai_access' });
        // Re-reporting the same phase is idempotent; there is no second phase
        // left to arbitrate an ordering against.
        await expect(storeRunnerActivationPhase({
            activationId: fixture.activationRequest.activationId,
            update: update('checking_ai_access'),
        })).resolves.toEqual({ status: 'stored', value: 'checking_ai_access' });
        const substituted = update('checking_ai_access');
        await expect(storeRunnerActivationPhase({
            activationId: fixture.activationRequest.activationId,
            update: { ...substituted, payload: { ...substituted.payload, machineId: 'machine-substituted' } },
        })).resolves.toEqual({ status: 'invalid_proof' });

        await db.ephemeralRunnerActivation.update({
            where: { id: fixture.activationRequest.activationId },
            data: { state: 'closed', closeReason: 'canceled' },
        });
        await expect(storeRunnerActivationPhase({
            activationId: fixture.activationRequest.activationId,
            update: update('checking_ai_access'),
        })).resolves.toEqual({ status: 'unavailable' });
        await expect(db.ephemeralRunnerActivation.findUnique({
            where: { id: fixture.activationRequest.activationId },
        })).resolves.toMatchObject({ state: 'closed', progressPhase: 'checking_ai_access' });
    });

    it.each([
        ['canceled', 'activation_closed'],
        ['expired', 'activation_expired'],
    ] as const)('reports a closed %s activation truthfully at materialization', async (closeReason, expectedReason) => {
        const fixture = await materializationFixture();
        await db.ephemeralRunnerActivation.update({
            where: { id: fixture.activationRequest.activationId },
            data: { state: 'closed', closeReason },
        });
        await expect(materializeEphemeralRunner({
            creatorAccountId: fixture.account.id,
            request: {
                v: 1,
                activationId: fixture.activationRequest.activationId,
                launchManifestCommitment: fixture.review.launchManifestCommitment,
                consent: fixture.consent,
                readiness: fixture.readiness,
                sealedBootstrap: 'sealed-bootstrap-closed',
                session: {
                    tag: `runner-${fixture.activationRequest.activationId}`,
                    metadata: JSON.stringify({ v: 1 }),
                    ownerMetadata: { t: 'plain', v: { v: 1 } },
                    agentState: null,
                    dataEncryptionKey: null,
                    requestedEncryptionMode: 'plain',
                },
                machine: { metadata: encodePlainMachineStoredContent({ v: 1 }), dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, runnerContentKeyBinding: null },
                accessKeyData: 'sealed-runner-access-key',
            },
            authentication: presentUserAuthentication,
            env: process.env,
        })).resolves.toEqual({ status: 'unavailable', reason: expectedReason });
    });

    it.each(['plain', 'e2ee'] as const)('stores proof-bound %s endpoint facts and returns the same signed content only to the creator', async (mode) => {
        const recipientKey = tweetnacl.box.keyPair();
        const { account, request, options, activationKey, accountSigningKey } = await activationFixture(mode, recipientKey.publicKey);
        const created = await createEphemeralRunnerActivation({
            creatorAccountId: account.id,
            request: mode === 'e2ee' ? { ...request, authorizeUnattendedTeamAccess: true } : request,
            authentication: mode === 'e2ee'
                ? {
                    ...presentUserAuthentication,
                    authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }],
                }
                : presentUserAuthentication,
        }, options);
        if (created.status !== 'created') throw new Error('Activation setup failed');
        const installationKey = tweetnacl.sign.keyPair();
        const claim = signRunnerClaimV1({ payload: runnerClaimPayload(runnerActivationProjectionBindingV1(created.activation), installationKey), activationSecretKey: activationKey.secretKey });
        const factsContent = (directory: string) => ({
            v: 1 as const,
            directory,
            machine: {
                host: 'runner.example.test',
                platform: 'linux' as const,
                happyCliVersion: '0.3.0',
                happyHomeDir: '/runner/home',
                homeDir: '/runner/home',
            },
        });
        const createContent = (directory: string) => mode === 'plain'
            ? { t: 'plain' as const, v: factsContent(directory) }
            : { t: 'encrypted' as const, c: encodeBase64(sealBoxBundle({ plaintext: new TextEncoder().encode(JSON.stringify(factsContent(directory))), recipientPublicKey: recipientKey.publicKey, randomBytes: tweetnacl.randomBytes }), 'base64url') };
        const content = createContent('/work/selected-project');
        const facts = signRunnerEndpointFactsV1({
            payload: { v: 1, purpose: 'happier.ephemeral-session-runner.endpoint-facts', claim: claim.payload, content },
            activationSecretKey: activationKey.secretKey, installationSecretKey: installationKey.secretKey,
        });
        const payload = facts.payload;
        const app = await activationRouteApp({ ...process.env, HAPPIER_SERVER_IDENTITY_ID: options.homeServerIdentityId });
        const factsUrl = `/v1/ephemeral-runners/activations/${request.activationId}/endpoint/facts`;
        const creatorHeaders = { authorization: `Bearer ${await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' })}` };
        try {
            expect((await app.inject({ method: 'PUT', url: factsUrl, payload: facts })).statusCode).toBe(404);
            expect(await claimEphemeralRunnerActivation({ activationId: request.activationId, claim }, options)).toMatchObject({ status: 'claimed' });
            const stored = await app.inject({ method: 'PUT', url: factsUrl, payload: facts });
            expect(stored.statusCode).toBe(200);
            expect(stored.json()).toEqual({ status: 'stored', endpointFacts: facts });
            expect((await app.inject({ method: 'PUT', url: factsUrl, payload: facts })).json()).toEqual(stored.json());
            const creator = await app.inject({ method: 'GET', url: `/v1/ephemeral-runners/activations/${request.activationId}`, headers: creatorHeaders });
            expect(creator.json()).toMatchObject({ endpointFacts: { status: 'available', facts } });
            if (content.t === 'encrypted') {
                expect(creator.body).not.toContain('/work/selected-project');
                const opened = openBoxBundleWithSecretKey({ bundle: decodeBase64(content.c, 'base64url'), recipientSecretKey: recipientKey.secretKey });
                expect(opened && JSON.parse(new TextDecoder().decode(opened))).toEqual(factsContent('/work/selected-project'));
            }
            expect((await app.inject({ method: 'PUT', url: factsUrl, payload: { ...facts, installationSignature: facts.activationSignature } })).statusCode).toBe(404);
            expect((await app.inject({ method: 'PUT', url: factsUrl, payload: { ...facts, payload: { ...payload, content: { t: 'plain', v: factsContent('/work/substituted') } } } })).statusCode).toBe(404);
            const loser = signRunnerEndpointFactsV1({ payload: { ...payload, content: createContent('/work/loser-package') },
                activationSecretKey: activationKey.secretKey, installationSecretKey: tweetnacl.sign.keyPair().secretKey });
            expect((await app.inject({ method: 'PUT', url: factsUrl, payload: loser })).statusCode).toBe(404);
            expect((await app.inject({ method: 'PUT', url: factsUrl, payload: { ...facts, payload: { ...payload, unexpected: true } } })).statusCode).toBe(400);
            const wrongMode = signRunnerEndpointFactsV1({ payload: { ...payload, content: mode === 'plain'
                ? { t: 'encrypted', c: encodeBase64(sealBoxBundle({ plaintext: new TextEncoder().encode('{}'), recipientPublicKey: recipientKey.publicKey, randomBytes: tweetnacl.randomBytes }), 'base64url') }
                : { t: 'plain', v: factsContent('/work/plain-leak') } }, activationSecretKey: activationKey.secretKey, installationSecretKey: installationKey.secretKey });
            expect((await app.inject({ method: 'PUT', url: factsUrl, payload: wrongMode })).statusCode).toBe(400);
            const corrected = signRunnerEndpointFactsV1({ payload: { ...payload, content: createContent('/work/corrected-before-review') },
                activationSecretKey: activationKey.secretKey, installationSecretKey: installationKey.secretKey });
            expect((await app.inject({ method: 'PUT', url: factsUrl, payload: corrected })).json()).toEqual({ status: 'stored', endpointFacts: corrected });
            const readinessResource = await materializationCredentialFixture(account.id, request.activationId);
            const machineContentKeyBinding = mode === 'plain' ? null : signRunnerMachineContentKeyBindingV1({
                payload: {
                    v: 1,
                    purpose: 'happier.ephemeral-runner.machine-content-key',
                    homeServerIdentityId: request.homeServerIdentityId,
                    activationId: request.activationId,
                    creatorAccountId: account.id,
                    machineId: created.activation.machineId,
                    installationId: claim.payload.installation.installationId,
                    machineContentKeyFingerprint: computeRunnerMachineContentKeyFingerprintV1(new Uint8Array(32).fill(13)),
                },
                activationSigningSecretKey: activationKey.secretKey,
            });
            const review = {
                sealedLaunchManifest: 'sealed-reviewed-manifest',
                authoringCommitment: request.authoringCommitment,
                launchManifestCommitment: encodeBase64(new Uint8Array(32).fill(43), 'base64url'),
                endpointFactsProof: {
                    activationSignature: corrected.activationSignature,
                    installationSignature: corrected.installationSignature,
                },
                agentTargetKey: 'agent:happier.agent.codex/codex',
                machineContentKeyBinding,
                credentialSelectionBinding: { v: 1 as const,
                    resourceId: readinessResource.resource.id,
                    brokerMachineId: readinessResource.brokerMachine.id,
                    revision: readinessResource.resource.revision,
                    application: { agentTargetKey: 'agent:happier.agent.codex/codex', implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' }, endpointTemplateId: 'responses', protocol: 'openai-responses' as const },
                    sourceRevision: 'source-revision-1' },
                displayFacts: {
                    v: 1 as const,
                    homeId: request.homeServerIdentityId,
                    homeName: expectedRunnerHomeName(),
                    requesterId: account.id,
                    requesterName: 'Alice Example',
                    teamId: readinessResource.team.id,
                    teamName: readinessResource.team.name,
                },
            };
            const selectionRequest = {
                v: 1 as const,
                selection: {
                    kind: 'team_credential_provider_model' as const,
                    resourceId: readinessResource.resource.id,
                    teamId: readinessResource.team.id,
                    expectedResourceRevision: readinessResource.resource.revision,
                    agentTargetKey: review.agentTargetKey,
                    modelId: 'gpt-5',
                    deliveryMode: 'brokered' as const,
                },
                application: review.credentialSelectionBinding.application,
                sourceRevision: review.credentialSelectionBinding.sourceRevision,
                plannedSession: { primaryTeamId: null, teamVisibilityTeamIds: [] },
            };
            await expect(resolveRunnerCredentialSelection({
                creatorAccountId: account.id,
                activationId: request.activationId,
                request: selectionRequest,
                authentication: presentUserAuthentication,
                signal: new AbortController().signal,
                readCurrentPresence: async () => ({ state: 'known', machineIds: new Set<string>() }),
                readPoolSourceEligibility: async () => { throw new Error('An exact broker placement selects no Pool member'); },
                readProviderProjection: async () => runnerOpenAiProviderProjection(
                    review.credentialSelectionBinding.application,
                    review.credentialSelectionBinding.sourceRevision,
                ),
            })).resolves.toEqual({
                v: 1,
                status: 'resolved',
                credentialSelectionBinding: review.credentialSelectionBinding,
                displayFacts: review.displayFacts,
            });
            const mismatchedAuthoringCommitment = encodeBase64(new Uint8Array(32).fill(44), 'base64url');
            await expect(storeRunnerActivationReview({
                creatorAccountId: account.id,
                activationId: request.activationId,
                review: { ...review, authoringCommitment: mismatchedAuthoringCommitment },
            })).resolves.toEqual({ status: 'invalid_proof' });
            await expect(db.ephemeralRunnerActivation.findUniqueOrThrow({ where: { id: request.activationId } }))
                .resolves.toMatchObject({
                    review: null,
                    endpointFacts: corrected,
                    credentialSelection: expect.objectContaining({ binding: review.credentialSelectionBinding }),
                });
            await expect(storeRunnerActivationReview({
                creatorAccountId: account.id,
                activationId: request.activationId,
                review: {
                    ...review,
                    endpointFactsProof: {
                        activationSignature: facts.activationSignature,
                        installationSignature: facts.installationSignature,
                    },
                },
            })).resolves.toEqual({ status: 'invalid_proof' });
            if (mode === 'e2ee') {
                const replayedBinding = signRunnerMachineContentKeyBindingV1({
                    payload: {
                        v: machineContentKeyBinding!.v,
                        purpose: machineContentKeyBinding!.purpose,
                        homeServerIdentityId: machineContentKeyBinding!.homeServerIdentityId,
                        activationId: '00000000-0000-4000-8000-000000000099',
                        creatorAccountId: machineContentKeyBinding!.creatorAccountId,
                        machineId: machineContentKeyBinding!.machineId,
                        installationId: machineContentKeyBinding!.installationId,
                        machineContentKeyFingerprint: machineContentKeyBinding!.machineContentKeyFingerprint,
                    },
                    activationSigningSecretKey: activationKey.secretKey,
                });
                expect((await app.inject({
                    method: 'PUT',
                    url: `/v1/ephemeral-runners/activations/${request.activationId}/review`,
                    headers: creatorHeaders,
                    payload: { ...review, machineContentKeyBinding: replayedBinding },
                })).statusCode).toBe(400);

                // The verifier is the activation identity this Home recorded at
                // creation. A binding re-signed under any other identity the
                // Home could publish — including the Account signing identity
                // carried by the endpoint-facts recipient — is refused.
                for (const substituteSigner of [accountSigningKey!, tweetnacl.sign.keyPair()]) {
                    const substituted = signRunnerMachineContentKeyBindingV1({
                        payload: {
                            v: machineContentKeyBinding!.v,
                            purpose: machineContentKeyBinding!.purpose,
                            homeServerIdentityId: machineContentKeyBinding!.homeServerIdentityId,
                            activationId: machineContentKeyBinding!.activationId,
                            creatorAccountId: machineContentKeyBinding!.creatorAccountId,
                            machineId: machineContentKeyBinding!.machineId,
                            installationId: machineContentKeyBinding!.installationId,
                            machineContentKeyFingerprint: computeRunnerMachineContentKeyFingerprintV1(
                                new Uint8Array(32).fill(97),
                            ),
                        },
                        activationSigningSecretKey: substituteSigner.secretKey,
                    });
                    expect((await app.inject({
                        method: 'PUT',
                        url: `/v1/ephemeral-runners/activations/${request.activationId}/review`,
                        headers: creatorHeaders,
                        payload: { ...review, machineContentKeyBinding: substituted },
                    })).statusCode).toBe(400);
                }
            }
            expect((await app.inject({ method: 'PUT', url: `/v1/ephemeral-runners/activations/${request.activationId}/review`, headers: creatorHeaders,
                payload: { ...review, machineContentKeyBinding: mode === 'plain' ? {
                    v: 1, purpose: 'happier.ephemeral-runner.machine-content-key', homeServerIdentityId: request.homeServerIdentityId,
                    activationId: request.activationId, creatorAccountId: account.id, machineId: created.activation.machineId,
                    installationId: claim.payload.installation.installationId,
                    machineContentKeyFingerprint: computeRunnerMachineContentKeyFingerprintV1(new Uint8Array(32).fill(14)),
                    accountSignatureBase64Url: encodeBase64(new Uint8Array(64).fill(14), 'base64url'),
                } : null },
            })).statusCode).toBe(400);
            expect((await app.inject({ method: 'PUT', url: `/v1/ephemeral-runners/activations/${request.activationId}/review`, headers: creatorHeaders, payload: review })).json())
                .toEqual({ status: 'stored', review });
            const consent = signRunnerConsentV1({ payload: { v: 1, purpose: 'happier.ephemeral-session-runner.consent', allow: true,
                claim: claim.payload, launchManifestCommitment: review.launchManifestCommitment },
                activationSecretKey: activationKey.secretKey, installationSecretKey: installationKey.secretKey });
            expect((await app.inject({ method: 'PUT', url: `/v1/ephemeral-runners/activations/${request.activationId}/endpoint/consent`, payload: consent })).json())
                .toEqual({ status: 'stored', consent });
            const readiness = signRunnerReadinessV1({ payload: { v: 1, purpose: 'happier.ephemeral-session-runner.readiness',
                claim: claim.payload, launchManifestCommitment: review.launchManifestCommitment,
                credentialSelectionBinding: review.credentialSelectionBinding,
                installation: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                    agentRuntimeId: 'codex', executablePath: '/managed/codex', authoritativeVersion: '1.0.0' },
                brokerReadinessRequest: signRunnerBrokerReadinessRequestV1({
                    facts: {
                        v: 1,
                        kind: 'provider_broker_readiness',
                        homeServerIdentityId: request.homeServerIdentityId,
                        activationId: request.activationId,
                        launchManifestCommitment: review.launchManifestCommitment,
                        resourceId: readinessResource.resource.id,
                        agentTargetKey: review.agentTargetKey,
                        modelId: selectionRequest.selection.modelId,
                        protocol: 'openai-responses',
                        initiator: {
                            installationId: claim.payload.installation.installationId,
                            endpointId: 'a'.repeat(64),
                        },
                        target: {
                            machineId: readinessResource.brokerMachine.id,
                            endpointId: readinessResource.brokerEndpointId,
                        },
                    },
                    claim,
                    activationSecretKey: activationKey.secretKey,
                    installationSecretKey: installationKey.secretKey,
                }) },
                activationSecretKey: activationKey.secretKey, installationSecretKey: installationKey.secretKey });
            expect((await app.inject({ method: 'PUT', url: `/v1/ephemeral-runners/activations/${request.activationId}/endpoint/readiness`, payload: readiness })).json())
                .toEqual({ status: 'stored', readiness });
            expect((await app.inject({ method: 'PUT', url: factsUrl, payload: corrected })).statusCode).toBe(200);
            expect((await app.inject({ method: 'PUT', url: factsUrl, payload: facts })).statusCode).toBe(409);
            expect((await app.inject({ method: 'GET', url: `/v1/ephemeral-runners/activations/${request.activationId}` })).statusCode).toBe(401);
            const other = await db.account.create({ data: { encryptionMode: 'plain' } });
            const otherToken = await auth.createToken(other.id, undefined, { kind: 'account', authority: 'present_user' });
            expect((await app.inject({ method: 'GET', url: `/v1/ephemeral-runners/activations/${request.activationId}`,
                headers: { authorization: `Bearer ${otherToken}` } })).statusCode).toBe(404);
            if (mode === 'plain') {
                const materialization = {
                    v: 1 as const,
                    activationId: request.activationId,
                    launchManifestCommitment: review.launchManifestCommitment,
                    consent,
                    readiness,
                    sealedBootstrap: 'sealed-bootstrap',
                    session: {
                        tag: 'runner-materialized',
                        metadata: JSON.stringify({ v: 1 }),
                        ownerMetadata: { t: 'plain' as const, v: { v: 1 as const } },
                        agentState: null,
                        dataEncryptionKey: null,
                        requestedEncryptionMode: 'plain' as const,
                    },
                    machine: { metadata: encodePlainMachineStoredContent({ v: 1 }), dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, runnerContentKeyBinding: null },
                    accessKeyData: 'sealed-access-key',
                };
                const materializeUrl = `/v1/ephemeral-runners/activations/${request.activationId}/session`;
                const firstMaterialization = await app.inject({ method: 'PUT', url: materializeUrl, headers: creatorHeaders, payload: materialization });
                expect(firstMaterialization.statusCode).toBe(200);
                expect(firstMaterialization.json()).toMatchObject({ status: 'materialized', result: {
                    activationId: request.activationId, sessionId: created.activation.sessionId, machineId: created.activation.machineId,
                } });
                expect((await app.inject({ method: 'PUT', url: materializeUrl, headers: creatorHeaders, payload: materialization })).json())
                    .toEqual(firstMaterialization.json());
                expect((await app.inject({ method: 'PUT', url: materializeUrl, headers: creatorHeaders,
                    payload: { ...materialization, accessKeyData: 'substituted-access-key' } })).statusCode).toBe(409);
                expect(await db.session.count({ where: { id: created.activation.sessionId, accountId: account.id } })).toBe(1);
                expect(await db.machine.count({ where: { id: created.activation.machineId, accountId: account.id } })).toBe(1);
                expect(await db.accessKey.count({ where: { accountId: account.id, sessionId: created.activation.sessionId, machineId: created.activation.machineId } })).toBe(1);
                const projectionProof = signRunnerEndpointProjectionProofV1({ payload: {
                    v: 1, purpose: 'happier.ephemeral-session-runner.endpoint-projection', activationId: request.activationId,
                    sessionId: created.activation.sessionId, machineId: created.activation.machineId,
                    launchManifestCommitment: review.launchManifestCommitment, creatorTokenEpoch: account.tokenEpoch,
                }, activationSecretKey: activationKey.secretKey, installationSecretKey: installationKey.secretKey });
                const endpointProjectionUrl = `/v1/ephemeral-runners/activations/${request.activationId}/endpoint/projection`;
                const endpointProjection = await app.inject({ method: 'POST', url: endpointProjectionUrl, payload: projectionProof });
                expect(endpointProjection.statusCode).toBe(200);
                expect(endpointProjection.json()).toMatchObject({ status: 'materialized', sealedBootstrap: materialization.sealedBootstrap });
                await expect(auth.verifyToken(endpointProjection.json().runtimeToken)).resolves.toMatchObject({
                    authTokenKind: 'ephemeral_session_runner', authority: 'session_runtime',
                    ephemeralSessionRunnerPrincipal: { activationId: request.activationId, sessionId: created.activation.sessionId,
                        machineId: created.activation.machineId, installationId: claim.payload.installation.installationId },
                });
                expect((await app.inject({ method: 'POST', url: endpointProjectionUrl,
                    payload: { ...projectionProof, installationSignature: projectionProof.activationSignature } })).json())
                    .toEqual({ status: 'conflict', reason: 'proof_mismatch' });
                expect((await app.inject({ method: 'POST',
                    url: `/v1/ephemeral-runners/activations/${request.activationId}/endpoint/teardown`,
                    payload: projectionProof })).statusCode).toBe(404);
                expect((await app.inject({ method: 'POST',
                    url: `/v1/ephemeral-runners/activations/${request.activationId}/teardown`,
                    headers: creatorHeaders })).statusCode).toBe(404);
                expect(await db.accessKey.count({ where: { accountId: account.id,
                    sessionId: created.activation.sessionId, machineId: created.activation.machineId } })).toBe(1);
                expect(await db.machine.findUniqueOrThrow({ where: { id: created.activation.machineId } }))
                    .toMatchObject({ revokedAt: null });
                return;
            } else {
                await db.account.update({ where: { id: account.id }, data: { tokenEpoch: { increment: 1 } } });
                expect(await readEphemeralRunnerActivation({ creatorAccountId: account.id, activationId: request.activationId }))
                    .toMatchObject({ state: 'closed', closeReason: 'revoked', endpointFacts: { status: 'available', facts: corrected } });
            }
            await app.inject({ method: 'DELETE', url: `/v1/ephemeral-runners/activations/${request.activationId}`, headers: creatorHeaders });
            expect((await app.inject({ method: 'PUT', url: factsUrl, payload: facts })).statusCode).toBe(404);
        } finally { await app.close(); }
    });

    it('projects the current signed E2EE Account binding in canonical Runner encoding', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
        const current = await inTx((tx) => readRunnerCreatorCurrentnessInTx(tx, account.id));
        if (current.status !== 'ready') throw new Error('Valid signed Account binding was rejected');
        expect(RunnerEndpointFactsRecipientV1Schema.safeParse(current.endpointFactsRecipient).success).toBe(true);
    });

    it.each(['exact', 'draft', 'replacement'] as const)('acknowledges elapsed optional expiry through %s without an endpoint claim', async (entryPoint) => {
        const { account, request, options } = await activationFixture();
        const created = await createEphemeralRunnerActivation({ creatorAccountId: account.id,
            request: { ...request, activationExpiresAt: Date.now() + 60_000 } }, options);
        expect(created.status).toBe('created');
        // Persistence boundary represents an elapsed optional package deadline, without an endpoint claim.
        await db.ephemeralRunnerActivation.update({ where: { id: request.activationId }, data: { activationExpiresAt: new Date(Date.now() - 1) } });
        if (entryPoint === 'exact') expect(await readEphemeralRunnerActivation({ creatorAccountId: account.id, activationId: request.activationId }))
            .toMatchObject({ state: 'closed', closeReason: 'expired' });
        if (entryPoint === 'draft') expect(await readDraftEphemeralRunnerActivation({ creatorAccountId: account.id, draftId: request.draftId }))
            .toMatchObject({ state: 'closed', closeReason: 'expired' });
        expect((await createEphemeralRunnerActivation({ creatorAccountId: account.id,
            request: { ...request, activationId: randomUUID() } }, options)).status).toBe('created');
        expect(await db.ephemeralRunnerActivation.findUnique({ where: { id: request.activationId } })).toMatchObject({ state: 'closed', closeReason: 'expired' });
    });

    it('recovers only the creator’s exact pending draft binding and cancels without overwriting newer draft edits', async () => {
        const { account, draftId, draft, request, options } = await activationFixture();
        const created = await createEphemeralRunnerActivation({ creatorAccountId: account.id, request }, options);
        expect(created.status).toBe('created');
        if (draft.record.content?.t !== 'plain') throw new Error('Expected a Plain draft');
        const original = draft.record.content.v;
        if (original.document.v !== 1) throw new Error('Expected the new-session draft document');
        const currentDraft = await mutateSessionDraft({ accountId: account.id, address: { kind: 'newSession', draftId },
            expectedRevision: draft.record.revision, content: { t: 'plain', v: { ...original, document: { ...original.document,
                composer: { ...original.document.composer, text: { mutationId: randomUUID(), value: 'Keep these newer edits' } },
            } } } });
        expect(currentDraft.status).toBe('updated');
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const otherToken = await auth.createToken(other.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = await activationRouteApp();
        const gatedApp = await activationRouteApp({ ...process.env, HAPPIER_FEATURE_SESSIONS_EPHEMERAL_RUNNER__ENABLED: '0' });
        const url = `/v1/ephemeral-runners/activations/${request.activationId}`;
        const lookup = `/v1/ephemeral-runners/activations?draftId=${draftId}`;
        const headers = { authorization: `Bearer ${token}` };
        try {
            expect((await gatedApp.inject({ method: 'GET', url: lookup, headers })).statusCode).toBe(404);
            expect((await gatedApp.inject({ method: 'DELETE', url, headers })).statusCode).toBe(404);
            const recovered = await app.inject({ method: 'GET', url: lookup, headers });
            expect(recovered.statusCode).toBe(200);
            expect(recovered.json()).toMatchObject({ activationId: request.activationId, draftId, state: 'pending' });
            expect(recovered.headers['cache-control']).toBe('no-store');
            for (const target of [lookup, url]) {
                expect((await app.inject({ method: 'GET', url: target, headers: { authorization: `Bearer ${otherToken}` } })).statusCode).toBe(404);
            }
            expect((await app.inject({ method: 'GET', url: '/v1/ephemeral-runners/activations', headers })).statusCode).toBe(400);
            expect((await app.inject({ method: 'GET', url: `${lookup}&creatorAccountId=${other.id}`, headers })).statusCode).toBe(400);
            expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(401);
            expect((await app.inject({ method: 'DELETE', url, headers: { authorization: `Bearer ${otherToken}` } })).statusCode).toBe(404);
            expect((await app.inject({ method: 'DELETE', url: `/v1/ephemeral-runners/activations/${randomUUID()}`, headers })).statusCode).toBe(404);
            const canceled = await app.inject({ method: 'DELETE', url, headers });
            expect(canceled.statusCode).toBe(200);
            expect(canceled.json()).toMatchObject({ activationId: request.activationId, state: 'closed', closeReason: 'canceled' });
            expect(canceled.headers['cache-control']).toBe('no-store');
            expect((await app.inject({ method: 'DELETE', url, headers })).json()).toEqual(canceled.json());
            expect((await app.inject({ method: 'GET', url: lookup, headers })).statusCode).toBe(404);
            expect(await readSessionDraft({ accountId: account.id, address: { kind: 'newSession', draftId } })).toEqual({ status: 'present', record: currentDraft.status === 'updated' ? currentDraft.record : null });
            const replacement = await createEphemeralRunnerActivation({ creatorAccountId: account.id, request: { ...request, activationId: randomUUID() } }, options);
            expect(replacement.status).toBe('created');
            expect((await app.inject({ method: 'GET', url: lookup, headers })).json()).toEqual(replacement.status === 'created' ? replacement.activation : null);
        } finally {
            await app.close();
            await gatedApp.close();
        }
    });

    it('acknowledges exact creator cancellation after an opaque draft rewrite without closing sibling activations', async () => {
        const { account, draftId, draft, request, options } = await activationFixture('e2ee');
        const created = await createEphemeralRunnerActivation({ creatorAccountId: account.id, request }, options);
        expect(created.status).toBe('created');
        const siblingDraftId = randomUUID();
        await mutateSessionDraft({ accountId: account.id, address: { kind: 'newSession', draftId: siblingDraftId }, expectedRevision: 'absent', content: { t: 'encrypted', c: 'opaque-sibling-draft' } });
        const siblingRequest = { ...request, activationId: randomUUID(), draftId: siblingDraftId };
        expect((await createEphemeralRunnerActivation({ creatorAccountId: account.id, request: siblingRequest }, options)).status).toBe('created');
        const rewritten = await mutateSessionDraft({ accountId: account.id, address: { kind: 'newSession', draftId },
            expectedRevision: draft.record.revision, content: { t: 'encrypted', c: 'opaque-rewrite-without-activation-reference' } });
        expect(rewritten.status).toBe('updated');
        // A newly authenticated creator may close an old package after epoch revocation.
        // Inspection/cancellation also remain available to existing terminal authority.
        await db.account.update({ where: { id: account.id }, data: { tokenEpoch: { increment: 1 } } });
        const token = await auth.createToken(account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        const app = await activationRouteApp();
        const headers = { authorization: `Bearer ${token}` };
        const url = `/v1/ephemeral-runners/activations/${request.activationId}`;
        try {
            const recovered = await app.inject({ method: 'GET', url: `/v1/ephemeral-runners/activations?draftId=${draftId}`, headers });
            expect(recovered.statusCode).toBe(200);
            expect(recovered.json()).toMatchObject({ activationId: request.activationId, state: 'closed', closeReason: 'revoked' });
            const canceled = await app.inject({ method: 'DELETE', url, headers });
            expect(canceled.statusCode).toBe(200);
            expect(canceled.json()).toMatchObject({ state: 'closed', closeReason: 'revoked' });
            expect((await app.inject({ method: 'DELETE', url, headers })).json()).toEqual(canceled.json());
            expect(await db.ephemeralRunnerActivation.findUnique({ where: { id: siblingRequest.activationId } })).toMatchObject({ state: 'pending' });
            expect(await readEphemeralRunnerActivation({ creatorAccountId: account.id, activationId: siblingRequest.activationId })).toMatchObject({ state: 'closed', closeReason: 'revoked' });
            expect(await readSessionDraft({ accountId: account.id, address: { kind: 'newSession', draftId } })).toEqual({ status: 'present', record: rewritten.status === 'updated' ? rewritten.record : null });
        } finally {
            await app.close();
        }
    });

    it('reserves one activation without runtime rows and closes it only after a successful draft tombstone', async () => {
        const { account, draftId, draft, request, options } = await activationFixture();
        const [created, concurrentRetry] = await Promise.all([
            createEphemeralRunnerActivation({ creatorAccountId: account.id, request }, options),
            createEphemeralRunnerActivation({ creatorAccountId: account.id, request }, options),
        ]);
        expect(concurrentRetry).toEqual(created);
        expect(created).toMatchObject({ status: 'created', activation: { state: 'pending', creatorAccountId: account.id, draftId } });
        expect(await db.session.count({ where: { id: created.status === 'created' ? created.activation.sessionId : '' } })).toBe(0);
        expect(await db.machine.count({ where: { id: created.status === 'created' ? created.activation.machineId : '' } })).toBe(0);
        expect(await db.accessKey.count({ where: { accountId: account.id } })).toBe(0);
        expect(await createEphemeralRunnerActivation({ creatorAccountId: account.id, request }, options)).toEqual(created);
        expect(await createEphemeralRunnerActivation({
            creatorAccountId: account.id,
            request: { ...request, workspace: { kind: 'endpoint_home' } },
        }, options)).toEqual({ status: 'conflict' });
        expect(await db.ephemeralRunnerActivation.findUnique({ where: { id: request.activationId } }))
            .toMatchObject({ workspacePolicy: 'choose_on_endpoint' });
        expect(await createEphemeralRunnerActivation({ creatorAccountId: account.id, request: { ...request, activationId: randomUUID() } }, options)).toEqual({ status: 'conflict' });
        expect(await db.ephemeralRunnerActivation.count({ where: { creatorAccountId: account.id } })).toBe(1);
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        expect(await readEphemeralRunnerActivation({ creatorAccountId: other.id, activationId: request.activationId })).toBeNull();
        const stale = await mutateSessionDraft({ accountId: account.id, address: { kind: 'newSession', draftId }, expectedRevision: draft.record.revision + 1, content: null });
        expect(stale.status).toBe('conflict');
        expect(await readEphemeralRunnerActivation({ creatorAccountId: account.id, activationId: request.activationId })).toMatchObject({ state: 'pending' });
        // Real database failure proves tombstone and activation closure share one transaction.
        await db.$executeRawUnsafe(`CREATE TRIGGER fail_activation_close BEFORE UPDATE ON "EphemeralRunnerActivation"
            WHEN NEW.state = 'closed' BEGIN SELECT RAISE(ABORT, 'injected activation close failure'); END`);
        try {
            await expect(mutateSessionDraft({ accountId: account.id, address: { kind: 'newSession', draftId }, expectedRevision: draft.record.revision, content: null })).rejects.toThrow();
            expect(await readSessionDraft({ accountId: account.id, address: { kind: 'newSession', draftId } })).toMatchObject({ status: 'present', record: { revision: draft.record.revision } });
            expect(await readEphemeralRunnerActivation({ creatorAccountId: account.id, activationId: request.activationId })).toMatchObject({ state: 'pending' });
        } finally {
            await db.$executeRawUnsafe('DROP TRIGGER fail_activation_close');
        }
        await mutateSessionDraft({ accountId: account.id, address: { kind: 'newSession', draftId }, expectedRevision: draft.record.revision, content: null });
        expect(await readEphemeralRunnerActivation({ creatorAccountId: account.id, activationId: request.activationId })).toMatchObject({ state: 'closed', closeReason: 'canceled' });
    });

    it('binds exactly one signed endpoint and does not revive its claim after creator epoch change', async () => {
        const { account, request, options, activationKey } = await activationFixture();
        const created = await createEphemeralRunnerActivation({ creatorAccountId: account.id, request }, options);
        if (created.status !== 'created') throw new Error('Activation setup failed');
        const binding = runnerActivationProjectionBindingV1(created.activation);
        const payload = runnerClaimPayload(binding);
        const first = signRunnerClaimV1({ payload, activationSecretKey: activationKey.secretKey });
        const second = signRunnerClaimV1({ payload: { ...payload, runnerBoxPublicKey: encodeBase64(tweetnacl.box.keyPair().publicKey, 'base64url') }, activationSecretKey: activationKey.secretKey });
        const results = await Promise.all([first, second].map((claim) => claimEphemeralRunnerActivation({ activationId: request.activationId, claim }, options)));
        expect(results.filter((result) => result.status === 'claimed')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'unavailable')).toHaveLength(1);
        const winningClaim = results[0]?.status === 'claimed' ? first : second;
        expect(await claimEphemeralRunnerActivation({ activationId: request.activationId, claim: winningClaim }, options)).toMatchObject({ status: 'claimed', claim: winningClaim });
        expect(await readEphemeralRunnerActivation({ creatorAccountId: account.id, activationId: request.activationId })).toMatchObject({ claim: winningClaim });
        expect(await db.session.count({ where: { id: binding.sessionId } })).toBe(0);
        expect(await db.machine.count({ where: { id: binding.machineId } })).toBe(0);
        expect(await db.accessKey.count({ where: { accountId: account.id,
            sessionId: binding.sessionId, machineId: binding.machineId } })).toBe(0);
        await db.account.update({ where: { id: account.id }, data: { tokenEpoch: { increment: 1 } } });
        expect(await claimEphemeralRunnerActivation({ activationId: request.activationId, claim: winningClaim }, options)).toEqual({ status: 'unavailable' });
        expect(await readEphemeralRunnerActivation({ creatorAccountId: account.id, activationId: request.activationId })).toMatchObject({ state: 'closed', closeReason: 'revoked' });
    });

    it('keeps creator cancellation final when a valid endpoint claim races it', async () => {
        const { account, request, options, activationKey } = await activationFixture();
        const created = await createEphemeralRunnerActivation({ creatorAccountId: account.id, request }, options);
        if (created.status !== 'created') throw new Error('Activation setup failed');
        const claim = signRunnerClaimV1({ payload: runnerClaimPayload(runnerActivationProjectionBindingV1(created.activation)), activationSecretKey: activationKey.secretKey });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = await activationRouteApp();
        try {
            const [canceled] = await Promise.all([
                app.inject({ method: 'DELETE', url: `/v1/ephemeral-runners/activations/${request.activationId}`, headers: { authorization: `Bearer ${token}` } }),
                claimEphemeralRunnerActivation({ activationId: request.activationId, claim }, options),
            ]);
            expect(canceled.statusCode).toBe(200);
            expect(canceled.json()).toMatchObject({ state: 'closed', closeReason: 'canceled' });
            expect(await claimEphemeralRunnerActivation({ activationId: request.activationId, claim }, options)).toEqual({ status: 'unavailable' });
            expect(await db.session.count({ where: { accountId: account.id } })).toBe(0);
            expect(await db.machine.count({ where: { accountId: account.id } })).toBe(0);
            expect(await db.accessKey.count({ where: { accountId: account.id } })).toBe(0);
        } finally {
            await app.close();
        }
    });

    it.each(['claimed', 'consented'] as const)('closes a %s activation and retains its verified endpoint binding', async (state) => {
        const { account, request, options, activationKey } = await activationFixture();
        const created = await createEphemeralRunnerActivation({ creatorAccountId: account.id, request }, options);
        if (created.status !== 'created') throw new Error('Activation setup failed');
        const claim = signRunnerClaimV1({ payload: runnerClaimPayload(runnerActivationProjectionBindingV1(created.activation)), activationSecretKey: activationKey.secretKey });
        expect((await claimEphemeralRunnerActivation({ activationId: request.activationId, claim }, options)).status).toBe('claimed');
        if (state === 'consented') {
            // Persisted pre-Session lifecycle fixture; consent verification belongs to its producer.
            await db.ephemeralRunnerActivation.update({ where: { id: request.activationId }, data: { state } });
        }
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = await activationRouteApp();
        try {
            const response = await app.inject({ method: 'DELETE', url: `/v1/ephemeral-runners/activations/${request.activationId}`, headers: { authorization: `Bearer ${token}` } });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({ state: 'closed', closeReason: 'canceled', claim });
            expect(await claimEphemeralRunnerActivation({ activationId: request.activationId, claim }, options)).toEqual({ status: 'unavailable' });
        } finally {
            await app.close();
        }
    });

    it('reconciles an already materialized activation without canceling its Session or Machine', async () => {
        const fixture = await materializationFixture();
        const { account, draftId, draft, activationRequest: request } = fixture;
        const binding = runnerActivationProjectionBindingV1(fixture.created.activation);
        // Reach the materialized state through the canonical transaction rather than
        // seeding rows: cancellation must reconcile a genuinely materialized winner.
        expect(await materializeEphemeralRunner({
            creatorAccountId: account.id,
            request: materializationRequest(fixture),
            authentication: presentUserAuthentication,
            env: process.env,
        })).toEqual({ status: 'materialized', result: {
            v: 1, activationId: request.activationId, sessionId: binding.sessionId, machineId: binding.machineId,
        } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = await activationRouteApp();
        const headers = { authorization: `Bearer ${token}` };
        try {
            const response = await app.inject({ method: 'DELETE', url: `/v1/ephemeral-runners/activations/${request.activationId}`, headers });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({ state: 'materialized', closeReason: null, sessionId: binding.sessionId, machineId: binding.machineId });
            expect((await app.inject({ method: 'GET', url: `/v1/ephemeral-runners/activations?draftId=${draftId}`, headers })).statusCode).toBe(404);
            expect((await mutateSessionDraft({ accountId: account.id, address: { kind: 'newSession', draftId }, expectedRevision: draft.record.revision, content: null })).status).toBe('updated');
            expect(await readEphemeralRunnerActivation({ creatorAccountId: account.id, activationId: request.activationId })).toEqual(response.json());
            expect(await db.session.findUnique({ where: { id: binding.sessionId } })).not.toBeNull();
            expect(await db.machine.findUnique({ where: { id: binding.machineId } })).toMatchObject({ revokedAt: null });
            expect(await db.accessKey.count({ where: { accountId: account.id, sessionId: binding.sessionId, machineId: binding.machineId } })).toBe(1);
        } finally {
            await app.close();
        }
    });

});
