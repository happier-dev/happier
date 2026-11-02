import React from 'react';
import { createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { z } from 'zod/mini';
import { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import 'fake-indexeddb/auto';
import { PluginContributesV2Schema, PluginProjectionV2Schema, buildQualifiedPluginContributionKey, createPluginContributionIdentity, createRecipientContractDigestV1, type PluginProjectionV2, type VoiceProviderContribution } from '@happier-dev/protocol';
import { vi } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import type {
    MachineCapabilitiesCacheState,
    MachineCapabilitiesSnapshot,
} from '@/hooks/server/useMachineCapabilitiesCache';
import { prefetchMachineCapabilities } from '@/hooks/server/useMachineCapabilitiesCache';
import { resolveDaemonCapabilitiesCacheKeySalt } from '@/hooks/server/useDaemonScopedMachineCapabilitiesCache';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1Schema } from '@happier-dev/protocol/daemon/voiceCredentials';
import { PluginPermissionGrantListActionOutputV1Schema } from '@happier-dev/protocol/plugins/permissions/grants';

import { createDeferred, findAllHostTestInstances, findTestInstanceByTypeWithProps, pressTestInstanceAsync, renderScreen as renderTestScreen, waitForTestEvent } from '@/dev/testkit';
import { refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { getConnectedAccountAuthentication, subscribeConnectedServiceRegistry } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { AppShellPluginUiProjectionProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { ConnectedAccountUiProjectionEntryV1Schema } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS } from '@/voice/registry/generatedBundledVoiceEntries';
import { createBundledVoiceRecipientContract } from '@/voice/credentials/voiceRecipientContract';
import type { BundledConversationRuntimeHost } from '@/voice/registry/bundledConversationRuntimeHost';
import { settingsDefaults, settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storageStore';
import { profileDefaults, type Profile } from '@/sync/domains/profiles/profile';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createVoiceSettingsAccountTestHarness, withVoiceSettingsCredentialResource } from './voiceSettingsAccountTestHarness';
import { ModalProvider } from '@/modal/ModalProvider';
import { t, tLoose } from '@/text';
import { VoiceServiceGallery, type VoiceServiceTile } from './VoiceServiceGallery';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { VoiceGlobalConnectedServicesBindingField } from './realtime/VoiceGlobalConnectedServicesBindingField';
import { useMachineCliDetectionTarget } from '@/sync/store/hooks';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import {
    ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
} from '../../../../../../packages/plugins/elevenlabs/src/protocol/voice/index';
import {
    OPENAI_REALTIME_DEFAULT_SETTINGS,
} from '../../../../../../packages/plugins/openai/src/protocol/voice/settings';
import {
    XAI_REALTIME_DEFAULT_SETTINGS,
} from '../../../../../../packages/plugins/xai/src/protocol/voice/settings';


// This third-party SDK export is unavailable on some workers and is never used by these settings rows.
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected streaming Markdown in Voice settings test'); },
}));


let accountFixture: Awaited<ReturnType<typeof createVoiceSettingsAccountTestHarness>>;
const storageBoundary = {
    get settings(): Settings { return storage.getState().settings; },
    set settings(settings: Settings | null) {
        accountFixture.replaceSettings(settings ?? settingsDefaults, { version: (storage.getState().settingsVersion ?? 0) + 1 });
    },
};
async function renderScreen(...input: Parameters<typeof renderTestScreen>) {
    await refreshSavedSecretCatalog(accountFixture.scope);
    if (passiveSetupBoundary.state.status === 'loaded') await primeCapabilities();
    return renderTestScreen(input[0], { ...input[1], wrapper: ({ children }) => <ModalProvider>{children}</ModalProvider> });
}

beforeEach(async () => {
    descriptorAvailable = false;
    voiceProjectionEntries = {};
    accountFixture = await createVoiceSettingsAccountTestHarness(settingsDefaults);
    onTestFinished(accountFixture.dispose);
    passiveSetupBoundary.profile = null;
    passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: false };
    capabilityState = { status: 'idle' };
    rawCredentialReadiness.mockClear();
    const request = accountFixture.request.getMockImplementation()!;
    accountFixture.request.mockImplementation(async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ ...profileDefaults,
            id: storage.getState().profile.id || accountFixture.scope.accountId, ...profileReply }));
        const machineRow = (id: string) => ({ ...createPlainMachineRowFixture({ id,
            accountId: storage.getState().profile.id || accountFixture.scope.accountId }),
            active: machineTarget.isOnline, activeAt: Date.now(), daemonStateVersion: machineTarget.daemonStateVersion,
        });
        const accessMatch = /^\/v1\/machines\/([^/]+)\/access$/.exec(path);
        if (accessMatch) {
            const machine = machineRow(decodeURIComponent(accessMatch[1]!));
            return Response.json({ machineId: machine.id, custodian: machine.access!.custodian, access: machine.access,
                canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [] });
        }
        if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body, machineRow);
        if (path.startsWith('/v1/machines/')) return Response.json({ machine: machineRow(decodeURIComponent(path.slice('/v1/machines/'.length))) });
        if (path === '/v1/machines') return Response.json([
            ...['machine-1', 'machine-2', 'machine-online'].map(machineRow),
            ...(descriptorAvailable ? [{ ...machineRow('descriptor-machine'), active: true }] : []),
        ]);
        if (path === '/v1/plugins/permissions/grants/list') {
            const input = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return Response.json(PluginPermissionGrantListActionOutputV1Schema.parse({ grants: [{
                v: 1, id: 'voice-raw-grant', accountId: accountFixture.scope.accountId,
                pluginId: input.pluginId, capability: input.capability, targetScope: input.targetScope,
                subject: input.subject, authoritySource: { kind: 'machine_installation', machineId: 'machine-online', installationId: 'installation-a' },
                status: 'active', grantedByUserId: accountFixture.scope.accountId, grantedAt: 1, createdAt: 1, updatedAt: 1,
            }], pendingRequests: [] }));
        }
        return request(url, init);
    });
});
let machineTarget = { daemonStateVersion: 0, isOnline: false };
let profileReply: Partial<Profile> | null = null;
let descriptorAvailable = false;
let voiceProjectionEntries: NonNullable<PluginProjectionV2['familiesById']['voiceProviders']>['entriesById'] = {};
let capabilityState: MachineCapabilitiesCacheState = { status: 'idle' };
const pendingDetections: Array<Readonly<{ resolve(value: unknown): void; reject(error: Error): void }>> = [];
function primeCapabilities() {
    return prefetchMachineCapabilities({ machineId: 'machine-1', serverId: accountFixture.scope.serverId,
        cacheKeySalt: resolveDaemonCapabilitiesCacheKeySalt({ id: 'machine-1' }, accountFixture.scope.serverId),
        request: { requests: [{ id: 'cli.codex' }], bypassCache: true } });
}
const passiveSetupBoundary = {
    get profile() { return storage.getState().profile; },
    set profile(value: Partial<z.input<typeof AccountProfileSchema>> | null) {
        const profile = AccountProfileSchema.parse({ ...profileDefaults, id: accountFixture.scope.accountId, ...value });
        profileReply = profile;
        storage.setState({ profile });
    },
    get machineTarget() { return machineTarget; },
    set machineTarget(value: typeof machineTarget) {
        machineTarget = value;
        storage.getState().applyMachines([
            ...['machine-1', 'machine-2', 'machine-online'].map(id => createMachineFixture({
                id, active: value.isOnline, activeAt: Date.now(), daemonStateVersion: value.daemonStateVersion,
            })),
            ...(descriptorAvailable ? [createMachineFixture({ id: 'descriptor-machine', active: true, activeAt: Date.now() })] : []),
        ], true, { sourceServerId: accountFixture.scope.serverId });
        observeMachinePresenceForTest(accountFixture.scope,
            ['machine-1', 'machine-2', 'machine-online', ...(descriptorAvailable ? ['descriptor-machine'] : [])]);
    },
    get state() { return capabilityState; },
    set state(next: MachineCapabilitiesCacheState) {
        capabilityState = next;
        if (next.status !== 'loading') for (const pending of pendingDetections.splice(0)) {
            if (next.status === 'error') pending.reject(new Error('daemon_capabilities_unavailable'));
            else pending.resolve('snapshot' in next && next.snapshot ? next.snapshot.response : { protocolVersion: 1, results: {} });
        }
        if (accountFixture && next.status !== 'idle') void primeCapabilities();
    },
    refresh: vi.fn(),
    invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(
        async () => ({ error: "unavailable" }),
    ),
};
const rawCredentialReadiness = vi.fn((contribution: Readonly<{ pluginId: string; localId: string }>) => contribution);
const rawReadinessListeners = new Set<() => void>();
const subscribeRawReadiness = (notify: () => void) => {
    rawReadinessListeners.add(notify);
    return () => { rawReadinessListeners.delete(notify); };
};
installSessionActionRpcBoundary(async request => {
    const separator = request.method.indexOf(':');
    const machineId = request.method.slice(0, separator);
    const method = request.method.slice(separator + 1);
    if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
        return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
            protocolVersion: 1,
            projection: PluginProjectionV2Schema.parse({ v: 2, generation: 1, installedPackagesById: {},
                agentsById: {}, actionsById: {}, toolsById: {}, commandsById: {}, resourcesById: {}, settingsById: {},
                familiesById: { connectedAccounts: { family: 'connectedAccounts',
                    entriesById: descriptorAvailable ? { [CODEX_CONNECTED_SERVICE_KEY]: codexDescriptorResponse } : {} },
                    voiceProviders: { family: 'voiceProviders', entriesById: voiceProjectionEntries } } }),
        });
    }
    if (method === RPC_METHODS.CAPABILITIES_DETECT) {
        passiveSetupBoundary.refresh(request.params);
        if (capabilityState.status === 'loading') return await new Promise((resolve, reject) => { pendingDetections.push({ resolve, reject }); });
        if (capabilityState.status === 'error') throw new Error('daemon_capabilities_unavailable');
        return 'snapshot' in capabilityState && capabilityState.snapshot
            ? capabilityState.snapshot.response : { protocolVersion: 1, results: {} };
    }
    if (method === RPC_METHODS.CAPABILITIES_INVOKE) {
        return await passiveSetupBoundary.invoke(machineId, request.params);
    }
    if (method === RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_AUTHORIZATION_INSPECT) {
        const input = request.params as { contribution: { pluginId: string; localId: string }; rawGrant: { realm: string; phase: string; request: { origin: string; headerNames: string[] } } };
        const contribution = rawCredentialReadiness(input.contribution);
        for (const notify of rawReadinessListeners) notify();
        return DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1Schema.parse({ ok: true,
            authorization: { pluginId: contribution.pluginId, capability: 'credentials.materialize.raw',
                targetScope: { kind: 'account' }, subject: { kind: 'credential_access_disclosure', contribution,
                    credentialSlotId: 'api_key', purpose: 'voice.speech', accessDeclarationDigest: 'b'.repeat(64),
                    selectedAuthorityDigest: 'c'.repeat(64), selectedRawAccessDigest: 'd'.repeat(64) },
                authoritySource: { kind: 'machine_installation', machineId, installationId: 'installation-a' },
                disclosures: [{ sourceClass: { kind: 'savedSecret', secretKinds: ['apiKey'] },
                    realm: input.rawGrant.realm, phase: input.rawGrant.phase, materialization: 'httpHeaders',
                    origin: input.rawGrant.request.origin, destination: input.rawGrant.request.headerNames[0] }],
            }, review: { plugin: { id: contribution.pluginId, name: 'Voice', version: '1.0.0' },
                package: { identity: contribution.pluginId }, distribution: { kind: 'unavailable' }, publisher: { status: 'unavailable' },
                contribution: { identity: contribution, name: 'Speech' }, credentialSlot: { id: 'api_key', name: 'API key', purpose: 'voice.speech' } },
        });
    }
    return { error: 'unavailable' };
});

async function createActiveAccountLifetime(accountId: string, requestedServerUrl?: string) {
    const profile = passiveSetupBoundary.profile;
    const target = passiveSetupBoundary.machineTarget;
    const serverUrl = requestedServerUrl ?? (await import('@/sync/domains/server/serverRuntime')).getActiveServerSnapshot().serverUrl;
    // A second Account is a logout/restore, not a second cold bootstrap of
    // the still-running Sync owner and its Account A requests.
    await (await import('@/sync/runtime/orchestration/connectionManager')).disconnectActiveServerConnection();
    const connection = await restoreServerAccountForTest({
        serverUrl,
        accountId, request: async (url, init) => new URL(String(url)).pathname === '/v1/account/profile'
            ? Response.json({ ...profile, id: accountId }) : accountFixture.request(url, init),
        credentialScope: 'restored-home',
    });
    onTestFinished(connection.dispose);
    const { sync } = await import('@/sync/sync');
    await Promise.all([
        (Reflect.get(sync, 'settingsSync') as import('@/utils/sessions/sync').InvalidateSync).awaitQueue(),
        sync.refreshProfile(),
    ]);
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Voice settings Account lifetime missing');
    passiveSetupBoundary.machineTarget = target;
    return { ...lifetime, retire: retireActiveServerAccountScopeLifetime };
}

afterEach(() => {
    passiveSetupBoundary.invoke.mockReset();
    passiveSetupBoundary.invoke.mockResolvedValue({ error: "unavailable" });
});

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
// Node's host renderer cannot mount Radix DOM effects; keep Happier's real
// popover, picker and Action owners above the third-party SDK boundary.
vi.mock('@/utils/web/radixCjs', async () => (
    await import('@/dev/testkit/mocks/radixCjs')
).createRadixCjsModuleMock());


vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
}));


function elevenLabsByoConfig() {
    return {
        ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
        billingMode: 'byo' as const,
    };
}

const OPENAI_PROVIDER_ID = 'happier.voice.openai/realtime-openai';
const XAI_PROVIDER_ID = 'happier.voice.xai/realtime-grok';
const ELEVENLABS_PROVIDER_ID = 'happier.voice.elevenlabs/realtime-elevenlabs';
const CODEX_PROVIDER_ID = 'happier.agent.codex/realtime-codex';
const CODEX_CONNECTED_SERVICE_KEY = 'happier.agent.codex/openai-codex';
const CLAUDE_CONNECTED_SERVICE_KEY = 'happier.agent.claude/anthropic';

// A schema-checked daemon DTO at the Socket boundary; the actual app-shell owner publishes it.
const codexDescriptorResponse = ConnectedAccountUiProjectionEntryV1Schema.parse({
            id: 'openai-codex',
            serviceId: 'openai-codex',
            pluginId: 'happier.agent.codex',
            provenance: 'first_party',
            sourceKind: 'bundled',
            title: 'Codex',
            authentication: {
                defaultModeId: 'oauth',
                modes: [{
                    id: 'oauth',
                    kind: 'oauthAuthorizationCode',
                    callbackUrl: 'http://127.0.0.1:4000/auth/callback',
                    scopes: ['openid', 'profile', 'email', 'offline_access'],
                    pkce: 'required',
                    outcomeReconciliation: 'none',
                }],
            },
            capabilities: [],
            availability: { state: 'available', reason: 'resolved' },
            diagnostics: [],
        });

async function installCodexConnectedAccountDescriptor(external?: Readonly<{
    pluginId: string;
    occurrenceId: string;
    declaration: VoiceProviderContribution;
    host: BundledConversationRuntimeHost;
}>) {
    const { createBundledConversationRuntimeHostLease } = await import('@/voice/registry/bundledConversationRuntimeHost');
    const { createBundledConversationRuntimes } = await import('@/voice/registry/bundledConversationRuntimes');
    const { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } = await import('@/voice/registry/generatedBundledVoiceRuntimeEntries');
    const lease = external ? null : createBundledConversationRuntimeHostLease();
    const runtimes = (await createBundledConversationRuntimes({
        bundledEntries: BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES,
        host: external?.host ?? lease!.host,
    }));
    onTestFinished(async () => {
        await Promise.all(runtimes.map(runtime => runtime.dispose()));
        lease?.revoke();
    });
    // These are authored daemon transport facts, not a second projection owner.
    // The CLI projector is deliberately not exercised by this downstream UI suite.
    const bundledEntries = BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS.map(entry => {
        const recipientContract = createBundledVoiceRecipientContract(entry);
        return {
            id: entry.providerId, contributionKey: entry.providerId, pluginId: entry.pluginId,
            occurrenceId: 'voice-settings-bundled-daemon-occurrence', definition: entry.declaration,
            ...(recipientContract ? { recipientContract,
                recipientContractDigest: createRecipientContractDigestV1(recipientContract) } : {}),
        } satisfies NonNullable<PluginProjectionV2['familiesById']['voiceProviders']>['entriesById'][string];
    });
    const externalId = external ? buildQualifiedPluginContributionKey(createPluginContributionIdentity({
        pluginId: external.pluginId, localId: external.declaration.id,
    })) : null;
    voiceProjectionEntries = Object.fromEntries([
        ...bundledEntries.map(entry => [entry.id, entry] as const),
        ...(external && externalId ? [[externalId, {
            id: externalId, contributionKey: externalId, pluginId: external.pluginId,
            occurrenceId: external.occurrenceId, definition: external.declaration,
        } satisfies NonNullable<PluginProjectionV2['familiesById']['voiceProviders']>['entriesById'][string]] as const] : []),
    ]);
    descriptorAvailable = true;
    passiveSetupBoundary.machineTarget = machineTarget;
    const projection = await renderTestScreen(<AppShellPluginUiProjectionProvider><></></AppShellPluginUiProjectionProvider>);
    onTestFinished(projection.unmount);
    await waitForTestEvent(subscribeConnectedServiceRegistry, () => getConnectedAccountAuthentication({
        pluginId: 'happier.agent.codex', localId: 'openai-codex',
    }), authentication => authentication !== null);
    expect(getConnectedAccountAuthentication({ pluginId: 'happier.agent.codex', localId: 'openai-codex' })).not.toBeNull();
}

/** The actual polite region's published announcement, not a synthetic readiness row. */
function checkedReadinessRow(tree: ReactTestRenderer) {
    return tree.root.findAllByProps({ statusTestID: 'settings.voice.provider.readiness-status' })
        .find(node => typeof node.props.announcement === 'string' && node.props.announcement.length > 0) ?? null;
}

/** Query the rendered SDK radio hosts; selection, admission and callbacks remain product-owned. */
function findProviderChoiceRow(tree: ReactTestRenderer | ReactTestInstance, query: Readonly<{ testID?: string; title?: string }>) {
    const root = 'root' in tree ? tree.root : tree;
    const hosts = findAllHostTestInstances(root, node => node.props.accessibilityRole === 'radio');
    if (query.title) return hosts.find(node => node.props.accessibilityLabel === query.title
        || node.props.accessibilityLabel?.startsWith(`${query.title}, `)) ?? null;
    if (!query.testID) return null;
    const testID = query.testID;
    const exact = hosts.find(node => node.props.testID === query.testID);
    const cut = query.testID.lastIndexOf('.');
    const prefix = query.testID.slice(0, cut + 1);
    const service = exact ?? hosts.find(node => node.props.testID?.startsWith(prefix));
    const billing = service?.props.accessibilityState?.checked === true
        ? hosts.find(node => node.props.testID === `settings.voice.provider.payWith:${decodeURIComponent(testID.slice(cut + 1))}`)
        : null;
    return billing ?? service ?? null;
}

