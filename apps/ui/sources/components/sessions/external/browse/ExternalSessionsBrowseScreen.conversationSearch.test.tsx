import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { DEFAULT_MEMORY_SETTINGS } from '@happier-dev/protocol/memory/memorySettings';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { createMachineFixture, flushHookEffects, PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { ExternalSessionBrowseCandidatesList } from './ExternalSessionBrowseCandidatesList';
import { readExternalSessionBrowseCandidateKey } from './useExternalSessionBrowseCandidates';
import { AppPaneProvider, useOptionalAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import type { FileFindSeedHandoff } from '@/components/appShell/panes/fileFindSeedHandoff';
import { makeExternalSessionHistoricalImportLocalId } from '@happier-dev/protocol/sessions/external/historicalImportIdentity';

const rpc = vi.hoisted(() => vi.fn());
const homes = createHomeGovernanceHarness();
let serverId: string;
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// The renderer has no native recycler viewport. Mount its cells at the SDK
// boundary while preserving the real SelectionList rows and activation path.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<typeof import('@legendapp/list/react-native')>() }).module;
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));

// The app entry publishes the real Sync tuning before Account-bound search.
// Bridge its Node require through the canonical loader; keep sockets external.
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

const projection = PluginProjectionV2Schema.parse({ ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
    agentsById: { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.agentsById, 'acme.archive': {
        id: 'acme.archive', identity: { pluginId: 'acme.review', localId: 'archive' }, title: 'Archive Agent',
        externalSessions: { agent: { pluginId: 'acme.review', localId: 'archive' }, generation: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.generation,
            operations: { listCandidates: true, resolveLinkIdentity: true, pageTranscript: true, readAfterTranscript: true },
            sources: [{ sourceKind: 'archive', contentSearch: true, schema: { fields: [{ name: 'kind', kind: 'literal', value: 'archive' }] },
                key: { segments: [{ kind: 'literal', value: 'archive' }] }, instances: [{ kind: 'default', constants: {} }] }],
        },
    } },
});

beforeEach(async () => {
    await homes.reset();
    serverId = resolveServerProfileScopeIdForIdentifier(await homes.addHome({ serverUrl: 'https://history-index.example.test', serverIdentityId: 'srv_history_index', name: 'History Home', accountId: 'history-account' }));
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async url => {
        const token = homes.findByServerUrl(url)?.token;
        return token ? { token } : null;
    });
    const machine = createMachineFixture({ id: 'machine-1', activeAt: Date.now() });
    const scope = { serverId, accountId: 'history-account' };
    storage.setState(state => ({ isDataReady: true, settingsVersion: 1, profile: { ...state.profile, id: scope.accountId }, profileScope: scope, settingsScope: scope,
        machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' },
        settings: { ...settingsDefaults, experiments: true, featureToggles: { 'memory.search': true } },
    }));
    clearDaemonMergedProjectionCacheForTests();
    rpc.mockReset();
    vi.useFakeTimers();
});
afterEach(async () => { standardCleanup(); vi.useRealTimers(); vi.restoreAllMocks(); await homes.reset(); });

async function flush() { await flushHookEffects({ runOnlyPendingTimers: true }); }

