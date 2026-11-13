import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import * as React from 'react';
import type { RunnerActivationBindingV1 } from '@happier-dev/protocol/ephemeralRunner/activation';
import type { RunnerActivationProjectionV1 } from '@happier-dev/protocol/ephemeralRunner/projection';
import { signRunnerClaimV1 } from '@happier-dev/protocol/ephemeralRunner/endpoint';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import {
    createRunnerActivationKeyCustody,
    openRunnerActivationKeyCustody,
    readRunnerActivationSigningKey,
} from './runnerActivationKeyCustody';
import { retireRunnerActivationKeyCustodyAfterVerifiedClaim } from './runnerActivationCustody';
import { acceptRunnerCreatorActivationBinding, writePreparedRunnerCreatorLaunchCustody } from './runnerCreatorLaunchCustody';
import { createRunnerActivationClient } from '@/sync/api/ephemeralRunner/runnerActivationClient';
import { renderScreen } from '@/dev/testkit';
import { NewSessionLaunchSurface } from '@/components/sessions/new/components/NewSessionLaunchSurface';
import type { TemporaryComputerLaunchController } from '@/components/sessions/new/hooks/useTemporaryComputerLaunch';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const scope = { serverId: 'home-a', accountId: 'creator-a' } as const;

beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
    } });
});
afterEach(() => vi.unstubAllGlobals());