function listProviderChoiceRows(tree: ReactTestRenderer | ReactTestInstance) {
    const root = 'root' in tree ? tree.root : tree;
    return findAllHostTestInstances(root, node => node.props.accessibilityRole === 'radio'
        && typeof node.props.testID === 'string' && node.props.testID.startsWith('settings.voice.provider.')
        && !node.props.testID.startsWith('settings.voice.provider.payWith:'));
}

/** Read what assistive technology receives from the real tile footer or billing segment. */
function providerChoiceDetail(node: ReactTestInstance | null | undefined): string {
    if (!node) return '';
    if (node.props.testID?.startsWith('settings.voice.provider.payWith:')) {
        let parent = node.parent;
        while (parent) {
            if (typeof parent.props.subtitle === 'string') return parent.props.subtitle;
            parent = parent.parent;
        }
    }
    // The tile's footer is a sibling of its press target, inside the same rendered card frame.
    let frame = node.parent;
    while (frame?.parent && typeof frame.type !== 'string') frame = frame.parent;
    return [node.props.accessibilityLabel, ...findAllHostTestInstances(frame ?? node, child => child.props.accessible === true)
        .map(child => child.props.accessibilityLabel)].filter(value => typeof value === 'string').join(' · ');
}

const readinessRecoveryLabels = [
    'select_provider', 'open_provider_settings', 'select_execution_machine', 'configure_credential',
    'review_credential_access', 'configure_endpoint', 'install_model', 'switch_provider',
].map(action => tLoose(`voice.readiness.actions.${action}`));

// The settings owner graph is collection work, not part of a timed user interaction.
await import('./VoiceProviderSection');
await import('./BundledConversationSettingsSection');