describe('History unified conversation search', () => {
    it('scans an unready source only on activation and keeps an empty partial page searchable', async () => {
        rpc.mockImplementation(async call => {
            if (call.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1, projection };
            if (call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) return DEFAULT_MEMORY_SETTINGS;
            if (call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST) return call.payload.cursor
                ? { ok: true, candidates: [{ remoteSessionId: 'later-native', updatedAtMs: 1,
                    match: { snippet: 'body phrase', sourceItemId: 'later-message', messageIndex: 0 } }], contentCoverage: 'complete', nextCursor: null }
                : { ok: true, candidates: [], contentCoverage: 'partial', nextCursor: 'remaining-file' };
            throw new Error(`Unexpected History scan transport ${call.method}`);
        });
        const { ExternalSessionsBrowseScreen } = await import('./ExternalSessionsBrowseScreen');
        const screen = await renderScreen(<ExternalSessionsBrowseScreen
            lockScope={{ machineId: 'machine-1', serverId, providerId: 'acme.archive', source: { kind: 'archive' } }} initialSearchTarget="content" />,
        { flushOptions: { runOnlyPendingTimers: true } });
        expect(isMachineOnline(storage.getState().machines['machine-1'])).toBe(true);
        await waitForHomeGovernance(async () => { await flush(); expect(screen.findHostByTestId('direct-session-candidates-search-input')).not.toBeNull(); });
        await act(async () => screen.changeTextByTestId('direct-session-candidates-search-input', 'body phrase'));
        await flush();
        await waitForHomeGovernance(async () => { await flush(); expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)[0].props.contentScanAvailable).toBe(true); });
        expect(rpc.mock.calls.some(([call]) => call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST)).toBe(false);
        await screen.pressByTestIdAsync('direct-session-candidates-content-submit');
        await waitForHomeGovernance(async () => { await flush(); expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)[0].props.nextCursor).toBe('remaining-file'); });
        const list = screen.findAllByType(ExternalSessionBrowseCandidatesList)[0];
        expect(list.props.candidates).toEqual([]);
        expect(list.props.contentCoverage).toBe('partial');
        await screen.pressByTestIdAsync('direct-session-candidates:pagination:more');
        await waitForHomeGovernance(async () => { await flush(); expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)[0].props.candidates).toMatchObject([
            { remoteSessionId: 'later-native', searchMode: 'standard', match: { sourceItemId: 'later-message' } },
        ]); });
        const requests = rpc.mock.calls.filter(([call]) => call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST).map(([call]) => call);
        expect(requests).toMatchObject([
            { machineId: 'machine-1', serverId, accountId: 'history-account', payload: { agentId: 'acme.archive', source: { kind: 'archive' }, searchTerm: 'body phrase', searchTarget: 'content' } },
            { payload: { cursor: 'remaining-file' } },
        ]);
        await act(async () => screen.changeTextByTestId('direct-session-candidates-search-input', 'new phrase'));
        await flush();
        expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)[0].props.candidates).toEqual([]);
        expect(rpc.mock.calls.filter(([call]) => call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST)).toHaveLength(2);
    });
    it('searches a ready native source while standard search is disabled and opens with a mapped Find seed', async () => {
        rpc.mockImplementation(async call => {
            if (call.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1, projection };
            if (call.method === RPC_METHODS.DAEMON_MEMORY_SETTINGS_GET) return { ...DEFAULT_MEMORY_SETTINGS, enabled: true,
                conversationSearch: { standardSearch: { enabled: false }, indexExternal: { enabled: true, agents: ['acme.archive'], historyDays: null, includeToolOutput: false } } };
            if (call.method === RPC_METHODS.DAEMON_MEMORY_STATUS) return { v: 1, enabled: true, indexMode: 'deep', hintsIndexReady: true,
                deepIndexReady: true, activeIndexReady: true, activeIndexSearchable: true, embeddingsEnabled: false, embeddingsMode: 'disabled',
                embeddingsPresetId: null, embeddingsProviderKind: null, embeddingsModelId: null, embeddingsRuntimeState: 'unavailable',
                embeddingsUsingFallback: false, tier1DbPath: null, deepDbPath: null, tier1DbBytes: null, deepDbBytes: null,
                sources: [{ source: { type: 'external_transcript', agentId: 'acme.archive', sourceKey: 'archive' }, state: 'ready' }] };
            if (call.method === RPC_METHODS.DAEMON_MEMORY_SEARCH) return { v: 1, ok: true, hits: [{ type: 'external_transcript',
                source: { type: 'external_transcript', agentId: 'acme.archive', sourceKey: 'archive', nativeSessionId: 'indexed-native' },
                sourceItemId: 'native-message', createdAtFromMs: 1, createdAtToMs: 1, summary: call.payload.query, score: 0.5 }] };
            if (call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE) return { ok: true, sessionId: 'happy-session', created: true };
            throw new Error(`Unexpected History transport ${call.method}`);
        });
        const scopes = await renderHook(() => useServerCredentialAccountScopeBindings([serverId]), { flushOptions: { runOnlyPendingTimers: true } });
        await waitForHomeGovernance(async () => { await flush(); expect(scopes.getCurrent().get(serverId)?.isCurrent()).toBe(true); });
        const lifetime = scopes.getCurrent().get(serverId);
        expect(lifetime?.isCurrent()).toBe(true);
        const { ExternalSessionsBrowseScreen } = await import('./ExternalSessionsBrowseScreen');
        const handoff: { current: FileFindSeedHandoff | undefined } = { current: undefined };
        function HandoffProbe() { handoff.current = useOptionalAppPaneContext()?.fileFindSeedHandoff; return null; }
        const screen = await renderScreen(<AppPaneProvider><HandoffProbe /><ExternalSessionsBrowseScreen accountLifetime={lifetime}
            lockScope={{ machineId: 'machine-1', serverId, providerId: 'acme.archive', source: { kind: 'archive' } }} initialSearchTarget="content" /></AppPaneProvider>,
        { flushOptions: { runOnlyPendingTimers: true } });
        await flush();
        await act(async () => screen.changeTextByTestId('direct-session-candidates-search-input', 'body phrase'));
        await flush();
        await flush();
        const request = rpc.mock.calls.find(([call]) => call.method === RPC_METHODS.DAEMON_MEMORY_SEARCH)?.[0];
        expect(request).toMatchObject({ machineId: 'machine-1', serverId, accountId: 'history-account',
            payload: { query: 'body phrase', externalSource: { agentId: 'acme.archive', sourceKey: 'archive' } } });
        const list = screen.findAllByType(ExternalSessionBrowseCandidatesList)[0];
        expect(list.props.candidates).toMatchObject([{ remoteSessionId: 'indexed-native', searchMode: 'indexed', match: { sourceItemId: 'native-message', snippet: 'body phrase' } }]);
        expect(list.props.candidateActionsDisabled).toBe(false);
        expect(list.props.contentScanAvailable).toBe(false);
        expect(rpc.mock.calls.some(([call]) => call.method === RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST)).toBe(false);
        await screen.pressByTestIdAsync(`direct-session-candidate:${readExternalSessionBrowseCandidateKey(list.props.candidates[0])}`);
        await flush();
        expect(handoff.current?.peekChatCurrent({ sessionId: 'happy-session', serverId })).toEqual({
            query: 'body phrase', options: { matchCase: false, regex: false }, target: { kind: 'route-message-id',
                routeMessageId: makeExternalSessionHistoricalImportLocalId({ agentId: 'acme.archive', remoteSessionId: 'indexed-native', directItemId: 'native-message' }) },
        });
        await act(async () => screen.changeTextByTestId('direct-session-candidates-search-input', 'new phrase'));
        await flush();
        expect(screen.findAllByType(ExternalSessionBrowseCandidatesList)[0].props.candidates[0]?.match.snippet).toBe('new phrase');
    });
});
