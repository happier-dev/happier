import * as React from 'react';
import { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';

import { renderSettingsView as renderSettingsScreen } from '@/dev/testkit/harness/settingsViewHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createDeferred, createModalModuleMock, flushHookEffects, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createAccountSettingsHttpBoundary } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { readExternalSessionFollowPolicy } from '@/sync/domains/session/external/externalSessionFollowMetadata';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';

const modalMock = createModalModuleMock();
const virtualizedBoundary = vi.hoisted(() => ({
    props: null as Record<string, any> | null,
    mountLimit: Number.POSITIVE_INFINITY,
}));
const administrationTargetState = { machineId: 'machine-1', peerHome: false };
const daemonProjectionRequest = vi.hoisted(() => vi.fn());

vi.mock('@/modal', () => modalMock.module);

let settingsHttp: ReturnType<typeof createAccountSettingsHttpBoundary> | null = null;
let settingsVersion = 1;
let rawAccountSettings: Record<string, unknown> = {};
let settingsWriteGate: Promise<void> | null = null;
let rejectSettingsWrite = false;
const settingsPosts = vi.fn();
let projectionGate: ReturnType<typeof createDeferred<void>> | null = null;
let peerServerId: string | null = null;
// These are external HTTP/Socket server facts, not replacements for the store,
// Sync, currentness, target selection, projection adapters or operation owners.
const effectBoundary = {
    followPolicySet: vi.fn(),
    machineRpc: vi.fn(),
    machines: [] as Machine[],
    sessions: [] as Session[],
    get accountSettings() { return rawAccountSettings; },
    set accountSettings(value: Record<string, unknown>) {
        rawAccountSettings = value;
        if (settingsHttp) settingsHttp.replaceAccountSettings('account-1', {
            content: { t: 'plain', v: value }, version: ++settingsVersion,
        });
    },
    daemonProjection: {
        phase: 'ready' as 'ready' | 'loading' | 'error',
        inputs: null as Record<string, unknown> | null,
    },
    settings: {
        v: 1 as const,
        keepPassivelyFollowingAfterRestart: false,
    } as unknown,
    contextSelections: null as {
        v: 1;
        selectionsByKey: Record<string, {
            machineId?: string | null;
            workspacePath?: string | null;
        }>;
    } | null,
};

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

// The native recycler owns viewport mounting; keep Happier's list and row projection real.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    const boundary = createCapturingLegendListMock({
        original: await importOriginal<Record<string, unknown>>(),
        renderItems: true,
        get renderItemLimit() { return virtualizedBoundary.mountLimit; },
    });
    return { ...boundary.module, LegendList: React.forwardRef(function LegendListBoundary(props: Record<string, unknown>, ref) {
        virtualizedBoundary.props = props;
        return React.createElement(boundary.module.LegendList, { ...props, ref });
    }) };
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const account = createProviderSettingsAccountHarness();
installDisconnectedServerSocketBoundary((socket, serverUrl) => {
    socket.connect = vi.fn<typeof socket.connect>(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event: string, value: unknown) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
        if (!value || typeof value !== 'object' || !('method' in value) || typeof value.method !== 'string'
            || !('params' in value)) throw new Error('Malformed External Sessions Socket request');
        const separator = value.method.indexOf(':');
        const machineId = value.method.slice(0, separator);
        const method = value.method.slice(separator + 1);
        const { listServerProfiles, resolveServerProfileScopeId } = await import('@/sync/domains/server/serverProfiles');
        const profile = listServerProfiles().find(candidate => candidate.serverUrl === serverUrl);
        if (!profile) throw new Error('External Sessions Socket requires its real Home');
        const serverId = resolveServerProfileScopeId(profile);
        if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
            daemonProjectionRequest({ machineId, serverId });
            await projectionGate?.promise;
            if (effectBoundary.daemonProjection.phase === 'error') throw new Error('fixture_projection_unavailable');
            return { ok: true, result: { protocolVersion: 1,
                projection: PluginProjectionV2Schema.parse(effectBoundary.daemonProjection.inputs?.pluginProjectionV2) } };
        }
        if (method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET) {
            return { ok: true, result: await effectBoundary.followPolicySet(value.params, { serverId }) };
        }
        if (method === 'daemon.plugins.sessionHooks.status.get') {
            return { ok: true, result: await effectBoundary.machineRpc({ machineId, serverId, method, payload: value.params }) };
        }
        throw new Error(`Unexpected External Sessions Socket request: ${method}`);
    });
});

// The Home's scope identity (its portable identity when it has one), which every Home-scoped call carries.
function scopeIdOf(serverId: string): string {
    return resolveServerProfileScopeIdForIdentifier(serverId);
}

function createExternalSession(params: Readonly<{
    id: string;
    policy: 'attached_only' | 'background_follow';
    status?: 'disabled' | 'paused' | 'reacquiring' | 'active' | 'error';
    reason?: string;
    machineId?: string;
    title?: string;
}>): Session {
    return createSessionFixture({
        id: params.id,
        serverId: 'server-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 2,
        active: true,
        activeAt: 2,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        metadata: {
            path: '/tmp/project',
            host: 'machine-1',
            summary: {
                text: params.title ?? `Session ${params.id}`,
                updatedAt: 2,
            },
            externalSessionV1: {
                v: 1,
                agentId: 'claude',
                machineId: params.machineId ?? 'machine-1',
                remoteSessionId: `remote-${params.id}`,
                source: {
                    kind: 'claudeConfig',
                    configDir: '/tmp/claude',
                },
                followPolicyV1: {
                    v: 1,
                    policy: params.policy,
                    updatedAtMs: 10,
                },
                ...(params.status ? {
                    followStatusV1: {
                        v: 1,
                        status: params.status,
                        ...(params.reason ? { reason: params.reason } : {}),
                        updatedAtMs: 11,
                    },
                } : {}),
            },
        },
    });
}

function createFollowCapabilityProjection(params?: Readonly<{ sourceKind?: string }>) {
    return PluginProjectionV2Schema.parse({
        v: 2,
        generation: 1,
        installedPackagesById: {
            'test.follow': { id: 'test.follow', displayName: 'Follow fixture', version: '1.0.0', enabled: true,
                source: { kind: 'npm', locator: 'test.follow' } },
        },
        agentsById: {
            claude: {
                id: 'claude',
                externalSessions: {
                    agent: { pluginId: 'test.follow', localId: 'claude' },
                    generation: 1,
                    operations: { listCandidates: true, resolveLinkIdentity: true, pageTranscript: true, readAfterTranscript: true },
                    sources: [{
                        sourceKind: params?.sourceKind ?? 'claudeConfig',
                        schema: {
                            fields: [
                                { name: 'kind', kind: 'literal', value: params?.sourceKind ?? 'claudeConfig' },
                                { name: 'configDir', kind: 'string', min: 1 },
                            ],
                        },
                        key: { segments: [{ kind: 'literal', value: params?.sourceKind ?? 'claudeConfig' }] },
                        instances: [{ kind: 'default', constants: { configDir: '/tmp/claude' } }],
                    }],
                },
            },
        },
    });
}

