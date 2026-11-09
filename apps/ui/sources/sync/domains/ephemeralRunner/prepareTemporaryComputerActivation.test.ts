import { describe, expect, it, vi } from 'vitest';
import sodium from '@/encryption/libsodium.lib';
import { Encryption } from '@/sync/encryption/encryption';
import { encodeBase64 } from '@/encryption/base64';
import {
    computeContentPublicKeyFingerprint} from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import {
    normalizeActionsSettingsV1} from '@happier-dev/protocol/actions/actionSettings';
import {
    SessionAuthoringValueV1Schema,
    type SessionAuthoringValueV1,
} from '@happier-dev/protocol/sessions/authoring/index';
import {
    signAccountContentKeyBindingV1} from '@happier-dev/protocol/crypto/accountContentKeyBindingV1';
import {
    type ComposerSnapshotV1} from '@happier-dev/protocol/plugins/ui/composer';
import type { RunnerEndpointFactsRecipientV1 } from '@happier-dev/protocol/ephemeralRunner/activation';
import type { RunnerPreparedAuthoringV1 } from '@happier-dev/protocol/ephemeralRunner/launchManifest';
import { prepareTemporaryComputerActivation } from './prepareTemporaryComputerActivation';

const custody = {
    activationId: '00000000-0000-4000-8000-000000000013',
    keyHandle: 'runner-key-handle',
    activationSigningPublicKey: 'A'.repeat(43),
} as const;

const preparedAuthoring: RunnerPreparedAuthoringV1 = {
    v: 1,
    actionsSettings: {
        v: 1,
        actions: {
            'session.activity.get': {
                enabledPlacements: [],
                disabledSurfaces: [],
                disabledPlacements: [],
                approvalRequiredSurfaces: [],
                toolExposureModes: {},
            },
        },
    },
    mcpMaterial: null,
    authoring: {
        targetType: 'new_session',
        executionTarget: {
            kind: 'temporary_computer',
            serverId: 'home-a',
            artifactTarget: 'linux-x64',
            workspace: { kind: 'choose_on_endpoint' },
        },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        permissionMode: 'default',
        modelSelection: null,
        transcriptStorage: 'persisted',
        profileId: null,
        environmentVariables: null,
        capabilitySelection: { mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: [] } },
        connectedServices: null,
        checkoutCreationDraft: null,
        resumeSessionId: null,
        terminal: null,
        windowsRemoteSessionLaunchMode: null,
        windowsRemoteSessionConsole: null,
        windowsTerminalWindowName: null,
        acpSessionModeId: 'plan',
        sessionConfigOptionOverrides: {
            v: 1,
            updatedAt: 456,
            overrides: { speed: { updatedAt: 456, value: 'fast' } },
        },
        access: null,
        primaryTeamId: null,
        organizationPlacement: { folderId: null, tagIds: [] },
    },
    agentPluginDistribution: null,
    composer: { text: 'Inspect the project', references: [], attachments: [] },
    files: [],
    attachmentDestination: {
        uploadLocation: 'workspace',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'git_info_exclude',
        vcsIgnoreWritesEnabled: true,
    },
};

const activationAuthoring = SessionAuthoringValueV1Schema.parse({
    ...preparedAuthoring.authoring,
    directory: '/workspace',
    checkoutCreationDraft: null,
    prompt: preparedAuthoring.composer.text,
    displayText: preparedAuthoring.composer.text,
    environmentVariables: null,
    resumeSessionId: null,
    permissionModeUpdatedAt: null,
    terminal: null,
    windowsRemoteSessionLaunchMode: null,
    windowsRemoteSessionConsole: null,
    windowsTerminalWindowName: null,
    runtimeDescriptorV1: null,
    existingSessionId: null,
    sessionEncryptionMode: null,
    sessionEncryptionKeyBase64: null,
    sessionEncryptionVariant: null,
    automation: null,
});

/**
 * The live Composer submission the creator actually freezes. Preparation reads
 * it directly, so the fixture keeps the scope facts a reviewed submission drops.
 */
