import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { DEFAULT_MEMORY_SETTINGS } from '@happier-dev/protocol/memory/memorySettings';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { SelectionListProps } from '@/components/ui/selectionList';
import type { SessionOrganizationProjection } from '@/sync/domains/session/organization/types';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';

const harness = vi.hoisted(() => ({
    selectionListProps: null as SelectionListProps | null,
    navigateToSession: vi.fn(),
    searchHomeMemory: vi.fn(),
    machineRpc: vi.fn(),
    routerPush: vi.fn(),
    memoryMachine: null as null | { serverId: string; machine: { id: string } },
    modalAlert: vi.fn(),
    featureEnabled: { search: true, 'memory.search': false } as Record<string, boolean>,
    fetchAllSessionMetadata: vi.fn(async () => {}),
    ensureSessionMetadataInventoryForServerAccountScope: vi.fn(async (_params: Readonly<{
        scope: { serverId: string; accountId: string };
        accountLifetime: {
            isCurrent(): boolean;
            onRetire(cancel: () => void): { dispose(): void };
        };
        signal?: AbortSignal;
    }>) => {}),
    sessionListRows: [] as Array<{
        serverId: string | null;
        serverName: string | null;
        session: {
            id: string;
            updatedAt: number;
            archivedAt?: number | null;
            metadata: { name: string; path?: string };
        };
    }>,
    homeCredentialMutationListeners: new Set<(event: { kind: 'credentials_set' | 'credentials_removed'; serverId: string; serverUrl: string }) => void>(),
    portableIdentity: false,
    singleHome: false,
    settingsCatalog: { tree: [], search: () => [] } as { tree: readonly unknown[]; search: (query: string) => readonly unknown[] },
    sessionOrganizationProjection: null as SessionOrganizationProjection | null,
    appShellPluginProjection: null as PluginUiProjectionModel | null,
    scopedPluginProjections: new Map<string, PluginUiProjectionModel>(),
    scopedPluginProjectionCalls: [] as Array<Readonly<{
        machineId?: string | null;
        serverId?: string | null;
        enabled?: boolean;
    }>>,
    activeAccountLifetime: null as null | {
        scope: { serverId: string; accountId: string };
        isCurrent(): boolean;
        onRetire(): { dispose(): void };
    },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});

vi.mock('@/modal', () => ({ Modal: { alert: harness.modalAlert } }));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: harness.routerPush } }).module;
});

vi.mock('@/components/ui/selectionList', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/ui/selectionList')>();
    return {
        ...actual,
        SelectionList: (props: SelectionListProps) => {
            harness.selectionListProps = props;
            return React.createElement('SelectionList');
        },
    };
});

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => harness.navigateToSession,
}));

vi.mock('@/components/projects/useOpenProject', () => ({ useOpenProject: () => vi.fn(() => true) }));
vi.mock('@/components/settings/catalog/runtime/useResolvedSettingsPageCatalog', () => ({
    useResolvedSettingsPageCatalog: () => harness.settingsCatalog,
}));
vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useAppShellPluginUiProjection: () => ({
        pluginUiProjection: harness.appShellPluginProjection,
        serverId: harness.appShellPluginProjection ? 'home-a' : null,
        machineId: harness.appShellPluginProjection ? 'machine-a' : null,
        interactionEnabled: harness.appShellPluginProjection !== null,
    }),
}));
vi.mock('@/components/plugins/projection/useScopedPluginUiProjection', () => ({
    useScopedPluginUiProjection: (params: Readonly<{
        machineId?: string | null;
        serverId?: string | null;
        enabled?: boolean;
    }>) => {
        harness.scopedPluginProjectionCalls.push(params);
        const projection = params.enabled === false
            ? null
            : harness.scopedPluginProjections.get(`${params.serverId ?? ''}:${params.machineId ?? ''}`) ?? null;
        return {
            pluginUiProjection: projection,
            pluginBrowserProjection: null,
            phase: projection ? 'current' : 'unavailable',
            interactionEnabled: projection !== null,
            serverId: params.serverId ?? null,
            machineId: params.machineId ?? null,
            platform: 'web',
        };
    },
}));
vi.mock('@/components/appShell/currentUiContext/CurrentUiContextProvider', () => ({
    useOptionalCurrentUiContextReader: () => null,
}));
vi.mock('@/components/plugins/surfaces/pluginSurfaceDestinationNavigation', () => ({
    usePluginSurfaceDestinationNavigationBinding: () => null,
}));