async function publishSessionFixtures(sessions: readonly Session[]) {
    const [{ sync }, { storage }] = await Promise.all([import('@/sync/sync'), import('@/sync/domains/state/storage')]);
    for (const session of sessions) session.serverId = account.serverId;
    const sessionHttp = createSessionMetadataHttpBoundary(() => Object.fromEntries(sessions.map(session => [session.id, session])));
    for (const path of ['/v2/sessions', '/v2/sessions/active', '/v2/session-organization',
        ...sessions.map(session => `/v2/sessions/${encodeURIComponent(session.id)}`)]) {
        account.home.answer(account.serverId, `GET ${path}`, { select: async (_input, request) => {
            const response = sessionHttp.handle(request.url, request.init);
            if (!response) throw new Error('Expected External Sessions Session listing route');
            return { status: response.status, body: await response.json() };
        } });
    }
    await sync.refreshSessions({ awaitSessionListHydration: true });
    // List snapshots intentionally stay lazy. These scenarios begin with
    // loaded linked Sessions, acquired through the same exact owner read as a
    // session route, rather than an invented full-store reader.
    for (const session of sessions) await sync.ensureSessionVisibleForMessageRoute(session.id, {
        serverId: account.serverId, forceRefresh: true, hydrateMessages: false,
    });
    await waitForHomeGovernance(() => {
        expect(Object.keys(storage.getState().sessions).sort()).toEqual(sessions.map(session => session.id).sort());
    });
}

function installSettingsBoundary(accountId: string, settings: Record<string, unknown>) {
    settingsVersion = 1;
    rawAccountSettings = settings;
    settingsHttp = createAccountSettingsHttpBoundary({ serverUrl: 'https://provider-settings-account.test',
        initialAccounts: [{ accountId, snapshot: { content: { t: 'plain', v: settings }, version: settingsVersion } }] });
    account.home.answer(account.serverId, '/v2/account/settings', { select: async (_input, request) => {
        const respondAfter = request.init?.method === 'POST' ? settingsWriteGate : null;
        if (request.init?.method === 'POST') {
            settingsPosts(_input);
            if (rejectSettingsWrite) {
                rejectSettingsWrite = false;
                return { status: 503, body: { error: 'account_settings_unavailable' },
                    ...(respondAfter ? { respondAfter } : {}) };
            }
        }
        const response = settingsHttp?.handle(request.url, request.init);
        if (!response) throw new Error('Expected External Sessions Account settings route');
        const snapshotResponse = settingsHttp!.handle(request.url, { ...request.init, method: 'GET' });
        const snapshot = AccountSettingsV2GetResponseSchema.parse(await snapshotResponse!.json());
        if (snapshot.content?.t === 'plain') rawAccountSettings = snapshot.content.v;
        settingsVersion = snapshot.version;
        return { status: response.status, body: await response.json(), ...(respondAfter ? { respondAfter } : {}) };
    } });
}

async function renderSettingsView(element: React.ReactElement) {
    const [preferences, projection] = await Promise.all([
        import('@/sync/domains/machines/administration/selectionPreferences'),
        import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs'),
    ]);
    const settings = { ...effectBoundary.accountSettings, externalSessionsSettingsV1: effectBoundary.settings,
        ...(effectBoundary.contextSelections ? { contextSelectionsV1: effectBoundary.contextSelections } : {}) };
    await account.restore({ accountId: 'account-1', serverIdentityId: 'srv_external_settings',
        machines: effectBoundary.machines, settings });
    installSettingsBoundary('account-1', settings);
    await publishSessionFixtures(effectBoundary.sessions);
    let selectedServerId = account.serverId;
    if (administrationTargetState.peerHome) {
        peerServerId = await account.addHome({ name: 'Other Home', serverUrl: 'https://external-settings-other.test',
            serverIdentityId: 'srv_external_other', accountId: 'account-1', active: false });
        await account.publishMachines(peerServerId, effectBoundary.machines.filter(machine => machine.id === administrationTargetState.machineId));
        await account.home.selectHomes([account.serverId, peerServerId]);
        selectedServerId = peerServerId;
    }
    await account.selectMachine(selectedServerId, administrationTargetState.machineId, preferences.MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.externalSessions);
    if (effectBoundary.daemonProjection.phase === 'ready') {
        await Promise.all([...new Set([...effectBoundary.machines.map(machine => machine.id),
            ...effectBoundary.sessions.map(session => readExternalSessionLink(session.metadata)?.machineId).filter((id): id is string => Boolean(id))])]
            .map(async machineId => {
                const result = await projection.loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId, serverId: scopeIdOf(account.serverId) });
                expect(result, 'The fixture daemon must publish a schema-admitted current projection').toMatchObject({ kind: 'ready' });
            }));
    } else if (effectBoundary.daemonProjection.phase === 'loading') {
        projectionGate = createDeferred<void>();
    }
    const screen = await renderSettingsScreen(element);
    await flushHookEffects();
    return screen;
}