describe('VoiceProviderSection', () => {
    it.each([true, false])('retries withdrawn Machine presence through a fresh Home read (online=%s)', async (online) => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { useVoiceExecutionMachinePresentation } = await import('@/voice/credentials/useExecutionMachinePresentation');
        const { withdrawMachinePresenceForScope, captureMachinePresenceObservation } = await import('@/sync/domains/machines/reachability/machineReachability');
        const { readLocalConversationVoiceSettings, writeLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 1, isOnline: true };
        const defaults = readLocalConversationVoiceSettings(accountFixture.settings.voice);
        accountFixture.replaceVoice(writeLocalConversationVoiceSettings({ ...accountFixture.settings.voice,
            providerId: 'local_conversation', executionMachine: { mode: 'fixed', machineId: 'machine-1' },
        }, { ...defaults, stt: { ...defaults.stt, provider: 'local_neural',
            localNeural: { ...defaults.stt.localNeural, execution: 'daemon' } } }));
        const voice = accountFixture.settings.voice;
        expect(voice.executionMachine).toEqual({ mode: 'fixed', machineId: 'machine-1' });
        const setVoice = vi.fn();
        const navigate = vi.fn();
        let selectionKind = '';
        function MountedPresenceReadiness() {
            const machine = useVoiceExecutionMachinePresentation();
            selectionKind = machine.selectionKind;
            return <VoiceProviderSection voice={voice} setVoice={setVoice} happierVoiceSupported={true} platformOs="web"
                executionMachineId={machine.machineId} executionMachineSelectedId={machine.selectedMachineId}
                executionMachineSelectionKind={machine.selectionKind} onRecoveryAction={navigate}
                localAvailability={{ daemon: { featureEnabled: true, route: 'direct', modelState: 'unknown',
                    runtimeState: 'unknown', pcmCapture: 'available' } }} />;
        }
        const screen = await renderScreen(<MountedPresenceReadiness />);
        const response = createDeferred<Response>();
        const request = accountFixture.request.getMockImplementation()!;
        const { readMachineOnlineGraceMsFromEnv } = await import('@/utils/sessions/machineUtils');
        const presenceGraceMs = readMachineOnlineGraceMsFromEnv();
        const freshMachine = (id: string) => ({
            ...createPlainMachineRowFixture({ id, accountId: accountFixture.scope.accountId }),
            active: online, activeAt: online ? Date.now() : Date.now() - presenceGraceMs - 1, daemonStateVersion: 1,
        });
        let freshRead = false;
        const freshReadEntered = createDeferred<void>();
        accountFixture.request.mockImplementation((url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/machines') {
                freshRead = true;
                freshReadEntered.resolve();
                return response.promise;
            }
            // Adjacent exact reads must observe the same Home fact as its census.
            if (freshRead && path === '/v1/machines/read-batch' && init?.method === 'POST') {
                return Promise.resolve(createMachineReadBatchResponseFixture(init.body, freshMachine));
            }
            if (freshRead && path === '/v1/machines/machine-1') {
                return Promise.resolve(Response.json({ machine: freshMachine('machine-1') }));
            }
            return request(url, init);
        });
        await act(async () => { withdrawMachinePresenceForScope(accountFixture.scope); });
        expect(selectionKind, JSON.stringify({ current: storage.getState().settings.voice.executionMachine,
            persisted: accountFixture.persistedSettings.voice.executionMachine, initial: voice.executionMachine })).toBe('selected_unknown');
        expect(screen.getTextContent()).toContain(tLoose('voice.readiness.execution_machine_unknown'));
        expect(screen.getTextContent()).toContain(t('common.retry'));
        const retry = findAllHostTestInstances(screen.tree.root, node => typeof node.props.testID === 'string'
            && node.props.testID.startsWith('settings.voice.conversations.pipeline')
            && node.props.testID.endsWith('.recover') && typeof node.props.onPress === 'function')[0];
        expect(retry).toBeDefined();
        await act(async () => { retry!.props.onPress(); });
        await freshReadEntered.promise;
        expect(freshRead).toBe(true);
        await act(async () => {
            const otherScope = { ...accountFixture.scope, accountId: 'another-account' };
            withdrawMachinePresenceForScope(otherScope);
            captureMachinePresenceObservation(otherScope)(['machine-1']);
        });
        expect(selectionKind).toBe('selected_unknown');
        if (!online) {
            // A fresh negative follows the existing heartbeat's grace; it does not
            // falsify the Machine owner's monotonic presence preservation.
            vi.useFakeTimers({ toFake: ['Date'] });
            onTestFinished(() => { vi.useRealTimers(); });
            vi.setSystemTime(Date.now() + presenceGraceMs * 2 + 2);
        }
        await act(async () => { response.resolve(Response.json([freshMachine('machine-1')])); });
        await waitForTestEvent(screen.subscribe, () => selectionKind,
            kind => kind === (online ? 'resolved' : 'selected_unreachable'));
        expect(selectionKind).toBe(online ? 'resolved' : 'selected_unreachable');
        if (!online) expect(screen.getTextContent()).toContain(tLoose('voice.readiness.execution_machine_incompatible'));
        expect(navigate).not.toHaveBeenCalled();
        expect(setVoice).not.toHaveBeenCalled();
        expect(storage.getState().settings.voice).toBe(voice);
        await screen.unmount();
    }, 120_000);

    it('retains normalized Voice input identity while propagating Machine and settings changes', async () => {
        const { useVoiceConversationsReadinessModel } = await import('./VoiceProviderSection');
        const voiceSettings = await import('@/sync/domains/settings/voiceSettings');
        accountFixture.replaceVoice({ ...accountFixture.settings.voice, providerId: 'local_conversation' });
        let voice = accountFixture.settings.voice;
        const machine = createMachineFixture({ id: 'normalization-machine', activeAt: Date.now(),
            daemonStateVersion: 1, daemonState: { status: 'running' } });
        const source = { sourceServerId: accountFixture.scope.serverId, sourceAccountId: accountFixture.scope.accountId };
        storage.getState().applyMachines([machine], true, source);
        // Observe the real parser without replacing normalization, migration or provider readers.
        const normalize = vi.spyOn(voiceSettings, 'voiceSettingsParse');
        onTestFinished(() => normalize.mockRestore());
        const frames: Array<Readonly<{ normalizations: number; retainedVoice: boolean; isOff: boolean; checkKey: string | null; readiness: unknown }>> = [];
        function ReadinessNormalizationProbe() {
            const before = normalize.mock.calls.length;
            const model = useVoiceConversationsReadinessModel({ voice, setVoice: accountFixture.replaceVoice,
                executionMachineId: machine.id, executionMachineSelectedId: machine.id,
                executionMachineSelectionKind: 'resolved', happierVoiceSupported: true, platformOs: 'web' });
            const frame = { normalizations: normalize.mock.calls.length - before,
                retainedVoice: model.voice === voice, isOff: model.isOff,
                checkKey: model.selectedReadinessCheckKey, readiness: model.selectedProviderReadiness };
            frames.push(frame);
            return React.createElement('ReadinessNormalizationProbe', frame);
        }
        const screen = await renderScreen(<ReadinessNormalizationProbe />);
        const first = frames.at(-1)!;
        expect(first.checkKey).toEqual(expect.any(String));
        expect(first.retainedVoice).toBe(true);
        await act(async () => {
            storage.getState().applyMachines([createMachineFixture({ id: 'unrelated-machine',
                activeAt: Date.now(), daemonStateVersion: 9 })], false, source);
        });
        // Home's setup ancestor may render for other inventory even though this
        // model's selected Machine and normalized settings are unchanged.
        await screen.update(<ReadinessNormalizationProbe />);
        expect(frames.at(-1)!.retainedVoice).toBe(true);
        expect(frames.at(-1)!.checkKey).toBe(first.checkKey);
        expect(frames.at(-1)!.normalizations).toBe(0);
        frames.length = 0;
        await act(async () => {
            storage.getState().applyMachines([{ ...machine, daemonStateVersion: 2,
                daemonState: { status: 'running', resources: { v: 1,
                    vitals: { state: 'unavailable', reason: 'reader_failed', since: 1 },
                    attention: { level: 'calm', reasons: [] } } } }], false, source);
        });
        const next = frames.at(-1);
        expect(next).toBeDefined();
        expect(next!.checkKey).not.toBe(first.checkKey);
        expect(next!.readiness).toEqual(first.readiness);
        expect(storage.getState().settings.voice).toBe(voice);
        expect(next!.retainedVoice).toBe(true);
        expect(next!.normalizations).toBe(0);
        await act(async () => {
            accountFixture.replaceVoice({ ...voice, providerId: null });
            voice = accountFixture.settings.voice;
        });
        await screen.update(<ReadinessNormalizationProbe />);
        const changedSettings = frames.at(-1)!;
        expect(changedSettings.retainedVoice).toBe(true);
        expect(changedSettings.isOff).toBe(true);
        expect(changedSettings.checkKey).toBeNull();
        await screen.unmount();
    });

    it('carries the declared service description through the registry and gallery independently of billing', async () => {
        const { PLUGIN_MANIFEST } = await import('@happier-dev/plugins-elevenlabs/manifest');
        const { VoiceProviderContributionSchema } = await import('@happier-dev/plugin-sdk/voice');
        const declaration = VoiceProviderContributionSchema.parse(PLUGIN_MANIFEST.contributes.voiceProviders?.[0]);
        expect(declaration).toHaveProperty('description');
        if (declaration.kind !== 'conversation' || !declaration.description) throw new Error('Expected service description');
        const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
        expect(createDefaultVoiceProviderRegistry().get(ELEVENLABS_PROVIDER_ID)).toHaveProperty('description', declaration.description);
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const screen = await renderScreen(<VoiceProviderSection
            voice={settingsParse({ voice: { providerId: null } }).voice}
            setVoice={accountFixture.replaceVoice}
            happierVoiceSupported={true}
            platformOs="web"
        />);
        const gallery = screen.tree.root.findByType(VoiceServiceGallery);
        const tile = (gallery.props.tiles as readonly VoiceServiceTile[]).find(row => row.id === ELEVENLABS_PROVIDER_ID);
        const expected = typeof declaration.description === 'string' ? declaration.description : declaration.description.fallback;
        expect(tile?.subtitle).toBe(expected);
        const choice = listProviderChoiceRows(screen.tree).find(row => row.props.testID?.includes(encodeURIComponent(ELEVENLABS_PROVIDER_ID)));
        expect(providerChoiceDetail(choice)).toContain(expected);
    });
    it.each([null, 'machine-1'])('settles credential-scoped consumers through Account and Home replacement and settings remount (%s)', async (machineId) => {
        const { useVoiceConversationsReadinessModel } = await import('./VoiceProviderSection');
        const { readLocalConversationVoiceSettings, writeLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
        const { useAgentInstallJob } = await import('@/agents/machineAgents/installJobs/useAgentInstallJob');
        const { useAgentSignIn } = await import('@/agents/machineAgents/signIn/useAgentSignIn');
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const configured = readLocalConversationVoiceSettings(accountFixture.settings.voice);
        accountFixture.replaceVoice(writeLocalConversationVoiceSettings(accountFixture.settings.voice, {
            ...configured, conversationMode: 'agent',
            agent: { ...configured.agent, agentSource: 'agent', agentId: 'claude' },
        }));
        const observedAccounts: Array<string | null> = [];
        function SettingsConsumers() {
            const scope = storage((state) => state.settingsScope);
            const voice = storage((state) => state.settings.voice);
            useVoiceConversationsReadinessModel({ voice, setVoice: accountFixture.replaceVoice,
                executionMachineId: machineId, happierVoiceSupported: true, platformOs: 'web' });
            useAgentInstallJob({ serverId: scope?.serverId ?? '', machineId: machineId ?? '', agentId: 'codex' });
            const signIn = useAgentSignIn({ serverId: scope?.serverId, machineId, agentId: 'codex' });
            const credential = useServerCredentialAccountScopeBinding(scope?.serverId);
            observedAccounts.push(credential.binding?.accountId ?? null);
            return React.createElement('CredentialNavigationProbe', {
                accountId: credential.binding?.accountId ?? null,
                serverId: credential.binding?.serverId ?? null,
                signInAvailable: signIn.available,
            });
        }
        const screen = await renderScreen(React.createElement(SettingsConsumers));
        const currentAccount = () => screen.root.findByType('CredentialNavigationProbe').props.accountId;
        await waitForTestEvent(screen.subscribe, currentAccount, accountId => accountId === accountFixture.scope.accountId);
        expect(currentAccount()).toBe(accountFixture.scope.accountId);
        await act(async () => { await createActiveAccountLifetime('account-navigation-next'); });
        await waitForTestEvent(screen.subscribe, currentAccount, accountId => accountId === 'account-navigation-next');
        expect(currentAccount()).toBe('account-navigation-next');
        await act(async () => { await createActiveAccountLifetime('account-navigation-other-home', 'https://voice-navigation-other.example.test'); });
        await waitForTestEvent(screen.subscribe, currentAccount, accountId => accountId === 'account-navigation-other-home');
        expect(currentAccount()).toBe('account-navigation-other-home');
        expect(screen.root.findByType('CredentialNavigationProbe').props.serverId).not.toBe(accountFixture.scope.serverId);
        await screen.update(React.createElement('WorkspaceNavigationProbe'));
        await screen.update(React.createElement(SettingsConsumers));
        await waitForTestEvent(screen.subscribe, currentAccount, accountId => accountId === 'account-navigation-other-home');
        expect(currentAccount()).toBe('account-navigation-other-home');
        // Remounting re-observes catalogs after a gap; their owners withdraw
        // mutation authority and revalidate before the consumers become idle.
        const { getSavedSecretCatalogSnapshot } = await import('@/sync/store/settings/savedSecretCatalogSnapshot');
        const { getConnectedAccountCatalogValue } = await import('@/sync/store/settings/connectedAccountCatalogSnapshot');
        await waitForTestEvent(screen.subscribe, () => {
            const scope = storage.getState().settingsScope;
            if (!scope) return false;
            const savedSecrets = getSavedSecretCatalogSnapshot(scope);
            const purposes = getConnectedAccountCatalogValue(scope, 'purposes');
            return savedSecrets?.status === 'ready' && !savedSecrets.stale
                && purposes.status === 'ready' && !purposes.stale;
        }, settled => settled);
        const settledRenders = observedAccounts.length;
        await act(async () => {});
        await act(async () => {});
        expect(observedAccounts.slice(settledRenders).every(accountId => accountId === 'account-navigation-other-home')).toBe(true);
        expect(screen.root.findByType('CredentialNavigationProbe').props.signInAvailable).toBe(machineId !== null);
    });

    it('does not render a second declarative settings writer for a provider-owned settings section', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const screen = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: settingsParse({ voice: {
                providerId: XAI_PROVIDER_ID,
                providers: {
                    [XAI_PROVIDER_ID]: {
                        schemaVersion: 1,
                        config: XAI_REALTIME_DEFAULT_SETTINGS,
                    },
                },
            } }).voice,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
        }));

        const duplicateDeclarativeControls = screen.tree.root.findAll((node) => (
            typeof node.props?.testID === 'string'
            && node.props.testID.startsWith('settings.plugins.detail.happier.voice.xai.settings.')
        ));
        expect(duplicateDeclarativeControls).toEqual([]);
    }, 120_000);

    it('checks the exact machine and selected Codex Connected Service passively when the page opens and when the machine changes', async () => {
        passiveSetupBoundary.profile = {
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [{
                    profileId: 'codex-profile',
                    status: 'connected',
                    kind: 'oauth',
                }],
            }],
        };
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 7, isOnline: true };
        passiveSetupBoundary.state = {
            status: 'loaded',
            snapshot: {
                response: {
                    protocolVersion: 1,
                    results: {
                        'cli.codex': {
                            ok: true,
                            checkedAt: 1,
                            data: {
                                available: true,
                                version: '0.146.0',
                                resolvedPath: '/managed/codex',
                            },
                        },
                    },
                },
            },
        };
        passiveSetupBoundary.refresh.mockClear();
        passiveSetupBoundary.invoke.mockResolvedValue({ ok: true, result: { v: 1, status: 'unavailable' } });
        onTestFinished(() => {
            passiveSetupBoundary.profile = null;
            passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: false };
            passiveSetupBoundary.state = { status: 'idle' };
            passiveSetupBoundary.refresh.mockReset();
        });
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const sectionProps = {
            voice: settingsParse({ voice: {
                providerId: CODEX_PROVIDER_ID,
                providers: {
                    [CODEX_PROVIDER_ID]: {
                        schemaVersion: 2,
                        config: {
                            globalConnectedServices: {
                                v: 1,
                                bindingsByServiceId: {
                                    [CODEX_CONNECTED_SERVICE_KEY]: {
                                        source: 'connected',
                                        selection: 'profile',
                                        profileId: 'codex-profile',
                                    },
                                },
                            },
                        },
                    },
                },
            } }).voice,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
            localAvailability: {
                browserSpeech: { support: 'available' },
            },
            executionMachineId: 'machine-1',
        } satisfies React.ComponentProps<typeof VoiceProviderSection>;
        const { useVoiceConversationsReadinessModel } = await import('./VoiceProviderSection');
        const transitions: Array<Readonly<{ online: boolean; daemonVersion: number; key: string | null;
            scope: Readonly<{ serverId: string; accountId: string }> | null }>> = [];
        function ReadinessAuthorityProbe() {
            const model = useVoiceConversationsReadinessModel(sectionProps);
            const target = useMachineCliDetectionTarget('machine-1');
            const { binding } = useServerCredentialAccountScopeBinding(accountFixture.scope.serverId);
            transitions.push({ online: target.isOnline, daemonVersion: target.daemonStateVersion,
                key: model.selectedReadinessCheckKey, scope: binding?.isCurrent() ? binding.scope : null });
            return null;
        }
        const screen = await renderScreen(<><VoiceProviderSection {...sectionProps} /><ReadinessAuthorityProbe /></>);
        await act(async () => {});
        await waitForTestEvent(screen.subscribe, () => transitions.some(frame => frame.online && frame.scope?.accountId === accountFixture.scope.accountId), ready => ready);
        expect(transitions.some(frame => frame.online && frame.scope?.accountId === accountFixture.scope.accountId)).toBe(true);
        const cold = transitions.find(frame => !frame.online && frame.scope === null);
        const warm = transitions.find(frame => frame.online && frame.scope?.accountId === accountFixture.scope.accountId);
        expect(cold?.daemonVersion).toBe(7);
        expect(warm?.daemonVersion).toBe(7);
        expect(warm?.scope).toEqual(accountFixture.scope);
        // Reachability admits the probe; unrelated credential catalogs do not.
        expect(warm?.key).not.toBe(cold?.key);

        // The daemon probes this Connected Service binding, not the unrelated
        // saved-secret or purpose catalogs. Their refresh must issue no probe.
        const checksBeforeCatalogRefresh = passiveSetupBoundary.invoke.mock.calls.length;
        await act(async () => {
            await Promise.all([
                refreshSavedSecretCatalog(accountFixture.scope),
                accountFixture.purposes.hydrate(accountFixture.scope),
            ]);
        });
        expect(passiveSetupBoundary.invoke).toHaveBeenCalledTimes(checksBeforeCatalogRefresh);

        // Always-on card readiness: no "Check setup" button; the passive check ran because the page opened.
        expect(screen.findHostByTestId('settings.voice.provider.checkSetup')).toBeNull();
        expect(screen.findHostByTestId('settings.voice.provider.readiness-status')).not.toBeNull();

        expect(passiveSetupBoundary.refresh).toHaveBeenCalledWith(expect.objectContaining({
            bypassCache: true,
        }));
        expect(passiveSetupBoundary.invoke).toHaveBeenCalledWith(
            'machine-1',
            {
                id: 'cli.codex',
                method: 'probePassiveRealtimeSetup',
                params: {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            [CODEX_CONNECTED_SERVICE_KEY]: {
                                source: 'connected',
                                selection: 'profile',
                                profileId: 'codex-profile',
                            },
                        },
                    },
                },
            },
        );
        const readinessHost = checkedReadinessRow(screen.tree);
        expect(readinessHost?.props.announcement).toContain(tLoose('voice.readiness.runtime_unknown'));
        expect(readinessHost?.props.announcement).not.toContain(tLoose('voice.readiness.actions.switch_provider'));
        // The card itself shows the checked readiness; there is no second "Setup status" row.
        expect(screen.getTextContent()).toContain(tLoose('voice.readiness.runtime_unknown'));
        expect(screen.findHostByTestId('settings.voice.provider.readiness')).toBeNull();
        const status = screen.findHostByTestId('settings.voice.provider.readiness-status');
        expect(status).not.toBeNull();
        if (status === null) return;
        expect(status.props.accessibilityLiveRegion).toBe('polite');
        expect(status.props['aria-live']).toBe('polite');

        // A different computer is a different setup to check; the page checks it without being asked.
        passiveSetupBoundary.invoke.mockClear();
        await act(async () => {
            await screen.update(React.createElement(VoiceProviderSection, { ...sectionProps, executionMachineId: 'machine-2' }));
        });
        await act(async () => {});
        expect(passiveSetupBoundary.invoke).toHaveBeenCalledTimes(1);
        expect(passiveSetupBoundary.invoke).toHaveBeenCalledWith('machine-2', expect.anything());
    }, 120_000);

    it('marks Codex setup ready only from the strict passive owner result', async () => {
        passiveSetupBoundary.profile = {
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [{ profileId: 'codex-profile', status: 'connected', kind: 'oauth' }],
            }],
        };
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 7, isOnline: true };
        passiveSetupBoundary.invoke.mockResolvedValue({ ok: true, result: { v: 1, status: 'ready' } });
        onTestFinished(() => {
            passiveSetupBoundary.profile = null;
            passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: false };
            passiveSetupBoundary.state = { status: 'idle' };
            passiveSetupBoundary.refresh.mockReset();
        });

        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const sectionProps = {
            voice: settingsParse({ voice: {
                providerId: CODEX_PROVIDER_ID,
                providers: {
                    [CODEX_PROVIDER_ID]: {
                        schemaVersion: 2,
                        config: {
                            globalConnectedServices: {
                                v: 1,
                                bindingsByServiceId: {
                                    [CODEX_CONNECTED_SERVICE_KEY]: {
                                        source: 'connected',
                                        selection: 'profile',
                                        profileId: 'codex-profile',
                                    },
                                },
                            },
                        },
                    },
                },
            } }).voice,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
            executionMachineId: 'machine-1',
        };
        const screen = await renderScreen(React.createElement(VoiceProviderSection, sectionProps));

        await act(async () => {});

        expect(screen.getTextContent()).toContain(tLoose('voice.readiness.ready'));

        passiveSetupBoundary.profile = {
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [{ profileId: 'codex-profile', status: 'needs_reauth', kind: 'oauth' }],
            }],
        };
        await act(async () => {
            await screen.update(React.createElement(VoiceProviderSection, sectionProps));
        });

        expect(screen.getTextContent()).toContain(tLoose('voice.readiness.credential_missing'));
        expect(screen.getTextContent()).not.toContain(tLoose('voice.readiness.ready'));
    }, 120_000);

    it('does not commit a stale passive result after the selected execution machine changes', async () => {
        passiveSetupBoundary.profile = {
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [{ profileId: 'codex-profile', status: 'connected', kind: 'oauth' }],
            }],
        };
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 7, isOnline: true };
        let settlePassiveCheck: ((value: unknown) => void) | null = null;
        const pendingPassiveCheck = new Promise<unknown>((resolve) => {
            settlePassiveCheck = resolve;
        });
        passiveSetupBoundary.invoke
            .mockImplementationOnce(async () => await pendingPassiveCheck)
            .mockResolvedValueOnce({ ok: true, result: { v: 1, status: 'ready' } });
        onTestFinished(() => {
            passiveSetupBoundary.profile = null;
            passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: false };
            passiveSetupBoundary.state = { status: 'idle' };
            passiveSetupBoundary.refresh.mockReset();
        });

        const { VoiceProviderSection, useVoiceConversationsReadinessModel } = await import('./VoiceProviderSection');
        const frames: Array<Readonly<{ machineId: string | null; online: boolean; daemonVersion: number;
            scope: typeof accountFixture.scope | null; publishedActive: boolean | null; key: string | null;
            modelExecution: string | null; modelCredential: string | null }>> = [];
        function TransitionMetadata(props: React.ComponentProps<typeof VoiceProviderSection>) {
            const model = useVoiceConversationsReadinessModel(props);
            const target = useMachineCliDetectionTarget(props.executionMachineId ?? null);
            const { binding } = useServerCredentialAccountScopeBinding(accountFixture.scope.serverId);
            const machine = storage.getState().machineListByServerId[accountFixture.scope.serverId]
                ?.find(row => row.id === props.executionMachineId);
            frames.push({ machineId: props.executionMachineId ?? null, online: target.isOnline,
                daemonVersion: target.daemonStateVersion, scope: binding?.isCurrent() ? binding.scope : null,
                publishedActive: machine?.active ?? null, key: model.selectedReadinessCheckKey,
                modelExecution: model.selectedProviderRow?.readinessFacts.executionMachine ?? null,
                modelCredential: model.selectedProviderRow?.readinessFacts.credential ?? null });
            return null;
        }
        const render = (executionMachineId: string) => {
            const props = {
                voice: settingsParse({ voice: {
                    providerId: CODEX_PROVIDER_ID,
                    providers: {
                        [CODEX_PROVIDER_ID]: {
                            schemaVersion: 2,
                            config: {
                                globalConnectedServices: {
                                    v: 1,
                                    bindingsByServiceId: {
                                        [CODEX_CONNECTED_SERVICE_KEY]: {
                                            source: 'connected',
                                            selection: 'profile',
                                            profileId: 'codex-profile',
                                        },
                                    },
                                },
                            },
                        },
                    },
                } }).voice,
                setVoice: vi.fn(),
                happierVoiceSupported: true,
                platformOs: 'web',
                executionMachineId,
            } satisfies React.ComponentProps<typeof VoiceProviderSection>;
            return <><VoiceProviderSection {...props} /><TransitionMetadata {...props} /></>;
        };
        const screen = await renderScreen(render('machine-1'));

        await act(async () => {});
        await act(async () => {
            await screen.update(render('machine-2'));
        });
        await act(async () => {
            settlePassiveCheck?.({ ok: true, result: { v: 1, status: 'unavailable' } });
            await Promise.resolve();
        });

        // The page checked the new machine on its own; machine-1's late answer never lands.
        expect(passiveSetupBoundary.invoke, JSON.stringify({
            frames: frames.map(({ key, ...frame }) => ({ ...frame,
                sameKeyAsInitial: key === frames.find(initial => initial.machineId === 'machine-1')?.key })),
            requestedMachines: passiveSetupBoundary.invoke.mock.calls.map(([machineId]) => machineId),
        })).toHaveBeenCalledTimes(2);
        expect(passiveSetupBoundary.invoke).toHaveBeenLastCalledWith('machine-2', expect.anything());
        const readiness = checkedReadinessRow(screen.tree);
        expect(readiness?.props.announcement).toContain(tLoose('voice.readiness.ready'));
        expect(readiness?.props.announcement).not.toContain(tLoose('voice.readiness.runtime_unknown'));
    }, 120_000);

    it('clears a settled passive result when the active Account changes', async () => {
        passiveSetupBoundary.profile = {
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [{ profileId: 'codex-profile', status: 'connected', kind: 'oauth' }],
            }],
        };
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 7, isOnline: true };
        const accountA = await createActiveAccountLifetime('account-a');
        passiveSetupBoundary.invoke.mockImplementation(async () => ({ ok: true, result: { v: 1,
                status: captureActiveServerAccountScopeLifetime()?.scope.accountId === 'account-b'
                    ? 'ready' : 'unavailable' } }));
        onTestFinished(() => {
            passiveSetupBoundary.profile = null;
            passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: false };
            passiveSetupBoundary.state = { status: 'idle' };
            passiveSetupBoundary.refresh.mockReset();
        });

        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const sectionProps = {
            voice: settingsParse({ voice: {
                providerId: CODEX_PROVIDER_ID,
                providers: {
                    [CODEX_PROVIDER_ID]: {
                        schemaVersion: 2,
                        config: {
                            globalConnectedServices: {
                                v: 1,
                                bindingsByServiceId: {
                                    [CODEX_CONNECTED_SERVICE_KEY]: {
                                        source: 'connected',
                                        selection: 'profile',
                                        profileId: 'codex-profile',
                                    },
                                },
                            },
                        },
                    },
                },
            } }).voice,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web' as const,
            executionMachineId: 'machine-1',
        };
        const screen = await renderScreen(React.createElement(VoiceProviderSection, sectionProps));

        await act(async () => {});
        expect(checkedReadinessRow(screen.tree)).not.toBeNull();
        expect(checkedReadinessRow(screen.tree)?.props.announcement).not.toContain(tLoose('voice.readiness.ready'));

        accountA.retire();
        const accountB = await createActiveAccountLifetime('account-b');
        expect(accountB.scope.accountId).toBe('account-b');
        expect(accountB.isCurrent()).toBe(true);
        expect(storage.getState().settingsScope?.accountId).toBe('account-b');
        await act(async () => {
            await screen.update(React.createElement(VoiceProviderSection, sectionProps));
        });

        await act(async () => {});
        // Account A was unavailable; only a fresh Account B answer can be ready.
        const readiness = checkedReadinessRow(screen.tree);
        expect(readiness?.props.announcement).toContain(tLoose('voice.readiness.ready'));
        expect(readiness?.props.announcement).not.toContain(tLoose('voice.readiness.runtime_unknown'));
    }, 120_000);

    it('does not display a settled passive result after the active Account lifetime restarts', async () => {
        passiveSetupBoundary.profile = {
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [{ profileId: 'codex-profile', status: 'connected', kind: 'oauth' }],
            }],
        };
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 7, isOnline: true };
        const accountA = await createActiveAccountLifetime('account-a');
        passiveSetupBoundary.invoke.mockResolvedValue({ ok: true, result: { v: 1, status: 'ready' } });
        onTestFinished(() => {
            passiveSetupBoundary.profile = null;
            passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: false };
            passiveSetupBoundary.state = { status: 'idle' };
            passiveSetupBoundary.refresh.mockReset();
        });

        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const sectionProps = {
            voice: settingsParse({ voice: {
                providerId: CODEX_PROVIDER_ID,
                providers: {
                    [CODEX_PROVIDER_ID]: {
                        schemaVersion: 2,
                        config: {
                            globalConnectedServices: {
                                v: 1,
                                bindingsByServiceId: {
                                    [CODEX_CONNECTED_SERVICE_KEY]: {
                                        source: 'connected',
                                        selection: 'profile',
                                        profileId: 'codex-profile',
                                    },
                                },
                            },
                        },
                    },
                },
            } }).voice,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web' as const,
            executionMachineId: 'machine-1',
        };
        const screen = await renderScreen(React.createElement(VoiceProviderSection, sectionProps));

        await act(async () => {});
        expect(checkedReadinessRow(screen.tree)?.props.announcement).toContain(tLoose('voice.readiness.ready'));

        const freshCheck = createDeferred<unknown>();
        const freshCheckEntered = createDeferred<void>();
        passiveSetupBoundary.invoke.mockClear();
        passiveSetupBoundary.invoke.mockImplementation(async () => { freshCheckEntered.resolve(); return freshCheck.promise; });
        accountA.retire();
        await createActiveAccountLifetime('account-a');
        await act(async () => {
            await screen.update(React.createElement(VoiceProviderSection, sectionProps));
        });

        await freshCheckEntered.promise;
        expect(passiveSetupBoundary.invoke).toHaveBeenCalled();
        expect(checkedReadinessRow(screen.tree)?.props.announcement).toBe(tLoose('settings.updates.checking'));
        expect(checkedReadinessRow(screen.tree)?.props.announcement).not.toContain(tLoose('voice.readiness.ready'));
        await act(async () => {
            freshCheck.resolve({ ok: true, result: { v: 1, status: 'unavailable' } });
        });
        await waitForTestEvent(screen.subscribe, () => checkedReadinessRow(screen.tree)?.props.announcement,
            announcement => typeof announcement === 'string' && announcement.includes(tLoose('voice.readiness.runtime_unknown')));
        expect(checkedReadinessRow(screen.tree)?.props.announcement).toContain(tLoose('voice.readiness.runtime_unknown'));
    }, 120_000);

    it('does not commit a stale passive result after the active Account lifetime restarts', async () => {
        passiveSetupBoundary.profile = {
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [{ profileId: 'codex-profile', status: 'connected', kind: 'oauth' }],
            }],
        };
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 7, isOnline: true };
        const accountA = await createActiveAccountLifetime('account-a');
        let settlePassiveCheck: ((value: unknown) => void) | null = null;
        const pendingPassiveCheck = new Promise<unknown>((resolve) => {
            settlePassiveCheck = resolve;
        });
        passiveSetupBoundary.invoke.mockImplementation(async () => await pendingPassiveCheck);
        onTestFinished(() => {
            passiveSetupBoundary.profile = null;
            passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: false };
            passiveSetupBoundary.state = { status: 'idle' };
            passiveSetupBoundary.refresh.mockReset();
        });

        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const render = () => React.createElement(VoiceProviderSection, {
            voice: settingsParse({ voice: {
                providerId: CODEX_PROVIDER_ID,
                providers: {
                    [CODEX_PROVIDER_ID]: {
                        schemaVersion: 2,
                        config: {
                            globalConnectedServices: {
                                v: 1,
                                bindingsByServiceId: {
                                    [CODEX_CONNECTED_SERVICE_KEY]: {
                                        source: 'connected',
                                        selection: 'profile',
                                        profileId: 'codex-profile',
                                    },
                                },
                            },
                        },
                    },
                },
            } }).voice,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
            executionMachineId: 'machine-1',
        });
        const screen = await renderScreen(render());

        await act(async () => {});
        const freshCheck = createDeferred<unknown>();
        const freshCheckEntered = createDeferred<void>();
        passiveSetupBoundary.invoke.mockClear();
        passiveSetupBoundary.invoke.mockImplementation(async () => { freshCheckEntered.resolve(); return freshCheck.promise; });
        accountA.retire();
        await createActiveAccountLifetime('account-a');
        await act(async () => {
            await screen.update(render());
        });
        await freshCheckEntered.promise;
        expect(passiveSetupBoundary.invoke).toHaveBeenCalled();
        await act(async () => {
            settlePassiveCheck?.({ ok: true, result: { v: 1, status: 'ready' } });
            await Promise.resolve();
        });

        expect(checkedReadinessRow(screen.tree)?.props.announcement).toBe(tLoose('settings.updates.checking'));
        expect(checkedReadinessRow(screen.tree)?.props.announcement).not.toContain(tLoose('voice.readiness.ready'));
        await act(async () => {
            freshCheck.resolve({ ok: true, result: { v: 1, status: 'unavailable' } });
        });
        await waitForTestEvent(screen.subscribe, () => checkedReadinessRow(screen.tree)?.props.announcement,
            announcement => typeof announcement === 'string' && announcement.includes(tLoose('voice.readiness.runtime_unknown')));
        expect(checkedReadinessRow(screen.tree)?.props.announcement).toContain(tLoose('voice.readiness.runtime_unknown'));
    }, 120_000);

    it('does not commit a delayed passive result after the selected daemon restarts', async () => {
        passiveSetupBoundary.profile = {
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [{ profileId: 'codex-profile', status: 'connected', kind: 'oauth' }],
            }],
        };
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 7, isOnline: true };
        let settlePassiveCheck: ((value: unknown) => void) | null = null;
        const pendingPassiveCheck = new Promise<unknown>((resolve) => {
            settlePassiveCheck = resolve;
        });
        passiveSetupBoundary.invoke
            .mockImplementationOnce(async () => await pendingPassiveCheck)
            .mockResolvedValueOnce({ ok: true, result: { v: 1, status: 'ready' } });
        onTestFinished(() => {
            passiveSetupBoundary.profile = null;
            passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: false };
            passiveSetupBoundary.state = { status: 'idle' };
            passiveSetupBoundary.refresh.mockReset();
        });

        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const render = () => React.createElement(VoiceProviderSection, {
            voice: settingsParse({ voice: {
                providerId: CODEX_PROVIDER_ID,
                providers: {
                    [CODEX_PROVIDER_ID]: {
                        schemaVersion: 2,
                        config: {
                            globalConnectedServices: {
                                v: 1,
                                bindingsByServiceId: {
                                    [CODEX_CONNECTED_SERVICE_KEY]: {
                                        source: 'connected',
                                        selection: 'profile',
                                        profileId: 'codex-profile',
                                    },
                                },
                            },
                        },
                    },
                },
            } }).voice,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
            executionMachineId: 'machine-1',
        });
        const screen = await renderScreen(render());

        await act(async () => {});
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 8, isOnline: true };
        await act(async () => {
            await screen.update(render());
        });
        await act(async () => {
            settlePassiveCheck?.({ ok: true, result: { v: 1, status: 'unavailable' } });
            await Promise.resolve();
        });

        // The restarted daemon was checked again; the old daemon's late answer never lands.
        expect(passiveSetupBoundary.invoke).toHaveBeenCalledTimes(2);
        const readiness = checkedReadinessRow(screen.tree);
        expect(readiness?.props.announcement).toContain(tLoose('voice.readiness.ready'));
        expect(readiness?.props.announcement).not.toContain(tLoose('voice.readiness.runtime_unknown'));
    }, 120_000);

    it('keeps the first passive setup check visibly and accessibly checking until it settles', async () => {
        passiveSetupBoundary.profile = {
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [{
                    profileId: 'codex-profile',
                    status: 'connected',
                    kind: 'oauth',
                }],
            }],
        };
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 7, isOnline: true };
        passiveSetupBoundary.state = { status: 'loading' };
        let settlePassiveCheck: ((value: unknown) => void) | null = null;
        const pendingPassiveCheck = new Promise<unknown>((resolve) => {
            settlePassiveCheck = resolve;
        });
        passiveSetupBoundary.invoke.mockImplementation(async () => await pendingPassiveCheck);
        onTestFinished(() => {
            passiveSetupBoundary.profile = null;
            passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: false };
            passiveSetupBoundary.state = { status: 'idle' };
            passiveSetupBoundary.refresh.mockReset();
        });

        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const render = () => React.createElement(VoiceProviderSection, {
            voice: settingsParse({ voice: {
                providerId: CODEX_PROVIDER_ID,
                providers: {
                    [CODEX_PROVIDER_ID]: {
                        schemaVersion: 2,
                        config: {
                            globalConnectedServices: {
                                v: 1,
                                bindingsByServiceId: {
                                    [CODEX_CONNECTED_SERVICE_KEY]: {
                                        source: 'connected',
                                        selection: 'profile',
                                        profileId: 'codex-profile',
                                    },
                                },
                            },
                        },
                    },
                },
            } }).voice,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
            executionMachineId: 'machine-1',
        });
        const screen = await renderScreen(render());
        const { tree } = screen;

        await act(async () => {});

        expect(screen.getTextContent()).toContain(tLoose('settings.updates.checking'));
        const checkingAnnouncers = tree.root.findAllByProps({
            statusTestID: 'settings.voice.provider.readiness-status',
        });
        expect(checkingAnnouncers).toHaveLength(1);
        expect(checkingAnnouncers[0]?.props.announcement).toBe(tLoose('settings.updates.checking'));

        // A re-render while the check is pending shares the one in flight.
        await act(async () => {
            await screen.update(render());
        });
        expect(passiveSetupBoundary.invoke).toHaveBeenCalledTimes(1);

        passiveSetupBoundary.state = {
            status: 'loaded',
            snapshot: {
                response: {
                    protocolVersion: 1,
                    results: {
                        'cli.codex': {
                            ok: true,
                            checkedAt: 1,
                            data: { available: false },
                        },
                    },
                },
            },
        };
        await act(async () => {
            await screen.update(render());
        });

        expect(screen.getTextContent()).toContain(tLoose('settings.updates.checking'));

        await act(async () => {
            settlePassiveCheck?.({
                    ok: true,
                    result: { v: 1, status: 'feature_disabled' },
                });
            await Promise.resolve();
        });

        expect(screen.getTextContent()).toContain(tLoose('voice.readiness.runtime_missing'));
        const announcers = tree.root.findAllByProps({
            statusTestID: 'settings.voice.provider.readiness-status',
        });
        expect(announcers).toHaveLength(1);
        expect(announcers[0]?.props.announcement).toContain(tLoose('voice.readiness.runtime_missing'));

        // A settled check is not repeated while the setup it checked is unchanged.
        await act(async () => {
            await screen.update(render());
        });
        expect(passiveSetupBoundary.invoke).toHaveBeenCalledTimes(1);
    }, 120_000);

    it('does not turn a settled passive check back into checking during a CLI refresh', async () => {
        const unavailableRuntimeSnapshot = {
            response: {
                protocolVersion: 1,
                results: {
                    'cli.codex': {
                        ok: true,
                        checkedAt: 1,
                        data: { available: false },
                    },
                },
            },
        } satisfies MachineCapabilitiesSnapshot;
        passiveSetupBoundary.profile = {
            connectedServicesV2: [{
                serviceId: 'openai-codex',
                profiles: [{
                    profileId: 'codex-profile',
                    status: 'connected',
                    kind: 'oauth',
                }],
            }],
        };
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 7, isOnline: true };
        passiveSetupBoundary.state = {
            status: 'loaded',
            snapshot: unavailableRuntimeSnapshot,
        };
        onTestFinished(() => {
            passiveSetupBoundary.profile = null;
            passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: false };
            passiveSetupBoundary.state = { status: 'idle' };
            passiveSetupBoundary.refresh.mockReset();
        });

        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const render = () => React.createElement(VoiceProviderSection, {
            voice: settingsParse({ voice: {
                providerId: CODEX_PROVIDER_ID,
                providers: {
                    [CODEX_PROVIDER_ID]: {
                        schemaVersion: 2,
                        config: {
                            globalConnectedServices: {
                                v: 1,
                                bindingsByServiceId: {
                                    [CODEX_CONNECTED_SERVICE_KEY]: {
                                        source: 'connected',
                                        selection: 'profile',
                                        profileId: 'codex-profile',
                                    },
                                },
                            },
                        },
                    },
                },
            } }).voice,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
            executionMachineId: 'machine-1',
        });
        const screen = await renderScreen(render());
        const { tree } = screen;

        await act(async () => {});
        const terminalAnnouncement = tree.root.findAllByProps({
            statusTestID: 'settings.voice.provider.readiness-status',
        })[0];
        expect(terminalAnnouncement?.props.announcement).toContain(tLoose('voice.readiness.runtime_missing'));
        const terminalTransitionKey = terminalAnnouncement?.props.transitionKey;

        passiveSetupBoundary.state = {
            status: 'loading',
            snapshot: unavailableRuntimeSnapshot,
        };
        await act(async () => {
            await screen.update(render());
        });
        expect(checkedReadinessRow(tree)?.props.announcement).toContain(tLoose('voice.readiness.runtime_missing'));
        expect(tree.root.findAllByProps({
            statusTestID: 'settings.voice.provider.readiness-status',
        })[0]?.props.transitionKey).toBe(terminalTransitionKey);

        passiveSetupBoundary.state = {
            status: 'error',
            snapshot: unavailableRuntimeSnapshot,
        };
        await act(async () => {
            await primeCapabilities();
            await screen.update(render());
        });
        expect(checkedReadinessRow(tree)?.props.announcement).toContain(tLoose('voice.readiness.runtime_unknown'));
        expect(tree.root.findAllByProps({
            statusTestID: 'settings.voice.provider.readiness-status',
        })[0]?.props.transitionKey).not.toBe(terminalTransitionKey);
    }, 120_000);

    it('reports a persisted but unreachable Codex execution target as incompatible', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const screen = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: settingsParse({ voice: {
                providerId: CODEX_PROVIDER_ID,
                providers: {
                    [CODEX_PROVIDER_ID]: {
                        schemaVersion: 2,
                        config: {
                            globalConnectedServices: {
                                v: 1,
                                bindingsByServiceId: {
                                    [CODEX_CONNECTED_SERVICE_KEY]: {
                                        source: 'connected',
                                        selection: 'profile',
                                        profileId: 'codex-profile',
                                    },
                                },
                            },
                        },
                    },
                },
            } }).voice,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
            executionMachineId: null,
            executionMachineSelectedId: 'machine-offline',
            executionMachineSelectionKind: 'selected_unreachable',
        }));
        const { tree } = screen;

        await act(async () => {});

        const readiness = checkedReadinessRow(tree);
        expect(readiness?.props.announcement).toContain(tLoose('voice.readiness.execution_machine_incompatible'));
        expect(readiness?.props.announcement).not.toContain(tLoose('voice.readiness.ready'));
        expect(JSON.stringify(readiness?.props)).not.toContain('machine-offline');
        expect(passiveSetupBoundary.invoke).not.toHaveBeenCalled();
    }, 120_000);

    it('exposes a generic passive setup check for selected Codex Live without a live-test action', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const setVoice = vi.fn();
        const onRecoveryAction = vi.fn();
        const screen = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: settingsParse({ voice: {
                providerId: 'happier.agent.codex/realtime-codex',
                providers: {
                    'happier.agent.codex/realtime-codex': {
                        schemaVersion: 2,
                        config: { globalConnectedServices: null },
                    },
                },
            } }).voice,
            setVoice,
            happierVoiceSupported: true,
            platformOs: 'web',
            onRecoveryAction,
        }));

        await act(async () => {});
        expect(screen.getTextContent()).toContain(t('voice.readiness.settings_missing_required_setting', { service: 'Codex Live' }),
        );
        expect(screen.getTextContent()).toContain(tLoose('voice.readiness.actions.open_provider_settings'),
        );
        expect(screen.getTextContent()).not.toContain(tLoose('voice.readiness.ready'));
        // The card carries the readiness and its one recovery action.
        const recoverActions = (root: ReactTestInstance) => root.findAll((node) => typeof node.props?.testID === 'string'
            && node.props.testID.startsWith('settings.voice.conversations.pipeline')
            && node.props.testID.endsWith('.recover')
            && typeof node.props.onPress === 'function');
        expect(checkedReadinessRow(screen.tree)).not.toBeNull();
        const recover = recoverActions(screen.tree.root)[0];
        expect(recover).toBeTruthy();
        await act(async () => { recover.props.onPress(); });
        expect(onRecoveryAction).toHaveBeenCalledWith('open_provider_settings');

        const withoutRecoveryHandler = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: settingsParse({ voice: {
                providerId: 'happier.agent.codex/realtime-codex',
                providers: {
                    'happier.agent.codex/realtime-codex': {
                        schemaVersion: 2,
                        config: { globalConnectedServices: null },
                    },
                },
            } }).voice,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
        }));
        await act(async () => {});
        expect(checkedReadinessRow(withoutRecoveryHandler.tree)).not.toBeNull();
        expect(recoverActions(withoutRecoveryHandler.tree.root)).toHaveLength(0);
        expect(withoutRecoveryHandler.findHostByTestId('settings.voice.provider.testLive')).toBeNull();
        expect(setVoice).not.toHaveBeenCalled();
    }, 120_000);

    it.each([
        OPENAI_PROVIDER_ID,
        XAI_PROVIDER_ID,
        ELEVENLABS_PROVIDER_ID,
    ])('uses configured-ready and missing provider credential projections for %s', async (providerId) => {
        const { resolveVoiceProviderCredentialFact: resolveCredentialFact } = await import('./VoiceProviderSection');

        expect(resolveCredentialFact({
            sourceKind: 'bundled',
            projectedCredential: { status: 'ready' },
            hasAccountCredentialSlot: false,
            hasAccountCredentialReference: false,
        }), providerId).toBe('ready');
        expect(resolveCredentialFact({
            sourceKind: 'bundled',
            projectedCredential: { status: 'missing' },
            hasAccountCredentialSlot: false,
            hasAccountCredentialReference: false,
        }), providerId).toBe('missing');
        expect(resolveCredentialFact({
            sourceKind: 'bundled',
            projectedCredential: { status: 'unknown' },
            hasAccountCredentialSlot: false,
            hasAccountCredentialReference: false,
        }), providerId).toBe('unknown');
        expect(resolveCredentialFact({
            sourceKind: 'bundled',
            projectedCredential: null,
            hasAccountCredentialSlot: false,
            hasAccountCredentialReference: false,
        }), providerId).toBe('unknown');
        expect(resolveCredentialFact({
            sourceKind: 'bundled',
            projectedCredential: { status: 'missing' },
            hasAccountCredentialSlot: true,
            hasAccountCredentialReference: false,
            accountCredentialApprovalRequired: true,
        }), providerId).toBe('missing');
    }, 120_000);

    it('keeps a stale recipient-contract review requirement for an external provider', async () => {
        const { resolveVoiceProviderCredentialFact: resolveCredentialFact } = await import('./VoiceProviderSection');

        expect(resolveCredentialFact({
            sourceKind: 'external',
            projectedCredential: { status: 'missing' },
            hasAccountCredentialSlot: true,
            hasAccountCredentialReference: false,
            accountCredentialApprovalRequired: true,
        })).toBe('approval_required');
    }, 120_000);

    it.each([
        ['an online machine', true, 'voice.readiness.ready'],
        ['an offline machine', false, 'voice.readiness.execution_machine_missing'],
    ] as const)('projects an explicitly bound Connected Account through %s', async (_label, machineOnline, expectedReadiness) => {
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const { applyAccountVoiceCredentialSourceSelection } = await import('@/voice/credentials/accountVoiceCredential');
        const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
        await installCodexConnectedAccountDescriptor();
        const account = {
            ref: {
                service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                accountId: 'codex-work',
            },
            status: 'connected' as const,
            configurationReady: false,
            authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned' as const,
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaaaa',
            configurationRevision: null,
            scopes: ['openid', 'profile', 'email', 'offline_access'],
        };
        const provider = createDefaultVoiceProviderRegistry().get(OPENAI_PROVIDER_ID);
        if (provider?.kind !== 'voice.conversation-provider.v1' || provider.declaration?.kind !== 'conversation') {
            throw new Error('expected OpenAI conversation provider');
        }
        const voice = {
            providerId: OPENAI_PROVIDER_ID,
            providers: {
                [OPENAI_PROVIDER_ID]: {
                    schemaVersion: 1,
                    config: OPENAI_REALTIME_DEFAULT_SETTINGS,
                },
            },
        };
        const selected = applyAccountVoiceCredentialSourceSelection({
            settings: settingsParse({ voice }),
            connectedPurposes: accountFixture.purposes.value,
            mutation: {
                contribution: {
                    pluginId: provider.pluginId,
                    localId: provider.declaration.id,
                },
                credentialSlotId: provider.declaration.credentials!.slot.id,
                selection: { kind: 'connectedAccount', target: { kind: 'account', account: account.ref } },
                expectedSettingsVersion: 1,
            },
            currentDeclaration: provider.declaration,
        });
        await accountFixture.replaceConnectedPurposes(selected.connectedPurposes);
        storageBoundary.settings = selected.settings;
        passiveSetupBoundary.profile = {
            connectedAccountsV4: [account],
            connectedAccountGroupsV4: [],
            connectedServicesV2: [],
        };
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 1, isOnline: machineOnline };
        onTestFinished(() => {
            storageBoundary.settings = null;
            passiveSetupBoundary.profile = null;
            passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: false };
        });

        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { VoiceCredentialSourceField } = await import('./realtime/VoiceCredentialSourceField');
        const { BundledConversationSettingsSection } = await import('./BundledConversationSettingsSection');
        // Provider choice/readiness and the public curated settings presentation
        // have separate renderers, as on the composed Conversations page.
        const screen = await renderScreen(React.createElement(React.Fragment, null,
            React.createElement(VoiceProviderSection, {
                voice: selected.settings.voice,
                executionMachineId: machineOnline ? 'machine-online' : 'machine-offline',
                setVoice: vi.fn(),
                happierVoiceSupported: true,
                platformOs: 'web',
            }),
            React.createElement(BundledConversationSettingsSection, {
                voice: selected.settings.voice,
            }),
        ));
        const { tree } = screen;

        const isCurrent = tree.root.findByType(VoiceCredentialSourceField).props.isCurrent;
        if (!isCurrent) throw new Error('Expected the selected Voice credential to expose currentness');
        expect(isCurrent()).toBe(true);

        await act(async () => {});
        expect(checkedReadinessRow(tree)?.props.announcement).toContain(tLoose(expectedReadiness));
        expect(JSON.stringify(checkedReadinessRow(tree)?.props)).not.toContain(account.ref.accountId);
    }, 120_000);

    it('uses bundled authentication for a bound Connected Account when its Machine descriptor is unavailable', async () => {
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const { applyAccountVoiceCredentialSourceSelection } = await import('@/voice/credentials/accountVoiceCredential');
        const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
        descriptorAvailable = false;
        const account = {
            ref: {
                service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                accountId: 'codex-work',
            },
            status: 'connected' as const,
            configurationReady: false,
            authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned' as const,
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaaaa',
            configurationRevision: null,
            scopes: ['openid', 'profile', 'email', 'offline_access'],
        };
        const provider = createDefaultVoiceProviderRegistry().get(OPENAI_PROVIDER_ID);
        if (provider?.kind !== 'voice.conversation-provider.v1' || provider.declaration?.kind !== 'conversation') {
            throw new Error('expected OpenAI conversation provider');
        }
        const voice = {
            providerId: OPENAI_PROVIDER_ID,
            providers: {
                [OPENAI_PROVIDER_ID]: {
                    schemaVersion: 1,
                    config: OPENAI_REALTIME_DEFAULT_SETTINGS,
                },
            },
        };
        const selected = applyAccountVoiceCredentialSourceSelection({
            settings: settingsParse({ voice }),
            connectedPurposes: accountFixture.purposes.value,
            mutation: {
                contribution: {
                    pluginId: provider.pluginId,
                    localId: provider.declaration.id,
                },
                credentialSlotId: provider.declaration.credentials!.slot.id,
                selection: { kind: 'connectedAccount', target: { kind: 'account', account: account.ref } },
                expectedSettingsVersion: 1,
            },
            currentDeclaration: provider.declaration,
        });
        await accountFixture.replaceConnectedPurposes(selected.connectedPurposes);
        storageBoundary.settings = selected.settings;
        passiveSetupBoundary.profile = {
            connectedAccountsV4: [account],
            connectedAccountGroupsV4: [],
            connectedServicesV2: [],
        };
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 1, isOnline: true };
        onTestFinished(() => {
            storageBoundary.settings = null;
            passiveSetupBoundary.profile = null;
            passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: false };
            descriptorAvailable = false;
        });

        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const screen = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: selected.settings.voice,
            executionMachineId: 'machine-online',
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
        }));
        const { tree } = screen;

        const row = findProviderChoiceRow(tree, { testID: `settings.voice.provider.${encodeURIComponent(OPENAI_PROVIDER_ID)}.byo` });
        expect(providerChoiceDetail(row)).toContain(t('settingsVoice.pages.conversations.serviceReady'));
        expect(providerChoiceDetail(row)).not.toContain(tLoose('voice.readiness.credential_unknown'));
        expect(providerChoiceDetail(row)).not.toContain(tLoose('voice.readiness.credential_missing'));
        expect(row?.props.disabled).not.toBe(true);

        await act(async () => {});
        const readiness = checkedReadinessRow(tree);
        expect(readiness?.props.announcement).toContain(tLoose('voice.readiness.ready'));
        expect(readiness?.props.announcement).not.toContain(tLoose('voice.readiness.credential_unknown'));
        expect(readiness?.props.announcement).not.toContain(tLoose('voice.readiness.credential_missing'));
    }, 120_000);

    it('keeps ordinary OpenAI configurable when an orphaned purpose binding makes current source resolution unknown', async () => {
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        await installCodexConnectedAccountDescriptor();
        const account = {
            ref: {
                service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                accountId: 'codex-work',
            },
            status: 'connected' as const,
            configurationReady: false,
            authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned' as const,
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaaaa',
            configurationRevision: null,
            scopes: ['openid', 'profile', 'email', 'offline_access'],
        };
        storageBoundary.settings = settingsParse({
            secrets: [{
                id: 'surviving-openai-secret',
                name: 'Saved OpenAI key',
                kind: 'apiKey',
                encryptedValue: {
                    _isSecretValue: true,
                    encryptedValue: { t: 'enc-v1', c: 'Y2lwaGVydGV4dA==' },
                },
                createdAt: 1,
                updatedAt: 1,
            }],
            voiceSettingsV1: { credentialBindings: [] },
        });
        await accountFixture.replaceConnectedPurposes({ v: 1, bindings: [{
            purpose: { consumer: { pluginId: 'happier.voice.openai', localId: 'realtime-openai' }, purpose: 'voice.client-auth' },
            target: { kind: 'account', account: account.ref },
        }] });
        passiveSetupBoundary.profile = {
            connectedAccountsV4: [account],
            connectedAccountGroupsV4: [],
            connectedServicesV2: [],
        };
        onTestFinished(() => {
            storageBoundary.settings = null;
            passiveSetupBoundary.profile = null;
        });

        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const setVoice = vi.fn();
        const screen = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: settingsParse({ voice: { providerId: null } }).voice,
            setVoice,
            happierVoiceSupported: true,
            platformOs: 'web',
        }));
        const { tree } = screen;
        const row = findProviderChoiceRow(tree, { testID: `settings.voice.provider.${encodeURIComponent(OPENAI_PROVIDER_ID)}.byo` });

        expect(providerChoiceDetail(row)).toContain(tLoose('voice.readiness.credential_unknown'));
        expect(row?.props.disabled).not.toBe(true);
        expect(row?.props.onPress).toBeTypeOf('function');
        await act(async () => {
            row?.props.onPress?.();
        });
        expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
            providerId: OPENAI_PROVIDER_ID,
        }));

        const selectedVoice = setVoice.mock.calls[0]?.[0];
        const { BundledConversationSettingsSection } = await import('./BundledConversationSettingsSection');
        const selected = await renderScreen(React.createElement(React.Fragment, null,
            React.createElement(VoiceProviderSection, {
                voice: selectedVoice,
                setVoice: vi.fn(),
                happierVoiceSupported: true,
                platformOs: 'web',
            }),
            React.createElement(BundledConversationSettingsSection, {
                voice: selectedVoice,
            }),
        ));
        const sourceField = findTestInstanceByTypeWithProps(selected.tree, DropdownMenu, {
            testID: 'voice-credential-source-api_key',
        });
        expect(sourceField?.props.items).toContainEqual(expect.objectContaining({
            id: JSON.stringify(['account', 'happier.agent.codex', 'openai-codex', 'codex-work']),
            disabled: false,
        }));
        expect(sourceField?.props.items).not.toContainEqual(expect.objectContaining({
            subtitle: 'codex-work',
        }));
        const credentialEditor = selected.tree.root.findAll((node) => (
            node.props?.contribution?.pluginId === 'happier.voice.openai'
            && node.props?.contribution?.localId === 'realtime-openai'
            && node.props?.credentialSlotId === 'api_key'
        ))[0];
        // The source resolver correctly fails closed for the orphaned purpose
        // binding. That must not make an explicit SavedSecret choice take the
        // slot-only mutation path: the existing source/purpose owner is the
        // only path that can repair all three roots atomically.
        expect(credentialEditor?.props.credentialSourcePurpose).toBe('voice.client-auth');
    }, 120_000);

    it('keeps an unresolvable credential snapshot unknown for an external provider instead of reporting it missing', async () => {
        const { resolveVoiceProviderCredentialFact: resolveCredentialFact } = await import('./VoiceProviderSection');

        // An external row whose account-settings snapshot could not be read has
        // no more evidence of absence than a bundled one. Falling back to the
        // reference lookup renders "Add the credential required by this Voice
        // provider" over a credential that is stored and was working.
        expect(resolveCredentialFact({
            sourceKind: 'external',
            projectedCredential: { status: 'unknown' },
            hasAccountCredentialSlot: true,
            hasAccountCredentialReference: false,
        })).toBe('unknown');
        expect(resolveCredentialFact({
            sourceKind: 'external',
            projectedCredential: { status: 'unknown' },
            hasAccountCredentialSlot: true,
            hasAccountCredentialReference: false,
            accountCredentialApprovalRequired: true,
        })).toBe('unknown');
        // A projection that was never produced still falls back, because the
        // external account-credential slot is then the only evidence there is.
        expect(resolveCredentialFact({
            sourceKind: 'external',
            projectedCredential: null,
            hasAccountCredentialSlot: true,
            hasAccountCredentialReference: true,
        })).toBe('ready');
    }, 120_000);

    it('does not let a stale SavedSecret approval override a bundled non-SavedSecret credential projection', async () => {
        const { resolveVoiceProviderCredentialFact: resolveCredentialFact } = await import('./VoiceProviderSection');

        expect(resolveCredentialFact({
            sourceKind: 'bundled',
            projectedCredential: { status: 'unknown' },
            hasAccountCredentialSlot: true,
            hasAccountCredentialReference: false,
            accountCredentialApprovalRequired: true,
        })).toBe('unknown');
    }, 120_000);

    it.each([
        [OPENAI_PROVIDER_ID, 'byo'],
        [XAI_PROVIDER_ID, 'byo'],
        [ELEVENLABS_PROVIDER_ID, 'byo'],
    ] as const)(
        'keeps the real bundled %s %s row selectable from fresh settings so its credential can be configured',
        async (providerId, optionId) => {
            const { VoiceProviderSection } = await import('./VoiceProviderSection');
            const setVoice = vi.fn<(next: Settings['voice']) => void>();
            const screen = await renderScreen(React.createElement(VoiceProviderSection, {
                // ElevenLabs is one service whose billing option is chosen beneath it once it is selected.
                voice: settingsParse({ voice: (providerId === ELEVENLABS_PROVIDER_ID ? { providerId } : { providerId: null }) }).voice,
                setVoice,
                happierVoiceSupported: true,
                platformOs: 'web',
            }));
        const { tree } = screen;
            const row = findProviderChoiceRow(tree, { testID: `settings.voice.provider.${encodeURIComponent(providerId)}.${optionId}` });

            expect(row?.props?.disabled).not.toBe(true);
            expect(row?.props?.onPress).toBeTypeOf('function');
            if (providerId === ELEVENLABS_PROVIDER_ID) {
                expect(row?.props.accessibilityLabel).toBe(t('settingsVoice.mode.byo'));
            } else {
                expect(providerChoiceDetail(row)).toContain(tLoose('voice.readiness.credential_missing'));
            }
            await pressTestInstanceAsync(row);
            expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
                providerId,
                providers: expect.objectContaining({
                    [providerId]: expect.objectContaining({
                        config: expect.any(Object),
                    }),
                }),
            }));
            if (providerId === ELEVENLABS_PROVIDER_ID) {
                const selected = setVoice.mock.calls[0]?.[0];
                if (!selected) throw new Error('Expected a Voice selection from the actual billing segment');
                await screen.update(<VoiceProviderSection voice={selected} setVoice={setVoice}
                    happierVoiceSupported platformOs="web" />);
                expect(providerChoiceDetail(findProviderChoiceRow(tree, {
                    testID: `settings.voice.provider.${encodeURIComponent(providerId)}.${optionId}`,
                }))).toBe(t('settingsVoice.pages.conversations.payWithOwnDescription'));
            }
        },
        120_000,
    );

    it('renders localized readiness for the selected provider without exposing its internal id', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const providerId = XAI_PROVIDER_ID;
        const screen = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: settingsParse({ voice: {
                providerId,
                providers: {
                    [providerId]: {
                        schemaVersion: 1,
                        config: XAI_REALTIME_DEFAULT_SETTINGS,
                    },
                },
            } }).voice,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
        }));
        const { tree } = screen;

        await act(async () => {});
        const readiness = checkedReadinessRow(tree);

        expect(readiness?.props.announcement).toContain(tLoose('voice.readiness.credential_missing'));
        expect(readiness?.props.announcement).not.toContain(providerId);
    }, 120_000);

    it('does not require external-publisher re-review for a bundled provider with a stale digest', async () => {
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
        const entry = createDefaultVoiceProviderRegistry().get(XAI_PROVIDER_ID);
        const slot = entry?.accountCredentialSlot;
        if (!slot || entry?.kind !== 'voice.conversation-provider.v1' || !entry.declaration) throw new Error('expected Grok account credential slot');
        const voice = {
            providerId: XAI_PROVIDER_ID,
            providers: {
                [XAI_PROVIDER_ID]: {
                    schemaVersion: 1,
                    config: XAI_REALTIME_DEFAULT_SETTINGS,
                },
            },
        };
        const settings = await withVoiceSettingsCredentialResource(accountFixture, {
            settings: settingsParse({ voice }), declaration: entry.declaration, pluginId: entry.pluginId,
            resourceId: 'grok-secret', approvedRecipientContractDigest: `sha256:${'0'.repeat(64)}`,
        });
        storageBoundary.settings = settings;
        onTestFinished(() => {
            storageBoundary.settings = null;
        });

        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const screen = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: settings.voice,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
        }));
        const { tree } = screen;
        await act(async () => {});
        const readiness = checkedReadinessRow(tree);
        expect(readiness?.props.announcement).toContain(tLoose('voice.readiness.ready'));
        expect(readiness?.props.announcement).not.toContain(tLoose('voice.readiness.credential_missing'));
        expect(readiness?.props.announcement).not.toContain(tLoose('voice.readiness.actions.configure_credential'));
        expect(readiness?.props.announcement).not.toContain(tLoose('voice.readiness.credential_approval_required'));
        expect(readiness?.props.announcement).not.toContain(tLoose('voice.readiness.actions.review_credential_access'));
    }, 120_000);

    it('does not report ElevenLabs ready when its credential is approved but its BYO agent is missing', async () => {
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
        const entry = createDefaultVoiceProviderRegistry().get(ELEVENLABS_PROVIDER_ID);
        const slot = entry?.accountCredentialSlot;
        if (!slot || entry?.kind !== 'voice.conversation-provider.v1' || !entry.declaration) throw new Error('expected ElevenLabs account credential slot');
        const voice = {
            providerId: ELEVENLABS_PROVIDER_ID,
            providers: {
                [ELEVENLABS_PROVIDER_ID]: {
                    schemaVersion: 2,
                    config: elevenLabsByoConfig(),
                },
            },
        };
        const settings = await withVoiceSettingsCredentialResource(accountFixture, {
            settings: settingsParse({ voice }), declaration: entry.declaration, pluginId: entry.pluginId,
            resourceId: 'elevenlabs-secret', recipientContractDigest: slot.recipientContractDigest,
        });
        storageBoundary.settings = settings;
        onTestFinished(() => {
            storageBoundary.settings = null;
        });

        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const screen = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: settings.voice,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
        }));
        const { tree } = screen;

        await act(async () => {});
        const readiness = checkedReadinessRow(tree);
        expect(readiness?.props.announcement).toContain(t('voice.readiness.settings_missing_required_setting', { service: 'ElevenLabs Voice' }),
        );
        expect(readiness?.props.announcement).toContain(tLoose('voice.readiness.actions.open_provider_settings'),
        );
        expect(readiness?.props.announcement).not.toContain(tLoose('voice.readiness.ready'));
        expect(readiness?.props.announcement).not.toContain(tLoose('voice.readiness.credential_missing'));
    }, 120_000);

    it('uses the pipeline readiness for the selected Service row, including unobserved Local prerequisites', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { VoicePipelineCard } = await import('@/voice/settings/pipeline/VoicePipelineCard');
        const { readLocalConversationVoiceSettings, writeLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
        const defaults = readLocalConversationVoiceSettings(accountFixture.settings.voice);
        const voice = writeLocalConversationVoiceSettings({ ...accountFixture.settings.voice, providerId: 'local_conversation' }, {
            ...defaults, conversationMode: 'direct_session',
            stt: { ...defaults.stt, provider: 'device' }, tts: { ...defaults.tts, provider: 'device' },
        });
        accountFixture.replaceVoice(voice);
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: true };
        const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
        observeMachinePresenceForTest(accountFixture.scope, ['machine-1']);
        const props = { voice, setVoice: vi.fn(), happierVoiceSupported: true, platformOs: 'web',
            executionMachineId: 'machine-1', executionMachineSelectedId: 'machine-1', executionMachineSelectionKind: 'resolved',
            localAvailability: { browserSpeech: { support: 'unknown', onDevice: 'unsupported' }, daemon: {
                featureEnabled: true, route: 'direct', modelState: 'ready', runtimeState: 'available', pcmCapture: 'available',
            }, nativeDevice: { requested: false } },
        } satisfies React.ComponentProps<typeof VoiceProviderSection>;
        const screen = await renderScreen(<VoiceProviderSection {...props} />);
        try {
            await act(async () => {});
            const gallery = screen.tree.findAllByType(VoiceServiceGallery)[0]!;
            const selected = (gallery.props.tiles as readonly VoiceServiceTile[]).find(tile => tile.selected)!;
            const card = screen.tree.findAllByType(VoicePipelineCard)[0]!;
            expect(card.props.status.text).toBe(t('settingsVoice.pages.pipeline.notChecked'));
            expect(selected.status?.text).toBe(card.props.status.text);
            expect(selected.status?.tone).toBe(card.props.status.tone);
            await screen.update(<VoiceProviderSection {...props} localAvailability={{ ...props.localAvailability,
                browserSpeech: { support: 'cloud_only', onDevice: 'unsupported' } }} />);
            const readyCard = screen.tree.findAllByType(VoicePipelineCard)[0]!;
            const readyGallery = screen.tree.findAllByType(VoiceServiceGallery)[0]!;
            const readyService = (readyGallery.props.tiles as readonly VoiceServiceTile[]).find(tile => tile.selected)!;
            expect(readyCard.props.status.text).toBe(t('settingsVoice.pages.pipeline.ready'));
            expect(readyService.status).toMatchObject({ text: readyCard.props.status.text, tone: readyCard.props.status.tone });
        } finally { await screen.unmount(); }
    });

    it('offers every provider as one choice in the gallery with exactly one selected', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const screen = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: settingsParse({ voice: { providerId: ELEVENLABS_PROVIDER_ID, providers: {
                [ELEVENLABS_PROVIDER_ID]: { schemaVersion: 2, config: elevenLabsByoConfig() },
            } } }).voice,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
        }));
        const { tree } = screen;
        const rows = listProviderChoiceRows(tree);
        expect(rows.length).toBeGreaterThan(1);
        expect(rows.every((row) => typeof row.props.testID === 'string')).toBe(true);
        expect(rows.filter((row) => row.props.accessibilityState?.checked === true)).toHaveLength(1);
        // One ElevenLabs service: who pays is its own choice beneath the gallery.
        expect(rows.filter((row) => row.props.testID.startsWith(`settings.voice.provider.${encodeURIComponent(ELEVENLABS_PROVIDER_ID)}.`))).toHaveLength(1);
        const payWith = tree.findAllByType(SegmentedChoiceItem)[0];
        expect(payWith?.props.options.map((option: { id: string }) => option.id)).toEqual(['happier', 'byo']);
    });

    it('keeps gallery tiles and Pay with to what each choice needs or means; the card owns the recovery action', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { VoicePipelineCard } = await import('@/voice/settings/pipeline/VoicePipelineCard');
        const screen = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: settingsParse({ voice: { providerId: ELEVENLABS_PROVIDER_ID, providers: {
                [ELEVENLABS_PROVIDER_ID]: { schemaVersion: 2, config: elevenLabsByoConfig() },
            } } }).voice,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
        }));
        const { tree } = screen;
        await act(async () => {});
        const gallery = tree.findAllByType(VoiceServiceGallery)[0]!;
        const needing = (gallery.props.tiles as readonly VoiceServiceTile[]).filter((tile) => tile.status?.tone === 'needs_you' && !tile.disabled);
        expect(needing.length).toBeGreaterThan(0);
        for (const tile of needing) {
            if (tile.selected) expect(tile.status!.text).toBe(tree.findAllByType(VoicePipelineCard)[0]!.props.status.text);
            else expect(['needsSetup', 'needsKey', 'needsApproval', 'offOnServer', 'needsComputer', 'needsAddress',
                'needsModel', 'installing', 'notInstalled', 'unavailableHere', 'needsUpdate', 'cantCheck']
                .map(key => tLoose(`voice.readiness.short.${key}`))).toContain(tile.status!.text);
            const rendered = findAllHostTestInstances(tree.root, node => node.props.testID === tile.testID)[0];
            expect(rendered).not.toBeNull();
            expect(providerChoiceDetail(rendered)).toContain(tile.status!.detail);
            expect(readinessRecoveryLabels.every(action => !tile.status!.detail?.includes(action))).toBe(true);
        }
        const payWith = tree.findAllByType(SegmentedChoiceItem)[0];
        const selected = payWith.props.options.find((option: Readonly<{ id: string; description?: string }>) => option.id === payWith.props.value);
        expect(selected.description).toBe(t('settingsVoice.pages.conversations.payWithOwnDescription'));
    });

    it.each([
        {
            label: 'removed provider contribution',
            providerId: 'acme.removed/conversation',
            envelope: {
                schemaVersion: 7,
                config: { futureOpaqueField: 'preserved' },
            },
            expectedReason: 'voice.readiness.contribution_unavailable',
            expectedAction: 'voice.readiness.actions.select_provider',
        },
        {
            label: 'unsupported provider settings schema',
            providerId: CODEX_PROVIDER_ID,
            envelope: {
                schemaVersion: 3,
                config: {
                    globalConnectedServices: null,
                    futureOpaqueField: 'preserved',
                },
            },
            expectedReason: 'voice.readiness.settings_unsupported_version',
            expectedAction: 'voice.readiness.actions.open_provider_settings',
        },
    ])(
        'keeps a persisted $label visibly selected with truthful recovery without rewriting its envelope',
        async ({ providerId, envelope, expectedReason, expectedAction }) => {
            const { VoiceProviderSection } = await import('./VoiceProviderSection');
            const setVoice = vi.fn();
            const voice = {
                providerId,
                providers: { [providerId]: envelope },
            };
            const before = JSON.stringify(voice);
            const screen = await renderScreen(React.createElement(VoiceProviderSection, {
                voice: settingsParse({ voice: voice }).voice,
                setVoice,
                happierVoiceSupported: true,
                platformOs: 'web',
            }));
        const { tree } = screen;

            const unavailableRow = findProviderChoiceRow(tree, { testID: 'settings.voice.provider.selectedUnavailable' });
            const offRow = findProviderChoiceRow(tree, { testID: 'settings.voice.provider.off' });
            const choices = listProviderChoiceRows(tree);
            const selectedRows = choices.filter((row) => row.props.accessibilityState?.checked === true);
            const ordinaryRowsForSelectedProvider = choices
                .filter((row) => row.props.testID?.startsWith(
                    `settings.voice.provider.${encodeURIComponent(providerId)}.`,
                ));
            const otherProviderRow = findProviderChoiceRow(tree, { testID: `settings.voice.provider.${encodeURIComponent(OPENAI_PROVIDER_ID)}.byo` });

            expect(unavailableRow).toBeTruthy();
            expect(unavailableRow?.props.accessibilityRole).toBe('radio');
            expect(unavailableRow?.props.accessibilityState?.checked).toBe(true);
            expect(unavailableRow?.props.disabled).toBe(true);
            expect(unavailableRow?.props.accessibilityLabel).toEqual(expect.any(String));
            expect(unavailableRow?.props.accessibilityLabel.length).toBeGreaterThan(0);
            expect(providerChoiceDetail(unavailableRow)).toContain(tLoose(expectedReason));
            expect(providerChoiceDetail(unavailableRow)).toContain(tLoose(expectedAction));
            expect(selectedRows.map((row) => row.props.testID)).toEqual([unavailableRow?.props.testID]);
            expect(ordinaryRowsForSelectedProvider).toHaveLength(0);
            expect(otherProviderRow).toBeTruthy();
            expect(offRow?.props.accessibilityState?.checked).toBe(false);
            expect(JSON.stringify(voice)).toBe(before);

            offRow?.props.onPress?.();
            expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
                providerId: null,
                providers: expect.objectContaining({ [providerId]: envelope }),
            }));
            expect(setVoice.mock.calls[0]?.[0]?.providers?.[providerId]).toEqual(envelope);
        },
        120_000,
    );

    it('shows the local provider row on web and preserves persisted local selection', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');

        const voice = settingsParse({ voice: {
            providerId: 'local_conversation',
            providers: {
                [ELEVENLABS_PROVIDER_ID]: { schemaVersion: 2, config: elevenLabsByoConfig() },
            },
        } }).voice;

        const screen = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice,
                setVoice: () => {},
                happierVoiceSupported: true,
            }),
        );
        const { tree } = screen;

        expect(
            findProviderChoiceRow(tree, { title: tLoose('settingsVoice.mode.local') })?.props.accessibilityState?.checked,
        ).toBeTruthy();
        expect(
            findProviderChoiceRow(tree, { title: tLoose('settingsVoice.mode.byo') })?.props.accessibilityState?.checked,
        ).toBeFalsy();
    });

    it('keeps hosted Happier Voice visible but disabled when the server does not support it', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const setVoice = vi.fn();

        // Who pays is chosen beneath the selected ElevenLabs service, so the hosted option is read there.
        const voice = settingsParse({ voice: {
            providerId: ELEVENLABS_PROVIDER_ID,
            providers: {
                [ELEVENLABS_PROVIDER_ID]: { schemaVersion: 2, config: elevenLabsByoConfig() },
            },
        } }).voice;

        const screen = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice,
                setVoice,
                happierVoiceSupported: false,
            }),
        );
        const { tree } = screen;
        const hostedRow = findProviderChoiceRow(tree, { title: tLoose('settingsVoice.mode.happier') });

        expect(hostedRow?.props?.disabled).toBe(true);
        expect(hostedRow?.props?.onPress).toBeTypeOf('function');
        expect(providerChoiceDetail(hostedRow)).toContain(tLoose('settingsVoice.pages.conversations.happierBillingUnavailable'));
        // The reason alone; the recovery action lives on the card, not in a Pay with option.
        expect(readinessRecoveryLabels.every(action => !providerChoiceDetail(hostedRow).includes(action))).toBe(true);
        expect(
            findProviderChoiceRow(tree, { title: tLoose('settingsVoice.mode.local') }),
        ).toBeTruthy();
        expect(setVoice).not.toHaveBeenCalled();
    });

    it('uses the runtime platform when no platform override is supplied', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');

        const voice = settingsParse({ voice: {
            providerId: 'off',
            providers: {
                [ELEVENLABS_PROVIDER_ID]: { schemaVersion: 2, config: elevenLabsByoConfig() },
            },
        } }).voice;

        const screen = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice,
                setVoice: () => {},
                happierVoiceSupported: true,
                localAvailability: {
                    browserSpeech: { support: 'unavailable' },
                    daemon: { featureEnabled: true, route: 'relay_disabled', modelState: 'ready' },
                    nativeDevice: { requested: true },
                },
            }),
        );
        const { tree } = screen;

        const localRow = findProviderChoiceRow(tree, { title: tLoose('settingsVoice.mode.local') });

        expect(localRow?.props?.disabled).toBe(true);
        expect(localRow?.props?.onPress).toBeTypeOf('function');
    });

    it('keeps Local visible but fail-closed on web while detailed browser and daemon availability are still loading', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const setVoice = vi.fn();

        const voice = settingsParse({ voice: {
            providerId: 'off',
            providers: {
                [ELEVENLABS_PROVIDER_ID]: { schemaVersion: 2, config: elevenLabsByoConfig() },
            },
        } }).voice;

        const screen = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice,
                setVoice,
                happierVoiceSupported: true,
            }),
        );
        const { tree } = screen;

        const localRow = findProviderChoiceRow(tree, { title: tLoose('settingsVoice.mode.local') });

        expect(localRow).toBeTruthy();
        expect(localRow?.props?.disabled).toBe(true);
        expect(localRow?.props?.onPress).toBeTypeOf('function');
        localRow?.props?.onPress?.();
        expect(setVoice).not.toHaveBeenCalled();
    });

    it('disables Local when browser, daemon, and native execution paths are unavailable', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');

        const voice = settingsParse({ voice: {
            providerId: 'off',
            providers: {
                [ELEVENLABS_PROVIDER_ID]: { schemaVersion: 2, config: elevenLabsByoConfig() },
            },
        } }).voice;

        const screen = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice,
                setVoice: () => {},
                happierVoiceSupported: true,
                platformOs: 'web',
                localAvailability: {
                    browserSpeech: { support: 'unavailable' },
                    daemon: { featureEnabled: true, route: 'relay_disabled', modelState: 'ready' },
                    nativeDevice: { requested: true },
                },
            }),
        );
        const { tree } = screen;

        const localRow = findProviderChoiceRow(tree, { title: tLoose('settingsVoice.mode.local') });

        expect(localRow?.props?.disabled).toBe(true);
        expect(localRow?.props?.onPress).toBeTypeOf('function');
    });

    it('keeps Local selectable on web when browser speech is available', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const setVoice = vi.fn();

        const voice = settingsParse({ voice: {
            providerId: 'off',
            providers: {
                [ELEVENLABS_PROVIDER_ID]: { schemaVersion: 2, config: elevenLabsByoConfig() },
            },
        } }).voice;

        const screen = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice,
                setVoice,
                happierVoiceSupported: true,
                platformOs: 'web',
                localAvailability: {
                    browserSpeech: { support: 'cloud_only' },
                    daemon: { featureEnabled: false, route: 'unavailable', modelState: 'unknown' },
                    nativeDevice: { requested: true },
                },
            }),
        );
        const { tree } = screen;

        const localRow = findProviderChoiceRow(tree, { title: tLoose('settingsVoice.mode.local') });

        expect(localRow?.props?.disabled).not.toBe(true);
        localRow?.props?.onPress?.();
        expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
            providerId: 'local_conversation',
            providers: expect.objectContaining({
                local_conversation: expect.objectContaining({ schemaVersion: 1 }),
            }),
        }));
    });

    it('keeps an installable daemon-backed Local provider selectable so setup is not cyclic', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const setVoice = vi.fn();

        const screen = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice: settingsParse({ voice: { providerId: 'off' } }).voice,
                setVoice,
                happierVoiceSupported: true,
                platformOs: 'web',
                localAvailability: {
                    browserSpeech: { support: 'unavailable' },
                    daemon: {
                        featureEnabled: true,
                        route: 'relay',
                        modelState: 'missing',
                        runtimeState: 'unknown',
                        pcmCapture: 'available',
                    },
                    nativeDevice: { requested: false },
                },
            }),
        );
        const { tree } = screen;

        const localRow = findProviderChoiceRow(tree, { title: tLoose('settingsVoice.mode.local') });
        expect(localRow?.props?.disabled).not.toBe(true);
        localRow?.props?.onPress?.();
        expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'local_conversation' }));
    });

    it('allows explicit Local selection while its reachable daemon model facts are still loading', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const setVoice = vi.fn();

        const screen = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice: settingsParse({ voice: { providerId: 'off' } }).voice,
                setVoice,
                happierVoiceSupported: true,
                platformOs: 'web',
                localAvailability: {
                    browserSpeech: { support: 'unavailable' },
                    daemon: {
                        featureEnabled: true,
                        route: 'relay',
                        modelState: 'unknown',
                        runtimeState: 'unknown',
                        pcmCapture: 'available',
                    },
                    nativeDevice: { requested: false },
                },
            }),
        );
        const { tree } = screen;

        const localRow = findProviderChoiceRow(tree, { title: tLoose('settingsVoice.mode.local') });
        expect(localRow?.props?.disabled).not.toBe(true);
        localRow?.props?.onPress?.();
        expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'local_conversation' }));
    });

    it.each([
        {
            label: 'selected daemon machine with an available direct speech route',
            executionMachineId: 'machine-online',
            executionMachine: {
                mode: 'fixed' as const,
                machineId: 'machine-online',
            },
            daemon: {
                featureEnabled: true,
                route: 'direct' as const,
                modelState: 'ready' as const,
                runtimeState: 'available' as const,
                pcmCapture: 'available' as const,
            },
            expectedCode: null,
        },
        {
            label: 'selected daemon machine without direct heavy audio while relay is disabled',
            executionMachineId: 'machine-online',
            executionMachine: {
                mode: 'fixed' as const,
                machineId: 'machine-online',
            },
            daemon: {
                featureEnabled: true,
                route: 'relay_disabled' as const,
                modelState: 'ready' as const,
                runtimeState: 'available' as const,
                pcmCapture: 'available' as const,
            },
            expectedCode: 'voice.readiness.daemon_relay_disabled',
        },
        {
            label: 'selected daemon machine with a policy-allowed relay route',
            executionMachineId: 'machine-online',
            executionMachine: {
                mode: 'fixed' as const,
                machineId: 'machine-online',
            },
            daemon: {
                featureEnabled: true,
                route: 'relay' as const,
                modelState: 'ready' as const,
                runtimeState: 'available' as const,
                pcmCapture: 'available' as const,
            },
            expectedCode: null,
        },
        {
            label: 'selected daemon machine that is offline',
            executionMachineId: null,
            executionMachine: {
                mode: 'fixed' as const,
                machineId: 'machine-offline',
            },
            daemon: {
                featureEnabled: true,
                route: 'direct' as const,
                modelState: 'unknown' as const,
                runtimeState: 'unknown' as const,
                pcmCapture: 'available' as const,
            },
            expectedCode: 'voice.readiness.execution_machine_incompatible',
        },
        {
            label: 'daemon inference feature disabled before its catalog is available',
            executionMachineId: 'machine-online',
            executionMachine: {
                mode: 'fixed' as const,
                machineId: 'machine-online',
            },
            daemon: {
                featureEnabled: false,
                route: 'direct' as const,
                modelState: 'unknown' as const,
                runtimeState: 'unknown' as const,
                pcmCapture: 'available' as const,
            },
            expectedCode: 'voice.readiness.server_feature_disabled',
        },
    ])(
        'projects selected Local execution-machine readiness for $label instead of hard-coded placeholders',
        async ({ executionMachineId, executionMachine, daemon, expectedCode }) => {
            const { VoiceProviderSection } = await import('./VoiceProviderSection');
            const {
                readLocalConversationVoiceSettings,
                voiceSettingsDefaults,
                writeLocalConversationVoiceSettings,
            } = await import('@/sync/domains/settings/voiceSettings');
            const local = readLocalConversationVoiceSettings(voiceSettingsDefaults);
            const voice = writeLocalConversationVoiceSettings(
                {
                    ...voiceSettingsDefaults,
                    providerId: 'local_conversation',
                    executionMachine,
                },
                {
                    ...local,
                    stt: {
                        ...local.stt,
                        provider: 'local_neural',
                        localNeural: {
                            ...local.stt.localNeural,
                            execution: 'daemon',
                        },
                    },
                    tts: {
                        ...local.tts,
                        provider: 'device',
                    },
                },
            );
            const screen = await renderScreen(
                React.createElement(VoiceProviderSection, {
                    voice,
                    executionMachineId,
                    executionMachineSelectionKind: executionMachineId ? 'resolved' : 'selected_unreachable',
                    setVoice: vi.fn(),
                    happierVoiceSupported: true,
                    platformOs: 'web',
                    localAvailability: {
                        browserSpeech: { support: 'unavailable' },
                        daemon,
                        nativeDevice: { requested: false },
                    },
                }),
            );
        const { tree } = screen;

            const localRow = findProviderChoiceRow(tree, { title: tLoose('settingsVoice.mode.local') });
            if (expectedCode === null) {
                expect(providerChoiceDetail(localRow)).not.toContain('voice.readiness');
            } else {
                expect(providerChoiceDetail(localRow)).toContain(tLoose(expectedCode));
            }
        },
        120_000,
    );

    it.each([
        {
            label: 'daemon inference is unavailable',
            daemon: {
                featureEnabled: true,
                route: 'direct' as const,
                modelState: 'unknown' as const,
                runtimeState: 'unavailable' as const,
                pcmCapture: 'available' as const,
            },
            expectedCode: 'voice.readiness.runtime_missing',
        },
        {
            label: 'the selected Local Neural model is missing',
            daemon: {
                featureEnabled: true,
                route: 'direct' as const,
                modelState: 'missing' as const,
                runtimeState: 'available' as const,
                pcmCapture: 'available' as const,
            },
            expectedCode: 'voice.readiness.model_missing',
        },
    ])(
        'does not let an unrelated runnable browser path make Local Voice ready when $label',
        async ({ daemon, expectedCode }) => {
            const {
                readLocalConversationVoiceSettings,
                voiceSettingsDefaults,
                writeLocalConversationVoiceSettings,
            } = await import('@/sync/domains/settings/voiceSettings');
            const local = readLocalConversationVoiceSettings(voiceSettingsDefaults);
            const voice = writeLocalConversationVoiceSettings(
                { ...voiceSettingsDefaults, providerId: 'local_conversation' },
                {
                    ...local,
                    stt: {
                        ...local.stt,
                        provider: 'local_neural',
                        localNeural: {
                            ...local.stt.localNeural,
                            execution: 'daemon',
                        },
                    },
                    tts: {
                        ...local.tts,
                        provider: 'device',
                    },
                },
            );
            const { VoiceProviderSection } = await import('./VoiceProviderSection');
            const screen = await renderScreen(
                React.createElement(VoiceProviderSection, {
                    voice,
                    executionMachineId: 'machine-online',
                    setVoice: vi.fn(),
                    happierVoiceSupported: true,
                    platformOs: 'web',
                    localAvailability: {
                        browserSpeech: { support: 'cloud_only', onDevice: 'unsupported' },
                        daemon,
                        nativeDevice: { requested: false },
                    },
                }),
            );
        const { tree } = screen;

            await act(async () => {});
            const readiness = checkedReadinessRow(tree);
            expect(readiness?.props.announcement).toContain(tLoose(expectedCode));
            expect(readiness?.props.announcement).not.toContain(tLoose('voice.readiness.ready'));
        },
        120_000,
    );

    it('does not report selected OpenAI-compatible Local STT as ready without its endpoint', async () => {
        const {
            readLocalConversationVoiceSettings,
            voiceSettingsDefaults,
            writeLocalConversationVoiceSettings,
        } = await import('@/sync/domains/settings/voiceSettings');
        const local = readLocalConversationVoiceSettings(voiceSettingsDefaults);
        const voice = writeLocalConversationVoiceSettings(
            {
                ...voiceSettingsDefaults,
                providerId: 'local_conversation',
                providers: {
                    ...voiceSettingsDefaults.providers,
                    'happier.voice.openai-compat/stt': {
                        schemaVersion: 2,
                        config: {
                            baseUrl: '',
                            insecureLocalOriginConsent: '',
                            insecureLocalConsentMachineId: '',
                            model: 'whisper-1',
                            language: '',
                        },
                    },
                },
            },
            {
                ...local,
                stt: {
                    ...local.stt,
                    provider: 'happier.voice.openai-compat/stt',
                },
                tts: {
                    ...local.tts,
                    provider: 'device',
                },
            },
        );
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const screen = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice,
                executionMachineId: 'machine-online',
                setVoice: vi.fn(),
                happierVoiceSupported: true,
                platformOs: 'web',
                localAvailability: {
                    browserSpeech: { support: 'cloud_only', onDevice: 'unsupported' },
                    daemon: {
                        featureEnabled: true,
                        route: 'direct',
                        modelState: 'ready',
                        runtimeState: 'available',
                        pcmCapture: 'available',
                    },
                    nativeDevice: { requested: false },
                },
            }),
        );
        const { tree } = screen;

        await act(async () => {});
        const readiness = checkedReadinessRow(tree);
        expect(readiness?.props.announcement).toContain(tLoose('voice.readiness.endpoint_missing'));
        expect(readiness?.props.announcement).not.toContain(tLoose('voice.readiness.ready'));
    }, 120_000);

    it('passively reports missing selected-machine credentials for nested Local cloud speech', async () => {
        const {
            readLocalConversationVoiceSettings,
            voiceSettingsDefaults,
            writeLocalConversationVoiceSettings,
        } = await import('@/sync/domains/settings/voiceSettings');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const local = readLocalConversationVoiceSettings(voiceSettingsDefaults);
        const voice = writeLocalConversationVoiceSettings(
            {
                ...voiceSettingsDefaults,
                providerId: 'local_conversation',
                providers: {
                    ...voiceSettingsDefaults.providers,
                    'happier.voice.google/gemini-stt': {
                        schemaVersion: 2,
                        config: { model: 'gemini-2.5-flash', language: '' },
                    },
                    'happier.voice.google/google-cloud-tts': {
                        schemaVersion: 2,
                        config: {
                            voiceName: 'en-US-Wavenet-D',
                            languageCode: 'en-US',
                            format: 'mp3',
                            speakingRate: 1,
                            pitch: 0,
                        },
                    },
                },
            },
            {
                ...local,
                stt: { ...local.stt, provider: 'happier.voice.google/gemini-stt' },
                tts: { ...local.tts, provider: 'happier.voice.google/google-cloud-tts' },
            },
        );
        storageBoundary.settings = settingsParse({ voice });
        onTestFinished(() => {
            storageBoundary.settings = null;
        });

        const setVoice = vi.fn();
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const screen = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice,
                executionMachineId: 'machine-online',
                setVoice,
                happierVoiceSupported: true,
                platformOs: 'web',
                localAvailability: {
                    browserSpeech: { support: 'cloud_only', onDevice: 'unsupported' },
                    daemon: {
                        featureEnabled: true,
                        route: 'direct',
                        modelState: 'ready',
                        runtimeState: 'available',
                        pcmCapture: 'available',
                    },
                    nativeDevice: { requested: false },
                },
            }),
        );
        const { tree } = screen;

        await act(async () => {});
        const readiness = checkedReadinessRow(tree);
        expect(readiness?.props.announcement).toContain(tLoose('voice.readiness.credential_missing'));
        expect(readiness?.props.announcement).not.toContain(tLoose('voice.readiness.ready'));
        expect(setVoice).not.toHaveBeenCalled();
    }, 120_000);

    it('reprojects a checked Local result when a nested cloud credential is removed', async () => {
        const {
            readLocalConversationVoiceSettings,
            voiceSettingsDefaults,
            writeLocalConversationVoiceSettings,
            writeVoiceProviderSettingsConfig,
        } = await import('@/sync/domains/settings/voiceSettings');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
        const local = readLocalConversationVoiceSettings(voiceSettingsDefaults);
        const voice = writeLocalConversationVoiceSettings(
            {
                ...voiceSettingsDefaults,
                providerId: 'local_conversation',
                providers: {
                    ...voiceSettingsDefaults.providers,
                    'happier.voice.google/gemini-stt': {
                        schemaVersion: 2,
                        config: { model: 'gemini-2.5-flash', language: '' },
                    },
                    'happier.voice.google/google-cloud-tts': {
                        schemaVersion: 2,
                        config: {
                            voiceName: 'en-US-Wavenet-D',
                            languageCode: 'en-US',
                            format: 'mp3',
                            speakingRate: 1,
                            pitch: 0,
                        },
                    },
                },
            },
            {
                ...local,
                stt: { ...local.stt, provider: 'happier.voice.google/gemini-stt' },
                tts: { ...local.tts, provider: 'happier.voice.google/google-cloud-tts' },
            },
        );
        const registry = createDefaultVoiceProviderRegistry();
        const sttEntry = registry.get('happier.voice.google/gemini-stt');
        const ttsEntry = registry.get('happier.voice.google/google-cloud-tts');
        const sttDeclaration = sttEntry?.kind === 'voice.speech-engine.v1' ? sttEntry.declaration : null;
        const ttsDeclaration = ttsEntry?.kind === 'voice.speech-engine.v1' ? ttsEntry.declaration : null;
        if (sttDeclaration?.kind !== 'speech' || ttsDeclaration?.kind !== 'speech') {
            throw new Error('expected current Google speech declarations');
        }
        const sttReady = await withVoiceSettingsCredentialResource(accountFixture, {
            settings: settingsParse({ voice }),
            pluginId: 'happier.voice.google', declaration: sttDeclaration,
            resourceId: 'google-stt-secret', recipientContractDigest: sttEntry?.accountCredentialSlot?.recipientContractDigest,
            machineId: 'machine-online',
        });
        const ready = await withVoiceSettingsCredentialResource(accountFixture, {
            settings: sttReady,
            pluginId: 'happier.voice.google', declaration: ttsDeclaration,
            resourceId: 'google-tts-secret', recipientContractDigest: ttsEntry?.accountCredentialSlot?.recipientContractDigest,
            machineId: 'machine-online',
        });
        rawCredentialReadiness.mockClear();
        storageBoundary.settings = ready;
        accountFixture.replaceVoice({ ...ready.voice, executionMachine: { mode: 'fixed', machineId: 'machine-online' } });
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 1, isOnline: true };
        onTestFinished(() => {
            storageBoundary.settings = null;
            passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: false };
        });

        const setVoice = vi.fn();
        const { VoiceProviderSection, useVoiceConversationsReadinessModel } = await import('./VoiceProviderSection');
        const { getConnectedAccountCatalogValue } = await import('@/sync/store/settings/connectedAccountCatalogSnapshot');
        const { resolveSavedSecretReference } = await import('@/sync/store/settings/savedSecretCatalogSnapshot');
        const { resolveAccountVoiceCredentialStatus } = await import('@/voice/credentials/accountVoiceCredential');
        const { projectVoiceRawSpeechReadinessTargets } = await import('@/voice/settings/voiceProviderReadinessInspection');
        const frames: Array<Readonly<{ online: boolean; daemonVersion: number; scope: typeof accountFixture.scope | null;
            publishedActive: boolean | null; key: string | null; catalogStatus: string | null; catalogStale: boolean | null;
            purposesStatus: string; purposesStale: boolean; credentialStates: readonly string[];
            rawTargets: readonly string[] | null; hearCode: string | null; speakCode: string | null;
            providerId: string | null; selectedProviderId: string | null; keyPresent: boolean }>> = [];
        function LocalMetadata(props: React.ComponentProps<typeof VoiceProviderSection>) {
            const model = useVoiceConversationsReadinessModel(props);
            const target = useMachineCliDetectionTarget('machine-online');
            const { binding } = useServerCredentialAccountScopeBinding(accountFixture.scope.serverId);
            const settings = storage.getState().settings;
            const catalog = getSavedSecretCatalogSnapshot(accountFixture.scope);
            const purposes = getConnectedAccountCatalogValue(accountFixture.scope, 'purposes');
            const machine = storage.getState().machineListByServerId[accountFixture.scope.serverId]
                ?.find(row => row.id === 'machine-online');
            frames.push({ online: target.isOnline, daemonVersion: target.daemonStateVersion,
                scope: binding?.isCurrent() ? binding.scope : null, publishedActive: machine?.active ?? null,
                key: model.selectedReadinessCheckKey, catalogStatus: catalog?.status ?? null,
                catalogStale: catalog?.stale ?? null, purposesStatus: purposes.status, purposesStale: purposes.stale,
                credentialStates: ['gemini-stt', 'google-cloud-tts'].map(localId => resolveAccountVoiceCredentialStatus({
                    settings, contribution: { pluginId: 'happier.voice.google', localId }, credentialSlotId: 'api_key',
                    machineId: 'machine-online', resolveSavedSecret: ref => resolveSavedSecretReference(accountFixture.scope, settings.secrets, ref),
                }).status),
                rawTargets: projectVoiceRawSpeechReadinessTargets({ ...settings, voice: props.voice }, registry,
                    'machine-online', 'conversation', purposes.value)?.map(target => target.contribution.localId) ?? null,
                hearCode: model.selectedLocalSpeechReadiness?.hear?.code ?? null,
                speakCode: model.selectedLocalSpeechReadiness?.speak?.code ?? null,
                providerId: model.voice.providerId, selectedProviderId: model.selectedProviderRow?.providerId ?? null,
                keyPresent: model.selectedReadinessCheckKey !== null });
            return null;
        }
        const render = (nextVoice: typeof ready.voice) => {
            const props = {
                voice: nextVoice,
                executionMachineId: 'machine-online',
                setVoice,
                happierVoiceSupported: true,
                platformOs: 'web',
                localAvailability: {
                    browserSpeech: { support: 'cloud_only' as const, onDevice: 'unsupported' as const },
                    daemon: {
                        featureEnabled: true,
                        route: 'direct' as const,
                        modelState: 'ready' as const,
                        runtimeState: 'available' as const,
                        pcmCapture: 'available' as const,
                    },
                    nativeDevice: { requested: false },
                },
            } satisfies React.ComponentProps<typeof VoiceProviderSection>;
            return <><VoiceProviderSection {...props} /><LocalMetadata {...props} /></>;
        };
        // The real foreground catalog materializes the current resource fixtures.
        const { getSavedSecretCatalogSnapshot } = await import('@/sync/store/settings/savedSecretCatalogSnapshot');
        await refreshSavedSecretCatalog(accountFixture.scope);
        expect(accountFixture.resources, JSON.stringify({
            catalogStatus: getSavedSecretCatalogSnapshot(accountFixture.scope)?.status,
            legacyImportStatus: getSavedSecretCatalogSnapshot(accountFixture.scope)?.legacyImport?.status,
            routes: accountFixture.request.mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : String(input)).pathname),
        })).toHaveLength(2);
        const screen = await renderScreen(render(ready.voice));
        const { tree } = screen;

        await act(async () => {});
        await waitForTestEvent(subscribeRawReadiness,
            () => new Set(rawCredentialReadiness.mock.calls.map(([contribution]) => contribution.localId)),
            checked => checked.size === 2 && checked.has('gemini-stt') && checked.has('google-cloud-tts'));
        expect(new Set(rawCredentialReadiness.mock.calls.map(([contribution]) => contribution.localId)),
            JSON.stringify(frames.map(({ key, ...frame }) => ({ ...frame, sameKeyAsInitial: key === frames[0]?.key }))))
            .toEqual(new Set(['gemini-stt', 'google-cloud-tts']));
        await waitForTestEvent(screen.subscribe, () => expect(checkedReadinessRow(tree)?.props.announcement).toContain(tLoose('voice.readiness.ready')));
        expect(checkedReadinessRow(tree)?.props.announcement).toContain(tLoose('voice.readiness.ready'));

        const hydrated = storage.getState().settings;
        const missingVoiceNameVoice = writeVoiceProviderSettingsConfig(
            hydrated.voice, 'happier.voice.google/google-cloud-tts', {
                voiceName: '', languageCode: 'en-US', format: 'mp3', speakingRate: 1, pitch: 0,
            },
        );
        const missingVoiceName = {
            ...hydrated,
            voice: missingVoiceNameVoice,
            voiceSettingsV1: { ...hydrated.voiceSettingsV1, providers: missingVoiceNameVoice.providers },
        };
        storageBoundary.settings = missingVoiceName;
        await act(async () => { await screen.update(render(missingVoiceName.voice)); });
        await act(async () => {});
        expect(checkedReadinessRow(tree)?.props.announcement).toContain(t('voice.readiness.settings_missing_required_setting', { service: t('settingsVoice.mode.local') }));

        const current = storage.getState().settings;
        const { resolveAccountVoiceCredential } = await import('@/voice/credentials/accountVoiceCredential');
        const sttRef = resolveAccountVoiceCredential(current,
            { pluginId: 'happier.voice.google', localId: 'gemini-stt' }, 'api_key', 'machine-online')?.secretId;
        const resourceIndex = accountFixture.resources.findIndex(resource => 'ref' in resource.entry && resource.entry.ref === sttRef);
        expect(resourceIndex).toBeGreaterThanOrEqual(0);
        accountFixture.resources.splice(resourceIndex, 1);
        const removed = settingsParse({ ...current,
            voiceSettingsV1: { ...current.voiceSettingsV1, providers: hydrated.voice.providers } });
        storageBoundary.settings = removed;
        await refreshSavedSecretCatalog(accountFixture.scope);
        await act(async () => {
            await screen.update(render(removed.voice));
        });

        expect(checkedReadinessRow(tree)?.props.announcement).toContain(tLoose('voice.readiness.credential_missing'));
        expect(setVoice).not.toHaveBeenCalled();
    }, 120_000);

    it('checks Local voice when the page opens and when the Hear engine changes, never from the hub model alone', async () => {
        const {
            readLocalConversationVoiceSettings,
            voiceSettingsDefaults,
            writeLocalConversationVoiceSettings,
        } = await import('@/sync/domains/settings/voiceSettings');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');
        const local = readLocalConversationVoiceSettings(voiceSettingsDefaults);
        const base = {
            ...voiceSettingsDefaults,
            providerId: 'local_conversation',
            providers: {
                ...voiceSettingsDefaults.providers,
                'happier.voice.google/gemini-stt': { schemaVersion: 2, config: { model: 'gemini-2.5-flash', language: '' } },
                'happier.voice.google/google-cloud-tts': {
                    schemaVersion: 2,
                    config: { voiceName: 'en-US-Wavenet-D', languageCode: 'en-US', format: 'mp3', speakingRate: 1, pitch: 0 },
                },
            },
        };
        const withHear = (stt: string) => writeLocalConversationVoiceSettings(base, {
            ...local,
            stt: { ...local.stt, provider: stt },
            tts: { ...local.tts, provider: 'happier.voice.google/google-cloud-tts' },
        });
        // Both cloud keys are saved up front, so only the engine choice differs between the two renders.
        const registry = createDefaultVoiceProviderRegistry();
        let settings = settingsParse({ voice: withHear(local.stt.provider) });
        for (const localId of ['gemini-stt', 'google-cloud-tts'] as const) {
            const entry = registry.get(`happier.voice.google/${localId}`);
            const declaration = entry?.kind === 'voice.speech-engine.v1' ? entry.declaration : null;
            if (declaration?.kind !== 'speech') throw new Error('expected current Google speech declarations');
            settings = await withVoiceSettingsCredentialResource(accountFixture, {
                settings,
                pluginId: 'happier.voice.google', declaration,
                resourceId: `${localId}-secret`, recipientContractDigest: entry?.accountCredentialSlot?.recipientContractDigest,
                machineId: 'machine-online',
            });
        }
        rawCredentialReadiness.mockClear();
        storageBoundary.settings = settings;
        accountFixture.replaceVoice({ ...settings.voice, executionMachine: { mode: 'fixed', machineId: 'machine-online' } });
        passiveSetupBoundary.machineTarget = { daemonStateVersion: 1, isOnline: true };
        onTestFinished(() => {
            storageBoundary.settings = null;
            passiveSetupBoundary.machineTarget = { daemonStateVersion: 0, isOnline: false };
        });

        const { VoiceProviderSection, useVoiceConversationsReadinessModel } = await import('./VoiceProviderSection');
        const sectionProps = (voice: typeof settings.voice) => ({
            voice,
            executionMachineId: 'machine-online',
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
            localAvailability: {
                browserSpeech: { support: 'cloud_only' as const, onDevice: 'unsupported' as const },
                daemon: {
                    featureEnabled: true,
                    route: 'direct' as const,
                    modelState: 'ready' as const,
                    runtimeState: 'available' as const,
                    pcmCapture: 'available' as const,
                },
                nativeDevice: { requested: false },
            },
        });
        // The hub reads the same model for its cards; reading it never runs the check.
        function HubModelReader() {
            useVoiceConversationsReadinessModel(sectionProps(settings.voice));
            return null;
        }
        const hub = await renderScreen(React.createElement(HubModelReader));
        await act(async () => {});
        expect(rawCredentialReadiness).not.toHaveBeenCalled();
        await hub.unmount();

        const render = (voice: typeof settings.voice) => React.createElement(VoiceProviderSection, sectionProps(voice));
        const screen = await renderScreen(render(settings.voice));
        await act(async () => {});
        expect(storage.getState().settings.voice.providerId, JSON.stringify({
            voiceProvider: storage.getState().settings.voice.providerId,
            executionMachine: storage.getState().settings.voice.executionMachine,
            persistedProvider: accountFixture.persistedSettings.voice.providerId,
            settingsScope: storage.getState().settingsScope,
        })).toBe('local_conversation');
        const checkedContributions = () => rawCredentialReadiness.mock.calls
            .map((call) => (call as unknown as [{ localId: string }])[0].localId);
        await waitForTestEvent(subscribeRawReadiness, checkedContributions, checked => checked.includes('google-cloud-tts'));
        await waitForTestEvent(screen.subscribe, () => checkedReadinessRow(screen.tree)?.props.announcement,
            announcement => typeof announcement === 'string' && announcement !== tLoose('settings.updates.checking'));
        // The hub's observer-free interval requires fresh catalog authority.
        // Each readiness invalidation may recheck speech; an unchanged render
        // after those real transitions must share the established result.
        expect(new Set(checkedContributions())).toEqual(new Set(['google-cloud-tts']));
        const checksAfterMount = rawCredentialReadiness.mock.calls.length;
        await screen.update(render(settings.voice));
        expect(rawCredentialReadiness).toHaveBeenCalledTimes(checksAfterMount);

        accountFixture.replaceVoice(withHear('happier.voice.google/gemini-stt'));
        const geminiHear = storage.getState().settings;
        await act(async () => { await screen.update(render(geminiHear.voice)); });
        await waitForTestEvent(subscribeRawReadiness, checkedContributions, checked => checked.includes('gemini-stt'));
        expect(checkedContributions()).toContain('gemini-stt');
        await screen.unmount();
    }, 120_000);

    it('updates an already-mounted provider selector when an external activation is added and removed', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { createExternalVoiceProviderActivationScope } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
        const { createBundledConversationRuntimeHostLease } = await import('@/voice/registry/bundledConversationRuntimeHost');
        const declaration = PluginContributesV2Schema.parse({ voiceProviders: [{
            id: 'conversation',
            title: 'Synthetic Live',
            kind: 'conversation',
            roles: ['realtime_conversation'],
            platforms: ['web'],
            capabilities: { turn: { cancelResponse: true, bargeIn: false } },
            client: { artifactId: 'voice-runtime-web', exportName: 'activate' },
        }] }).voiceProviders[0]!;
        if (declaration.kind !== 'conversation') throw new Error('expected conversation declaration');
        const scope = createExternalVoiceProviderActivationScope({
            pluginId: 'acme.synthetic-live',
            occurrenceId: 'acme.synthetic-live-occurrence-1',
            declarations: [declaration],
            hostPlatform: 'web',
        });
        const hostLease = createBundledConversationRuntimeHostLease();
        onTestFinished(async () => {
            await scope.unwind();
            hostLease.revoke();
        });
        const screen = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: settingsParse({ voice: { providerId: null } }).voice,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
        }));
        const { tree } = screen;

        expect(findProviderChoiceRow(tree, { title: 'Synthetic Live' })).toBeFalsy();
        await act(async () => {
            scope.api.voiceProviders.register('conversation', {
                kind: 'conversation',
                protocol: {
                    async prepare() {
                        return { kind: 'prepared', session: { config: {}, safeMetadata: null } };
                    },
                    decodeControl: () => [],
                    encodeTurnControl: (action) => action === 'cancel_response' ? { type: 'cancel' } : null,
                },
                async createConnection() {
                    return {
                        kind: 'sdk_handle',
                        async connect() {}, async sendControl() {},
                        controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                        transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                        async close() {}, state: () => 'closed',
                        currentProviderSessionId: () => null, playbackCursorMs: () => null,
                        beginOutputInterruptionCandidate: () => 'unsupported',
                        resolveOutputInterruptionCandidate() {},
                    };
                },
                encodeToolResults: () => [],
                encodeToolContinuation: (responseId) => ({ type: 'continue', responseId }),
                encodeContextUpdate: (text) => [{ type: 'context', text }],
                encodeTextTurn: (text) => [{ type: 'text', text }],
                microphoneMode: 'provider_managed',
                setInputMuted: () => {},
            });
            scope.commit();
        });
        expect(findProviderChoiceRow(tree, { title: 'Synthetic Live' })).toBeTruthy();

        await act(async () => scope.unwind());
        expect(findProviderChoiceRow(tree, { title: 'Synthetic Live' })).toBeFalsy();
    });

    it('renders and persists an active external provider select through the canonical qualified envelope', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { createExternalVoiceProviderActivationScope } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
        const { createBundledConversationRuntimeHostLease } = await import('@/voice/registry/bundledConversationRuntimeHost');
        const declaration = PluginContributesV2Schema.parse({ voiceProviders: [{
            id: 'conversation',
            title: 'Synthetic Configurable',
            kind: 'conversation',
            roles: ['realtime_conversation'],
            platforms: ['web'],
            capabilities: { turn: { cancelResponse: true, bargeIn: false } },
            settings: {
                schemaVersion: 1,
                fields: [{
                    id: 'voice',
                    title: { key: 'settings.voice.title', fallback: 'Provider voice' },
                    description: {
                        key: 'settings.voice.description',
                        fallback: 'Applied to the next provider session.',
                    },
                    schema: { type: 'string', enum: ['calm', 'bright'] },
                    default: 'calm',
                    presentation: {
                        control: 'select',
                        options: [
                            { value: 'calm', title: { key: 'settings.voice.calm', fallback: 'Calm' } },
                            { value: 'bright', title: { key: 'settings.voice.bright', fallback: 'Bright' } },
                        ],
                    },
                }],
            },
            client: { artifactId: 'voice-runtime-web', exportName: 'activate' },
        }] }).voiceProviders[0]!;
        if (declaration.kind !== 'conversation') throw new Error('expected conversation declaration');
        const scope = createExternalVoiceProviderActivationScope({
            pluginId: 'acme.synthetic-configurable',
            occurrenceId: 'acme.synthetic-configurable-occurrence-1',
            declarations: [declaration],
            hostPlatform: 'web',
        });
        const hostLease = createBundledConversationRuntimeHostLease();
        onTestFinished(async () => {
            await scope.unwind();
            hostLease.revoke();
        });
        scope.api.voiceProviders.register('conversation', {
            kind: 'conversation',
            protocol: {
                async prepare() {
                    return { kind: 'prepared', session: { config: {}, safeMetadata: null } };
                },
                decodeControl: () => [],
                encodeTurnControl: () => null,
            },
            async createConnection() {
                return {
                    kind: 'sdk_handle',
                    async connect() {}, async sendControl() {},
                    controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                    transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                    async close() {}, state: () => 'closed',
                    currentProviderSessionId: () => null, playbackCursorMs: () => null,
                    beginOutputInterruptionCandidate: () => 'unsupported',
                    resolveOutputInterruptionCandidate() {},
                };
            },
            encodeToolResults: () => [],
            encodeToolContinuation: () => null,
            encodeContextUpdate: () => [],
            encodeTextTurn: () => [],
            microphoneMode: 'provider_managed',
            setInputMuted: () => {},
        });
        await scope.commit();
        const providerId = 'acme.synthetic-configurable/conversation';
        const setVoice = vi.fn();
        const screen = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: settingsParse({ voice: {
                providerId,
                providers: {
                    [providerId]: {
                        schemaVersion: 1,
                        config: { voice: 'calm' },
                    },
                },
            } }).voice,
            setVoice,
            happierVoiceSupported: true,
            platformOs: 'web',
        }));
        const { tree } = screen;

        const select = findTestInstanceByTypeWithProps(tree, DropdownMenu, {
            selectedId: JSON.stringify('calm'),
        });
        expect(select?.props.itemTrigger.title).toBe('Provider voice');
        expect(select?.props.items.map((item: Readonly<{ title: string }>) => item.title)).toEqual([
            'Calm',
            'Bright',
        ]);
        await act(async () => select?.props.onSelect(JSON.stringify('bright')));
        expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
            providerId,
            providers: expect.objectContaining({
                [providerId]: {
                    schemaVersion: 1,
                    config: { voice: 'bright' },
                },
            }),
        }));
    });

    it('keeps an externally installed provider selectable when its credential source resolution is unknown', async () => {
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { createExternalVoiceProviderActivationScope } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
        const { createBundledConversationRuntimeHostLease } = await import('@/voice/registry/bundledConversationRuntimeHost');
        const declaration = PluginContributesV2Schema.parse({ voiceProviders: [{
            id: 'conversation',
            title: 'Acme selectable voice',
            kind: 'conversation',
            roles: ['realtime_conversation'],
            platforms: ['web'],
            capabilities: { turn: { cancelResponse: false, bargeIn: false } },
            credentials: {
                slot: { id: 'api_key', purpose: 'voice.client-auth', title: 'API key' },
                requirement: { kind: 'always' },
                sources: [{
                    kind: 'savedSecret',
                    secretKinds: ['apiKey'],
                    rawGrants: [{
                        realm: 'web',
                        phase: 'prepare',
                        request: {
                            kind: 'httpHeaders',
                            origin: 'https://voice.example.com',
                            headerNames: ['authorization'],
                        },
                    }],
                }, {
                    kind: 'connectedAccount',
                    service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                    rawGrants: [{
                        realm: 'web',
                        phase: 'prepare',
                        request: {
                            kind: 'httpHeaders',
                            origin: 'https://voice.example.com',
                            headerNames: ['authorization'],
                        },
                    }],
                }],
            },
            settings: {
                schemaVersion: 1,
                fields: [{
                    id: 'voice',
                    title: 'Voice',
                    schema: { type: 'string', minLength: 1, maxLength: 64 },
                    default: 'calm',
                    presentation: { control: 'text' },
                }],
            },
            client: { artifactId: 'voice-runtime-web', exportName: 'activate' },
        }] }).voiceProviders[0]!;
        if (declaration.kind !== 'conversation' || !declaration.credentials) {
            throw new Error('expected credential conversation declaration');
        }
        const scope = createExternalVoiceProviderActivationScope({
            pluginId: 'acme.selectable-voice',
            occurrenceId: 'acme.selectable-voice-occurrence-1',
            declarations: [declaration],
            hostPlatform: 'web',
        });
        const hostLease = createBundledConversationRuntimeHostLease();
        const account = {
            ref: {
                service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                accountId: 'codex-work',
            },
            status: 'connected' as const,
            configurationReady: false,
            authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned' as const,
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaaaa',
            configurationRevision: null,
            scopes: ['openid', 'profile', 'email', 'offline_access'],
        };
        onTestFinished(async () => {
            storageBoundary.settings = null;
            passiveSetupBoundary.profile = null;
            await scope.unwind();
            hostLease.revoke();
        });
        scope.api.voiceProviders.register('conversation', {
            kind: 'conversation',
            protocol: {
                async prepare() {
                    return { kind: 'prepared', session: { config: {}, safeMetadata: null } };
                },
                decodeControl: () => [],
                encodeTurnControl: () => null,
            },
            async createConnection() {
                return {
                    kind: 'sdk_handle',
                    async connect() {}, async sendControl() {},
                    controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                    transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                    async close() {}, state: () => 'closed',
                    currentProviderSessionId: () => null, playbackCursorMs: () => null,
                    beginOutputInterruptionCandidate: () => 'unsupported',
                    resolveOutputInterruptionCandidate() {},
                };
            },
            encodeToolResults: () => [],
            encodeToolContinuation: () => null,
            encodeContextUpdate: () => [],
            encodeTextTurn: () => [],
            microphoneMode: 'provider_managed',
            setInputMuted: () => {},
        });
        await scope.commit();

        await installCodexConnectedAccountDescriptor({
            pluginId: 'acme.selectable-voice', occurrenceId: 'acme.selectable-voice-occurrence-1',
            declaration, host: hostLease.host,
        });

        const providerId = 'acme.selectable-voice/conversation';
        storageBoundary.settings = settingsParse({
            secrets: [{
                id: 'surviving-acme-secret',
                name: 'Saved Acme key',
                kind: 'apiKey',
                encryptedValue: {
                    _isSecretValue: true,
                    encryptedValue: { t: 'enc-v1', c: 'Y2lwaGVydGV4dA==' },
                },
                createdAt: 1,
                updatedAt: 1,
            }],
            voiceSettingsV1: { credentialBindings: [] },
        });
        await accountFixture.replaceConnectedPurposes({ v: 1, bindings: [{
            purpose: { consumer: { pluginId: 'acme.selectable-voice', localId: 'conversation' }, purpose: 'voice.client-auth' },
            target: { kind: 'account', account: account.ref },
        }] });
        passiveSetupBoundary.profile = {
            connectedAccountsV4: [account],
            connectedAccountGroupsV4: [],
            connectedServicesV2: [],
        };

        const screen = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: settingsParse({ voice: { providerId: null } }).voice,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
        }));
        const { tree } = screen;
        const row = findProviderChoiceRow(tree.root, { testID: `settings.voice.provider.${encodeURIComponent(providerId)}.default` })!;

        expect(row).toBeTruthy();
        expect(providerChoiceDetail(row)).toContain(tLoose('voice.readiness.credential_unknown'));
        // The declaration names savedSecret and connectedAccount sources, so
        // the credential is configurable once the row can be selected. A
        // bundled row in this exact state stays selectable; provenance is not
        // evidence about whether a credential can be supplied.
        expect(row.props.disabled).not.toBe(true);
    }, 120_000);

    it('keeps a dormant external SavedSecret edit standalone while Connected Account is selected', async () => {
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const { applyAccountVoiceCredentialSourceSelection } = await import('@/voice/credentials/accountVoiceCredential');
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { createExternalVoiceProviderActivationScope } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
        const { createBundledConversationRuntimeHostLease } = await import('@/voice/registry/bundledConversationRuntimeHost');
        const declaration = PluginContributesV2Schema.parse({ voiceProviders: [{
            id: 'conversation',
            title: 'External credential voice',
            kind: 'conversation',
            roles: ['realtime_conversation'],
            platforms: ['web'],
            capabilities: { turn: { cancelResponse: false, bargeIn: false } },
            credentials: {
                slot: { id: 'api_key', purpose: 'voice.client-auth', title: 'API key' },
                requirement: { kind: 'always' },
                sources: [{
                    kind: 'savedSecret',
                    secretKinds: ['apiKey'],
                    rawGrants: [{
                        realm: 'web',
                        phase: 'prepare',
                        request: {
                            kind: 'httpHeaders',
                            origin: 'https://voice.example.com',
                            headerNames: ['authorization'],
                        },
                    }],
                }, {
                    kind: 'connectedAccount',
                    service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                    rawGrants: [{
                        realm: 'web',
                        phase: 'prepare',
                        request: {
                            kind: 'httpHeaders',
                            origin: 'https://voice.example.com',
                            headerNames: ['authorization'],
                        },
                    }],
                }],
            },
            settings: {
                schemaVersion: 1,
                fields: [{
                    id: 'voice',
                    title: 'Voice',
                    schema: { type: 'string', minLength: 1, maxLength: 64 },
                    default: 'calm',
                    presentation: { control: 'text' },
                }],
            },
            client: { artifactId: 'voice-runtime-web', exportName: 'activate' },
        }] }).voiceProviders[0]!;
        if (declaration.kind !== 'conversation' || !declaration.credentials) {
            throw new Error('expected credential conversation declaration');
        }
        const scope = createExternalVoiceProviderActivationScope({
            pluginId: 'acme.external-credential',
            occurrenceId: 'acme.external-credential-occurrence-1',
            declarations: [declaration],
            hostPlatform: 'web',
        });
        const hostLease = createBundledConversationRuntimeHostLease();
        const account = {
            ref: {
                service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                accountId: 'codex-work',
            },
            status: 'connected' as const,
            configurationReady: false,
            authenticationModeId: 'oauth',
            revisionSemantics: 'revisioned' as const,
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaaaa',
            configurationRevision: null,
            scopes: [],
        };
        onTestFinished(async () => {
            storageBoundary.settings = null;
            passiveSetupBoundary.profile = null;
            await scope.unwind();
            hostLease.revoke();
        });
        scope.api.voiceProviders.register('conversation', {
            kind: 'conversation',
            protocol: {
                async prepare() {
                    return { kind: 'prepared', session: { config: {}, safeMetadata: null } };
                },
                decodeControl: () => [],
                encodeTurnControl: () => null,
            },
            async createConnection() {
                return {
                    kind: 'sdk_handle',
                    async connect() {}, async sendControl() {},
                    controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                    transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                    async close() {}, state: () => 'closed',
                    currentProviderSessionId: () => null, playbackCursorMs: () => null,
                    beginOutputInterruptionCandidate: () => 'unsupported',
                    resolveOutputInterruptionCandidate() {},
                };
            },
            encodeToolResults: () => [],
            encodeToolContinuation: () => null,
            encodeContextUpdate: () => [],
            encodeTextTurn: () => [],
            microphoneMode: 'provider_managed',
            setInputMuted: () => {},
        });
        await scope.commit();
        await installCodexConnectedAccountDescriptor({
            pluginId: 'acme.external-credential', occurrenceId: 'acme.external-credential-occurrence-1',
            declaration, host: hostLease.host,
        });
        const providerId = 'acme.external-credential/conversation';
        const voice = {
            providerId,
            providers: { [providerId]: { schemaVersion: 1, config: { voice: 'calm' } } },
        };
        const selected = applyAccountVoiceCredentialSourceSelection({
            settings: settingsParse({ voice }),
            connectedPurposes: accountFixture.purposes.value,
            mutation: {
                contribution: { pluginId: 'acme.external-credential', localId: 'conversation' },
                credentialSlotId: 'api_key',
                selection: { kind: 'connectedAccount', target: { kind: 'account', account: account.ref } },
                expectedSettingsVersion: 1,
            },
            currentDeclaration: declaration,
        });
        await accountFixture.replaceConnectedPurposes(selected.connectedPurposes);
        storageBoundary.settings = selected.settings;
        passiveSetupBoundary.profile = {
            connectedAccountsV4: [account],
            connectedAccountGroupsV4: [],
            connectedServicesV2: [],
        };
        const screen = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: selected.settings.voice,
            setVoice: vi.fn(),
            happierVoiceSupported: true,
            platformOs: 'web',
        }));
        const { tree } = screen;
        const credentialEditor = tree.root.findAll((node) => (
            node.props.contribution?.pluginId === 'acme.external-credential'
            && node.props.credentialSlotId === 'api_key'
        ))[0];

        expect(credentialEditor).toBeTruthy();
        expect(credentialEditor.props.credentialSourcePurpose).toBeUndefined();
    });

    it('qualifies a same-plugin shorthand Agent binding before rendering Connected Services settings', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const { createExternalVoiceProviderActivationScope } = await import('@/voice/registry/externalVoiceProviderActivation.testkit');
        const { createBundledConversationRuntimeHostLease } = await import('@/voice/registry/bundledConversationRuntimeHost');
        const declaration = PluginContributesV2Schema.parse({ voiceProviders: [{
            id: 'conversation',
            title: 'Installed Agent Voice',
            kind: 'conversation',
            roles: ['realtime_conversation'],
            platforms: ['web'],
            capabilities: { turn: { cancelResponse: false, bargeIn: false } },
            execution: {
                kind: 'experimental_agent_session_realtime',
                agent: 'claude',
                supportedRuntimeVersions: ['1.2.3'],
            },
            settings: {
                schemaVersion: 2,
                fields: [],
                privacyDisclosure: {
                    key: 'settingsVoice.realtimeProviders.codex.privacyDisclosure',
                    fallback: 'Installed provider privacy disclosure.',
                },
                connectedServicesBinding: {
                    id: 'globalConnectedServices',
                    title: 'Claude account',
                    description: 'Account for the global Voice session.',
                    agent: 'claude',
                    serviceIds: ['anthropic', 'openai-codex'],
                },
            },
            client: { artifactId: 'voice-runtime-web', exportName: 'activate' },
        }] }).voiceProviders[0]!;
        if (declaration.kind !== 'conversation') throw new Error('expected conversation declaration');
        const scope = createExternalVoiceProviderActivationScope({
            pluginId: 'acme.voice',
            occurrenceId: 'acme.voice-occurrence-1',
            declarations: [declaration],
            hostPlatform: 'web',
        });
        const hostLease = createBundledConversationRuntimeHostLease();
        onTestFinished(async () => {
            await scope.unwind();
            hostLease.revoke();
        });
        scope.api.voiceProviders.register('conversation', {
            kind: 'conversation',
            protocol: {
                async prepare() {
                    return { kind: 'prepared', session: { config: {}, safeMetadata: null } };
                },
                decodeControl: () => [],
                encodeTurnControl: () => null,
            },
            async createConnection() {
                return {
                    kind: 'sdk_handle',
                    async connect() {}, async sendControl() {},
                    controlEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                    transportEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
                    async close() {}, state: () => 'closed',
                    currentProviderSessionId: () => null, playbackCursorMs: () => null,
                    beginOutputInterruptionCandidate: () => 'unsupported',
                    resolveOutputInterruptionCandidate() {},
                };
            },
            encodeToolResults: () => [],
            encodeToolContinuation: () => null,
            encodeContextUpdate: () => [],
            encodeTextTurn: () => [],
            microphoneMode: 'provider_managed',
            setInputMuted: () => {},
        });
        await scope.commit();
        const providerId = 'acme.voice/conversation';
        const binding = {
            v: 1 as const,
            bindingsByServiceId: {
                [CLAUDE_CONNECTED_SERVICE_KEY]: {
                    source: 'connected' as const,
                    selection: 'profile' as const,
                    profileId: 'anthropic-account-a',
                },
                [CODEX_CONNECTED_SERVICE_KEY]: {
                    source: 'connected' as const,
                    selection: 'profile' as const,
                    profileId: 'codex-account-a',
                },
            },
        };
        const setVoice = vi.fn();
        accountFixture.replaceVoice(settingsParse({ voice: {
            providerId,
            providers: {
                [providerId]: {
                    schemaVersion: 2,
                    config: { globalConnectedServices: null },
                },
            },
        } }).voice);
        passiveSetupBoundary.profile = { connectedServicesV2: [
            { serviceId: 'anthropic', profiles: [{ profileId: 'anthropic-account-a', status: 'connected', kind: 'token' }] },
            { serviceId: 'openai-codex', profiles: [{ profileId: 'codex-account-a', status: 'connected', kind: 'oauth' }] },
        ] };
        const screen = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: accountFixture.settings.voice,
            setVoice,
            happierVoiceSupported: true,
            platformOs: 'web',
        }));
        const { tree } = screen;

        const field = tree.findAllByType(VoiceGlobalConnectedServicesBindingField)
            .find((candidate) => candidate.props.title === 'Claude account');
        expect(field).toBeTruthy();
        expect(field?.props.agentId).toEqual({
            pluginId: 'acme.voice',
            localId: 'claude',
        });
        expect(field?.props.serviceIds).toEqual(['anthropic', 'openai-codex']);
        const version = storage.getState().settingsVersion;
        expect(version).not.toBeNull();
        await act(async () => field?.props.onChange(binding, version));
        await waitForTestEvent(screen.subscribe, () => expect(accountFixture.persistedSettings.voice).toMatchObject({
            providerId,
            providers: {
                [providerId]: {
                    schemaVersion: 2,
                    config: { globalConnectedServices: binding },
                },
            },
        }));
        expect(setVoice).not.toHaveBeenCalled();
    });

    it('renders bundled Codex through the same exact qualified public Connected Services declaration', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const binding = {
            v: 1 as const,
            bindingsByServiceId: {
                [CODEX_CONNECTED_SERVICE_KEY]: {
                    source: 'connected' as const,
                    selection: 'profile' as const,
                    profileId: 'codex-account-b',
                },
            },
        };
        const setVoice = vi.fn();
        accountFixture.replaceVoice(settingsParse({ voice: {
            providerId: CODEX_PROVIDER_ID,
            providers: {
                [CODEX_PROVIDER_ID]: {
                    schemaVersion: 2,
                    config: { globalConnectedServices: null },
                },
            },
        } }).voice);
        passiveSetupBoundary.profile = { connectedServicesV2: [{ serviceId: 'openai-codex',
            profiles: [{ profileId: 'codex-account-b', status: 'connected', kind: 'oauth' }] }] };
        const screen = await renderScreen(React.createElement(VoiceProviderSection, {
            voice: accountFixture.settings.voice,
            setVoice,
            happierVoiceSupported: true,
            platformOs: 'web',
        }));
        const { tree } = screen;

        const fields = tree.findAllByType(VoiceGlobalConnectedServicesBindingField)
            .filter((candidate) => candidate.props.title === 'Codex account'
                && candidate.props.agentId?.pluginId === 'happier.agent.codex'
                && candidate.props.agentId?.localId === 'codex');
        expect(fields).toHaveLength(1);
        const version = storage.getState().settingsVersion;
        expect(version).not.toBeNull();
        await act(async () => fields[0]?.props.onChange(binding, version));
        await waitForTestEvent(screen.subscribe, () => expect(accountFixture.persistedSettings.voice).toMatchObject({
            providerId: CODEX_PROVIDER_ID,
            providers: {
                [CODEX_PROVIDER_ID]: {
                    schemaVersion: 2,
                    config: { globalConnectedServices: binding },
                },
            },
        }));
        expect(setVoice).not.toHaveBeenCalled();
    });
});