describe('Runner activation custody retirement', () => {
    it('retains the exact signing key until the creator proof is published, then removes it', async () => {
        const custody = await createRunnerActivationKeyCustody(scope);
        const secretKey = decodeBase64(await readRunnerActivationSigningKey(scope, custody), 'base64url');
        const installation = tweetnacl.sign.keyPair();
        const binding: RunnerActivationBindingV1 = {
            activationId: custody.activationId,
            homeServerIdentityId: 'srv_runner',
            creatorAccountId: scope.accountId,
            creatorTokenEpoch: 1,
            activationExpiresAt: null,
            workspace: { kind: 'choose_on_endpoint' },
            sessionId: 'session-a',
            machineId: 'machine-a',
            activationSigningPublicKey: custody.activationSigningPublicKey,
            authoringCommitment: encodeBase64(new Uint8Array(32).fill(3), 'base64url'),
            artifact: {
                product: 'happier-runner',
                version: '0.3.0',
                target: 'linux-x64',
                sha256: 'a'.repeat(64),
            },
            endpointFactsRecipient: { mode: 'plain', creatorAccountId: scope.accountId },
        };
        const claim = signRunnerClaimV1({
            payload: {
                v: 1,
                purpose: 'happier.ephemeral-session-runner.claim',
                binding,
                runnerBoxPublicKey: encodeBase64(tweetnacl.box.keyPair().publicKey, 'base64url'),
                installation: {
                    installationId: 'runner-installation',
                    publicKey: encodeBase64(installation.publicKey, 'base64url'),
                    proof: signMachineInstallationProof({
                        payload: {
                            version: 1,
                            installationId: 'runner-installation',
                            machineId: binding.machineId,
                            accountId: binding.creatorAccountId,
                        },
                        privateKey: installation.secretKey,
                    }),
                },
                protocolEpoch: 1,
            },
            activationSecretKey: secretKey,
        });
        secretKey.fill(0);
        const review: NonNullable<RunnerActivationProjectionV1['review']> = {
            sealedLaunchManifest: 'sealed',
            authoringCommitment: binding.authoringCommitment,
            launchManifestCommitment: encodeBase64(new Uint8Array(32).fill(7), 'base64url'),
            endpointFactsProof: {
                activationSignature: claim.signature,
                installationSignature: claim.signature,
            },
            agentTargetKey: 'agent:happier.agent.codex/codex',
            machineContentKeyBinding: null,
            credentialSelectionBinding: {
                v: 1,
                resourceId: 'resource-a',
                brokerMachineId: 'broker-a',
                revision: 1,
                application: {
                    agentTargetKey: 'agent:happier.agent.codex/codex',
                    implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' },
                    endpointTemplateId: 'responses',
                    protocol: 'openai-responses',
                },
                sourceRevision: 'source-revision-a',
            },
            displayFacts: {
                v: 1,
                homeId: 'home-a',
                homeName: 'Alice’s Home',
                requesterId: scope.accountId,
                requesterName: 'Alice',
                teamId: 'team-a',
                teamName: 'Acme',
            },
        };
        const claimedProjection: RunnerActivationProjectionV1 = {
            ...binding,
            draftId: 'draft-a',
            state: 'claimed',
            closeReason: null,
            progressPhase: null,
            claim,
            endpointFacts: null,
            review: null,
            consent: null,
            readiness: null,
            materialization: null,
        };
        const projection: RunnerActivationProjectionV1 = { ...claimedProjection, review };
        await writePreparedRunnerCreatorLaunchCustody({
            scope, activationId: custody.activationId,
            preparedAuthoring: {
                v: 1, actionsSettings: { v: 1, actions: {} }, mcpMaterial: null,
                agentPluginDistribution: null,
                authoring: {
                    targetType: 'new_session',
                    executionTarget: { kind: 'temporary_computer', serverId: scope.serverId, artifactTarget: 'linux-x64', workspace: binding.workspace },
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                    permissionMode: 'default', modelSelection: null, transcriptStorage: 'persisted',
                    profileId: null, environmentVariables: null,
                    capabilitySelection: { mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: [] } },
                    connectedServices: null, checkoutCreationDraft: null, resumeSessionId: null, terminal: null,
                    windowsRemoteSessionLaunchMode: null, windowsRemoteSessionConsole: null, windowsTerminalWindowName: null,
                    acpSessionModeId: null, sessionConfigOptionOverrides: null, access: null, primaryTeamId: null,
                    organizationPlacement: { folderId: null, tagIds: [] },
                },
                composer: { text: 'Inspect this', references: [], attachments: [] }, files: [],
                attachmentDestination: { uploadLocation: 'workspace', workspaceRelativeDir: '.happier/uploads', vcsIgnoreStrategy: 'git_info_exclude', vcsIgnoreWritesEnabled: true },
            },
        });
        await acceptRunnerCreatorActivationBinding(scope, claimedProjection);

        await expect(retireRunnerActivationKeyCustodyAfterVerifiedClaim({
            scope,
            expectedBinding: binding,
            projection: {
                ...projection,
                claim: { ...claim, signature: encodeBase64(new Uint8Array(64), 'base64url') },
            },
        })).rejects.toThrow('runner_activation_invalid_claim');
        await expect(openRunnerActivationKeyCustody(scope, custody.activationId)).resolves.toEqual(custody);

        // The proof this key must still sign is not published yet, so the claim
        // alone must not retire it.
        await expect(retireRunnerActivationKeyCustodyAfterVerifiedClaim({
            scope,
            expectedBinding: binding,
            projection: claimedProjection,
        })).rejects.toThrow('runner_activation_review_unpublished');
        await expect(openRunnerActivationKeyCustody(scope, custody.activationId)).resolves.toEqual(custody);

        await retireRunnerActivationKeyCustodyAfterVerifiedClaim({ scope, expectedBinding: binding, projection });
        await expect(openRunnerActivationKeyCustody(scope, custody.activationId)).rejects.toMatchObject({
            code: 'runner_activation_key_unavailable',
        });

        // A fresh presentation mount has no process-local key handle. Retired
        // signing authority must not turn retained creator custody into an
        // observer, nor re-enable export after the endpoint claimed the package.
        const surface = React.createElement(NewSessionLaunchSurface, {
            children: React.createElement('View'),
            temporaryComputerLaunch: {
                input: {
                    client: createRunnerActivationClient(async () => Response.json(projection)),
                    serverId: scope.serverId, draftId: 'draft-a', existingPublicRef: null,
                    prepareActivation: async () => { throw new Error('Unexpected activation creation'); },
                    persistPublicRef: () => undefined, onMaterialized: () => undefined,
                },
                controlRef: { current: null as TemporaryComputerLaunchController | null },
                scope, committedTarget: null, homeLabel: 'Home A', accountLabel: null,
                exportPackage: async () => { throw new Error('Claimed package must not export'); },
                onActiveChange: () => undefined, onLeave: () => undefined,
            },
        });
        const screen = await renderScreen(surface);
        await vi.waitFor(() => expect(screen.findByTestId('temporary-computer-export-claimed')).not.toBeNull());
        expect(screen.findByTestId('temporary-computer-other-device-guidance')).toBeNull();
        expect(screen.findByTestId('temporary-computer-export')?.props.accessibilityState?.disabled).toBe(true);
        await screen.unmount();

        // The same Account on a genuinely different device has no retained custody.
        vi.stubGlobal('window', { localStorage: {
            getItem: () => null,
            setItem: () => undefined,
            removeItem: () => undefined,
        } });
        const observer = await renderScreen(surface);
        await vi.waitFor(() => expect(observer.findByTestId('temporary-computer-other-device-guidance')).not.toBeNull());
        expect(observer.findByTestId('temporary-computer-export')).toBeNull();
        expect(observer.findByTestId('temporary-computer-retry')).toBeNull();
        expect(observer.findByTestId('temporary-computer-cancel')).not.toBeNull();
        await observer.unmount();
    });
});