vi.mock('@/sync/store/hooks', () => ({
    useAllMachines: () => [],
    useAllSessions: () => [{
        id: 'session-b',
        serverId: harness.portableIdentity ? 'local-home-b' : 'home-b',
        updatedAt: 1,
        metadata: { name: 'Home B session', path: '/repo/b' },
    }],
    useSessionListRowsByServerId: () => harness.sessionListRows.reduce<Record<string, Record<string, typeof harness.sessionListRows[number]['session']>>>((byServer, row) => {
        const serverId = row.serverId ?? '';
        if (!serverId) return byServer;
        byServer[serverId] ??= {};
        byServer[serverId]![row.session.id] = row.session;
        return byServer;
    }, {}),
    useSessionOrganizationProjection: () => harness.sessionOrganizationProjection,
}));
vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: () => ({
        fetchAllSessionMetadata: harness.fetchAllSessionMetadata,
        ensureSessionVisibleForMessageRoute: async () => ({ kind: 'available' }),
        getSyncTuning: () => ({ sessionListHydrationConcurrencyLimit: 2 }),
    }),
}));
vi.mock('@/sync/domains/session/fetchSessionMetadataInventoryForServerAccountScope', () => ({
    ensureSessionMetadataInventoryForServerAccountScope: harness.ensureSessionMetadataInventoryForServerAccountScope,
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/fetchSessionByIdWithServerScope', () => ({
    fetchSessionByIdWithServerScope: async (params: Readonly<{
        sessionId: string;
        serverId?: string | null;
        applySessions(sessions: readonly unknown[]): void;
    }>) => {
        params.applySessions([{
            id: params.sessionId,
            serverId: params.serverId,
            seq: 100,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            archivedAt: null,
            encryptionMode: 'plain',
            metadata: { name: 'Scoped Session', path: '/repo/b' },
            metadataVersion: 1,
            agentState: {},
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
        }]);
        return { ok: true };
    },
}));
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSetting: () => [],
        storage: { getState: () => ({
            sessions: {},
            machines: {},
            machineListByServerId: harness.memoryMachine ? { [harness.memoryMachine.serverId]: [{
                id: harness.memoryMachine.machine.id, active: true, activeAt: Date.now(), createdAt: 1, updatedAt: 1,
                metadata: { host: 'Test machine' },
            }] } : {},
            sessionListRowsByServerId: harness.sessionListRows.reduce<Record<string, Record<string, typeof harness.sessionListRows[number]['session']>>>((byServer, row) => {
                const serverId = row.serverId ?? '';
                if (!serverId) return byServer;
                byServer[serverId] ??= {};
                byServer[serverId]![row.session.id] = row.session;
                return byServer;
            }, {}),
            clearSessionListRowsForServerScope: () => undefined,
            mergeSessionListRowsForServerScope: (serverId: string, sessions: typeof harness.sessionListRows[number]['session'][]) => {
                for (const session of sessions) {
                    harness.sessionListRows = harness.sessionListRows.filter((row) => (
                        row.serverId !== serverId || row.session.id !== session.id
                    ));
                    harness.sessionListRows.push({ serverId, serverName: serverId, session });
                }
            },
        }) },
    });
});
vi.mock('@/sync/domains/state/storageStore', async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    return { storage };
});
vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    getActiveServerAccountScope: () => ({ serverId: 'home-a', accountId: 'account-1' }),
    captureActiveServerAccountScopeLifetime: () => {
        harness.activeAccountLifetime ??= {
            scope: { serverId: 'home-a', accountId: 'account-1' },
            isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }),
        };
        return harness.activeAccountLifetime;
    },
}));
vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({ serverId: 'home-a' }),
}));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (id: string) => harness.featureEnabled[id] === true,
}));
vi.mock('@/sync/domains/features/featureDecisionRuntime', () => {
    const ready = {
        status: 'ready',
        features: { capabilities: { homeSearch: { enabled: true } } },
    };
    return {
        useServerFeaturesRuntimeSnapshot: () => ready,
        useServerFeaturesSnapshotForServerId: () => ready,
    };
});
vi.mock('@/sync/domains/machines/administration/useTargetSelection', () => ({
    useMachineAdministrationTargetSelection: () => ({ resolveExecutionTarget: () => harness.memoryMachine }),
}));
vi.mock('@/sync/domains/memory/searchHomeMemory', () => ({
    searchHomeMemory: harness.searchHomeMemory,
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope', () => ({
    captureServerRequestAuthorityForServerAccountScope: async ({ scope }: { scope: { serverId: string; accountId: string } }) => ({
        scope,
        context: { scope: 'scoped', credentials: { token: scope.accountId } },
        request: async () => new Response('{}'),
        release: async () => undefined,
    }),
}));
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
    return {
        ...actual,
        accountDirectoryAuthCredentials: {
        read: async () => ({ kind: 'absent' as const }),
        get: async () => null,
        set: async () => false,
        remove: async () => false,
        clear: async () => false,
        logout: async () => false,
        },
        TokenStorage: {
            ...actual.TokenStorage,
            getCredentialsForServerUrl: async (_url: string, options: { serverId?: string }) => ({
                token: options.serverId === 'home-b' ? 'account-1' : 'account-a',
            }),
        },
        subscribeHomeCredentialMutations: (listener: Parameters<typeof actual.subscribeHomeCredentialMutations>[0]) => {
            harness.homeCredentialMutationListeners.add(listener);
            return () => harness.homeCredentialMutationListeners.delete(listener);
        },
    };
});
vi.mock('@/utils/auth/parseToken', () => ({ parseToken: (token: string) => token }));
// The daemon RPC is the system boundary; negotiation, parsing and eligibility remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: harness.machineRpc,
}));
vi.mock('@/sync/ops/sessionMachineTarget', () => ({ readMachineControlTargetForSession: () => null }));
vi.mock('@/hooks/server/useServerProfilesGeneration', () => ({ useServerProfilesGeneration: () => 1 }));
vi.mock('@/sync/domains/server/serverProfiles', () => ({
    // The Home display-name owner reads a user-given name; these fixtures name every Home.
    readServerProfileHomeName: (profile: { name?: string }) => profile.name?.trim() || null,
    getActiveServerSnapshot: () => ({
        serverId: 'home-a',
        serverUrl: 'https://home-a.example.test',
        generation: 1,
        isSelectionExplicit: true,
    }),
    listServerProfiles: () => [
        ...(harness.singleHome ? [] : [{ id: 'home-a', name: 'Home A', serverUrl: 'https://home-a.example.test' }]),
        harness.portableIdentity
            ? { id: 'local-home-b', serverIdentityId: 'home-b', name: 'Home B', serverUrl: 'https://home-b.example.test' }
            : { id: 'home-b', name: 'Home B', serverUrl: 'https://home-b.example.test' },
    ],
    getServerProfileById: (serverId: string) => harness.portableIdentity && (serverId === 'home-b' || serverId === 'local-home-b')
        ? { id: 'local-home-b', serverIdentityId: 'home-b', name: 'Home B', serverUrl: 'https://home-b.example.test' }
        : { id: serverId, name: serverId, serverUrl: `https://${serverId}.example.test` },
    resolveServerProfileScopeId: (profile: { id: string; serverIdentityId?: string | null }) => profile.serverIdentityId ?? profile.id,
    resolveServerProfileScopeIdForIdentifier: (serverId: string) => harness.portableIdentity && serverId === 'local-home-b' ? 'home-b' : serverId,
    areServerProfileIdentifiersEquivalent: (left: string, right: string) => left === right
        || (harness.portableIdentity && [left, right].sort().join(':') === 'home-b:local-home-b'),
}));

