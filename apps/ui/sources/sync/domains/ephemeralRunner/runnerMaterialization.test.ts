import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
    computeRunnerAuthoringCommitmentV1,
    type RunnerPreparedAuthoringV1,
} from '@happier-dev/protocol/ephemeralRunner/launchManifest';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { signRunnerClaimV1, signRunnerEndpointFactsV1 } from '@happier-dev/protocol/ephemeralRunner/endpoint';
import { signRunnerConsentV1 } from '@happier-dev/protocol/ephemeralRunner/consent';
import { signRunnerReadinessV1 } from '@happier-dev/protocol/ephemeralRunner/readiness';
import { signRunnerBrokerReadinessRequestV1 } from '@happier-dev/protocol/teams';
import { openBoxBundleWithSecretKey } from '@happier-dev/protocol/crypto/boxBundle';
import { computeRunnerMachineContentKeyFingerprintV1, openRunnerMachineContentKeyVerifierFactV1, verifyRunnerMachineContentKeyBindingV1 } from '@happier-dev/protocol/ephemeralRunner/machineContentKeyBinding';
import { MACHINE_PLAIN_DATA_KEY_MARKER, decodePlainMachineStoredContent} from '@happier-dev/protocol/machines/machineStoredContent';
import { sealBoxBundle} from '@happier-dev/protocol/crypto/boxBundle';
import { signAccountContentKeyBindingV1} from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import { computeContentPublicKeyFingerprint} from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { openEncryptedDataKeyEnvelopeV1} from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { openSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { SessionDisplayProjectionV1Schema, openSessionOwnerDisplayEnvelopeV1, openSessionSharedDisplayEnvelopeV1 } from '@happier-dev/protocol/sessions';
import type { RunnerEndpointFactsRecipientV1 } from '@happier-dev/protocol/ephemeralRunner/activation';
import { RunnerRuntimeBootstrapV1Schema } from '@happier-dev/protocol/ephemeralRunner/bootstrap';
import { Encryption } from '@/sync/encryption/encryption';
import { AES256Encryption } from '@/sync/encryption/encryptor';
import { acceptRunnerCreatorActivationBinding, getOrCreateRunnerMaterializationRequest, readAcceptedRunnerCreatorActivationBinding, writePreparedRunnerCreatorLaunchCustody, writeReviewedRunnerCreatorLaunchCustody } from './runnerCreatorLaunchCustody';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { createRunnerActivationClient } from '@/sync/api/ephemeralRunner/runnerActivationClient';
import {
    createRunnerActivationKeyCustody,
    readRunnerActivationSigningKey,
} from './runnerActivationKeyCustody';
import {
    loadRunnerCreatorMachineContentKeyTrust,
    resetRunnerCreatorMachineContentKeyTrustProjectionForTests,
} from './runnerCreatorMachineContentKeyTrust';
import {
    buildRunnerMaterializationRequestV1,
    prepareRunnerActivationReviewV1,
    prepareAndStoreRunnerActivationReviewV1,
    RunnerMaterializationPreparationError,
    type RunnerReviewCustodyV1,
} from './runnerMaterialization';

const preparedAuthoring: RunnerPreparedAuthoringV1 = {
    v: 1,
    actionsSettings: { v: 1, actions: {} },
    mcpMaterial: null,
    authoring: {
        targetType: 'new_session',
        executionTarget: { kind: 'temporary_computer', serverId: 'srv_runner', artifactTarget: 'linux-x64', workspace: { kind: 'choose_on_endpoint' } },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.codex', localId: 'codex' } },
        permissionMode: 'default', modelSelection: { v: 1, ref: { agentTargetKey: 'agent:happier.codex/codex', providerConnectionId: null, modelId: 'gpt-5' }, updatedAt: 1 },
        transcriptStorage: 'persisted', profileId: null, environmentVariables: null,
        capabilitySelection: { mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: [] } },
        connectedServices: null, acpSessionModeId: null, sessionConfigOptionOverrides: null,
        checkoutCreationDraft: null, resumeSessionId: null, terminal: null,
        windowsRemoteSessionLaunchMode: null, windowsRemoteSessionConsole: null, windowsTerminalWindowName: null,
        access: null, primaryTeamId: null,
        organizationPlacement: { folderId: null, tagIds: [] },
    },
    agentPluginDistribution: null,
    composer: { text: 'Inspect the project', references: [], attachments: [] },
    files: [],
    attachmentDestination: { uploadLocation: 'workspace', workspaceRelativeDir: '.happier/uploads', vcsIgnoreStrategy: 'git_info_exclude', vcsIgnoreWritesEnabled: true },
};

const credentialSelectionBinding = {
    v: 1 as const,
    resourceId: 'resource-a',
    brokerMachineId: 'broker-a',
    revision: 1,
    application: {
        agentTargetKey: 'agent:happier.codex/codex',
        implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' },
        endpointTemplateId: 'responses',
        protocol: 'openai-responses' as const,
    },
    sourceRevision: 'source-revision-1',
};
const reviewedProviderModel = {
    selection: { kind: 'team_credential_provider_model' as const, resourceId: 'resource-a', teamId: 'team-a', expectedResourceRevision: 1, deliveryMode: 'brokered' as const, agentTargetKey: 'agent:happier.codex/codex', modelId: 'gpt-5' },
    descriptor: { id: 'gpt-5', name: 'GPT-5' },
    application: credentialSelectionBinding.application,
    sourceRevision: credentialSelectionBinding.sourceRevision,
    availability: 'available' as const,
};
const displayFacts = {
    v: 1 as const,
    homeId: 'srv_runner',
    homeName: 'Acme Home',
    requesterId: 'creator',
    requesterName: 'Alice Example',
    teamId: 'team-a',
    teamName: 'Platform 🌍',
};
const connectedServiceReviewBindings = { v: 1 as const, bindings: [] };