async function currentMetadata(sessionId: string) {
    const { storage } = await import('@/sync/domains/state/storage');
    const session = storage.getState().sessions[sessionId];
    return session ? readSessionOwnerMetadataView(session) : null;
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

function requireItemGroupSurface(row: ReactTestInstance | null | undefined): ReactTestInstance {
    if (!row) throw new Error('Expected rendered Item row');
    let current = row.parent;
    while (current) {
        if (typeof current.type === 'string') {
            const style = flattenStyle(current.props.style);
            if (style.backgroundColor !== undefined && style.borderRadius !== undefined) {
                return current;
            }
        }
        current = current.parent;
    }
    throw new Error('Expected Item row to be inside real ItemGroup surface chrome');
}

const { Item } = await import('@/components/ui/lists/Item');

// Load the real owner after boundaries during collection, outside behavior deadlines.
await import('./ExternalSessionsSettingsView');

describe('ExternalSessionsSettingsView passive shell', () => {
    beforeEach(async () => {
        settingsHttp = null;
        settingsWriteGate = null;
        rejectSettingsWrite = false;
        settingsPosts.mockReset();
        effectBoundary.machines = [createMachineFixture({ id: 'machine-1', active: true, activeAt: Date.now() })];
        effectBoundary.sessions = [];
        effectBoundary.settings = { v: 1, keepPassivelyFollowingAfterRestart: false };
        effectBoundary.machineRpc.mockReset();
        effectBoundary.followPolicySet.mockReset();
        modalMock.spies.alert.mockClear();
        modalMock.spies.alertAsync.mockClear();
        const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
        clearDaemonMergedProjectionCacheForTests();
        effectBoundary.daemonProjection = {
            phase: 'ready',
            inputs: {
                pluginProjectionV2: createFollowCapabilityProjection(),
            },
        };
        administrationTargetState.machineId = 'machine-1';
        administrationTargetState.peerHome = false;
        peerServerId = null;
        daemonProjectionRequest.mockReset();
        effectBoundary.contextSelections = null;
        effectBoundary.accountSettings = {
            externalSessionsSettingsV1: effectBoundary.settings,
        };
        virtualizedBoundary.props = null;
        virtualizedBoundary.mountLimit = Number.POSITIVE_INFINITY;
    });
    afterEach(async () => {
        standardCleanup();
        projectionGate?.resolve();
        projectionGate = null;
        settingsHttp = null;
        await account.reset();
    });

    it('conceals hidden follow identities without changing the retained follow policy', async () => {
        effectBoundary.sessions = [createExternalSession({ id: 'private-follow', policy: 'background_follow',
            status: 'active', title: 'Private follow project' })];
        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(<ExternalSessionsSettingsView />);
        const { storage } = await import('@/sync/domains/state/storage');
        const { setScreenSharingPrivacyActive } = await import('@/desktop/capture/useNativeRecordingActive');
        try {
            expect(screen.getTextContent()).toContain('Private follow project');
            await act(async () => {
                storage.getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { [account.serverId]: ['private'] } });
                storage.getState().setSessionTagAssignmentsOptimistic(account.serverId, 'private-follow', ['private']);
                setScreenSharingPrivacyActive(true);
            });
            const { readSessionRecordingVisibility } = await import('@/sync/store/sessionRecordingVisibility');
            expect(readSessionRecordingVisibility()({ sessionId: 'private-follow', serverId: account.serverId })).toBe(false);
            expect(readSessionRecordingVisibility()({ sessionId: 'private-follow', serverId: storage.getState().sessions['private-follow']?.serverId })).toBe(false);
            expect(screen.getTextContent()).not.toContain('Private follow project');
            expect(readExternalSessionFollowPolicy(readSessionOwnerMetadataView(storage.getState().sessions['private-follow']!)))
                .toBe('background_follow');
            expect(effectBoundary.followPolicySet).not.toHaveBeenCalled();
            await act(async () => { setScreenSharingPrivacyActive(false); });
            expect(screen.getTextContent()).toContain('Private follow project');
        } finally { setScreenSharingPrivacyActive(false); await screen.unmount(); }
    });

    it('keeps 1k integration and follow inventories as lazy descriptors behind the virtualized window', async () => {
        virtualizedBoundary.mountLimit = 4;
        effectBoundary.machines = [createMachineFixture({
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
        })];
        effectBoundary.sessions = Array.from({ length: 1_000 }, (_, index) => createExternalSession({
            id: `follow-${index}`,
            policy: 'attached_only',
            status: 'disabled',
            title: `Follow ${index}`,
        }));
        const integrations = Array.from({ length: 1_000 }, (_, index) => ({
            key: `integration-${index}`,
            machineId: 'machine-1',
            agent: {
                pluginId: 'com.example.external-agent',
                localId: `assistant-${index}`,
            },
            agentTitle: `Assistant ${index}`,
            state: 'installed_enabled' as const,
            installationId: `installation-${index}`,
        }));

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(
            <ExternalSessionsSettingsView integrations={integrations} />,
        );

        const [{ ItemList }, { VirtualizedList }, { Item }] = await Promise.all([
            import('@/components/ui/lists/ItemList'), import('@/components/ui/lists/virtualized'), import('@/components/ui/lists/Item'),
        ]);
        expect(screen.tree.root.findAllByType(ItemList)).toHaveLength(0);
        expect(screen.tree.root.findAllByType(VirtualizedList)).toHaveLength(1);
        expect(virtualizedBoundary.props?.data.length).toBeGreaterThan(100);
        const supplementalRows = virtualizedBoundary.props?.data.filter(
            (row: { kind?: string }) => row.kind === 'supplemental',
        );
        expect(supplementalRows.length).toBeGreaterThan(80);
        expect(supplementalRows.every((row: Record<string, unknown>) => (
            typeof row.render === 'function' && !React.isValidElement(row.element)
        ))).toBe(true);
        expect(screen.findAllByType(Item).length).toBeLessThanOrEqual(20);

        await screen.unmount();
    });

    it('keeps integration and follow group chrome and dividers continuous across virtualized chunks', async () => {
        effectBoundary.machines = [createMachineFixture({
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
        })];
        effectBoundary.sessions = Array.from({ length: 13 }, (_, index) => createExternalSession({
            id: `follow-${String(index).padStart(2, '0')}`,
            policy: 'attached_only',
            status: 'disabled',
            title: `Follow ${String(index).padStart(2, '0')}`,
        }));
        const integrations = Array.from({ length: 5 }, (_, index) => ({
            key: `integration-${index}`,
            machineId: 'machine-1',
            agent: {
                pluginId: 'com.example.external-agent',
                localId: `assistant-${index}`,
            },
            agentTitle: `Assistant ${index}`,
            state: 'installed_enabled' as const,
            installationId: `installation-${index}`,
        }));

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(
            <ExternalSessionsSettingsView integrations={integrations} />,
        );

        const integrationChunkEnd = screen.findRow(
            'settings-external-sessions-integration-integration-3',
        );
        const integrationContinuation = screen.findRow(
            'settings-external-sessions-integration-integration-4',
        );
        const followChunkEnd = screen.findRow(
            'settings-external-sessions-follow-item-follow-11',
        );
        const followContinuation = screen.findRow(
            'settings-external-sessions-follow-item-follow-12',
        );

        expect(integrationChunkEnd?.props.showDivider).toBe(true);
        expect(followChunkEnd?.props.showDivider).toBe(true);
        // The group's true last row must NOT draw one: `Item` defaults to drawing a
        // divider, so a wrapper that drops the prop looks continuous here while
        // trailing a stray rule under the bottom of the group.
        expect(integrationContinuation?.props.showDivider).toBe(false);
        expect(followContinuation?.props.showDivider).toBe(false);

        const integrationFirstSurface = requireItemGroupSurface(integrationChunkEnd);
        const integrationLastSurface = requireItemGroupSurface(integrationContinuation);
        const followFirstSurface = requireItemGroupSurface(followChunkEnd);
        const followLastSurface = requireItemGroupSurface(followContinuation);

        expect(flattenStyle(integrationFirstSurface.props.style).borderBottomLeftRadius).toBe(0);
        expect(flattenStyle(integrationLastSurface.props.style).borderTopLeftRadius).toBe(0);
        expect(flattenStyle(followFirstSurface.props.style).borderBottomLeftRadius).toBe(0);
        expect(flattenStyle(followLastSurface.props.style).borderTopLeftRadius).toBe(0);
        expect(integrationLastSurface.parent?.children[0]).toBe(integrationLastSurface);
        expect(followLastSurface.parent?.children[0]).toBe(followLastSurface);

        await screen.unmount();
    });

    it('loads the selected machine integration inventory once without an Agent filter', async () => {
        effectBoundary.sessions = [];
        effectBoundary.machines = [createMachineFixture({
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
        })];
        effectBoundary.machineRpc.mockResolvedValue({
            ok: true,
            rows: [{
                agent: {
                    pluginId: 'com.example.removed-agent',
                    localId: 'removed',
                },
                status: {
                    state: 'unavailable',
                    installationId: 'installation-removed',
                },
            }],
            nextCursor: null,
            diagnostics: [],
        });

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(
            <ExternalSessionsSettingsView integrationInventoryEnabled={true} />,
        );
        await flushHookEffects();

        await waitForHomeGovernance(() => expect(screen.findRow(
            'settings-external-sessions-integration-machine-1\u0000com.example.removed-agent\u0000removed\u0000installation:installation-removed',
        )).toBeTruthy());
        await waitForHomeGovernance(() => expect(effectBoundary.machineRpc).toHaveBeenCalledOnce());
        expect(effectBoundary.machineRpc).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: scopeIdOf(account.serverId),
            method: 'daemon.plugins.sessionHooks.status.get',
            payload: {
                machineId: 'machine-1',
                intent: 'passive_inventory',
                limit: 50,
            },
        });

        await screen.unmount();
    });

    it('loads the next integration page only when the continuation enters the virtualized viewport', async () => {
        effectBoundary.sessions = [];
        effectBoundary.machines = [createMachineFixture({
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
        })];
        effectBoundary.machineRpc
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                    agent: {
                        pluginId: 'com.example.external-agent',
                        localId: 'assistant',
                    },
                    status: {
                        state: 'installed_enabled',
                        installationId: 'installation-1',
                    },
                }],
                nextCursor: 'page-2',
                diagnostics: [],
            })
            .mockResolvedValueOnce({
                ok: true,
                rows: [{
                    agent: {
                        pluginId: 'com.example.external-agent',
                        localId: 'assistant',
                    },
                    status: {
                        state: 'installed_enabled',
                        installationId: 'installation-2',
                    },
                }],
                nextCursor: null,
                diagnostics: [],
            });

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(
            <ExternalSessionsSettingsView integrationInventoryEnabled={true} />,
        );
        await flushHookEffects();

        expect(effectBoundary.machineRpc).toHaveBeenCalledOnce();
        const continuation = virtualizedBoundary.props?.data.find(
            (item: { kind?: string }) => item.kind === 'inventory_continuation',
        );
        const initialIntegrationChunkKey = virtualizedBoundary.props?.data.find(
            (item: { kind?: string }) => item.kind === 'integration_chunk',
        )?.key;
        expect(continuation).toBeTruthy();

        await act(async () => {
            virtualizedBoundary.props?.onViewableItemsChanged({
                viewableItems: [{ item: continuation }],
                changed: [],
            });
            await Promise.resolve();
        });

        await waitForHomeGovernance(() => expect(effectBoundary.machineRpc).toHaveBeenCalledTimes(2));
        expect(effectBoundary.machineRpc).toHaveBeenLastCalledWith({
            machineId: 'machine-1',
            serverId: scopeIdOf(account.serverId),
            method: 'daemon.plugins.sessionHooks.status.get',
            payload: {
                machineId: 'machine-1',
                intent: 'passive_inventory',
                cursor: 'page-2',
                limit: 50,
            },
        });
        expect(virtualizedBoundary.props?.data.find(
            (item: { kind?: string }) => item.kind === 'integration_chunk',
        )?.key).toBe(initialIntegrationChunkKey);
        await waitForHomeGovernance(() => expect(screen.findRow(
            'settings-external-sessions-integration-machine-1\u0000com.example.external-agent\u0000assistant\u0000installation:installation-2',
        )).toBeTruthy());
        await screen.unmount();
    });

    it('uses the exact Administration target rather than the legacy context machine for integration RPCs', async () => {
        effectBoundary.sessions = [];
        effectBoundary.machines = [
            createMachineFixture({
                id: 'machine-1',
                active: true,
                activeAt: Date.now(),
            }),
            createMachineFixture({
                id: 'machine-2',
                active: true,
                activeAt: Date.now(),
            }),
        ];
        effectBoundary.contextSelections = {
            v: 1,
            selectionsByKey: {
                externalSessionsSettings: {
                    machineId: 'machine-1',
                    workspacePath: null,
                },
            },
        };
        administrationTargetState.machineId = 'machine-2';
        administrationTargetState.peerHome = true;
        effectBoundary.machineRpc.mockResolvedValue({
            ok: true,
            rows: [],
            nextCursor: null,
            diagnostics: [],
        });

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(
            <ExternalSessionsSettingsView
                integrationInventoryEnabled={true}
            />,
        );
        await flushHookEffects();

        if (!peerServerId) throw new Error('Expected the peer Home fixture');
        const peerScopeId = scopeIdOf(peerServerId);
        await waitForHomeGovernance(() => expect(daemonProjectionRequest).toHaveBeenCalledWith({
            machineId: 'machine-2',
            serverId: peerScopeId,
        }));
        expect(effectBoundary.machineRpc).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-2',
            serverId: peerScopeId,
            payload: expect.objectContaining({
                machineId: 'machine-2',
            }),
        }));
        expect(effectBoundary.machineRpc).not.toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
        }));

        await screen.unmount();
    });

    it('uses the canonical projected Agent title for live global inventory rows', async () => {
        effectBoundary.sessions = [];
        effectBoundary.machines = [createMachineFixture({
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
        })];
        effectBoundary.daemonProjection = {
            phase: 'ready',
            inputs: {
                pluginProjectionV2: PluginProjectionV2Schema.parse({
                    v: 2,
                    generation: 4,
                    agentsById: {
                        'acme-agent': {
                            id: 'acme-agent',
                            title: 'Acme Projected Agent',
                            iconAgentId: 'codex',
                            channel: 'plugin',
                            isBuiltIn: false,
                            externalSessions: {
                                agent: {
                                    pluginId: 'com.example.acme',
                                    localId: 'reviewer',
                                },
                                generation: 4,
                                operations: { listCandidates: true, resolveLinkIdentity: true, pageTranscript: true, readAfterTranscript: true },
                                sources: [{ sourceKind: 'claudeConfig', schema: { fields: [{ name: 'kind', kind: 'literal', value: 'claudeConfig' }] },
                                    key: { segments: [{ kind: 'literal', value: 'claudeConfig' }] }, instances: [{ kind: 'default', constants: {} }] }],
                            },
                        },
                    },
                }),
            },
        };
        effectBoundary.machineRpc.mockResolvedValue({
            ok: true,
            rows: [{
                agent: {
                    pluginId: 'com.example.acme',
                    localId: 'reviewer',
                },
                status: {
                    state: 'installed_enabled',
                    installationId: 'installation-acme',
                },
            }],
            nextCursor: null,
            diagnostics: [],
        });

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(
            <ExternalSessionsSettingsView integrationInventoryEnabled={true} />,
        );
        await flushHookEffects();

        await waitForHomeGovernance(() => expect(screen.findRow(
            'settings-external-sessions-integration-machine-1\u0000com.example.acme\u0000reviewer\u0000installation:installation-acme',
        )?.props.title).toBe('Acme Projected Agent · externalSessions.settingsIntegrationTitle'));

        await screen.unmount();
    });

    it('projects persisted policies without an Agent filter and removes only the selected source offline', async () => {
        const selectedPolicy = {
            machineId: 'machine-1',
            qualifiedIdentity: {
                v: 1 as const,
                agent: {
                    pluginId: 'com.example.unknown-agent',
                    localId: 'reviewer',
                },
                source: {
                    kind: 'claudeConfig',
                    contractVersion: 1 as const,
                },
            },
            sourcePolicyId: `es-source-policy:v1:${'a'.repeat(64)}`,
            enabledAtMs: 1_000,
        };
        const otherMachinePolicy = {
            ...selectedPolicy,
            machineId: 'machine-2',
            sourcePolicyId: `es-source-policy:v1:${'b'.repeat(64)}`,
        };
        effectBoundary.sessions = [];
        effectBoundary.machines = [createMachineFixture({
            id: 'machine-1',
            active: false,
            activeAt: Date.now() - (10 * 60_000),
        })];
        effectBoundary.settings = {
            v: 1,
            keepPassivelyFollowingAfterRestart: false,
            autoLinkSourcePolicies: [selectedPolicy, otherMachinePolicy],
        };
        effectBoundary.accountSettings = {
            externalSessionsSettingsV1: effectBoundary.settings,
        };

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(<ExternalSessionsSettingsView />);
        const rows = screen.findAllByType(Item).filter(
            (row) => row.props.testID === 'settings-external-sessions-auto-link-source',
        );

        expect(rows).toHaveLength(1);
        expect(rows[0]?.props.title)
            .toBe('externalSessions.settingsAgentAutoLinkTitle');

        effectBoundary.accountSettings = {
            externalSessionsSettingsV1: {
                v: 1,
                keepPassivelyFollowingAfterRestart: true,
                autoLinkSourcePolicies: [selectedPolicy, otherMachinePolicy],
                futureNested: { revision: 2 },
            },
            futureRoot: { revision: 3 },
        };

        await act(async () => {
            await rows[0]?.props.onPress?.();
        });

        expect(settingsPosts).toHaveBeenCalledTimes(1);
        expect(effectBoundary.accountSettings).toEqual({
            externalSessionsSettingsV1: {
                v: 1,
                keepPassivelyFollowingAfterRestart: true,
                autoLinkSourcePolicies: [otherMachinePolicy],
                futureNested: { revision: 2 },
            },
            futureRoot: { revision: 3 },
        });

        await screen.unmount();
    });

    it('renders durable read-only guidance without acquiring follow or mutating Agent configuration', async () => {
        effectBoundary.sessions = [
            createExternalSession({
                id: 'passive',
                policy: 'background_follow',
                status: 'active',
                reason: 'background_follow',
                title: 'Passive follow',
            }),
        ];
        effectBoundary.settings = {
            v: 1,
            keepPassivelyFollowingAfterRestart: false,
        };
        effectBoundary.followPolicySet.mockReset();
        effectBoundary.machineRpc.mockReset();
        settingsPosts.mockClear();

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(<ExternalSessionsSettingsView />);

        const guidanceRow = screen.findRowByTitle('externalSessions.settingsPassiveTitle');
        expect(guidanceRow).toBeTruthy();
        expect(guidanceRow?.props.mode).toBe('info');
        expect(guidanceRow?.props.onPress).toBeUndefined();
        expect(guidanceRow?.props.rightElement).toBeUndefined();

        await screen.update(<ExternalSessionsSettingsView key="reconnect" />);

        expect(screen.findRowByTitle('externalSessions.settingsPassiveTitle')).toBeTruthy();
        expect(effectBoundary.followPolicySet).not.toHaveBeenCalled();
        expect(effectBoundary.machineRpc).not.toHaveBeenCalled();
        expect(readExternalSessionFollowPolicy(await currentMetadata('passive'))).toBe('background_follow');
        expect(settingsPosts).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('honors Settings Action Off before changing restart-follow policy', async () => {
        effectBoundary.accountSettings = { actionsSettingsV1: { v: 1,
            actions: { 'settings.set': { enabled: false } } } };
        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(<ExternalSessionsSettingsView />);
        const row = screen.findRow('settings-external-sessions-restore-item');
        expect(row).not.toBeNull();
        // Await the owner callback itself: the painted press adapter does not retain its Promise.
        await act(async () => { await row?.props.onPress(); });
        expect(settingsPosts).not.toHaveBeenCalled();
        expect(modalMock.spies.alert).toHaveBeenCalledWith(
            'actionConfirmations.turnedOffTitle', 'actionConfirmations.turnedOffMessage', expect.any(Array));
        expect(effectBoundary.accountSettings.externalSessionsSettingsV1)
            .toMatchObject({ keepPassivelyFollowingAfterRestart: false });
        await screen.unmount();
    });

    it('patches the latest account-settings CAS winner after the explicit accessible toggle', async () => {
        effectBoundary.sessions = [];
        effectBoundary.settings = {
            v: 1,
            keepPassivelyFollowingAfterRestart: false,
        };
        effectBoundary.accountSettings = {
            externalSessionsSettingsV1: effectBoundary.settings,
            futureRoot: { revision: 3 },
        };

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(<ExternalSessionsSettingsView />);

        const restoreRow = screen.findRow('settings-external-sessions-restore-item');
        const toggle = restoreRow?.props.rightElement as
            | React.ReactElement<{
                value: boolean;
                accessibilityLabel: string;
            }>
            | undefined;
        expect(toggle).toBeTruthy();
        expect(toggle?.props.value).toBe(false);
        expect(toggle?.props.accessibilityLabel).toBe('externalSessions.settingsRestoreTitle');
        expect(screen.findRowByTitle('externalSessions.settingsNotificationsTitle')?.props.subtitle)
            .toBe('externalSessions.settingsNotificationsInactiveSubtitle');

        const concurrentPolicy = {
            machineId: 'machine-1',
            qualifiedIdentity: {
                v: 1 as const,
                agent: {
                    pluginId: 'com.example.external-agent',
                    localId: 'assistant',
                },
                source: {
                    kind: 'claudeConfig',
                    contractVersion: 1 as const,
                },
            },
            sourcePolicyId: `es-source-policy:v1:${'a'.repeat(64)}`,
            enabledAtMs: 1_000,
        };
        effectBoundary.accountSettings = {
            externalSessionsSettingsV1: {
                v: 1,
                keepPassivelyFollowingAfterRestart: false,
                autoLinkSourcePolicies: [concurrentPolicy],
                futureNested: { revision: 2 },
            },
            futureRoot: { revision: 3 },
        };

        await act(async () => { await screen.findRow('settings-external-sessions-restore-item')?.props.onPress(); });

        expect(settingsPosts).toHaveBeenCalledTimes(1);
        expect(effectBoundary.accountSettings).toEqual({
            externalSessionsSettingsV1: {
                v: 1,
                keepPassivelyFollowingAfterRestart: true,
                autoLinkSourcePolicies: [concurrentPolicy],
                futureNested: { revision: 2 },
            },
            futureRoot: { revision: 3 },
        });

        await screen.unmount();
    });

    it.each([
        { latest: false, rejectLatest: false },
        { latest: true, rejectLatest: false },
        { latest: false, rejectLatest: true },
    ])('keeps latest restart-follow interactive and skips identical followups ($latest, reject=$rejectLatest)', async ({ latest, rejectLatest }) => {
        effectBoundary.sessions = [];
        const firstMutation = createDeferred<void>();
        settingsWriteGate = firstMutation.promise;
        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(<ExternalSessionsSettingsView />);
        const toggle = () => screen.findRow('settings-external-sessions-restore-item')?.props.rightElement as
            React.ReactElement<{ value: boolean; disabled?: boolean; onValueChange: (enabled: boolean) => void }>;
        await act(async () => { toggle().props.onValueChange(true); });
        await waitForHomeGovernance(() => expect(settingsPosts).toHaveBeenCalledTimes(1));
        await act(async () => {
            for (const enabled of [false, true, latest, latest]) toggle().props.onValueChange(enabled);
        });
        expect(toggle().props.disabled).not.toBe(true);
        expect(toggle().props.value).toBe(latest);
        await act(async () => { settingsWriteGate = null; rejectSettingsWrite = rejectLatest; firstMutation.resolve(); });
        await waitForHomeGovernance(() => {
            expect(screen.findRow('settings-external-sessions-restore-item')?.props.loading).not.toBe(true);
            expect(settingsPosts).toHaveBeenCalledTimes(latest ? 1 : 2);
        });
        const confirmed = rejectLatest ? true : latest;
        await waitForHomeGovernance(() => expect(toggle().props.value).toBe(confirmed));
        expect(effectBoundary.accountSettings.externalSessionsSettingsV1).toMatchObject({ keepPassivelyFollowingAfterRestart: confirmed });
        if (rejectLatest) expect(modalMock.spies.alertAsync).toHaveBeenCalledExactlyOnceWith('common.error', 'externalSessions.settingsRestoreUpdateFailed');
        await flushHookEffects();
        expect(settingsPosts).toHaveBeenCalledTimes(latest ? 1 : 2);
        await screen.unmount();
    });

    it('does not join a retired Account restart-follow write when the mounted Account changes', async () => {
        const first = createDeferred<void>();
        settingsWriteGate = first.promise;
        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(<ExternalSessionsSettingsView />);
        const toggle = () => screen.findRow('settings-external-sessions-restore-item')?.props.rightElement as
            React.ReactElement<{ value: boolean; onValueChange: (enabled: boolean) => void }>;
        try {
            await act(async () => { toggle().props.onValueChange(true); });
            await waitForHomeGovernance(() => expect(settingsPosts).toHaveBeenCalledTimes(1));
            const nextSettings = { externalSessionsSettingsV1: { v: 1, keepPassivelyFollowingAfterRestart: false } };
            await act(async () => { await account.restore({ accountId: 'account-next', serverIdentityId: 'srv_external_settings',
                machines: effectBoundary.machines, settings: nextSettings }); });
            installSettingsBoundary('account-next', nextSettings);
            expect(toggle().props.value).toBe(false);
            settingsWriteGate = null;
            await act(async () => { toggle().props.onValueChange(true); });
            await waitForHomeGovernance(() => expect(settingsPosts).toHaveBeenCalledTimes(2));
            first.resolve();
            await flushHookEffects();
            expect(toggle().props.value).toBe(true);
            expect(effectBoundary.accountSettings.externalSessionsSettingsV1).toMatchObject({ keepPassivelyFollowingAfterRestart: true });
            expect(modalMock.spies.alertAsync).not.toHaveBeenCalled();
        } finally { first.resolve(); await screen.unmount(); }
    });

    it('coalesces identical restore intents and recovers after a rejected account mutation', async () => {
        effectBoundary.sessions = [];
        effectBoundary.settings = {
            v: 1,
            keepPassivelyFollowingAfterRestart: false,
        };
        const firstMutation = createDeferred<void>();
        settingsWriteGate = firstMutation.promise;
        rejectSettingsWrite = true;
        modalMock.spies.alertAsync.mockClear();

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(<ExternalSessionsSettingsView />);
        const restoreRow = screen.findRow('settings-external-sessions-restore-item');
        const restoreToggle = restoreRow?.props.rightElement as
            | React.ReactElement<{
                disabled?: boolean;
                onValueChange?: (enabled: boolean) => void;
            }>
            | undefined;

        await act(async () => {
            restoreRow?.props.onPress?.();
            restoreToggle?.props.onValueChange?.(true);
            await Promise.resolve();
        });

        await waitForHomeGovernance(() => expect(settingsPosts).toHaveBeenCalledTimes(1));
        expect(screen.findRow('settings-external-sessions-restore-item')?.props.loading).not.toBe(true);
        expect(screen.findRow('settings-external-sessions-restore-item')?.props.disabled).not.toBe(true);
        const pendingToggle = screen.findRow('settings-external-sessions-restore-item')
            ?.props.rightElement as React.ReactElement<{ disabled?: boolean }> | undefined;
        expect(pendingToggle?.props.disabled).not.toBe(true);

        await act(async () => {
            settingsWriteGate = null;
            firstMutation.resolve();
            await Promise.resolve();
        });

        await waitForHomeGovernance(() => expect(modalMock.spies.alertAsync).toHaveBeenCalledWith(
            'common.error',
            'externalSessions.settingsRestoreUpdateFailed',
        ));
        expect(screen.findRow('settings-external-sessions-restore-item')?.props.disabled).not.toBe(true);
        const recoveredToggle = screen.findRow('settings-external-sessions-restore-item')
            ?.props.rightElement as React.ReactElement<{ disabled?: boolean; value: boolean }> | undefined;
        expect(recoveredToggle?.props.disabled).not.toBe(true);
        await waitForHomeGovernance(() => expect((screen.findRow('settings-external-sessions-restore-item')
            ?.props.rightElement as React.ReactElement<{ value: boolean }>).props.value).toBe(false));

        await act(async () => {
            screen.findRow('settings-external-sessions-restore-item')?.props.onPress?.();
            await Promise.resolve();
        });
        await waitForHomeGovernance(() => expect(settingsPosts).toHaveBeenCalledTimes(2));

        await screen.unmount();
    });

    it('hides the follow control when the current projection no longer declares the linked source', async () => {
        effectBoundary.sessions = [createExternalSession({
            id: 'undeclared-source',
            policy: 'attached_only',
            status: 'disabled',
            title: 'Undeclared linked source',
        })];
        effectBoundary.daemonProjection = {
            phase: 'ready',
            inputs: {
                // The Agent is projected, but it no longer declares the
                // `claudeConfig` source this session is linked to.
                pluginProjectionV2: createFollowCapabilityProjection({
                    sourceKind: 'claudeArchive',
                }),
            },
        };

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(<ExternalSessionsSettingsView />);

        const row = screen.findRow('settings-external-sessions-follow-item-undeclared-source');
        expect(row).toBeTruthy();
        expect(row?.props.rightElement).toBeUndefined();
        expect(row?.props.onPress).toBeUndefined();
        expect(row?.props.subtitle).toBe('externalSessions.followStatusUnsupported');

        await screen.unmount();
    });

    it('offers background follow for a declared linked source that carries no terminal-follow opt-in', async () => {
        effectBoundary.sessions = [createExternalSession({
            id: 'observation-follow',
            policy: 'attached_only',
            status: 'disabled',
            title: 'Observation-backed follow',
        })];

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(<ExternalSessionsSettingsView />);

        const row = screen.findRow('settings-external-sessions-follow-item-observation-follow');
        expect(row).toBeTruthy();
        expect(row?.props.mode).not.toBe('info');
        expect(row?.props.rightElement).toBeTruthy();
        expect(row?.props.onPress).toBeTruthy();
        expect(row?.props.subtitle).toBe('externalSessions.followStatusDisabled');

        await screen.unmount();
    });

    it('renders every linked session with its canonical follow status and scopes notifications to explicit background policies', async () => {
        effectBoundary.sessions = [
            createExternalSession({
                // Not `active`: `/v2/sessions/active` is the active-Session listing route, never this Session's detail.
                id: 'active-follow',
                policy: 'background_follow',
                status: 'active',
                reason: 'background_follow',
                title: 'Actively followed',
            }),
            createExternalSession({
                id: 'paused',
                policy: 'attached_only',
                status: 'paused',
                reason: 'archived',
                title: 'Paused follow',
            }),
            createExternalSession({
                id: 'unknown',
                policy: 'attached_only',
                title: 'Unknown follow',
            }),
            createExternalSession({
                id: 'disabled',
                policy: 'attached_only',
                status: 'disabled',
                title: 'Disabled follow',
            }),
            createExternalSession({
                id: 'reacquiring',
                policy: 'attached_only',
                status: 'reacquiring',
                title: 'Reacquiring follow',
            }),
            createExternalSession({
                id: 'error',
                policy: 'attached_only',
                status: 'error',
                title: 'Errored follow',
            }),
            {
                ...createExternalSession({
                    id: 'hosted',
                    policy: 'attached_only',
                    title: 'Hosted',
                }),
                metadata: {
                    path: '/tmp/project',
                    host: 'machine-1',
                    summary: { text: 'Hosted', updatedAt: 2 },
                },
            },
        ];

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(<ExternalSessionsSettingsView />);

        expect(screen.findRow('settings-external-sessions-follow-item-active-follow')).toBeTruthy();
        expect(screen.findRow('settings-external-sessions-follow-item-paused')).toBeTruthy();
        expect(screen.findRow('settings-external-sessions-follow-item-unknown')).toBeTruthy();
        expect(screen.findRow('settings-external-sessions-follow-item-disabled')).toBeTruthy();
        expect(screen.findRow('settings-external-sessions-follow-item-reacquiring')).toBeTruthy();
        expect(screen.findRow('settings-external-sessions-follow-item-error')).toBeTruthy();
        expect(screen.findRowByTitle('Actively followed')?.props.subtitle).toBe('externalSessions.followStatusActive');
        expect(screen.findRowByTitle('Paused follow')?.props.subtitle).toBe('externalSessions.followStatusPaused');
        expect(screen.findRowByTitle('Unknown follow')?.props.subtitle).toBe('externalSessions.followStatusUnknown');
        expect(screen.findRowByTitle('Disabled follow')?.props.subtitle).toBe('externalSessions.followStatusDisabled');
        expect(screen.findRowByTitle('Reacquiring follow')?.props.subtitle).toBe('externalSessions.followStatusReacquiring');
        expect(screen.findRowByTitle('Errored follow')?.props.subtitle).toBe('externalSessions.followStatusError');
        expect(screen.findRowByTitle('Hosted')).toBeNull();
        expect(screen.findRowByTitle('externalSessions.settingsNotificationsTitle')?.props.subtitle)
            .toBe('externalSessions.settingsNotificationsActiveSubtitle');

        const activeToggle = screen.findRow('settings-external-sessions-follow-item-active-follow')
            ?.props.rightElement as React.ReactElement<Record<string, unknown>> | undefined;
        const pausedToggle = screen.findRow('settings-external-sessions-follow-item-paused')
            ?.props.rightElement as React.ReactElement<Record<string, unknown>> | undefined;
        expect(activeToggle?.props.value).toBe(true);
        expect(pausedToggle?.props.value).toBe(false);
        expect(activeToggle?.props.accessibilityLabel).toBe('Actively followed');
        expect(pausedToggle?.props.accessibilityLabel).toBe('Paused follow');
        expect(activeToggle?.props.accessibilityHint)
            .toBe('externalSessions.settingsFollowToggleHint');

        await screen.unmount();
    });

    it('renders known-offline and typed unsupported follows truthfully without hidden work', async () => {
        effectBoundary.machines = [
            createMachineFixture({
                id: 'machine-1',
                active: false,
                activeAt: Date.now() - (10 * 60_000),
            }),
            createMachineFixture({
                id: 'machine-2',
                active: true,
                activeAt: Date.now(),
            }),
        ];
        effectBoundary.sessions = [
            createExternalSession({
                id: 'offline',
                policy: 'attached_only',
                status: 'disabled',
                title: 'Offline follow',
            }),
            createExternalSession({
                id: 'unsupported',
                policy: 'attached_only',
                status: 'disabled',
                machineId: 'machine-2',
                title: 'Unsupported follow',
            }),
        ];
        effectBoundary.followPolicySet.mockReset();
        effectBoundary.followPolicySet.mockResolvedValue({
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'background_follow_not_supported',
        });

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(<ExternalSessionsSettingsView />);

        const offlineRow = screen.findRow('settings-external-sessions-follow-item-offline');
        expect(offlineRow?.props.subtitle).toBe('externalSessions.followStatusMachineOffline');
        expect(offlineRow?.props.disabled).toBe(true);

        await act(async () => {
            await offlineRow?.props.onPress?.();
        });
        expect(effectBoundary.followPolicySet).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('settings-external-sessions-follow-item-unsupported');

        await waitForHomeGovernance(() => expect(screen.findRow('settings-external-sessions-follow-item-unsupported')?.props.subtitle)
            .toBe('externalSessions.followStatusUnsupported'));
        const unsupportedRow = screen.findRow('settings-external-sessions-follow-item-unsupported');
        expect(effectBoundary.followPolicySet).toHaveBeenCalledTimes(1);
        expect(unsupportedRow?.props.subtitle).toBe('externalSessions.followStatusUnsupported');
        expect(unsupportedRow?.props.disabled).toBe(true);
        expect(readExternalSessionFollowPolicy(await currentMetadata('unsupported'))).toBe('attached_only');

        await screen.unmount();
    });

    it('keeps withdrawn follow machines unknown and disabled while freshly observed offline machines stay offline', async () => {
        effectBoundary.machines = [createMachineFixture({ id: 'machine-1', activeAt: Date.now() }),
            createMachineFixture({ id: 'machine-2', active: false, activeAt: 0 })];
        effectBoundary.sessions = [createExternalSession({ id: 'unknown', title: 'Waiting follow', policy: 'attached_only', status: 'disabled' }),
            createExternalSession({ id: 'offline', title: 'Sleeping follow', machineId: 'machine-2', policy: 'attached_only', status: 'disabled' })];
        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(<ExternalSessionsSettingsView />);
        const { withdrawMachinePresenceForScope, captureMachinePresenceObservation, clearMachineRequestReachabilityForTest } = await import('@/sync/domains/machines/reachability/machineReachability');
        const scope = { serverId: scopeIdOf(account.serverId), accountId: 'account-1' };
        try {
            await act(async () => { withdrawMachinePresenceForScope(scope); captureMachinePresenceObservation(scope)(['machine-2']); });
            await flushHookEffects({ cycles: 2, turns: 2 });
            expect(screen.findRow('settings-external-sessions-follow-item-unknown')?.props.subtitle).toBe('externalSessions.followStatusUnknown');
            expect(screen.findRow('settings-external-sessions-follow-item-unknown')?.props.disabled).toBe(true);
            expect(screen.findRow('settings-external-sessions-follow-item-offline')?.props.subtitle).toBe('externalSessions.followStatusMachineOffline');
            await act(async () => captureMachinePresenceObservation(scope)(['machine-1']));
            await flushHookEffects({ cycles: 2, turns: 2 });
            expect(screen.findRow('settings-external-sessions-follow-item-unknown')?.props.disabled).toBe(false);
        } finally { clearMachineRequestReachabilityForTest(); }
    });

    it('keeps the stored follow status but fails mutation closed while capability projection is still loading', async () => {
        effectBoundary.machines = [createMachineFixture({
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
        })];
        effectBoundary.sessions = [createExternalSession({
            id: 'loading-projection',
            policy: 'attached_only',
            status: 'paused',
            title: 'Loading projection follow',
        })];
        effectBoundary.daemonProjection = {
            phase: 'loading',
            inputs: null,
        };

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(<ExternalSessionsSettingsView />);

        const row = screen.findRow(
            'settings-external-sessions-follow-item-loading-projection',
        );
        // The stored policy/status stay visible as last-known information, but
        // the mutation is disabled and the row truthfully shows its in-flight
        // capability state instead of an enabled-looking control.
        expect(row?.props.subtitle).toBe('externalSessions.followStatusPaused');
        expect(row?.props.rightElement).toBeTruthy();
        expect(row?.props.mode).not.toBe('info');
        expect(row?.props.loading).toBe(true);
        expect(row?.props.disabled).toBe(true);
        const toggle = row?.props.rightElement as React.ReactElement<Record<string, unknown>> | undefined;
        expect(toggle?.props.disabled).toBe(true);
        expect(effectBoundary.followPolicySet).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('reports a failed capability projection as unverifiable and keeps the follow mutation closed', async () => {
        effectBoundary.machines = [createMachineFixture({
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
        })];
        effectBoundary.sessions = [createExternalSession({
            id: 'errored-projection',
            policy: 'attached_only',
            status: 'paused',
            title: 'Errored projection follow',
        })];
        effectBoundary.daemonProjection = {
            phase: 'error' as 'ready' | 'loading' | 'error',
            inputs: null,
        };

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(<ExternalSessionsSettingsView />);

        await waitForHomeGovernance(() => expect(screen.findRow('settings-external-sessions-follow-item-errored-projection')?.props.subtitle)
            .toBe('externalSessions.followStatusUnknown'));
        const row = screen.findRow(
            'settings-external-sessions-follow-item-errored-projection',
        );
        expect(row?.props.subtitle).toBe('externalSessions.followStatusUnknown');
        expect(row?.props.rightElement).toBeTruthy();
        expect(row?.props.mode).not.toBe('info');
        expect(row?.props.disabled).toBe(true);
        const toggle = row?.props.rightElement as React.ReactElement<Record<string, unknown>> | undefined;
        expect(toggle?.props.disabled).toBe(true);
        expect(effectBoundary.followPolicySet).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('retires a late follow settlement when the active Account is no longer current', async () => {
        effectBoundary.machines = [createMachineFixture({
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
        })];
        effectBoundary.sessions = [createExternalSession({
            id: 'selected',
            policy: 'attached_only',
            status: 'disabled',
            title: 'Selected follow',
        })];
        effectBoundary.followPolicySet.mockReset();
        let resolveFollowPolicySet: ((value: {
            ok: true;
            enabled: true;
            leaseActive: true;
            updatedAtMs: number;
        }) => void) | undefined;
        effectBoundary.followPolicySet.mockReturnValue(new Promise((resolve) => {
            resolveFollowPolicySet = resolve;
        }));

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(<ExternalSessionsSettingsView />);
        const row = screen.findRow('settings-external-sessions-follow-item-selected');

        let press: Promise<void> | undefined;
        await act(async () => {
            press = row?.props.onPress();
            await Promise.resolve();
        });
        // Account A retires while the machine RPC is in flight; its late
        // settlement must not alert or publish into the successor Account.
        await waitForHomeGovernance(() => expect(effectBoundary.followPolicySet).toHaveBeenCalledOnce());
        await account.restore({ accountId: 'account-next', serverIdentityId: 'srv_external_settings', machines: effectBoundary.machines });
        // A successor with the same Session id makes a missing retirement
        // fence observable: the old result must not patch this new owner.
        await publishSessionFixtures([createExternalSession({ id: 'selected', policy: 'attached_only',
            status: 'disabled', title: 'Successor Account session' })]);
        const successorMetadata = await currentMetadata('selected');
        await act(async () => {
            resolveFollowPolicySet?.({ ok: true, enabled: true, leaseActive: true, updatedAtMs: 42 });
            await press;
        });

        expect(await currentMetadata('selected')).toEqual(successorMetadata);
        expect(readExternalSessionFollowPolicy(await currentMetadata('selected'))).toBe('attached_only');
        expect(modalMock.spies.alert).not.toHaveBeenCalled();
        expect(modalMock.spies.alertAsync).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('starts or stops only the explicitly selected session through the canonical machine operation', async () => {
        effectBoundary.sessions = [
            createExternalSession({
                id: 'selected',
                policy: 'attached_only',
                status: 'disabled',
                title: 'Selected follow',
            }),
            createExternalSession({
                id: 'untouched',
                policy: 'attached_only',
                status: 'disabled',
                title: 'Untouched follow',
            }),
        ];
        effectBoundary.followPolicySet.mockReset();
        effectBoundary.followPolicySet.mockResolvedValue({
            ok: true,
            enabled: true,
            leaseActive: true,
            updatedAtMs: 42,
        });

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        let screen = await renderSettingsView(<ExternalSessionsSettingsView />);

        await screen.pressByTestIdAsync('settings-external-sessions-follow-item-selected');

        await waitForHomeGovernance(async () => expect(readExternalSessionFollowPolicy(await currentMetadata('selected'))).toBe('background_follow'));
        expect(effectBoundary.followPolicySet).toHaveBeenCalledTimes(1);
        expect(effectBoundary.followPolicySet).toHaveBeenCalledWith({
            machineId: 'machine-1',
            sessionId: 'selected',
            agentId: 'claude',
            remoteSessionId: 'remote-selected',
            source: {
                kind: 'claudeConfig',
                configDir: '/tmp/claude',
            },
            enabled: true,
        }, {
            serverId: scopeIdOf(account.serverId),
        });
        const updated = await currentMetadata('selected');
        expect(readExternalSessionLink(updated)?.followPolicyV1).toEqual({
            v: 1,
            policy: 'background_follow',
            updatedAtMs: 42,
        });
        expect(readExternalSessionFollowPolicy(await currentMetadata('untouched')))
            .toBe('attached_only');

        await screen.unmount();

        effectBoundary.sessions = [
            createExternalSession({
                id: 'selected',
                policy: 'background_follow',
                status: 'active',
                title: 'Selected follow',
            }),
        ];
        effectBoundary.followPolicySet.mockReset();
        effectBoundary.followPolicySet.mockResolvedValue({
            ok: true,
            enabled: false,
            leaseActive: false,
            updatedAtMs: 84,
        });

        screen = await renderSettingsView(<ExternalSessionsSettingsView />);
        await screen.pressByTestIdAsync('settings-external-sessions-follow-item-selected');

        await waitForHomeGovernance(async () => expect(readExternalSessionFollowPolicy(await currentMetadata('selected'))).toBe('attached_only'));
        expect(effectBoundary.followPolicySet).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 'selected',
                enabled: false,
            }),
            { serverId: scopeIdOf(account.serverId) },
        );
        const disabled = await currentMetadata('selected');
        expect(readExternalSessionLink(disabled)?.followPolicyV1).toEqual({
            v: 1,
            policy: 'attached_only',
            updatedAtMs: 84,
        });

        await screen.unmount();
    });

    it.each([false, true])('keeps latest per-session follow interactive and reverts to confirmed on failure (reject=%s)', async reject => {
        effectBoundary.sessions = [createExternalSession({ id: 'selected', policy: 'attached_only', status: 'disabled' })];
        const first = createDeferred<unknown>();
        effectBoundary.followPolicySet.mockReset();
        effectBoundary.followPolicySet.mockReturnValueOnce(first.promise);
        if (reject) effectBoundary.followPolicySet.mockRejectedValue(new Error('fixture follow write failed'));
        else effectBoundary.followPolicySet.mockResolvedValue({ ok: true, enabled: false, leaseActive: false, updatedAtMs: 84 });
        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(<ExternalSessionsSettingsView />);
        const toggle = () => screen.findRow('settings-external-sessions-follow-item-selected')?.props.rightElement as
            React.ReactElement<{ value: boolean; disabled?: boolean; onValueChange: (enabled: boolean) => void }>;
        await act(async () => { toggle().props.onValueChange(true); });
        await waitForHomeGovernance(() => expect(effectBoundary.followPolicySet).toHaveBeenCalledTimes(1));
        expect(toggle().props.value).toBe(true);
        await act(async () => { toggle().props.onValueChange(false); });
        expect(toggle().props.disabled).not.toBe(true);
        expect(toggle().props.value).toBe(false);
        await act(async () => { first.resolve({ ok: true, enabled: true, leaseActive: true, updatedAtMs: 42 }); });
        await waitForHomeGovernance(async () => {
            expect(effectBoundary.followPolicySet).toHaveBeenCalledTimes(2);
            expect(readExternalSessionFollowPolicy(await currentMetadata('selected'))).toBe(reject ? 'background_follow' : 'attached_only');
            expect(toggle().props.value).toBe(reject);
        });
        if (reject) expect(modalMock.spies.alert).toHaveBeenCalledExactlyOnceWith('common.error', 'externalSessions.followUpdateFailed');
        await screen.unmount();
    });

    it('coalesces repeated presses while one session follow mutation is in flight', async () => {
        effectBoundary.sessions = [
            createExternalSession({
                id: 'selected',
                policy: 'attached_only',
                status: 'disabled',
                title: 'Selected follow',
            }),
        ];
        effectBoundary.followPolicySet.mockReset();
        let resolveFollowPolicySet: ((value: {
            ok: true;
            enabled: true;
            leaseActive: true;
            updatedAtMs: number;
        }) => void) | undefined;
        const pendingResult = new Promise<{
            ok: true;
            enabled: true;
            leaseActive: true;
            updatedAtMs: number;
        }>((resolve) => {
            resolveFollowPolicySet = resolve;
        });
        effectBoundary.followPolicySet.mockReturnValue(pendingResult);

        const { ExternalSessionsSettingsView } = await import('./ExternalSessionsSettingsView');
        const screen = await renderSettingsView(<ExternalSessionsSettingsView />);
        const row = screen.findRow('settings-external-sessions-follow-item-selected');
        expect(row).toBeTruthy();

        let firstPress: Promise<void> | undefined;
        let secondPress: Promise<void> | undefined;
        await act(async () => {
            firstPress = row?.props.onPress();
            secondPress = row?.props.onPress();
            await Promise.resolve();
        });

        await waitForHomeGovernance(() => expect(effectBoundary.followPolicySet).toHaveBeenCalledTimes(1));

        await act(async () => {
            resolveFollowPolicySet?.({
                ok: true,
                enabled: true,
                leaseActive: true,
                updatedAtMs: 42,
            });
            await Promise.all([firstPress, secondPress]);
        });

        await waitForHomeGovernance(async () => expect(readExternalSessionLink(await currentMetadata('selected'))?.followPolicyV1)
            .toEqual({ v: 1, policy: 'background_follow', updatedAtMs: 42 }));
        await screen.unmount();
    });
});