function pluginSearchProjection(input: Readonly<{
    pluginId: string;
    title: string;
    generation: number;
}>): PluginUiProjectionModel {
    const providerId = `searchProvider:${input.pluginId}:entries`;
    return Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: input.generation,
        searchProvidersById: Object.freeze({
            [providerId]: Object.freeze({
                id: providerId,
                pluginId: input.pluginId,
                contributionKind: 'searchProvider' as const,
                descriptorId: 'entries',
                identity: Object.freeze({ pluginId: input.pluginId, localId: 'entries' }),
                action: Object.freeze({ pluginId: input.pluginId, localId: 'search' }),
            }),
        }),
        actionsById: Object.freeze({
            [`${input.pluginId}/search`]: Object.freeze({
                id: 'search',
                pluginId: input.pluginId,
                title: input.title,
                icon: 'action',
                scopes: ['global'],
                surfaces: ['ui'],
                execution: { target: 'daemon' },
                dangerLevel: 'safe',
                available: true,
            }),
        }),
    }) as PluginUiProjectionModel;
}

afterEach(() => {
    harness.selectionListProps = null;
    harness.sessionListRows = [];
    harness.homeCredentialMutationListeners.clear();
    harness.portableIdentity = false;
    harness.singleHome = false;
    harness.settingsCatalog = { tree: [], search: () => [] };
    harness.sessionOrganizationProjection = null;
    harness.appShellPluginProjection = null;
    harness.scopedPluginProjections.clear();
    harness.scopedPluginProjectionCalls = [];
    harness.activeAccountLifetime = null;
    harness.featureEnabled = { search: true, 'memory.search': false };
    harness.memoryMachine = null;
    harness.machineRpc.mockReset();
    vi.clearAllMocks();
    standardCleanup();
});

// Load the real owner outside React act and the behavior-test timeout. Its large
// transitive graph can take over two minutes to transform on the remote mirror.
beforeAll(async () => {
    await import('./UniversalSearchController');
}, 300_000);