const endpointFactsContent = {
    v: 1 as const,
    directory: '/work/project',
    machine: {
        host: 'runner.example.test',
        platform: 'linux' as const,
        happyCliVersion: '0.3.0',
        happyHomeDir: '/runner/home',
        homeDir: '/runner/home',
    },
};

function claimedFixture(
    recipient: RunnerEndpointFactsRecipientV1 = { mode: 'plain', creatorAccountId: 'creator' },
    creatorActivation?: Readonly<{ activationId: string; key: tweetnacl.SignKeyPair }>,
    encryptedContent: unknown = endpointFactsContent,
) {
    const activationKey = creatorActivation?.key ?? tweetnacl.sign.keyPair();
    const installationKey = tweetnacl.sign.keyPair();
    const runnerBox = tweetnacl.box.keyPair();
    const binding = {
        activationId: creatorActivation?.activationId ?? '00000000-0000-4000-8000-000000000007',
        homeServerIdentityId: 'srv_runner',
        creatorAccountId: 'creator', creatorTokenEpoch: 1, activationExpiresAt: null, workspace: { kind: 'choose_on_endpoint' as const },
        sessionId: 'session-a', machineId: 'machine-a',
        activationSigningPublicKey: encodeBase64(activationKey.publicKey, 'base64url'),
        authoringCommitment: computeRunnerAuthoringCommitmentV1(preparedAuthoring),
        artifact: { product: 'happier-runner' as const, version: '0.3.0', target: 'linux-x64' as const, sha256: 'a'.repeat(64) },
        endpointFactsRecipient: recipient,
    };
    const claim = signRunnerClaimV1({
        payload: {
            v: 1, purpose: 'happier.ephemeral-session-runner.claim', binding,
            runnerBoxPublicKey: encodeBase64(runnerBox.publicKey, 'base64url'),
            installation: {
                installationId: 'runner-installation', publicKey: encodeBase64(installationKey.publicKey, 'base64url'),
                proof: signMachineInstallationProof({ payload: { version: 1, installationId: 'runner-installation', machineId: binding.machineId, accountId: binding.creatorAccountId }, privateKey: installationKey.secretKey }),
            }, protocolEpoch: 1,
        }, activationSecretKey: activationKey.secretKey,
    });
    const facts = signRunnerEndpointFactsV1({
        payload: { v: 1, purpose: 'happier.ephemeral-session-runner.endpoint-facts', claim: claim.payload, content: recipient.mode === 'plain'
            ? { t: 'plain', v: endpointFactsContent }
            : { t: 'encrypted', c: encodeBase64(sealBoxBundle({ plaintext: new TextEncoder().encode(JSON.stringify(encryptedContent)), recipientPublicKey: decodeBase64(recipient.contentPublicKey, 'base64url'), randomBytes: tweetnacl.randomBytes }), 'base64url') } },
        activationSecretKey: activationKey.secretKey, installationSecretKey: installationKey.secretKey,
    });
    return { activationKey, installationKey, runnerBox, binding, claim, projection: {
        ...binding, draftId: 'draft-a', state: 'claimed' as const, closeReason: null,
        claim, endpointFacts: { status: 'available' as const, facts }, review: null, consent: null, readiness: null, materialization: null,
    } };
}

function brokerReadinessRequest(
    fixture: ReturnType<typeof claimedFixture>,
    review: Readonly<{ launchManifestCommitment: string; agentTargetKey: string;
        credentialSelectionBinding: Readonly<{ resourceId: string; brokerMachineId: string }> }>,
    modelId: string,
) {
    return signRunnerBrokerReadinessRequestV1({
        facts: {
            v: 1,
            kind: 'provider_broker_readiness',
            homeServerIdentityId: fixture.binding.homeServerIdentityId,
            activationId: fixture.binding.activationId,
            launchManifestCommitment: review.launchManifestCommitment,
            resourceId: review.credentialSelectionBinding.resourceId,
            agentTargetKey: review.agentTargetKey,
            modelId,
            protocol: 'openai-responses',
            initiator: {
                installationId: fixture.claim.payload.installation.installationId,
                endpointId: 'a'.repeat(64),
            },
            target: {
                machineId: review.credentialSelectionBinding.brokerMachineId,
                endpointId: 'b'.repeat(64),
            },
        },
        claim: fixture.claim,
        activationSecretKey: fixture.activationKey.secretKey,
        installationSecretKey: fixture.installationKey.secretKey,
    });
}

const creatorScope = { serverId: 'srv_runner', accountId: 'creator' } as const;

/**
 * Creates the exact device-local activation custody a creator holds after
 * package creation, then returns the same identity the published activation
 * binding names. The Machine-content-key proof is signed with it, so no
 * Account signing key is involved for any credential kind.
 */
async function claimedFixtureWithCreatorCustody(
    recipient: RunnerEndpointFactsRecipientV1,
    encryptedContent: unknown = endpointFactsContent,
) {
    const custody = await createRunnerActivationKeyCustody(creatorScope);
    const secretKey = decodeBase64(await readRunnerActivationSigningKey(creatorScope, custody), 'base64url');
    return claimedFixture(recipient, {
        activationId: custody.activationId,
        key: tweetnacl.sign.keyPair.fromSecretKey(secretKey),
    }, encryptedContent);
}