const composerSnapshot: ComposerSnapshotV1 = {
    revision: 3,
    ref: { kind: 'newSession', instanceId: 'new-session-a' },
    text: preparedAuthoring.composer.text,
    references: [],
    attachments: [],
    layout: 'wrap',
    capabilities: { text: true, references: true, attachments: true, submit: true },
    state: { focused: true, editable: true, submittable: true, submitting: false, running: false },
};

/** Selecting an Automation is an unsupported Temporary-computer authoring field. */
const blockedAutomationSelection: NonNullable<SessionAuthoringValueV1['automation']> = {
    enabled: true,
    name: 'nightly',
    description: '',
    triggers: [],
};

async function recipientForSeed(seedByte: number): Promise<Readonly<{
    recipient: RunnerEndpointFactsRecipientV1;
    encryption: Encryption;
    credentials: Readonly<{ token: string; secret: string }>;
}>> {
    const seed = new Uint8Array(32).fill(seedByte);
    const encryption = await Encryption.create(seed);
    const signing = sodium.crypto_sign_seed_keypair(seed);
    const signature = signAccountContentKeyBindingV1({
        accountSigningSecretKey: signing.privateKey,
        contentPublicKey: encryption.contentDataKey,
    });
    return {
        credentials: { token: 'creator-token', secret: encodeBase64(seed, 'base64url') },
        encryption,
        recipient: {
            mode: 'e2ee',
            creatorAccountId: 'creator-a',
            accountSigningPublicKey: encodeBase64(signing.publicKey, 'base64url'),
            contentPublicKey: encodeBase64(encryption.contentDataKey, 'base64url'),
            contentPublicKeySignature: encodeBase64(signature, 'base64url'),
            contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(encryption.contentDataKey),
        },
    };
}

/**
 * A modern data-key creator: the device holds the Account content key pair but
 * no Account signing key, so it cannot re-sign its own content-key binding. The
 * binding is public material the Account already published and the Home carries
 * it, exactly as `runnerMaterialization` consumes it for every other recipient.
 */
async function dataKeyCreator(seedByte: number): Promise<Readonly<{
    recipient: RunnerEndpointFactsRecipientV1;
    encryption: Encryption;
    credentials: Readonly<{ token: string; encryption: Readonly<{ publicKey: string; machineKey: string }> }>;
}>> {
    const contentKeyPair = sodium.crypto_box_seed_keypair(new Uint8Array(32).fill(seedByte));
    const encryption = await Encryption.createFromContentKeyPair({
        publicKey: contentKeyPair.publicKey,
        machineKey: contentKeyPair.privateKey,
    });
    // The Account signing identity lives with the Account, never on this device.
    const signing = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(seedByte ^ 0x5a));
    const signature = signAccountContentKeyBindingV1({
        accountSigningSecretKey: signing.privateKey,
        contentPublicKey: contentKeyPair.publicKey,
    });
    return {
        encryption,
        credentials: {
            token: 'creator-token',
            encryption: {
                publicKey: encodeBase64(contentKeyPair.publicKey),
                machineKey: encodeBase64(contentKeyPair.privateKey),
            },
        },
        recipient: {
            mode: 'e2ee',
            creatorAccountId: 'creator-a',
            accountSigningPublicKey: encodeBase64(signing.publicKey, 'base64url'),
            contentPublicKey: encodeBase64(contentKeyPair.publicKey, 'base64url'),
            contentPublicKeySignature: encodeBase64(signature, 'base64url'),
            contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(contentKeyPair.publicKey),
        },
    };
}