describe('UniversalSearchController exact Home scope', () => {
    it('keeps old-daemon Session hits usable with explicit unavailable document coverage', async () => {
        harness.featureEnabled = { search: false, 'memory.search': true };
        harness.memoryMachine = { serverId: 'home-b', machine: { id: 'machine-b' } };
        harness.machineRpc.mockImplementation(async (call) => {
            if (call.method === 'daemon.memory.settings.get') return DEFAULT_MEMORY_SETTINGS;
            if (call.method === 'daemon.memory.status') throw Object.assign(new Error('Older daemon'), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            });
            return { v: 1, ok: true, hits: [{ sessionId: 'session-b', seqFrom: 9, seqTo: 9,
                createdAtFromMs: 1, createdAtToMs: 1, summary: 'Old transcript match', score: 0.5 }] };
        });
        const { UniversalSearchController } = await import('./UniversalSearchController');
        await renderScreen(<UniversalSearchController commands={[]} initialQuery="recovery"
            initialScope={{ accountId: 'account-1', serverId: 'home-b', sessionId: null, machineId: null, rootPath: null }}
            presentation="modal" onRequestClose={vi.fn()} />);
        const section = harness.selectionListProps?.rootStep.sections.find((item) => item.id === 'transcript');
        if (!section || section.kind !== 'dynamic') throw new Error('Memory search section missing');
        const resolved = await section.resolve('recovery', new AbortController().signal);
        expect(resolved.options).toHaveLength(1);
        expect(resolved.resultHint).toContain('Memory document search is unavailable here.');
        const query = harness.machineRpc.mock.calls.find(([call]) => call.method === 'daemon.memory.search')?.[0];
        expect(query?.payload).not.toHaveProperty('corpora');
        const option = resolved.options[0]!;
        await act(async () => {
            option.onSelect?.();
            harness.selectionListProps?.onSelect?.(option.id, option);
            await vi.waitFor(() => expect(harness.navigateToSession).toHaveBeenCalledWith('session-b', {
                serverId: 'home-b', query: { jumpSeq: 9 },
            }));
        });
    });

    it('keeps mixed memory hits and opens their named topic through the qualified document route', async () => {
        harness.featureEnabled['memory.search'] = true;
        harness.memoryMachine = { serverId: 'home-b', machine: { id: 'machine-b' } };
        harness.searchHomeMemory.mockResolvedValue({ v: 1, ok: true, hits: [{ sessionId: 'session-b',
            seqFrom: 7, seqTo: 7, createdAtFromMs: 1, createdAtToMs: 1,
            summary: 'Past release discussion', score: 0.5 }] });
        const statusFixture = {
            v: 1, enabled: true, indexMode: 'deep', hintsIndexReady: false,
            deepIndexReady: true, activeIndexReady: true, activeIndexSearchable: true, embeddingsEnabled: false,
            embeddingsMode: 'disabled', embeddingsPresetId: null, embeddingsProviderKind: null,
            embeddingsModelId: null, embeddingsRuntimeState: 'unavailable', embeddingsUsingFallback: false,
            tier1DbPath: null, deepDbPath: '/memory/deep.sqlite', tier1DbBytes: null, deepDbBytes: 1,
            documentSearchSupported: true,
        };
        const resultFixture = {
            v: 1, ok: true, documents: { state: 'ready' }, hits: [
                { type: 'artifact', ref: { kind: 'doc', serverId: 'home-b', artifactId: 'memory/b' },
                    revision: { headerVersion: 1, bodyVersion: 2 },
                    location: { type: 'topic', title: 'Release & recovery' }, factId: 'fact/b',
                    summary: 'Keep release recovery steps', score: 0.8 },
                { type: 'artifact', ref: { kind: 'doc', serverId: 'home-b', artifactId: 'memory/b' },
                    revision: { headerVersion: 1, bodyVersion: 2 },
                    location: { type: 'topic', title: 'facts' }, factId: 'same-fact',
                    summary: 'Named facts topic', score: 0.7 },
                { type: 'artifact', ref: { kind: 'doc', serverId: 'home-b', artifactId: 'memory/b' },
                    revision: { headerVersion: 1, bodyVersion: 2 }, location: 'facts', factId: 'same-fact',
                    summary: 'Key facts section', score: 0.6 },
                { sessionId: 'session-b', seqFrom: 7, seqTo: 7,
                    createdAtFromMs: 1, createdAtToMs: 1, summary: 'Past release discussion', score: 0.5 },
            ],
        };
        harness.machineRpc.mockImplementation(async call => call.method === 'daemon.memory.settings.get' ? DEFAULT_MEMORY_SETTINGS
            : call.method === 'daemon.memory.status' ? statusFixture : resultFixture);
        const { UniversalSearchController } = await import('./UniversalSearchController');
        await renderScreen(<UniversalSearchController commands={[]} initialQuery="recovery"
            initialScope={{ accountId: 'account-1', serverId: 'home-b', sessionId: null, machineId: null, rootPath: null }}
            presentation="modal" onRequestClose={vi.fn()} />);
        const section = harness.selectionListProps?.rootStep.sections.find((item) => item.id === 'transcript');
        if (!section || section.kind !== 'dynamic') throw new Error('Memory search section missing');
        const resolved = await section.resolve('recovery', new AbortController().signal);
        expect(resolved.options.map((option) => option.label))
            .toContain('Keep release recovery steps');
        expect(harness.searchHomeMemory).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'home-b', accountId: 'account-1' }));
        const query = harness.machineRpc.mock.calls.find(([call]) => call.method === 'daemon.memory.search')?.[0];
        expect(query).toMatchObject({ serverId: 'home-b', accountId: 'account-1', machineId: 'machine-b',
            payload: { corpora: ['documents'] } });
        expect(resolved.options).toHaveLength(4);
        expect(new Set(resolved.options.map((option) => option.id)).size).toBe(4);
        const memoryOption = resolved.options.find((option) => option.label === 'Keep release recovery steps');
        if (!memoryOption) throw new Error('Remembered fact missing');
        await act(async () => {
            memoryOption.onSelect?.();
            harness.selectionListProps?.onSelect?.(memoryOption.id, memoryOption);
            await vi.waitFor(() => expect(harness.routerPush).toHaveBeenCalledWith(
                '/settings/prompts/memory/memory%2Fb?serverId=home-b&topic=Release%20%26%20recovery&fact=fact%2Fb',
            ));
        });
        const sessionOption = resolved.options.find((option) => option.subtitle === 'Past release discussion');
        if (!sessionOption) throw new Error('Past Session missing');
        await act(async () => {
            sessionOption.onSelect?.();
            harness.selectionListProps?.onSelect?.(sessionOption.id, sessionOption);
            await vi.waitFor(() => expect(harness.navigateToSession).toHaveBeenCalledWith('session-b', {
                serverId: 'home-b', query: { jumpSeq: 7 },
            }));
        });
    });

    it('keeps a typed Messages section with a truthful hint when transcript search is disabled', async () => {
        harness.featureEnabled = { search: false, 'memory.search': false };
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="needle"
                initialScope={{ accountId: 'account-1', serverId: 'home-b', sessionId: null, machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        const rootStep = harness.selectionListProps?.rootStep;
        const transcript = rootStep?.sections.find((section) => section.id === 'transcript');
        expect(transcript?.kind).toBe('dynamic');
        if (!transcript || transcript.kind !== 'dynamic') throw new Error('Messages availability section missing');
        const resolved = await transcript.resolve('needle', new AbortController().signal);
        expect(resolved.options).toEqual([]);
        expect(resolved.emptyHint).toBe('Enable memory search in Features to configure local indexing.');
        expect(rootStep?.emptyStateLabel).toBe('No matches');

        await act(async () => {
            harness.selectionListProps?.onSelect?.('missing-result', { id: 'missing-result', label: 'Missing' });
        });
        await vi.waitFor(() => expect(harness.modalAlert).toHaveBeenCalledWith(
            'Error',
            'Search failed. Please try again.',
        ));
    });

    it('keeps an explicit empty scope closed instead of widening to ambient or cross-Home entities', async () => {
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="needle"
                initialScope={{ accountId: null, serverId: null, sessionId: null, machineId: null, rootPath: null }}
                activeSessionId="ambient-session-a"
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        const ids = harness.selectionListProps?.rootStep.sections.map((section) => section.id) ?? [];
        expect(ids).not.toContain('transcript');
        expect(ids).not.toContain('sessions');
        expect(harness.searchHomeMemory).not.toHaveBeenCalled();
    });

    it('uses the canonical Session organization projection when matching Session tags', async () => {
        harness.sessionListRows = [{
            serverId: 'home-b',
            serverName: 'Home B',
            session: {
                id: 'session-b',
                updatedAt: 1,
                metadata: { name: 'Home B session', path: '/repo/b' },
            },
        }];
        harness.sessionOrganizationProjection = {
            schemaVersion: 1,
            version: 1,
            orderedPinSessionIds: [],
            pinnedSessionIds: [],
            railPinnedSessionIds: [],
            pinsBySessionId: {},
            foldersById: {},
            folderAssignmentsBySessionId: {},
            tagsById: {
                urgent: {
                    tagId: 'urgent',
                    tagKey: 'tag/urgent',
                    sortKey: 'a',
                    display: { t: 'plain', v: { label: 'Urgent' } },
                    displayState: { status: 'available', value: { label: 'Urgent' } },
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                },
            },
            tagAssignmentsBySessionId: { 'session-b': ['urgent'] },
            attentionStandingsBySessionId: {},
            orderEntriesByScopeKey: {},
            labelsByLabelKey: {},
        };
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialScope={{ accountId: 'account-1', serverId: 'home-b', sessionId: null, machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        const sessionSection = harness.selectionListProps?.rootStep.sections.find((section) => section.id === 'sessions');
        if (!sessionSection || sessionSection.kind !== 'static') throw new Error('Sessions section missing');
        expect(sessionSection.options[0]?.searchText).toContain('Urgent');
    });

    it('ensures complete inventory once for the scope lifetime without exposing or restarting a result section', async () => {
        harness.activeAccountLifetime = {
            scope: { serverId: 'home-a', accountId: 'account-a' },
            isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }),
        };
        harness.sessionListRows = [
            {
                serverId: 'home-a',
                serverName: 'Home A',
                session: {
                    id: 'unloaded-active',
                    updatedAt: 3,
                    archivedAt: null,
                    metadata: { name: 'Unloaded active needle', path: '/repo/active' },
                },
            },
            {
                serverId: 'home-a',
                serverName: 'Home A',
                session: {
                    id: 'unloaded-archived',
                    updatedAt: 2,
                    archivedAt: 1,
                    metadata: { name: 'Archived needle', path: '/repo/archived' },
                },
            },
        ];
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="needle"
                initialScope={{ accountId: 'account-a', serverId: 'home-a', sessionId: null, machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        await vi.waitFor(() => expect(harness.ensureSessionMetadataInventoryForServerAccountScope).toHaveBeenCalledOnce());
        expect(harness.selectionListProps?.rootStep.sections.some((section) => section.id === 'session-inventory')).toBe(false);
        await act(async () => {
            harness.selectionListProps?.onChangeInputValue?.('needle again');
        });
        await act(async () => undefined);
        expect(harness.ensureSessionMetadataInventoryForServerAccountScope).toHaveBeenCalledTimes(1);
        expect(harness.ensureSessionMetadataInventoryForServerAccountScope).toHaveBeenCalledWith(expect.objectContaining({
            scope: { serverId: 'home-a', accountId: 'account-a' },
        }));
        const sessions = harness.selectionListProps?.rootStep?.sections.find((section) => section.id === 'sessions');
        expect(sessions?.kind).toBe('static');
        if (!sessions || sessions.kind !== 'static') throw new Error('Sessions section not ready');
        expect(sessions.options.map((option) => option.label)).toEqual([
            'Unloaded active needle',
            'Archived needle',
        ]);
    });

    it('surfaces Session inventory failures section-locally while silencing cancellation', async () => {
        const failure = new Error('current inventory unavailable');
        harness.ensureSessionMetadataInventoryForServerAccountScope.mockRejectedValueOnce(failure);
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="needle"
                initialScope={{ accountId: 'account-1', serverId: 'home-b', sessionId: null, machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        await vi.waitFor(() => expect(harness.ensureSessionMetadataInventoryForServerAccountScope).toHaveBeenCalledOnce());
        expect(harness.selectionListProps?.rootStep.sections.some((section) => section.id === 'session-inventory')).toBe(false);
        await vi.waitFor(() => {
            const sessions = harness.selectionListProps?.rootStep.sections.find((section) => section.id === 'sessions');
            expect(sessions?.kind).toBe('static');
            expect(sessions && 'resultHint' in sessions ? sessions.resultHint : undefined).toEqual(expect.any(String));
        });
    });

    it('pages Session metadata for an explicitly selected inactive Home without borrowing the active Sync scope', async () => {
        harness.activeAccountLifetime = {
            scope: { serverId: 'home-a', accountId: 'account-a' },
            isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }),
        };
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="archived needle"
                initialScope={{ accountId: 'account-1', serverId: 'home-b', sessionId: null, machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        await vi.waitFor(() => expect(harness.ensureSessionMetadataInventoryForServerAccountScope).toHaveBeenCalledOnce());
        expect(harness.ensureSessionMetadataInventoryForServerAccountScope).toHaveBeenCalledWith(expect.objectContaining({
            scope: { serverId: 'home-b', accountId: 'account-1' },
        }));
        expect(harness.fetchAllSessionMetadata).not.toHaveBeenCalled();
    });

    it('aborts inactive-Home Session metadata paging when that exact credential lifetime retires', async () => {
        harness.ensureSessionMetadataInventoryForServerAccountScope.mockImplementationOnce(async (params) => await new Promise<void>((_resolve, reject) => {
            params.accountLifetime.onRetire(() => {
                reject(Object.assign(new Error('retired'), { name: 'AbortError' }));
            });
        }));
        const { UniversalSearchController } = await import('./UniversalSearchController');
        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="needle"
                initialScope={{ accountId: 'account-1', serverId: 'home-b', sessionId: null, machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );
        await vi.waitFor(() => expect(harness.ensureSessionMetadataInventoryForServerAccountScope).toHaveBeenCalledOnce());
        const firstSignal = harness.ensureSessionMetadataInventoryForServerAccountScope.mock.calls[0]?.[0]?.signal as AbortSignal;
        expect(firstSignal.aborted).toBe(false);

        await act(async () => {
            for (const listener of harness.homeCredentialMutationListeners) {
                listener({ kind: 'credentials_set', serverId: 'home-b', serverUrl: 'https://home-b.example.test' });
            }
        });

        await vi.waitFor(() => expect(firstSignal.aborted).toBe(true));
    });

    it('keeps Search open when a previously rendered command has left the current catalog', async () => {
        const dismiss = vi.fn();
        const action = vi.fn(async () => {});
        const command = {
            id: 'retired-command',
            title: 'Retired command',
            action,
            // This test exercises pre-dismiss currentness, not the separately
            // covered empty-query suggestion projection.
            emptyQuerySuggested: true,
        };
        const { UniversalSearchController } = await import('./UniversalSearchController');
        const renderController = (commands: typeof command[]) => (
            <UniversalSearchController
                commands={commands}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={dismiss}
            />
        );
        const screen = await renderScreen(renderController([command]));
        const staleOption = harness.selectionListProps?.rootStep.sections
            .flatMap((section) => section.kind === 'static' ? section.options : [])
            .find((option) => option.id === 'command:retired-command');
        expect(staleOption).toBeDefined();

        await act(async () => { screen.tree.update(renderController([])); });
        await act(async () => {
            harness.selectionListProps?.onSelect?.(staleOption!.id, staleOption!);
        });

        expect(dismiss).not.toHaveBeenCalled();
        expect(action).not.toHaveBeenCalled();
    });

    it('canonicalizes a local profile id to portable Home identity for credentials, filtering, query, and result activation', async () => {
        harness.portableIdentity = true;
        harness.searchHomeMemory.mockResolvedValue({
            v: 1,
            ok: true,
            hits: [{
                sessionId: 'session-b',
                seqFrom: 5,
                seqTo: 5,
                createdAtFromMs: 1,
                createdAtToMs: 1,
                summary: 'Portable identity result',
                score: 1,
            }],
        });
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="needle"
                initialScope={{ accountId: 'account-1', serverId: 'local-home-b', sessionId: 'session-b', machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        const transcript = harness.selectionListProps?.rootStep?.sections.find((section) => section.id === 'transcript');
        expect(transcript?.kind).toBe('dynamic');
        if (!transcript || transcript.kind !== 'dynamic') throw new Error('Transcript section not ready');
        const resolved = await transcript.resolve('needle', new AbortController().signal);
        const option = resolved.options[0];
        expect(harness.searchHomeMemory).toHaveBeenCalledWith(expect.objectContaining({
            serverId: 'home-b',
            accountId: 'account-1',
        }));
        await act(async () => {
            option?.onSelect?.();
            harness.selectionListProps?.onSelect?.(option!.id, option!);
            await vi.waitFor(() => expect(harness.navigateToSession).toHaveBeenCalledWith('session-b', {
                serverId: 'home-b',
                query: { jumpSeq: 5 },
            }));
        });
    });

    it('keeps a contextual Home B seed through query, result identity, and canonical scoped activation while Home A is focused', async () => {
        harness.searchHomeMemory.mockResolvedValue({
            v: 1,
            ok: true,
            hits: [{
                sessionId: 'session-b',
                seqFrom: 7,
                seqTo: 7,
                createdAtFromMs: 1,
                createdAtToMs: 1,
                summary: 'Needle in Home B',
                score: 1,
            }],
        });
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="needle"
                initialScope={{ accountId: 'account-1', serverId: 'home-b', sessionId: 'session-b', machineId: null, rootPath: null }}
                activeSessionId="ambient-session-a"
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        const rootStep = harness.selectionListProps?.rootStep;
        const transcript = rootStep?.sections.find((section) => section.id === 'transcript');
        expect(transcript?.kind).toBe('dynamic');
        if (!transcript || transcript.kind !== 'dynamic') throw new Error('Transcript section not ready');
        const resolved = await transcript.resolve('needle', new AbortController().signal);
        const option = resolved.options[0];
        expect(harness.searchHomeMemory).toHaveBeenCalledWith(expect.objectContaining({
            serverId: 'home-b',
            accountId: 'account-1',
            query: 'needle',
        }));
        expect(option?.id).toContain('home-b');

        await act(async () => {
            option?.onSelect?.();
            harness.selectionListProps?.onSelect?.(option!.id, option!);
            await vi.waitFor(() => {
                expect(harness.navigateToSession).toHaveBeenCalledWith('session-b', {
                    serverId: 'home-b',
                    query: { jumpSeq: 7 },
                });
            });
        });
        expect(harness.fetchAllSessionMetadata).not.toHaveBeenCalled();
    });

    it('uses Home B plugin providers from the selected scope while Home A is focused', async () => {
        harness.appShellPluginProjection = pluginSearchProjection({
            pluginId: 'acme.home-a',
            title: 'Home A entities',
            generation: 11,
        });
        harness.scopedPluginProjections.set(
            'home-b:machine-b',
            pluginSearchProjection({
                pluginId: 'acme.home-b',
                title: 'Home B entities',
                generation: 22,
            }),
        );
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="needle"
                initialScope={{
                    accountId: 'account-1',
                    serverId: 'home-b',
                    sessionId: null,
                    machineId: 'machine-b',
                    rootPath: null,
                }}
                activeSessionId="ambient-session-a"
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        expect(harness.scopedPluginProjectionCalls).toContainEqual({
            serverId: 'home-b',
            machineId: 'machine-b',
            enabled: true,
        });
        const sectionIds = harness.selectionListProps?.rootStep.sections.map((section) => section.id) ?? [];
        expect(sectionIds).toContain('plugin-search:acme.home-b:entries');
        expect(sectionIds).not.toContain('plugin-search:acme.home-a:entries');
    });

    it('uses the freshly hydrated exact Session title instead of duplicating the transcript excerpt', async () => {
        harness.searchHomeMemory.mockResolvedValue({
            v: 1,
            ok: true,
            hits: [{
                sessionId: 'newly-hydrated',
                seqFrom: 1,
                seqTo: 1,
                createdAtFromMs: 1,
                createdAtToMs: 1,
                summary: 'Matching transcript excerpt',
                score: 1,
            }],
        });
        const { UniversalSearchController } = await import('./UniversalSearchController');
        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="needle"
                initialScope={{ accountId: 'account-1', serverId: 'home-b', sessionId: null, machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        const transcript = harness.selectionListProps?.rootStep.sections.find((section) => section.id === 'transcript');
        if (!transcript || transcript.kind !== 'dynamic') throw new Error('Transcript section missing');
        const result = await transcript.resolve('needle', new AbortController().signal);

        expect(result.options[0]?.label).toBe('Scoped Session');
        expect(result.options[0]?.subtitle).toBe('Matching transcript excerpt');
    });

    it('lists settings results as one group, pages first, each row with the path the settings rail shows', async () => {
        harness.settingsCatalog = {
            tree: [{
                id: 'root',
                title: 'Settings',
                keywords: [],
                children: [
                    { id: 'appearance', title: 'Appearance', subtitle: 'Theme, density and fonts', route: '/settings/appearance', keywords: [], children: [
                        { id: 'terminal', title: 'Terminal', route: '/settings/appearance/terminal', keywords: [] },
                    ] },
                ],
            }],
            // The catalog ranks a setting above a page; Search still shows pages first.
            search: () => [
                { id: 'appearance', route: '/settings/appearance?setting=appearance.theme', setting: { anchor: 'appearance.theme', title: 'Theme', path: ['Appearance'] } },
                { id: 'terminal', route: '/settings/appearance/terminal' },
            ],
        };
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="the"
                initialScope={{ accountId: 'account-1', serverId: 'home-b', sessionId: null, machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        const sections = harness.selectionListProps?.rootStep.sections ?? [];
        const settingsSections = sections.filter((section) => section.id === 'settings');
        expect(settingsSections).toHaveLength(1);
        const settings = settingsSections[0];
        if (!settings || settings.kind !== 'dynamic') throw new Error('Settings section missing');
        const resolved = await settings.resolve('the', new AbortController().signal);
        expect(resolved.options.map((option) => [option.label, option.subtitle])).toEqual([
            ['Terminal', 'Appearance'],
            ['Theme', 'Appearance'],
        ]);
    });

    it('offers the all-machines choice even when there is only one Home', async () => {
        harness.singleHome = true;
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialScope={{ accountId: 'account-1', serverId: 'home-b', sessionId: null, machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        expect(harness.selectionListProps).not.toBeNull();
        expect(harness.selectionListProps?.filters ?? []).toHaveLength(1);
        expect(harness.selectionListProps?.filters?.[0].options).toHaveLength(2);
    });

    it('names the scope chip by the Home display name when there are several Homes', async () => {
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialScope={{ accountId: 'account-1', serverId: 'home-b', sessionId: null, machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        const scopeFilter = harness.selectionListProps?.filters?.find((filter) => filter.id === 'scope');
        if (!scopeFilter) throw new Error('Scope filter missing from Search');
        expect(scopeFilter.valueLabel).toBe('Home B');
    });

    it('keeps the result query when the scope filter changes the Home', async () => {
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="needle"
                initialScope={{ accountId: 'account-1', serverId: 'home-b', sessionId: null, machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        expect(harness.selectionListProps?.rootStep.sections.some((section) => section.id === 'scope')).toBe(false);
        // The scope is a filter chip: choosing another Home changes the scope, not the query.
        const scopeFilter = harness.selectionListProps?.filters?.find((filter) => filter.id === 'scope');
        if (!scopeFilter) throw new Error('Scope filter missing from Search');
        expect(scopeFilter.testID).toBe('universal-search:scope');
        const nextScope = scopeFilter.options?.find((option) => option.id.includes('home-a'));
        expect(nextScope).toBeDefined();
        await act(async () => {
            scopeFilter.onChange?.(nextScope!.id);
        });

        expect(harness.selectionListProps?.inputValue).toBe('needle');
        expect(harness.selectionListProps?.filters?.find((filter) => filter.id === 'scope')?.selectedId)
            .toBe(nextScope!.id);
    });

    it('invalidates the Home transcript resolver identity when that Home credential mutates', async () => {
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="needle"
                initialScope={{ accountId: 'account-1', serverId: 'home-b', sessionId: null, machineId: null, rootPath: null }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        const before = harness.selectionListProps?.rootStep?.sections.find((section) => section.id === 'transcript');
        if (!before || before.kind !== 'dynamic') throw new Error('Transcript section not ready');
        const retiredCache = harness.selectionListProps?.dynamicSectionCache;
        if (!retiredCache) throw new Error('Credential-scoped cache not installed');
        retiredCache.set('transcript::old-credential::needle', [{ id: 'sensitive-old-row', label: 'Sensitive old row' }]);

        await act(async () => {
            for (const listener of harness.homeCredentialMutationListeners) {
                listener({ kind: 'credentials_set', serverId: 'home-b', serverUrl: 'https://home-b.example.test' });
            }
        });

        const after = harness.selectionListProps?.rootStep?.sections.find((section) => section.id === 'transcript');
        if (!after || after.kind !== 'dynamic') throw new Error('Transcript section not ready after credential mutation');
        const activeCache = harness.selectionListProps?.dynamicSectionCache;
        if (!activeCache) throw new Error('Replacement credential-scoped cache not installed');
        expect(after.resolverKey).not.toBe(before.resolverKey);
        expect(activeCache).not.toBe(retiredCache);
        expect(retiredCache.size()).toBe(0);

        // Completion from work admitted under the old credential can only touch its retired
        // cache instance; it cannot publish into the replacement credential lifetime.
        retiredCache.set('transcript::old-credential::needle', [{ id: 'late-old-row', label: 'Late old row' }]);
        expect(activeCache.get('transcript::old-credential::needle')).toBeUndefined();
    });

    it('normalizes a provider hit session id once for authorization, identity, and activation', async () => {
        harness.searchHomeMemory.mockResolvedValue({
            v: 1,
            ok: true,
            hits: [{
                sessionId: '  session-b  ',
                seqFrom: 9,
                seqTo: 9,
                createdAtFromMs: 1,
                createdAtToMs: 1,
                summary: 'Whitespace-bearing provider hit',
                score: 1,
            }],
        });
        const { UniversalSearchController } = await import('./UniversalSearchController');

        await renderScreen(
            <UniversalSearchController
                commands={[]}
                initialQuery="needle"
                initialScope={{
                    accountId: 'account-1',
                    serverId: 'home-b',
                    sessionId: 'session-b',
                    machineId: null,
                    rootPath: null,
                }}
                activeSessionId={null}
                presentation="modal"
                onRequestClose={vi.fn()}
            />,
        );

        const transcript = harness.selectionListProps?.rootStep?.sections.find((section) => section.id === 'transcript');
        if (!transcript || transcript.kind !== 'dynamic') throw new Error('Transcript section not ready');
        const resolved = await transcript.resolve('needle', new AbortController().signal);
        const option = resolved.options[0];

        expect(option).toBeTruthy();
        await act(async () => {
            option?.onSelect?.();
            harness.selectionListProps?.onSelect?.(option!.id, option!);
            await vi.waitFor(() => {
                expect(harness.navigateToSession).toHaveBeenCalledWith('session-b', {
                    serverId: 'home-b',
                    query: { jumpSeq: 9 },
                });
            });
        });
    });
});