describe('creator Runner review and materialization', () => {
    let storedValues: Map<string, string>;
    beforeEach(() => {
        storedValues = new Map();
        resetRunnerCreatorMachineContentKeyTrustProjectionForTests();
        vi.stubGlobal('window', { localStorage: {
            getItem: (key: string) => storedValues.get(key) ?? null,
            setItem: (key: string, value: string) => { storedValues.set(key, value); },
            removeItem: (key: string) => { storedValues.delete(key); },
        } });
    });
    afterEach(() => {
        resetRunnerCreatorMachineContentKeyTrustProjectionForTests();
        vi.unstubAllGlobals();
    });
    it('projects retired encrypted endpoint content only after authenticating the untouched ciphertext', async () => {
        const accountSecret = new Uint8Array(32).fill(73);
        const encryption = await Encryption.create(accountSecret);
        const signing = tweetnacl.sign.keyPair.fromSeed(accountSecret);
        const fixture = await claimedFixtureWithCreatorCustody({
            mode: 'e2ee', creatorAccountId: 'creator',
            accountSigningPublicKey: encodeBase64(signing.publicKey, 'base64url'),
            contentPublicKey: encodeBase64(encryption.contentDataKey, 'base64url'),
            contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({
                accountSigningSecretKey: signing.secretKey, contentPublicKey: encryption.contentDataKey,
            }), 'base64url'),
            contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(encryption.contentDataKey),
        }, { ...endpointFactsContent, retiredFactsField: true,
            machine: { ...endpointFactsContent.machine, retiredMachineField: true } });
        const prepared = await prepareRunnerActivationReviewV1({
            projection: fixture.projection, expectedBinding: fixture.binding, preparedAuthoring,
            credentialSelectionBinding, reviewedProviderModel, displayFacts, connectedServiceReviewBindings,
            credentials: { token: 'token', secret: encodeBase64(accountSecret, 'base64url') }, encryption,
        });
        expect(prepared.custody.launchManifest.endpointFacts).toEqual(endpointFactsContent);
        await expect(prepareRunnerActivationReviewV1({
            projection: { ...fixture.projection, endpointFacts: { ...fixture.projection.endpointFacts,
                facts: { ...fixture.projection.endpointFacts.facts, activationSignature: 'A'.repeat(86) } } },
            expectedBinding: fixture.binding, preparedAuthoring,
            credentialSelectionBinding, reviewedProviderModel, displayFacts, connectedServiceReviewBindings,
            credentials: { token: 'token', secret: encodeBase64(accountSecret, 'base64url') }, encryption,
        })).rejects.toMatchObject({ code: 'runner_endpoint_facts_unavailable' });
    });
    it('rejects a later Home-substituted binding instead of replacing accepted creator custody', async () => {
        const values = new Map<string, string>();
        vi.stubGlobal('window', { localStorage: {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => { values.set(key, value); },
            removeItem: (key: string) => { values.delete(key); },
        } });
        try {
            const fixture = claimedFixture();
            const scope = { serverId: 'srv_runner', accountId: 'creator' };
            const prepared = await prepareRunnerActivationReviewV1({
                projection: fixture.projection, expectedBinding: fixture.binding, preparedAuthoring,
                credentialSelectionBinding, reviewedProviderModel, displayFacts, connectedServiceReviewBindings,
                credentials: { token: 'token' }, encryption: null,
            });
            expect(prepared.review.endpointFactsProof).toEqual({
                activationSignature: fixture.projection.endpointFacts.facts.activationSignature,
                installationSignature: fixture.projection.endpointFacts.facts.installationSignature,
            });
            expect(prepared.review.authoringCommitment).toBe(fixture.binding.authoringCommitment);
            await writePreparedRunnerCreatorLaunchCustody({ scope, activationId: fixture.binding.activationId, preparedAuthoring });
            await acceptRunnerCreatorActivationBinding(scope, fixture.projection);
            expect(await readAcceptedRunnerCreatorActivationBinding(scope, fixture.binding.activationId, fixture.projection)).toEqual(fixture.binding);
            const retained = [...values.entries()];
            await expect(readAcceptedRunnerCreatorActivationBinding(scope, fixture.binding.activationId, {
                ...fixture.projection, machineId: 'substituted-machine',
            })).rejects.toMatchObject({ code: 'runner_creator_launch_custody_unavailable' });
            await expect(writeReviewedRunnerCreatorLaunchCustody({
                scope, activationId: fixture.binding.activationId,
                custody: { ...prepared.custody, binding: { ...fixture.binding, machineId: 'substituted-machine' } },
            })).rejects.toMatchObject({ code: 'runner_creator_launch_custody_unavailable' });
            expect([...values.entries()]).toEqual(retained);
        } finally {
            vi.unstubAllGlobals();
        }
    });
    it('reports absent endpoint facts as the typed unavailable result rather than failing on the projection', async () => {
        const fixture = claimedFixture();
        // A claimed activation whose winning endpoint has not published facts
        // yet projects `endpointFacts: null`, which review must refuse through
        // its own contract instead of reading the missing projection.
        let caught: unknown;
        try {
            await prepareRunnerActivationReviewV1({
                projection: { ...fixture.projection, endpointFacts: null },
                expectedBinding: fixture.binding, preparedAuthoring,
                credentialSelectionBinding, reviewedProviderModel, displayFacts, connectedServiceReviewBindings,
                credentials: { token: 'token' }, encryption: null,
            });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(RunnerMaterializationPreparationError);
        expect(caught).toMatchObject({ code: 'runner_endpoint_facts_unavailable' });
    });
    it('exports fresh scoped Session and Machine keys for Legacy credentials while retaining Account-only owner metadata', async () => {
        const credentialType = 'legacy' as const;
        const accountSecret = new Uint8Array(32).fill(73);
        const accountEncryption = await Encryption.create(accountSecret);
        const credentials = credentialType === 'legacy'
            ? { token: 'token', secret: encodeBase64(accountSecret, 'base64url') }
            : { token: 'token', encryption: { publicKey: encodeBase64(accountEncryption.contentDataKey, 'base64'), machineKey: encodeBase64(accountEncryption.getContentPrivateKey(), 'base64') } };
        const encryption = credentialType === 'legacy'
            ? accountEncryption
            : await Encryption.createFromContentKeyPair({ publicKey: accountEncryption.contentDataKey, machineKey: accountEncryption.getContentPrivateKey() });
        const signing = tweetnacl.sign.keyPair.fromSeed(accountSecret);
        const fixture = await claimedFixtureWithCreatorCustody({
            mode: 'e2ee', creatorAccountId: 'creator',
            accountSigningPublicKey: encodeBase64(signing.publicKey, 'base64url'),
            contentPublicKey: encodeBase64(encryption.contentDataKey, 'base64url'),
            contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey, contentPublicKey: encryption.contentDataKey }), 'base64url'),
            contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(encryption.contentDataKey),
        });
        const prepared = await prepareRunnerActivationReviewV1({
            projection: fixture.projection, expectedBinding: fixture.binding, preparedAuthoring,
            credentialSelectionBinding, reviewedProviderModel, displayFacts, connectedServiceReviewBindings,
            credentials, encryption,
        });
        expect(prepared.custody.machineContentKey).toHaveLength(32);
        expect(prepared.custody.machineContentKey).not.toEqual(accountSecret);
        expect(prepared.custody.machineContentKey).not.toEqual(encryption.getContentPrivateKey());
        expect(prepared.review.machineContentKeyBinding).toEqual(prepared.custody.launchManifest.machineContentKeyBinding);
        const consent = signRunnerConsentV1({
            payload: { v: 1, purpose: 'happier.ephemeral-session-runner.consent', allow: true, claim: fixture.claim.payload, launchManifestCommitment: prepared.review.launchManifestCommitment },
            activationSecretKey: fixture.activationKey.secretKey, installationSecretKey: fixture.installationKey.secretKey,
        });
        const readiness = signRunnerReadinessV1({
            payload: {
                v: 1, purpose: 'happier.ephemeral-session-runner.readiness', claim: fixture.claim.payload,
                launchManifestCommitment: prepared.review.launchManifestCommitment,
                installation: { agentTarget: preparedAuthoring.authoring.agentTarget!, agentRuntimeId: 'codex', executablePath: '/runner/agent', authoritativeVersion: null },
                credentialSelectionBinding: prepared.review.credentialSelectionBinding,
                brokerReadinessRequest: brokerReadinessRequest(
                    fixture,
                    prepared.review,
                    prepared.custody.launchManifest.reviewedProviderModel.selection.modelId,
                ),
            }, activationSecretKey: fixture.activationKey.secretKey, installationSecretKey: fixture.installationKey.secretKey,
        });
        const recipientContent = tweetnacl.box.keyPair();
        const recipientSigning = tweetnacl.sign.keyPair();
        const recipientContentSignature = signAccountContentKeyBindingV1({
            accountSigningSecretKey: recipientSigning.secretKey,
            contentPublicKey: recipientContent.publicKey,
        });
        const requestRecipientEnvelopeProjection = vi.fn(async (accountId: string) => {
            const unavailableReason = accountId === 'setup-pending-account'
                ? 'encryption_setup_required'
                : accountId === 'repair-required-account' ? 'encryption_inconsistent' : null;
            return new Response(JSON.stringify({
                user: {
                    id: accountId,
                    firstName: 'Recipient',
                    lastName: null,
                    avatar: null,
                    username: 'recipient',
                    bio: null,
                    badges: [],
                    status: 'none',
                    publicKey: unavailableReason ? null : Buffer.from(recipientSigning.publicKey).toString('hex'),
                    contentPublicKey: unavailableReason ? null : encodeBase64(recipientContent.publicKey, 'base64'),
                    contentPublicKeySig: unavailableReason ? null : encodeBase64(recipientContentSignature, 'base64'),
                    recipientEnvelopeReadiness: unavailableReason
                        ? { status: 'unavailable', reason: unavailableReason }
                        : { status: 'available' },
                },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        });
        const request = await buildRunnerMaterializationRequestV1({
            projection: { ...fixture.projection, state: 'consented', review: prepared.review, consent, readiness },
            custody: prepared.custody, credentials, encryption, tag: 'runner-session',
            agentState: null,
            initialAccess: {
                grants: [
                    {
                        subject: { kind: 'account', accountId: 'recipient-account' },
                        accessLevel: 'view',
                        canApprovePermissions: false,
                    },
                    {
                        subject: { kind: 'account', accountId: 'setup-pending-account' },
                        accessLevel: 'view',
                        canApprovePermissions: false,
                    },
                    {
                        subject: { kind: 'account', accountId: 'repair-required-account' },
                        accessLevel: 'view',
                        canApprovePermissions: false,
                    },
                ],
            },
            requestRecipientEnvelopeProjection,
        });
        const opened = openBoxBundleWithSecretKey({ bundle: decodeBase64(request.sealedBootstrap, 'base64url'), recipientSecretKey: fixture.runnerBox.secretKey });
        const bootstrap = RunnerRuntimeBootstrapV1Schema.parse(JSON.parse(new TextDecoder().decode(opened!)));
        expect(bootstrap).toMatchObject({
            homeServerIdentityId: fixture.binding.homeServerIdentityId,
            activationId: fixture.binding.activationId,
            creatorAccountId: fixture.binding.creatorAccountId,
            sessionId: fixture.binding.sessionId,
            machineId: fixture.binding.machineId,
            installationId: fixture.claim.payload.installation.installationId,
            launchManifestCommitment: prepared.review.launchManifestCommitment,
        });
        expect(bootstrap.storedContent.mode).toBe('e2ee');
        if (bootstrap.storedContent.mode !== 'e2ee') throw new Error('Expected encrypted Session');
        expect(bootstrap.machineContent).toMatchObject({
            mode: 'e2ee',
            binding: {
                homeServerIdentityId: fixture.binding.homeServerIdentityId,
                creatorAccountId: fixture.binding.creatorAccountId,
                installationId: fixture.claim.payload.installation.installationId,
            },
        });
        const sessionKey = decodeBase64(bootstrap.storedContent.sessionDataEncryptionKey, 'base64url');
        expect(sessionKey).not.toEqual(accountSecret);
        expect(sessionKey).not.toEqual(encryption.getContentPrivateKey());
        expect(sessionKey).not.toEqual(prepared.custody.machineContentKey);
        expect(request.session.dataEncryptionKey).not.toBeNull();
        expect(await encryption.decryptEncryptionKey(request.session.dataEncryptionKey!)).toEqual(sessionKey);
        expect(requestRecipientEnvelopeProjection).toHaveBeenCalledTimes(3);
        const directGrant = request.session.initialAccess?.grants[0];
        expect(directGrant?.subject).toEqual({ kind: 'account', accountId: 'recipient-account' });
        expect(directGrant && 'accountEnvelopeInput' in directGrant
            ? openEncryptedDataKeyEnvelopeV1({
                envelope: decodeBase64(directGrant.accountEnvelopeInput!.encryptedDataKey, 'base64'),
                recipientSecretKeyOrSeed: recipientContent.secretKey,
            })
            : null).toEqual(sessionKey);
        expect(request.session.initialAccess?.grants.slice(1)).toEqual([
            {
                subject: { kind: 'account', accountId: 'setup-pending-account' },
                accessLevel: 'view',
                canApprovePermissions: false,
            },
            {
                subject: { kind: 'account', accountId: 'repair-required-account' },
                accessLevel: 'view',
                canApprovePermissions: false,
            },
        ]);
        expect(await new AES256Encryption(sessionKey).decrypt([decodeBase64(request.session.metadata, 'base64')])).toEqual([{ v: 1 }]);
        expect(openSessionOwnerMetadataEnvelopeV1({ accountMode: 'e2ee', envelope: request.session.ownerMetadata, material: credentialType === 'legacy'
            ? { type: 'legacy', secret: accountSecret }
            : { type: 'dataKey', machineKey: accountEncryption.getContentPrivateKey() } })).toMatchObject({ ok: true, ownerMetadata: { workspace: { path: '/work/project' } } });
        expect(openSessionOwnerMetadataEnvelopeV1({ accountMode: 'e2ee', envelope: request.session.ownerMetadata, material: { type: 'legacy', secret: sessionKey } })).toMatchObject({ ok: false });
        const display = SessionDisplayProjectionV1Schema.parse(request.session.displayProjectionV1);
        expect(display).toMatchObject({ sourceMetadataVersion: 0, metadataLayoutVersion: 1,
            shared: { t: 'encrypted' }, owner: { t: 'encrypted' } });
        expect(await openSessionSharedDisplayEnvelopeV1({
            sessionMode: 'e2ee', envelope: display.shared,
            decryptPayload: async (ciphertext) => (await new AES256Encryption(sessionKey)
                .decrypt([decodeBase64(ciphertext, 'base64')]))[0],
        })).toEqual({ ok: true, display: { v: 1 } });
        expect(openSessionOwnerDisplayEnvelopeV1({
            accountMode: 'e2ee', envelope: display.owner,
            material: credentialType === 'legacy' ? { type: 'legacy', secret: accountSecret }
                : { type: 'dataKey', machineKey: accountEncryption.getContentPrivateKey() },
        })).toMatchObject({ ok: true, display: { path: '/work/project', host: 'runner.example.test',
            homeDir: '/runner/home', machineId: fixture.binding.machineId } });
        expect(openSessionOwnerDisplayEnvelopeV1({
            accountMode: 'e2ee', envelope: display.owner,
            material: { type: 'legacy', secret: sessionKey },
        })).toMatchObject({ ok: false });
        const machineEncryption = encryption.getMachineEncryption(fixture.binding.machineId);
        expect(machineEncryption).not.toBeNull();
        expect(await machineEncryption!.decryptMetadata(1, request.machine.metadata)).toEqual(endpointFactsContent.machine);

        await expect(buildRunnerMaterializationRequestV1({
            projection: { ...fixture.projection, state: 'consented', review: prepared.review, consent, readiness },
            custody: prepared.custody, credentials, encryption, tag: 'runner-session-malformed-recipient',
            agentState: null,
            initialAccess: {
                grants: [{
                    subject: { kind: 'account', accountId: 'malformed-recipient' },
                    accessLevel: 'view',
                    canApprovePermissions: false,
                }],
            },
            requestRecipientEnvelopeProjection: async () => new Response('{', {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        })).rejects.toMatchObject({ code: 'session_access_invalid_recipient_envelope' });
    });

    it('signs the scoped Machine key proof for a data-key credential that holds no Account signing key', async () => {
        const accountSecret = new Uint8Array(32).fill(59);
        const accountEncryption = await Encryption.create(accountSecret);
        const encryption = await Encryption.createFromContentKeyPair({
            publicKey: accountEncryption.contentDataKey,
            machineKey: accountEncryption.getContentPrivateKey(),
        });
        // The Account content-key binding is public material the Home projects.
        // This creator's credential carries no signing secret at all.
        const accountSigning = tweetnacl.sign.keyPair.fromSeed(accountSecret);
        const credentials = {
            token: 'token',
            encryption: {
                publicKey: encodeBase64(encryption.contentDataKey, 'base64'),
                machineKey: encodeBase64(encryption.getContentPrivateKey(), 'base64'),
            },
        };
        const fixture = await claimedFixtureWithCreatorCustody({
            mode: 'e2ee', creatorAccountId: 'creator',
            accountSigningPublicKey: encodeBase64(accountSigning.publicKey, 'base64url'),
            contentPublicKey: encodeBase64(encryption.contentDataKey, 'base64url'),
            contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({
                accountSigningSecretKey: accountSigning.secretKey,
                contentPublicKey: encryption.contentDataKey,
            }), 'base64url'),
            contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(encryption.contentDataKey),
        });

        const prepared = await prepareRunnerActivationReviewV1({
            projection: fixture.projection, expectedBinding: fixture.binding, preparedAuthoring,
            credentialSelectionBinding, reviewedProviderModel, displayFacts, connectedServiceReviewBindings,
            credentials, encryption,
        });

        const binding = prepared.review.machineContentKeyBinding!;
        expect(prepared.custody.machineContentKey).toHaveLength(32);
        expect(binding.machineContentKeyFingerprint)
            .toBe(computeRunnerMachineContentKeyFingerprintV1(prepared.custody.machineContentKey!));
        // The proof verifies against the creator's activation identity, and not
        // against the Account signing identity the Home publishes.
        const { accountSignatureBase64Url: _signature, ...payload } = binding;
        expect(verifyRunnerMachineContentKeyBindingV1({
            binding,
            expectedPayload: payload,
            expectedAccountSigningPublicKey: fixture.binding.activationSigningPublicKey,
        })).toEqual(binding);
        expect(verifyRunnerMachineContentKeyBindingV1({
            binding,
            expectedPayload: payload,
            expectedAccountSigningPublicKey: encodeBase64(accountSigning.publicKey, 'base64url'),
        })).toBeNull();
        // The creating device retains the exact verifier for a later read of the
        // published Machine row.
        await expect(loadRunnerCreatorMachineContentKeyTrust(creatorScope, fixture.binding.machineId))
            .resolves.toEqual({
                activationId: fixture.binding.activationId,
                activationSigningPublicKey: fixture.binding.activationSigningPublicKey,
            });
        // …and seals the same non-secret verifier for every other authorized
        // device of the Account, bound to this exact activation and Machine.
        const material = { type: 'dataKey', machineKey: encryption.getContentPrivateKey() } as const;
        expect(openRunnerMachineContentKeyVerifierFactV1({
            ciphertext: binding.creatorVerifierFactCiphertext,
            material,
            expectedActivationId: fixture.binding.activationId,
            expectedMachineId: fixture.binding.machineId,
        })).toBe(fixture.binding.activationSigningPublicKey);
        expect(openRunnerMachineContentKeyVerifierFactV1({
            ciphertext: binding.creatorVerifierFactCiphertext,
            material,
            expectedActivationId: fixture.binding.activationId,
            expectedMachineId: 'another-runner-machine',
        })).toBeNull();
    });

    it('refuses to sign the scoped Machine key without creator activation custody', async () => {
        const accountSecret = new Uint8Array(32).fill(61);
        const encryption = await Encryption.create(accountSecret);
        const accountSigning = tweetnacl.sign.keyPair.fromSeed(accountSecret);
        const fixture = claimedFixture({
            mode: 'e2ee', creatorAccountId: 'creator',
            accountSigningPublicKey: encodeBase64(accountSigning.publicKey, 'base64url'),
            contentPublicKey: encodeBase64(encryption.contentDataKey, 'base64url'),
            contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({
                accountSigningSecretKey: accountSigning.secretKey,
                contentPublicKey: encryption.contentDataKey,
            }), 'base64url'),
            contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(encryption.contentDataKey),
        });
        await expect(prepareRunnerActivationReviewV1({
            projection: fixture.projection, expectedBinding: fixture.binding, preparedAuthoring,
            credentialSelectionBinding, reviewedProviderModel, displayFacts, connectedServiceReviewBindings,
            credentials: { token: 'token', secret: encodeBase64(accountSecret, 'base64url') },
            encryption,
        })).rejects.toMatchObject({ code: 'runner_activation_signing_custody_unavailable' });
    });

    it('rejects readiness for an Agent other than the reviewed launch Agent', async () => {
        const fixture = claimedFixture();
        const prepared = await prepareRunnerActivationReviewV1({
            projection: fixture.projection,
            expectedBinding: fixture.binding,
            preparedAuthoring,
            credentialSelectionBinding, reviewedProviderModel, displayFacts, connectedServiceReviewBindings,
            credentials: { token: 'token' },
            encryption: null,
        });
        const consent = signRunnerConsentV1({
            payload: {
                v: 1,
                purpose: 'happier.ephemeral-session-runner.consent',
                allow: true,
                claim: fixture.claim.payload,
                launchManifestCommitment: prepared.review.launchManifestCommitment,
            },
            activationSecretKey: fixture.activationKey.secretKey,
            installationSecretKey: fixture.installationKey.secretKey,
        });
        const readiness = signRunnerReadinessV1({
            payload: {
                v: 1,
                purpose: 'happier.ephemeral-session-runner.readiness',
                claim: fixture.claim.payload,
                launchManifestCommitment: prepared.review.launchManifestCommitment,
                installation: {
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.opencode', localId: 'opencode' } },
                    agentRuntimeId: 'opencode',
                    executablePath: '/runner/opencode',
                    authoritativeVersion: null,
                },
                credentialSelectionBinding: prepared.review.credentialSelectionBinding,
                brokerReadinessRequest: brokerReadinessRequest(
                    fixture,
                    prepared.review,
                    prepared.custody.launchManifest.reviewedProviderModel.selection.modelId,
                ),
            },
            activationSecretKey: fixture.activationKey.secretKey,
            installationSecretKey: fixture.installationKey.secretKey,
        });

        await expect(buildRunnerMaterializationRequestV1({
            projection: { ...fixture.projection, state: 'consented', review: prepared.review, consent, readiness },
            custody: prepared.custody,
            credentials: { token: 'token' },
            encryption: null,
            tag: 'runner-session',
            agentState: null,
        })).rejects.toMatchObject({ code: 'runner_review_mismatch' });
    });

    it('rejects endpoint Machine-fact substitution after creator review', async () => {
        const fixture = claimedFixture();
        const prepared = await prepareRunnerActivationReviewV1({
            projection: fixture.projection,
            expectedBinding: fixture.binding,
            preparedAuthoring,
            credentialSelectionBinding, reviewedProviderModel, displayFacts, connectedServiceReviewBindings,
            credentials: { token: 'token' },
            encryption: null,
        });
        const consent = signRunnerConsentV1({
            payload: {
                v: 1,
                purpose: 'happier.ephemeral-session-runner.consent',
                allow: true,
                claim: fixture.claim.payload,
                launchManifestCommitment: prepared.review.launchManifestCommitment,
            },
            activationSecretKey: fixture.activationKey.secretKey,
            installationSecretKey: fixture.installationKey.secretKey,
        });
        const readiness = signRunnerReadinessV1({
            payload: {
                v: 1,
                purpose: 'happier.ephemeral-session-runner.readiness',
                claim: fixture.claim.payload,
                launchManifestCommitment: prepared.review.launchManifestCommitment,
                installation: {
                    agentTarget: preparedAuthoring.authoring.agentTarget!,
                    agentRuntimeId: 'codex',
                    executablePath: '/runner/agent',
                    authoritativeVersion: null,
                },
                credentialSelectionBinding: prepared.review.credentialSelectionBinding,
                brokerReadinessRequest: brokerReadinessRequest(
                    fixture,
                    prepared.review,
                    prepared.custody.launchManifest.reviewedProviderModel.selection.modelId,
                ),
            },
            activationSecretKey: fixture.activationKey.secretKey,
            installationSecretKey: fixture.installationKey.secretKey,
        });
        await expect(buildRunnerMaterializationRequestV1({
            projection: { ...fixture.projection, state: 'consented', review: prepared.review, consent, readiness },
            custody: {
                ...prepared.custody,
                launchManifest: {
                    ...prepared.custody.launchManifest,
                    endpointFacts: {
                        ...prepared.custody.launchManifest.endpointFacts,
                        machine: {
                            ...prepared.custody.launchManifest.endpointFacts.machine,
                            host: 'substituted.example.test',
                        },
                    },
                },
            },
            credentials: { token: 'token' },
            encryption: null,
            tag: 'runner-session',
            agentState: null,
        })).rejects.toMatchObject({ code: 'runner_review_mismatch' });
    });

    it('stores one sealed reviewed manifest, then builds the strict plain materialization request', async () => {
        const fixture = claimedFixture();
        const storeReview = vi.fn(async (activationId, review) => review);
        const prepared = await prepareAndStoreRunnerActivationReviewV1({
            client: { storeReview } as never,
            projection: fixture.projection, expectedBinding: fixture.binding, preparedAuthoring,
            credentialSelectionBinding, reviewedProviderModel, displayFacts, connectedServiceReviewBindings,
            credentials: { token: 'token' }, encryption: null,
        });
        expect((prepared.review as unknown as Record<string, unknown>).agentTargetKey)
            .toBe('agent:happier.codex/codex');
        expect(storeReview).toHaveBeenCalledWith(fixture.binding.activationId, prepared.review);
        const openedManifest = openBoxBundleWithSecretKey({
            bundle: decodeBase64(prepared.review.sealedLaunchManifest, 'base64url'),
            recipientSecretKey: fixture.runnerBox.secretKey,
        });
        expect(openedManifest && JSON.parse(new TextDecoder().decode(openedManifest))).toEqual(prepared.custody.launchManifest);

        const consent = signRunnerConsentV1({
            payload: { v: 1, purpose: 'happier.ephemeral-session-runner.consent', allow: true, claim: fixture.claim.payload, launchManifestCommitment: prepared.review.launchManifestCommitment },
            activationSecretKey: fixture.activationKey.secretKey, installationSecretKey: fixture.installationKey.secretKey,
        });
        const readiness = signRunnerReadinessV1({
            payload: {
                v: 1, purpose: 'happier.ephemeral-session-runner.readiness', claim: fixture.claim.payload,
                launchManifestCommitment: prepared.review.launchManifestCommitment,
                installation: { agentTarget: preparedAuthoring.authoring.agentTarget!, agentRuntimeId: 'codex', executablePath: '/runner/agent', authoritativeVersion: null },
                credentialSelectionBinding: prepared.review.credentialSelectionBinding,
                brokerReadinessRequest: brokerReadinessRequest(
                    fixture,
                    prepared.review,
                    prepared.custody.launchManifest.reviewedProviderModel.selection.modelId,
                ),
            }, activationSecretKey: fixture.activationKey.secretKey, installationSecretKey: fixture.installationKey.secretKey,
        });
        const requestRecipientEnvelopeProjection = vi.fn(async () => {
            throw new Error('Plain materialization must not request recipient key material');
        });
        const request = await buildRunnerMaterializationRequestV1({
            projection: { ...fixture.projection, state: 'consented', review: prepared.review, consent, readiness },
            custody: prepared.custody, credentials: { token: 'token' }, encryption: null, tag: 'runner-session',
            agentState: null,
            initialAccess: {
                grants: [{
                    subject: { kind: 'account', accountId: 'plain-recipient' },
                    accessLevel: 'view',
                    canApprovePermissions: false,
                    accountEnvelopeInput: {
                        v: 1,
                        encryptedDataKey: encodeBase64(new Uint8Array(105), 'base64'),
                    },
                }],
            },
            requestRecipientEnvelopeProjection,
        });
        expect(request).toMatchObject({
            v: 1, activationId: fixture.binding.activationId,
            session: {
                requestedEncryptionMode: 'plain',
                dataEncryptionKey: null,
                displayProjectionV1: {
                    v: 1,
                    sourceMetadataVersion: 0,
                    metadataLayoutVersion: 1,
                    shared: { t: 'plain' },
                    owner: { t: 'plain' },
                },
            },
            machine: { dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, runnerContentKeyBinding: null },
        });
        expect(requestRecipientEnvelopeProjection).not.toHaveBeenCalled();
        const display = SessionDisplayProjectionV1Schema.parse(request.session.displayProjectionV1);
        expect(await openSessionSharedDisplayEnvelopeV1({
            sessionMode: 'plain', envelope: display.shared,
        })).toEqual({ ok: true, display: { v: 1 } });
        expect(openSessionOwnerDisplayEnvelopeV1({
            accountMode: 'plain', envelope: display.owner,
        })).toMatchObject({ ok: true, display: { path: '/work/project', host: 'runner.example.test',
            homeDir: '/runner/home', machineId: fixture.binding.machineId } });
        expect(request.session.initialAccess?.grants).toEqual([{
            subject: { kind: 'account', accountId: 'plain-recipient' },
            accessLevel: 'view',
            canApprovePermissions: false,
        }]);
        expect(decodePlainMachineStoredContent(request.machine.metadata)).toEqual(endpointFactsContent.machine);
        expect(openSessionOwnerMetadataEnvelopeV1({
            accountMode: 'plain',
            envelope: request.session.ownerMetadata,
            material: null,
        })).toMatchObject({
            ok: true,
            ownerMetadata: {
                workspace: {
                    path: endpointFactsContent.directory,
                    host: endpointFactsContent.machine.host,
                    version: endpointFactsContent.machine.happyCliVersion,
                    os: endpointFactsContent.machine.platform,
                    machineId: fixture.binding.machineId,
                    homeDir: endpointFactsContent.machine.homeDir,
                    happyHomeDir: endpointFactsContent.machine.happyHomeDir,
                },
            },
        });
        expect(request.accessKeyData).toMatch(/^session-machine-control:/);

        const values = new Map<string, string>();
        vi.stubGlobal('window', { localStorage: {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => { values.set(key, value); },
            removeItem: (key: string) => { values.delete(key); },
        } });
        const scope = { serverId: 'srv_runner', accountId: 'creator' };
        await writePreparedRunnerCreatorLaunchCustody({ scope, activationId: fixture.binding.activationId, preparedAuthoring });
        await acceptRunnerCreatorActivationBinding(scope, fixture.projection);
        await writeReviewedRunnerCreatorLaunchCustody({ scope, activationId: fixture.binding.activationId, custody: prepared.custody });
        const currentProjection = { ...fixture.projection, state: 'consented' as const, review: prepared.review, consent, readiness };
        const build = vi.fn(async () => request);
        const [first, concurrent] = await Promise.all([
            getOrCreateRunnerMaterializationRequest({ scope, activationId: fixture.binding.activationId, projection: currentProjection, build }),
            getOrCreateRunnerMaterializationRequest({ scope, activationId: fixture.binding.activationId, projection: currentProjection, build }),
        ]);
        expect(build).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(first)).toBe(JSON.stringify(request));
        expect(JSON.stringify(concurrent)).toBe(JSON.stringify(request));
        expect(JSON.stringify(await getOrCreateRunnerMaterializationRequest({
            scope,
            activationId: fixture.binding.activationId,
            projection: currentProjection,
            build: async () => { throw new Error('must not rebuild after remount'); },
        }))).toBe(JSON.stringify(request));
        await expect(getOrCreateRunnerMaterializationRequest({
            scope,
            activationId: fixture.binding.activationId,
            projection: { ...currentProjection, machineId: 'different-machine' },
            build,
        })).rejects.toMatchObject({ code: 'runner_creator_launch_custody_unavailable' });
        const transport = vi.fn(async () => new Response(JSON.stringify({
            status: 'materialized',
            result: { v: 1, activationId: fixture.binding.activationId, sessionId: 'session-a', machineId: 'machine-a' },
        }), { status: 200 }));
        await expect(createRunnerActivationClient(transport).materialize(request)).resolves.toMatchObject({ status: 'materialized' });
        expect(transport).toHaveBeenCalledWith(
            `/v1/ephemeral-runners/activations/${fixture.binding.activationId}/session`,
            expect.objectContaining({ method: 'PUT', body: JSON.stringify(request) }),
            { includeAuth: true, retry: 'none' },
        );
        vi.unstubAllGlobals();
    });

    it('replays the exact retained sealed review after a committed response is lost', async () => {
        const fixture = claimedFixture();
        let retained: RunnerReviewCustodyV1 | null = null;
        const submitted: unknown[] = [];
        const storeReview = vi.fn(async (_activationId: string, review: unknown) => {
            submitted.push(review);
            if (submitted.length === 1) throw new Error('response_lost_after_commit');
            return review;
        });
        const input = {
            client: { storeReview } as never,
            projection: fixture.projection,
            expectedBinding: fixture.binding,
            preparedAuthoring,
            credentialSelectionBinding,
            reviewedProviderModel,
            displayFacts,
            connectedServiceReviewBindings,
            credentials: { token: 'token' },
            encryption: null,
            readRetainedCustody: async () => retained,
            retainPreparedCustody: async (custody: RunnerReviewCustodyV1) => { retained = custody; },
        } as const;

        await expect(prepareAndStoreRunnerActivationReviewV1(input)).rejects.toThrow('response_lost_after_commit');
        await expect(prepareAndStoreRunnerActivationReviewV1(input)).resolves.toMatchObject({ custody: retained });
        expect(submitted).toHaveLength(2);
        expect(JSON.stringify(submitted[1])).toBe(JSON.stringify(submitted[0]));
    });
});