describe('prepareTemporaryComputerActivation creator recipient authority', () => {
    it.each([
        ['transcriptStorage', { transcriptStorage: 'direct' }],
        ['connectedServices', { connectedServices: { v: 2, bindingsByServiceId: {
            'happier.service.github/github': { source: 'team_resource', resourceId: 'resource-acme' },
        } } }],
        ['connectedServices', { connectedServices: { v: 2, bindingsByServiceId: {
            'happier.service.github/github': { source: 'connected', selection: 'profile', profileId: 'work' },
        } } }],
        ['environmentVariables', { environmentVariables: { HOME: '/creator-selected' } }],
        ['environmentVariables', { environmentVariables: { HAPPIER_CODEX_PROVIDER_API_KEY: 'direct-provider-secret' } }],
        ['windowsRemoteSessionLaunchMode', { windowsRemoteSessionLaunchMode: 'windows_terminal' }],
        ['windowsRemoteSessionConsole', { windowsRemoteSessionConsole: 'visible' }],
        ['windowsTerminalWindowName', { windowsTerminalWindowName: 'Runner reviewed' }],
        ['runtimeDescriptorV1', { runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'appServer' } } }],
        ['automation', { automation: blockedAutomationSelection }],
    ] as const)('blocks selected %s before Home access', async (field, patch) => {
        const readCreatorRecipient = vi.fn();

        await expect(prepareTemporaryComputerActivation({
            client: { readCreatorRecipient } as never,
            custody,
            scope: { serverId: 'home-a', accountId: 'creator-a' },
            credentials: { token: 'creator-token' },
            encryption: null,
            draftId: 'draft-a',
            homeServerIdentityId: 'home-a',
            artifact: {
                identity: { product: 'happier-runner', version: '0.3.0', target: 'linux-x64', sha256: 'a'.repeat(64) },
                channel: 'dev',
                url: 'https://example.test/runner.zip',
                checksumsUrl: 'https://example.test/checksums.txt',
                checksumsSignatureUrl: 'https://example.test/checksums.txt.minisig',
                sizeBytes: 123, entries: [{ path: 'happier-runner', kind: 'file', sizeBytes: 100, mode: 0o755 }],
            },
            authoring: { ...activationAuthoring, ...patch },
            composer: composerSnapshot,
            files: preparedAuthoring.files,
            attachmentDestination: preparedAuthoring.attachmentDestination,
            actionsSettings: preparedAuthoring.actionsSettings,
            mcpMaterial: null,
            selectedAgentProviderOwnedEnvironmentKeys: ['HAPPIER_CODEX_PROVIDER_API_KEY'],
        })).rejects.toMatchObject({
            name: 'RunnerAuthoringIncompatibilityError',
            field,
        });

        expect(readCreatorRecipient).not.toHaveBeenCalled();
    });

    it('preserves portable profile environment, transcript, ACP mode and configuration selections in reviewed authoring', async () => {
        const readCreatorRecipient = vi.fn(async () => ({ mode: 'plain', creatorAccountId: 'creator-a' } as const));

        const prepared = await prepareTemporaryComputerActivation({
            client: { readCreatorRecipient } as never,
            custody,
            scope: { serverId: 'home-a', accountId: 'creator-a' },
            credentials: { token: 'creator-token' },
            encryption: null,
            draftId: 'draft-a',
            homeServerIdentityId: 'home-a',
            artifact: {
                identity: { product: 'happier-runner', version: '0.3.0', target: 'linux-x64', sha256: 'a'.repeat(64) },
                channel: 'dev',
                url: 'https://example.test/runner.zip',
                checksumsUrl: 'https://example.test/checksums.txt',
                checksumsSignatureUrl: 'https://example.test/checksums.txt.minisig',
                sizeBytes: 123,
                entries: [{ path: 'happier-runner', kind: 'file', sizeBytes: 100, mode: 0o755 }],
            },
            authoring: {
                ...activationAuthoring,
                profileId: 'work',
                environmentVariables: { RUNNER_PROFILE_TOKEN: 'sealed-secret' },
                checkoutCreationDraft: { kind: 'git_worktree', displayName: 'reviewed-worktree', baseRef: 'main' },
                resumeSessionId: 'provider-session-reviewed',
                terminal: { mode: 'tmux', tmux: { sessionName: 'runner-reviewed', isolated: true, tmpDir: '/tmp/runner-reviewed' } },
                connectedServices: { v: 2, bindingsByServiceId: {
                    'happier.service.github/github': { source: 'native' },
                } },
            },
            composer: composerSnapshot,
            files: preparedAuthoring.files,
            attachmentDestination: preparedAuthoring.attachmentDestination,
            actionsSettings: preparedAuthoring.actionsSettings,
            mcpMaterial: {
                v: 1,
                strictMode: true,
                capabilitySelection: { mcp: { v: 1, managedServersEnabled: false, forceIncludeServerIds: ['reviewed'], forceExcludeServerIds: [] } },
                servers: [{
                    serverId: 'reviewed', serverRevision: 2, bindingId: 'all', bindingRevision: 4,
                    savedSecretRevisions: [{ secretId: 'token', revision: 5 }],
                    config: {
                        id: 'reviewed', name: 'reviewed', transport: 'stdio',
                        stdio: { command: '/runner/bin/reviewed', args: [] },
                        env: { TOKEN: { t: 'literal', v: 'mcp-sealed-secret' } },
                        createdAt: 1, updatedAt: 2,
                    },
                }],
            },
            selectedAgentProviderOwnedEnvironmentKeys: ['HAPPIER_CODEX_PROVIDER_API_KEY'],
        });

        expect(prepared.preparedAuthoring.authoring).toMatchObject({
            profileId: 'work',
            environmentVariables: { RUNNER_PROFILE_TOKEN: 'sealed-secret' },
            checkoutCreationDraft: { kind: 'git_worktree', displayName: 'reviewed-worktree', baseRef: 'main' },
            resumeSessionId: 'provider-session-reviewed',
            terminal: { mode: 'tmux', tmux: { sessionName: 'runner-reviewed', isolated: true, tmpDir: '/tmp/runner-reviewed' } },
            connectedServices: { v: 2, bindingsByServiceId: {
                'happier.service.github/github': { source: 'native' },
            } },
            transcriptStorage: 'persisted',
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 456,
                overrides: { speed: { updatedAt: 456, value: 'fast' } },
            },
        });
        expect(prepared.preparedAuthoring.mcpMaterial?.servers[0]).toMatchObject({
            serverId: 'reviewed',
            serverRevision: 2,
            bindingId: 'all',
            bindingRevision: 4,
        });
        expect(JSON.stringify(prepared.request)).not.toContain('sealed-secret');
        expect(JSON.stringify(prepared.request)).not.toContain('mcp-sealed-secret');
    });

    it('rejects an exact Home-substituted recipient before returning an activation request', async () => {
        const local = await recipientForSeed(7);
        const substituted = await recipientForSeed(9);

        await expect(prepareTemporaryComputerActivation({
            client: {
                readCreatorRecipient: vi.fn(async () => substituted.recipient),
            } as never,
            custody,
            scope: { serverId: 'home-a', accountId: 'creator-a' },
            credentials: local.credentials,
            encryption: local.encryption,
            draftId: 'draft-a',
            homeServerIdentityId: 'home-a',
            artifact: {
                identity: { product: 'happier-runner', version: '0.3.0', target: 'linux-x64', sha256: 'a'.repeat(64) },
                channel: 'dev',
                url: 'https://example.test/runner.zip',
                checksumsUrl: 'https://example.test/checksums.txt',
                checksumsSignatureUrl: 'https://example.test/checksums.txt.minisig',
                sizeBytes: 123, entries: [{ path: 'happier-runner', kind: 'file', sizeBytes: 100, mode: 0o755 }],
            },
            authoring: activationAuthoring,
            composer: composerSnapshot,
            files: preparedAuthoring.files,
            attachmentDestination: preparedAuthoring.attachmentDestination,
            actionsSettings: preparedAuthoring.actionsSettings,
            mcpMaterial: null,
            selectedAgentProviderOwnedEnvironmentKeys: ['HAPPIER_CODEX_PROVIDER_API_KEY'],
        })).rejects.toMatchObject({ code: 'runner_creator_recipient_mismatch' });

    });

    it('publishes the exact locally derived legacy recipient after Home confirmation', async () => {
        const local = await recipientForSeed(7);

        const prepared = await prepareTemporaryComputerActivation({
            client: { readCreatorRecipient: vi.fn(async () => local.recipient) } as never,
            custody,
            scope: { serverId: 'home-a', accountId: 'creator-a' },
            credentials: local.credentials,
            encryption: local.encryption,
            draftId: 'draft-a',
            homeServerIdentityId: 'home-a',
            artifact: {
                identity: { product: 'happier-runner', version: '0.3.0', target: 'linux-x64', sha256: 'a'.repeat(64) },
                channel: 'dev',
                url: 'https://example.test/runner.zip',
                checksumsUrl: 'https://example.test/checksums.txt',
                checksumsSignatureUrl: 'https://example.test/checksums.txt.minisig',
                sizeBytes: 123, entries: [{ path: 'happier-runner', kind: 'file', sizeBytes: 100, mode: 0o755 }],
            },
            authoring: activationAuthoring,
            composer: composerSnapshot,
            files: preparedAuthoring.files,
            attachmentDestination: preparedAuthoring.attachmentDestination,
            actionsSettings: preparedAuthoring.actionsSettings,
            mcpMaterial: null,
            selectedAgentProviderOwnedEnvironmentKeys: ['HAPPIER_CODEX_PROVIDER_API_KEY'],
            authorizeUnattendedTeamAccess: true,
        });

        expect(prepared.request.endpointFactsRecipient).toEqual(local.recipient);
        expect(prepared.request.authorizeUnattendedTeamAccess).toBe(true);
        expect(prepared.preparedAuthoring.actionsSettings).toEqual(
            normalizeActionsSettingsV1(preparedAuthoring.actionsSettings),
        );
    });

    it.each([
        ['an explicit absolute package expiry', new Date(2031, 4, 17, 6, 42).getTime(), 'choose_on_endpoint'],
        ['the Never default and endpoint Home policy', undefined, 'endpoint_home'],
    ] as const)('carries %s from the reviewed target into the activation request', async (_label, packageExpiresAt, workspaceKind) => {
        const local = await recipientForSeed(7);

        const prepared = await prepareTemporaryComputerActivation({
            client: { readCreatorRecipient: vi.fn(async () => local.recipient) } as never,
            custody,
            scope: { serverId: 'home-a', accountId: 'creator-a' },
            credentials: local.credentials,
            encryption: local.encryption,
            draftId: 'draft-a',
            homeServerIdentityId: 'home-a',
            artifact: {
                identity: { product: 'happier-runner', version: '0.3.0', target: 'linux-x64', sha256: 'a'.repeat(64) },
                channel: 'dev',
                url: 'https://example.test/runner.zip',
                checksumsUrl: 'https://example.test/checksums.txt',
                checksumsSignatureUrl: 'https://example.test/checksums.txt.minisig',
                sizeBytes: 123,
                entries: [{ path: 'happier-runner', kind: 'file', sizeBytes: 100, mode: 0o755 }],
            },
            authoring: {
                ...activationAuthoring,
                executionTarget: {
                    kind: 'temporary_computer',
                    serverId: 'home-a',
                    artifactTarget: 'linux-x64',
                    workspace: { kind: workspaceKind },
                    ...(packageExpiresAt !== undefined ? { packageExpiresAt } : {}),
                },
            },
            composer: composerSnapshot,
            files: preparedAuthoring.files,
            attachmentDestination: preparedAuthoring.attachmentDestination,
            actionsSettings: preparedAuthoring.actionsSettings,
            mcpMaterial: null,
            selectedAgentProviderOwnedEnvironmentKeys: ['HAPPIER_CODEX_PROVIDER_API_KEY'],
        });

        // Exactly the instant the author committed — never rounded, re-derived
        // from a duration, or dropped on the way to the activation row.
        expect(prepared.request.activationExpiresAt).toBe(packageExpiresAt ?? null);
        expect(prepared.request.workspace).toEqual({ kind: workspaceKind });
        expect(prepared.request).not.toHaveProperty('authorizeUnattendedTeamAccess');
    });

    it('cancels the Home currentness read with the preparation signal', async () => {
        const local = await recipientForSeed(7);
        const controller = new AbortController();
        const abortReason = new Error('runner_activation_preparation_canceled');
        const readCreatorRecipient = vi.fn(async (signal?: AbortSignal) => {
            controller.abort(abortReason);
            signal?.throwIfAborted();
            return local.recipient;
        });

        await expect(prepareTemporaryComputerActivation({
            client: { readCreatorRecipient } as never,
            custody,
            scope: { serverId: 'home-a', accountId: 'creator-a' },
            credentials: local.credentials,
            encryption: local.encryption,
            draftId: 'draft-a',
            homeServerIdentityId: 'home-a',
            artifact: {
                identity: { product: 'happier-runner', version: '0.3.0', target: 'linux-x64', sha256: 'a'.repeat(64) },
                channel: 'dev',
                url: 'https://example.test/runner.zip',
                checksumsUrl: 'https://example.test/checksums.txt',
                checksumsSignatureUrl: 'https://example.test/checksums.txt.minisig',
                sizeBytes: 123, entries: [{ path: 'happier-runner', kind: 'file', sizeBytes: 100, mode: 0o755 }],
            },
            authoring: activationAuthoring,
            composer: composerSnapshot,
            files: preparedAuthoring.files,
            attachmentDestination: preparedAuthoring.attachmentDestination,
            actionsSettings: preparedAuthoring.actionsSettings,
            mcpMaterial: null,
            selectedAgentProviderOwnedEnvironmentKeys: ['HAPPIER_CODEX_PROVIDER_API_KEY'],
            signal: controller.signal,
        })).rejects.toBe(abortReason);

        expect(readCreatorRecipient).toHaveBeenCalledWith(controller.signal);
    });

    it('publishes the Account’s own signed binding for a data-key creator that holds no Account signing key', async () => {
        const creator = await dataKeyCreator(4);
        const readCreatorRecipient = vi.fn(async () => creator.recipient);

        const prepared = await prepareTemporaryComputerActivation({
            client: { readCreatorRecipient } as never,
            custody,
            scope: { serverId: 'home-a', accountId: 'creator-a' },
            credentials: creator.credentials,
            encryption: creator.encryption,
            draftId: 'draft-a',
            homeServerIdentityId: 'home-a',
            artifact: {
                identity: { product: 'happier-runner', version: '0.3.0', target: 'linux-x64', sha256: 'a'.repeat(64) },
                channel: 'dev',
                url: 'https://example.test/runner.zip',
                checksumsUrl: 'https://example.test/checksums.txt',
                checksumsSignatureUrl: 'https://example.test/checksums.txt.minisig',
                sizeBytes: 123, entries: [{ path: 'happier-runner', kind: 'file', sizeBytes: 100, mode: 0o755 }],
            },
            authoring: activationAuthoring,
            composer: composerSnapshot,
            files: preparedAuthoring.files,
            attachmentDestination: preparedAuthoring.attachmentDestination,
            actionsSettings: preparedAuthoring.actionsSettings,
            mcpMaterial: null,
            selectedAgentProviderOwnedEnvironmentKeys: ['HAPPIER_CODEX_PROVIDER_API_KEY'],
        });

        expect(prepared.request.endpointFactsRecipient).toEqual(creator.recipient);
    });

    it('refuses a data-key recipient bound to a content key this device does not hold', async () => {
        const creator = await dataKeyCreator(4);
        const substituted = await dataKeyCreator(9);

        await expect(prepareTemporaryComputerActivation({
            client: { readCreatorRecipient: vi.fn(async () => substituted.recipient) } as never,
            custody,
            scope: { serverId: 'home-a', accountId: 'creator-a' },
            credentials: creator.credentials,
            encryption: creator.encryption,
            draftId: 'draft-a',
            homeServerIdentityId: 'home-a',
            artifact: {
                identity: { product: 'happier-runner', version: '0.3.0', target: 'linux-x64', sha256: 'a'.repeat(64) },
                channel: 'dev',
                url: 'https://example.test/runner.zip',
                checksumsUrl: 'https://example.test/checksums.txt',
                checksumsSignatureUrl: 'https://example.test/checksums.txt.minisig',
                sizeBytes: 123, entries: [{ path: 'happier-runner', kind: 'file', sizeBytes: 100, mode: 0o755 }],
            },
            authoring: activationAuthoring,
            composer: composerSnapshot,
            files: preparedAuthoring.files,
            attachmentDestination: preparedAuthoring.attachmentDestination,
            actionsSettings: preparedAuthoring.actionsSettings,
            mcpMaterial: null,
            selectedAgentProviderOwnedEnvironmentKeys: ['HAPPIER_CODEX_PROVIDER_API_KEY'],
        })).rejects.toMatchObject({ code: 'runner_account_encryption_mismatch' });
    });
});

describe('prepareTemporaryComputerActivation reviewed external Agent plugin', () => {
    const externalAgentTarget = {
        kind: 'agent' as const,
        identity: { pluginId: 'acme.reviewed-external', localId: 'assistant' },
    };
    const externalListing = {
        source: {
            id: 'marketplace:community-npm' as const,
            kind: 'community-npm' as const,
            sourceUrl: 'https://registry.npmjs.org/',
        },
        pluginId: 'acme.reviewed-external',
        publisher: { id: 'acme', displayName: 'Acme' },
        packageName: '@acme/reviewed-external',
        registryOrigin: 'https://registry.npmjs.org',
        version: '1.2.3',
        integrity: `sha512-${'A'.repeat(86)}==`,
        manifestDigest: `sha256:${'b'.repeat(64)}`,
        review: { status: 'unreviewed' as const, reviewedAt: null },
        updatePolicy: 'allowed' as const,
    };

    function baseInput(overrides: Record<string, unknown>) {
        return {
            client: { readCreatorRecipient: vi.fn(async () => ({ mode: 'plain', creatorAccountId: 'creator-a' } as const)) } as never,
            custody,
            scope: { serverId: 'home-a', accountId: 'creator-a' },
            credentials: { token: 'creator-token' },
            encryption: null,
            draftId: 'draft-a',
            homeServerIdentityId: 'home-a',
            artifact: {
                identity: { product: 'happier-runner', version: '0.3.0', target: 'linux-x64', sha256: 'a'.repeat(64) },
                channel: 'dev',
                url: 'https://example.test/runner.zip',
                checksumsUrl: 'https://example.test/checksums.txt',
                checksumsSignatureUrl: 'https://example.test/checksums.txt.minisig',
                sizeBytes: 123,
                entries: [{ path: 'happier-runner', kind: 'file', sizeBytes: 100, mode: 0o755 }],
            },
            authoring: activationAuthoring,
            composer: composerSnapshot,
            files: preparedAuthoring.files,
            attachmentDestination: preparedAuthoring.attachmentDestination,
            actionsSettings: preparedAuthoring.actionsSettings,
            mcpMaterial: null,
            selectedAgentProviderOwnedEnvironmentKeys: [],
            ...overrides,
        } as Parameters<typeof prepareTemporaryComputerActivation>[0];
    }

    it('seals the exact reviewed distribution for an externally installed Agent', async () => {
        const prepared = await prepareTemporaryComputerActivation(baseInput({
            authoring: { ...activationAuthoring, agentTarget: externalAgentTarget },
            agentPluginDistribution: externalListing,
        }));

        expect(prepared.preparedAuthoring.agentPluginDistribution).toMatchObject({
            pluginId: 'acme.reviewed-external',
            packageName: '@acme/reviewed-external',
            version: '1.2.3',
            integrity: externalListing.integrity,
        });
    });

    it('refuses an externally installed Agent with no resolved distribution before Home access', async () => {
        const readCreatorRecipient = vi.fn();

        await expect(prepareTemporaryComputerActivation(baseInput({
            client: { readCreatorRecipient } as never,
            authoring: { ...activationAuthoring, agentTarget: externalAgentTarget },
        }))).rejects.toMatchObject({ code: 'runner_agent_plugin_distribution_unavailable' });
        expect(readCreatorRecipient).not.toHaveBeenCalled();
    });

    it('refuses a fabricated distribution for a bundled Agent before Home access', async () => {
        const readCreatorRecipient = vi.fn();

        await expect(prepareTemporaryComputerActivation(baseInput({
            client: { readCreatorRecipient } as never,
            agentPluginDistribution: { ...externalListing, pluginId: 'happier.agent.codex' },
        }))).rejects.toMatchObject({ code: 'runner_agent_plugin_distribution_unexpected' });
        expect(readCreatorRecipient).not.toHaveBeenCalled();
    });

    it('carries no distribution for a bundled Agent', async () => {
        const prepared = await prepareTemporaryComputerActivation(baseInput({}));
        expect(prepared.preparedAuthoring.agentPluginDistribution).toBeNull();
    });
});
