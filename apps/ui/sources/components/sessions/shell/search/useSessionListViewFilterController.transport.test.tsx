import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { createCompactSessionListRowFixture, createSessionListSourceFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { SessionListQueryResponseV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { encodeV2SessionListCursorV2 } from '@happier-dev/protocol/sessions/listing/cursor';
import { SESSION_LIST_PAGE_DEFAULT_LIMIT } from '@happier-dev/protocol/sessions/listing/query';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { CollectionSpacesV1Schema } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { SessionOrganizationFolderSchema } from '@happier-dev/protocol/sessions/organization/folders';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityMaterializationsReadActionOutputV1Schema,
    PluginAvailabilityIntentsListActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';

import { renderHook, renderScreen, flushHookEffects, standardCleanup } from '@/dev/testkit';
import { createSessionFixture, createPlainSessionCurrentProjectionRecordFixture, createSessionOwnerViewerFixture,
    createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createSessionListQuerySourceHarness, waitForSessionListQueryState } from '@/dev/testkit/harness/sessionListQuerySourceHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import { sync } from '@/sync/sync';
import { useSessionListQuerySourceState } from '@/sync/domains/session/listing/useSessionListQuerySourceState';
import { useVisibleSessionListSourceState } from '@/hooks/session/useVisibleSessionListSourceState';
import { useVisibleSessionListViewState } from '@/hooks/session/useVisibleSessionListViewState';
import { useVisibleSessionListPaneState } from '@/hooks/session/useVisibleSessionListPaneState';
import { useSessionListViewFilterController } from './useSessionListViewFilterController';
import { useSessionListSpaceNavigation } from './useSessionListSpaceNavigation';
import { clearSessionListViewFilterRetentionForTests } from './useSessionListViewFilters';
import { SessionListFilterControl } from './SessionListFilterControl';
import { useSessionListRowsByServerId, useSessionOrganizationProjections } from '@/sync/domains/state/storage';
import { useSessionListSpaceChrome } from './useSessionListSpaceChrome';
import { SessionListFilterEditor } from './SessionListFilterEditor';
import { buildSessionListFilterEditorLabels } from './SessionListFilterControl';
import { useSessionListFilterEditorOptions } from './useSessionListFilterEditorOptions';
import { useSessionListFilterLocalOptions } from './useSessionListFilterLocalOptions';
import { fetchSessionListQueryPageForHome } from '@/sync/domains/session/listing/sessionListQueryRuntime';
import { projectSessionDisplayV1, SessionDisplayProjectionV1Schema} from '@happier-dev/protocol/sessions';
import { SessionOwnerMetadataV1Schema,
    SessionSharedMetadataV1Schema} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionCreationCorrespondenceV1Schema} from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { createSessionDisplayCrypto } from '@/sync/encryption/sessionDisplayCrypto';
import { resolveAgentExecutionTargetFromSessionMetadata } from '@happier-dev/agents';
import { matchSessionListRowLocalFilter } from '@/sync/domains/session/listing/sessionListWorkFilter';
import { buildSessionListCacheEntriesFromRenderables, buildSessionListRenderableFromCacheEntry } from '@/sync/domains/state/warmCacheAdapters';
import { SessionListCacheEntryV1Schema } from '@/sync/domains/state/warmCachePersistence';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';

// Native presentation and Socket.IO are external boundaries; Account, Settings,
// selection, query lifecycle, hydration and store owners below remain real.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

afterEach(() => { standardCleanup(); clearSessionListViewFilterRetentionForTests(); });

describe('saved Session spaces through the mounted query transport', () => {
    it('keeps qualified manual membership from both Homes before pagination without draining pages', async () => {
        const boundary = await createSessionListQuerySourceHarness();
        const home = boundary.serverIds[0]!;
        const peer = boundary.serverIds[1]!;
        // The pagination owner fills short transport pages up to its caller's
        // page policy; a full first page leaves the next page for explicit demand.
        const firstPageIds = Array.from({ length: SESSION_LIST_PAGE_DEFAULT_LIMIT }, (_, index) => `same-id-${index}`);
        const firstPageAddresses = [home, peer].flatMap(serverId => firstPageIds.map(sessionId => ({ serverId, sessionId })));
        const nextCursor = encodeV2SessionListCursorV2({ sessionId: firstPageIds.at(-1)!, meaningfulActivityAt: 1 });
        try {
            await boundary.http.selectHomes([home, peer]);
            const features = createRootLayoutFeaturesResponse({ features: { sessions: { enabled: true,
                filteredListing: { enabled: true, membershipSelectorVersion: 1 } } } });
            for (const serverId of [home, peer]) {
                for (const path of ['/v1/features', '/v1/features/authenticated']) boundary.http.answer(serverId, path, { body: features });
                await getServerFeaturesSnapshot({ serverId, force: true });
                boundary.http.answer(serverId, '/v2/sessions/query', { select(input) {
                    const cursor = input && typeof input === 'object' && 'cursor' in input ? input.cursor : null;
                    return { body: createSessionListSourceFixture({ sessions: (cursor ? ['beyond-first-page'] : firstPageIds).map(id => {
                        const row = createSessionFixture({ id, ownerAccountId: boundary.accountId(serverId), active: true });
                        return {
                            ...createPlainSessionCurrentProjectionRecordFixture({ id, active: true, activeAt: Date.now(),
                                metadata: { ...row.metadata!, machineId: 'different-machine' } }),
                            viewer: { ...createSessionOwnerViewerFixture(row), tagIds: ['manual'] },
                        };
                    }), nextCursor: serverId === home && !cursor ? nextCursor : null,
                    hasNext: serverId === home && !cursor, attentionNextCursor: null, attentionHasNext: false }) };
                } });
            }
            const filter = normalizeSessionListFilterV1({ homeServerIds: [home, peer], scope: 'all_accessible',
                includeInactive: true, show: 'sessions', machines: { include: [
                    { serverId: home, machineId: 'smart-machine' }, { serverId: peer, machineId: 'smart-machine' },
                ], exclude: [] } });
            const settings = settingsParse({ ...storage.getState().settings, collectionSpacesV1: { v: 1, spaces: [{
                entityKind: 'sessionWork', id: 'cross-home', name: 'Cross Home', icon: { kind: 'icon', name: 'filter' },
                filter, includeNeedsYouEverywhere: false, membership: { mode: 'filter_or_manual', tags: [
                    { serverId: home, accountId: boundary.accountId(home), tagId: 'manual' },
                    { serverId: peer, accountId: boundary.accountId(peer), tagId: 'manual' },
                ] },
            }] } });
            boundary.http.answer(home, '/v2/account/settings', { body: AccountSettingsV2GetResponseSchema.parse({
                content: { t: 'plain', v: settings }, version: 2,
            }) });
            storage.setState({ settings, settingsVersion: 2, settingsScope: { serverId: home, accountId: boundary.accountId(home) } });
            const pane = await renderHook(() => {
                const controller = useSessionListViewFilterController();
                return { controller, navigation: useSessionListSpaceNavigation(controller), state: useVisibleSessionListPaneState('all', {
                    queryHomes: controller.pagingHomes, workFilter: controller.displayFilters, spaceMembership: controller.spaceMembership,
                }) };
            });
            try {
                await waitForSessionListQueryState(() => expect(pane.getCurrent().controller.spacesReady).toBe(true));
                const baseline = boundary.http.requests.length;
                await act(async () => { expect(await pane.getCurrent().navigation.selectSpace('cross-home')).toBe(true); });
                const qualifiedRows = () => [home, peer].flatMap(serverId =>
                    pane.getCurrent().state.query?.statesByServerId[serverId]?.addresses ?? []);
                await waitForSessionListQueryState(() => {
                    for (const serverId of [home, peer]) expect(pane.getCurrent().state.query?.statesByServerId[serverId]?.phase).toBe('ready');
                    expect(qualifiedRows()).toEqual(firstPageAddresses);
                });
                expect(pane.getCurrent().state.query?.coverageComplete).toBe(false);
                const pageRequests = () => boundary.http.requests.slice(baseline).filter(request => request.path === '/v2/sessions/query');
                expect(pageRequests()).toHaveLength(2);
                for (const serverId of [home, peer]) expect(pageRequests().find(request => request.serverId === serverId)?.input)
                    .toMatchObject({ membership: { mode: 'filter_or_manual', tagIds: ['manual'] } });
                await act(async () => { await pane.getCurrent().state.query?.loadNext(); });
                await waitForSessionListQueryState(() => expect(pane.getCurrent().state.query?.coverageComplete).toBe(true));
                expect(qualifiedRows()).toEqual(expect.arrayContaining([
                    ...firstPageAddresses,
                    { serverId: home, sessionId: 'beyond-first-page' },
                ]));
                expect(qualifiedRows()).toHaveLength(firstPageAddresses.length + 1);
                expect(pageRequests()).toHaveLength(3);
                expect(pageRequests()[2]).toMatchObject({ serverId: home, input: { cursor: nextCursor } });
            } finally { await pane.unmount(); }
        } finally { await boundary.dispose(); }
    });
    it.each([false, true])('renders manual candidates through the membership-capable Home only (supported: %s)', async supported => {
        const boundary = await createSessionListQuerySourceHarness();
        const home = boundary.serverIds[0]!;
        try {
            await boundary.http.selectHomes([home]);
            const features = createRootLayoutFeaturesResponse({ features: { sessions: { enabled: true,
                filteredListing: { enabled: true, ...(supported ? { membershipSelectorVersion: 1 as const } : {}) } } } });
            for (const path of ['/v1/features', '/v1/features/authenticated']) boundary.http.answer(home, path, { body: features });
            await getServerFeaturesSnapshot({ serverId: home, force: true });
            const filter = normalizeSessionListFilterV1({ homeServerIds: [home], scope: 'following', includeInactive: true, show: 'sessions',
                machines: { include: [{ serverId: home, machineId: 'smart-machine' }], exclude: [] } });
            const settings = settingsParse({ ...storage.getState().settings, collectionSpacesV1: { v: 1, spaces: [{
                entityKind: 'sessionWork', id: 'mixed', name: 'Mixed', icon: { kind: 'icon', name: 'filter' },
                filter, includeNeedsYouEverywhere: false,
                membership: { mode: 'filter_or_manual', tags: [{ serverId: home, accountId: boundary.accountId(home), tagId: 'manual' }] },
            }] } });
            boundary.http.answer(home, '/v2/account/settings', { body: AccountSettingsV2GetResponseSchema.parse({
                content: { t: 'plain', v: settings }, version: 2,
            }) });
            storage.setState({ settings, settingsVersion: 2, settingsScope: { serverId: home, accountId: boundary.accountId(home) } });
            const row = createSessionFixture({ id: 'explicit-member', ownerAccountId: boundary.accountId(home), active: true });
            boundary.http.answer(home, '/v2/sessions/query', { body: createSessionListSourceFixture({
                sessions: [{ ...createPlainSessionCurrentProjectionRecordFixture({ id: row.id, active: true, activeAt: Date.now(),
                    metadata: { ...row.metadata!, machineId: 'different-machine' } }), viewer: { ...createSessionOwnerViewerFixture(row), tagIds: ['manual'] } }],
                nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
                membershipUnavailableReason: 'following',
            }) });
            const pane = await renderHook(() => {
                const controller = useSessionListViewFilterController();
                return { controller, navigation: useSessionListSpaceNavigation(controller), state: useVisibleSessionListPaneState('all', {
                    queryHomes: controller.pagingHomes, workFilter: controller.displayFilters, spaceMembership: controller.spaceMembership,
                }) };
            });
            try {
                await waitForSessionListQueryState(() => expect(pane.getCurrent().controller.spacesReady).toBe(true));
                const baseline = boundary.http.requests.length;
                await act(async () => { expect(await pane.getCurrent().navigation.selectSpace('mixed')).toBe(true); });
                await waitForSessionListQueryState(() => expect(pane.getCurrent().state.query?.statesByServerId[home]?.phase)
                    .toBe(supported ? 'ready' : 'error'));
                if (supported) {
                    expect(pane.getCurrent().state.filterResult?.matchedCount).toBe(1);
                    expect(pane.getCurrent().state.visibleSessionListIndex?.flatMap(item => item.type === 'session'
                        ? [{ serverId: item.serverId, sessionId: item.sessionId }] : []))
                        .toEqual([{ serverId: home, sessionId: row.id }]);
                    expect(pane.getCurrent().state.queryPresentation).toEqual({ kind: 'partial', unavailableHomes: [{ serverId: home, reason: 'unsupported' }] });
                }
                else expect(boundary.http.requests.slice(baseline).filter(request => /^\/v[12]\/sessions(?:[/?]|$)/.test(request.path))).toEqual([]);
                expect(pane.getCurrent().controller.queryHomes[0]?.query.membership?.tagIds).toEqual(['manual']);
            } finally { await pane.unmount(); }
        } finally { await boundary.dispose(); }
    });
    it.each(['picker', 'local filter', 'inactive surface', 'persisted warm picker'] as const)('demands exact private configured targets from compact display through the %s rather than their shared presentation', async demandVia => {
        const boundary = await createSessionListQuerySourceHarness();
        const home = boundary.serverIds[0]!;
        try {
            boundary.http.answer(home, PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'], {
                body: PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({ availabilityCursor: 0, snapshots: [] }),
            });
            boundary.http.answer(home, PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], {
                body: PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 0, pluginIds: [], intentReads: [], failedPluginIds: [] }),
            });
            await sync.awaitBootstrapForegroundAcquisition();
            await boundary.http.selectHomes([home]);
            const targets = ['private-review', 'private-build'].map(definitionId => ({ kind: 'agent' as const,
                identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId }));
            const records = await Promise.all(targets.map(async (target, index) => {
                const id = `cold-configured-agent-${index}`;
                const correspondence = SessionCreationCorrespondenceV1Schema.parse({ v: 1,
                    sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'cold-agent-test', creationKey: id }),
                    recipe: { execution: { machineId: 'm', directory: { kind: 'path', path: '/repo' } },
                        organization: { folderId: null, tagIds: [] }, agentTarget: target,
                        modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null,
                        configuration: null, connectedServices: null, capabilitySelection: null, transcriptStorage: null,
                        terminal: null, agentSessionStartupInstructionsMarkerV1: null, checkout: null },
                });
                const metadata = { name: id, path: '/repo', host: 'host', flavor: 'custom-acp',
                    agentPresentation: { agentId: 'custom-acp', label: 'Shared ACP presentation' },
                    sessionCreationCorrespondenceV1: correspondence };
                expect(resolveAgentExecutionTargetFromSessionMetadata(metadata)).toEqual(target);
                const full = createPlainSessionCurrentProjectionRecordFixture({ id, metadata });
                if (full.ownerMetadata?.t !== 'plain') throw new Error('Expected the canonical plaintext owner fixture');
                const display = projectSessionDisplayV1({ sharedMetadata: SessionSharedMetadataV1Schema.parse(JSON.parse(full.metadata!)),
                    ownerMetadata: SessionOwnerMetadataV1Schema.parse(full.ownerMetadata.v) });
                expect(display.shared.agentPresentation).toEqual(metadata.agentPresentation);
                const crypto = createSessionDisplayCrypto({ sessionMode: 'plain', accountMode: 'plain',
                    credentials: { token: 'plaintext-sealer', secret: '' } });
                const displayProjectionV1 = SessionDisplayProjectionV1Schema.parse({ v: 1,
                    sourceMetadataVersion: full.metadataVersion, metadataLayoutVersion: 1,
                    shared: await crypto.encodeSharedDisplay(display.shared), owner: crypto.encodeOwnerDisplay(display.owner!) });
                expect(JSON.stringify(displayProjectionV1)).not.toContain(target.definitionId);
                return { ...full, displayProjectionV1, viewer: createSessionOwnerViewerFixture(createSessionFixture({
                    id, ownerAccountId: boundary.accountId(home), metadata,
                })) };
            }));
            const page = createSessionListSourceFixture({ sessions: records, nextCursor: 'agent-next', hasNext: true,
                attentionNextCursor: null, attentionHasNext: false });
            SessionListQueryResponseV1Schema.parse({ ...page, sessions: records.map(createCompactSessionListRowFixture) });
            boundary.http.answer(home, '/v2/sessions/query', { body: page });
            for (const record of records) boundary.http.answer(home, `/v2/sessions/${record.id}`, { body: { session: record } });
            let baseline = boundary.http.requests.length;
            const fullReads = () => boundary.http.requests.slice(baseline).filter(request => request.path === '/v2/sessions/read-batch');
            const refreshDisplay = () => fetchSessionListQueryPageForHome(home, { source: { kind: 'query', allowV1Fallback: false,
                body: { v: 1, storage: 'active', includeInactive: true, scope: 'all_accessible', attention: 'any', audiences: [], tagIds: [], includeAttention: false } },
                membership: 'rowOnly', signal: new AbortController().signal });
            await refreshDisplay();
            const readRow = (index: number) => storage.getState().sessionListRowsByServerId[home]?.[records[index]!.id];
            expect(records.map((_, index) => readRow(index)?.metadata?.flavor)).toEqual(['custom-acp', 'custom-acp']);
            expect(fullReads()).toHaveLength(0);
            if (demandVia === 'persisted warm picker') {
                const homes = [{ serverId: home, label: 'Configured Home' }];
                const seed = await renderHook(() => useSessionListFilterLocalOptions(homes, 'agents', false));
                try {
                    await waitForSessionListQueryState(() => expect(seed.getCurrent().agents.map(option => option.agentTargetKey))
                        .toEqual(expect.arrayContaining(targets.map(buildBackendTargetKeyV2))));
                } finally { await seed.unmount(); }
                const entries = buildSessionListCacheEntriesFromRenderables(storage.getState().sessionListRowsByServerId[home] ?? {});
                const serialized = JSON.stringify(entries);
                for (const target of targets) expect(serialized).not.toContain(target.definitionId);
                expect(serialized).not.toContain('agentTargetKey');
                const restored = Object.values(JSON.parse(serialized) as Record<string, unknown>)
                    .map(entry => SessionListCacheEntryV1Schema.parse(entry));
                // The same cache-to-row/store boundary used by Sync's warm restore; no memory witnesses survive JSON.
                storage.getState().applyServerScopedSessionListRows(home, restored.map(buildSessionListRenderableFromCacheEntry),
                    { source: 'ordinary', mode: 'replace' });
                expect(records.map((_, index) => readRow(index)?.agentTargetKey)).toEqual([undefined, undefined]);
                baseline = boundary.http.requests.length;
                await refreshDisplay();
                expect(fullReads()).toHaveLength(0);
            }
            if (demandVia === 'inactive surface') {
                const keys = targets.map(buildBackendTargetKeyV2);
                const workFilter = normalizeSessionListFilterV1({ homeServerIds: [home],
                    startedBy: ['you', 'agents', 'triggers'], agents: { include: [keys[0]!], exclude: [] } });
                const homes = [{ serverId: home, queryMembership: 'rowOnly' as const, query: {
                    v: 1 as const, storage: 'active' as const, includeInactive: true, scope: 'all_accessible' as const,
                    attention: 'any' as const, audiences: [], tagIds: [], includeAttention: false, limit: records.length,
                } }];
                let setActive: React.Dispatch<React.SetStateAction<boolean>> | undefined;
                const view = await renderHook(() => {
                    const [active, updateActive] = React.useState(false);
                    setActive = updateActive;
                    return useVisibleSessionListViewState('all', { queryHomes: homes, workFilter,
                        sessionListSurfaceDataActive: active });
                });
                try {
                    await waitForSessionListQueryState(() => expect(view.getCurrent().query?.statesByServerId[home]?.phase).toBe('ready'));
                    await flushHookEffects();
                    expect(fullReads()).toHaveLength(0);
                    expect(records.map((_, index) => readRow(index)?.agentTargetKey)).toEqual([undefined, undefined]);
                    await act(async () => setActive!(true));
                    await waitForSessionListQueryState(() => expect(readRow(0)?.agentTargetKey).toBe(keys[0]));
                    expect(readRow(1)?.agentTargetKey).toBe(keys[1]);
                    expect(fullReads()).toHaveLength(1);
                    expect(matchSessionListRowLocalFilter(readRow(0)!, home, workFilter, { nowMs: 1_000 })).toBe('match');
                    expect(matchSessionListRowLocalFilter(readRow(1)!, home, workFilter, { nowMs: 1_000 })).toBe('miss');
                    for (const record of records) expect(storage.getState().sessions[record.id]).toBeUndefined();
                } finally { await view.unmount(); }
                return;
            }
            let controller: ReturnType<typeof useSessionListViewFilterController> | undefined;
            let querySource: ReturnType<typeof useSessionListQuerySourceState> | undefined;
            function MountedPicker() {
                controller = useSessionListViewFilterController();
                // Two compact records fill this caller's requested page. Preserve
                // the next cursor without fabricating a repeating short response.
                const homes = React.useMemo(() => controller!.pagingHomes?.map(home => ({ ...home,
                    query: { ...home.query, limit: records.length } })), [controller.pagingHomes]);
                const source = useVisibleSessionListSourceState({ queryHomes: homes,
                    emptyQuerySelectionComplete: controller.emptyQuerySelectionComplete,
                    agentTargetDemand: Boolean(controller.filters.agents
                        && controller.filters.agents.include.length + controller.filters.agents.exclude.length > 0) });
                querySource = source.query;
                const homeIds = React.useMemo(() => controller!.homeOptions.map(option => option.serverId), [controller.homeOptions]);
                const options = useSessionListFilterEditorOptions(homeIds, controller.filters.homeServerIds);
                return <SessionListFilterEditor {...options} {...controller} homes={controller.homeOptions}
                    labels={buildSessionListFilterEditorLabels()} disableTransitions />;
            }
            const screen = await renderScreen(<MountedPicker />);
            try {
                await flushHookEffects();
                await waitForSessionListQueryState(() => expect(querySource?.statesByServerId[home]?.phase).toBe('ready'));
                expect(fullReads()).toHaveLength(0);
                const queryReadsBeforeDemand = boundary.http.requests.filter(request => request.path === '/v2/sessions/query').length;
                const targetKeys = targets.map(buildBackendTargetKeyV2);
                if (demandVia === 'picker' || demandVia === 'persisted warm picker') {
                    await screen.pressByTestIdAsync('collection-filter-add');
                    await screen.pressByTestIdAsync('collection-filter-field:agents');
                    for (const key of targetKeys) await vi.waitFor(() =>
                        expect(screen.findByTestId(`collection-filter-value:agents:${key}`)).not.toBeNull());
                    await screen.pressByTestIdAsync(`collection-filter-value:agents:${targetKeys[0]}`);
                } else {
                    // A local condition can be enabled after the compact corpus is already loaded.
                    await act(async () => controller!.updateFilters(previous => ({ ...previous,
                        agents: { include: [targetKeys[0]!], exclude: [] } })));
                    await vi.waitFor(() => expect(readRow(0)?.agentTargetKey).toBe(targetKeys[0]));
                    expect(readRow(1)?.agentTargetKey).toBe(targetKeys[1]);
                }
                expect(fullReads()).toHaveLength(1);
                expect(fullReads()[0]?.input).toMatchObject({ sessionIds: records.map(record => record.id),
                    includeSnapshot: true, includeTurns: false, includeMessages: false });
                expect(matchSessionListRowLocalFilter(readRow(0)!, home, controller!.filters, { nowMs: 1_000 })).toBe('match');
                expect(matchSessionListRowLocalFilter(readRow(1)!, home, controller!.filters, { nowMs: 1_000 })).toBe('miss');
                expect(boundary.http.requests.filter(request => request.path === '/v2/sessions/query')).toHaveLength(queryReadsBeforeDemand);
                expect(querySource?.statesByServerId[home]).toMatchObject({ nextCursor: 'agent-next', hasNext: true });
                for (const record of records) expect(storage.getState().sessions[record.id]).toBeUndefined();
            } finally { await screen.unmount(); }
        } finally { await boundary.dispose(); }
    });

    it('composes Project + Agent + Section through UI controls and session.list.view.set on the same real controller', async () => {
        const boundary = await createSessionListQuerySourceHarness();
        const home = boundary.serverIds[0]!;
        try {
            boundary.http.answer(home, PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'], {
                body: PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({ availabilityCursor: 0, snapshots: [] }),
            });
            boundary.http.answer(home, PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], {
                body: PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 0, pluginIds: [], intentReads: [], failedPluginIds: [] }),
            });
            await sync.awaitBootstrapForegroundAcquisition();
            await sync.refreshPluginAccountAvailability();
            await boundary.http.selectHomes([home]);
            const settings = settingsParse({ ...storage.getState().settings, collectionSpacesV1: { v: 1, spaces: [] } });
            storage.setState({ settings, settingsVersion: 2, settingsScope: { serverId: home, accountId: boundary.accountId(home) } });
            const ref = { id: 'project-workspace', serverId: home, machineId: 'machine-a', rootPath: '/repo',
                projectKey: 'project-a', label: 'Project A', createdAtMs: 1 };
            applyProjectAccountRowsFixture(storage, { workspaceRefs: [ref] });
            const session = createSessionFixture({ id: 'matching-session', ownerAccountId: boundary.accountId(home),
                projectKey: 'project-a', metadata: { ...createSessionFixture().metadata!, flavor: 'codex', machineId: 'machine-a',
                    path: '/repo', projectId: 'project-a', workspaceId: ref.id } });
            const page = createSessionListSourceFixture({ sessions: [{ ...createPlainSessionCurrentProjectionRecordFixture({
                id: session.id, active: true, activeAt: Date.now(), metadata: session.metadata, projectKey: 'project-a',
            }), viewer: createSessionOwnerViewerFixture(session) }], nextCursor: null, hasNext: false,
                attentionNextCursor: null, attentionHasNext: false });
            for (const path of ['/v2/sessions', '/v2/sessions/active', '/v2/sessions/query']) boundary.http.answer(home, path, { body: page });
            boundary.http.answer(home, `/v2/sessions/${session.id}`, { body: { session: page.sessions[0] } });
            await sync.refreshSessions({ awaitSessionListHydration: true });
            const agent = buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' });
            await vi.waitFor(() => expect(Object.values(storage.getState().sessionListRowsByServerId)
                .flatMap(rows => Object.values(rows)).find(row => row.id === session.id)?.agentTargetKey).toBe(agent));
            storage.getState().applySessionOrganizationSnapshot(home, { schemaVersion: 1, version: 10, pins: [], tags: [],
                tagAssignments: [], orderEntries: [], labels: [], folderAssignments: [{ sessionId: 'matching-session', folderId: 'section-a' }],
                folders: [{ ...SessionOrganizationFolderSchema.parse({ folderId: 'section-a', folderKey: 'section-a', parentFolderId: null,
                    parentFolderKey: null, sortKey: null, display: { t: 'plain', v: { name: 'Release', icon: null } },
                    archivedAt: null, createdAt: 1, updatedAt: 1 }),
                    displayState: { status: 'available', value: { name: 'Release', icon: null } } }],
            }, { includeAllFolderAssignments: true });
            let current: ReturnType<typeof useSessionListViewFilterController> | undefined;
            let currentPane: ReturnType<typeof useVisibleSessionListPaneState> | undefined;
            function MountedFilters() {
                const controller = useSessionListViewFilterController();
                current = controller;
                currentPane = useVisibleSessionListPaneState('all', {
                    queryHomes: controller.pagingHomes, workFilter: controller.displayFilters,
                    spaceMembership: controller.spaceMembership,
                });
                const ids = React.useMemo(() => controller.homeOptions.map(home => home.serverId), [controller.homeOptions]);
                const organization = useSessionOrganizationProjections(ids);
                const chrome = useSessionListSpaceChrome({ controller, organizationProjectionsByServerId: organization });
                const options = useSessionListFilterEditorOptions(ids, controller.filters.homeServerIds);
                return <>
                    <SessionListFilterControl controller={controller} spaceChrome={chrome} organizationProjectionsByServerId={organization} />
                    <SessionListFilterEditor {...options} {...controller} homes={controller.homeOptions}
                        labels={buildSessionListFilterEditorLabels()} disableTransitions />
                </>;
            }
            const screen = await renderScreen(<MountedFilters />);
            await vi.waitFor(() => expect(current?.spacesReady).toBe(true));
            const homes = current!.homeOptions;
            const admittedRow = Object.values(storage.getState().sessionListRowsByServerId)
                .flatMap(rows => Object.values(rows)).find(row => row.id === session.id)!;
            await act(async () => {
                storage.getState().applyServerScopedSessionListRows(home,
                    Array.from({ length: 1_000 }, (_, index) => createSessionListRenderableSessionFixture({ ...admittedRow,
                        id: index === 0 ? session.id : `agent-options-${index}` })), { source: 'ordinary', mode: 'replace' });
            });
            const rowProbe = await renderHook(() => useSessionListRowsByServerId([home]));
            expect(Object.values(rowProbe.getCurrent()).flatMap(rows => Object.values(rows))).toHaveLength(1_000);
            await rowProbe.unmount();
            let optionRenders = 0;
            const options = await renderHook(() => {
                optionRenders += 1;
                return useSessionListFilterLocalOptions(homes, 'agents', false);
            });
            const originalOptions = options.getCurrent().agents;
            const rendersBeforeArrival = optionRenders;
            expect(originalOptions).toEqual(expect.arrayContaining([expect.objectContaining({ agentTargetKey: agent })]));
            const beforeArrival = boundary.http.requests.length;
            const rowBeforeArrival = Object.values(storage.getState().sessionListRowsByServerId)
                .flatMap(rows => Object.values(rows)).find(row => row.id === session.id)!;
            await act(async () => {
                storage.getState().applyServerScopedSessionListRowPatches(home, [{ sessionId: session.id,
                    patch: previous => ({ updatedAt: previous.updatedAt + 1, seq: previous.seq + 1 }) }]);
            });
            expect(Object.values(storage.getState().sessionListRowsByServerId).flatMap(rows => Object.values(rows))
                .find(row => row.id === session.id)?.seq).toBe(rowBeforeArrival.seq + 1);
            expect(options.getCurrent().agents).toBe(originalOptions);
            expect(optionRenders).toBe(rendersBeforeArrival);
            expect(boundary.http.requests.slice(beforeArrival).filter(request => /^\/v[12]\/sessions(?:[/?]|$)/.test(request.path))).toEqual([]);
            await options.unmount();
            const project = { serverId: home, projectKey: 'project-a' };
            const section = { serverId: home, sectionId: 'section-a' };
            for (const [fieldId, value] of [['projects', project], ['agents', agent], ['sections', section]] as const) {
                await screen.pressByTestIdAsync('collection-filter-add');
                await screen.pressByTestIdAsync(`collection-filter-field:${fieldId}`);
                const valueId = `collection-filter-value:${fieldId}:${typeof value === 'string' ? value : JSON.stringify(value)}`;
                await vi.waitFor(() => expect(screen.findByTestId(valueId)).not.toBeNull());
                await screen.pressByTestIdAsync(valueId);
                await screen.pressByTestIdAsync('collection-filter-back');
            }
            expect(screen.getTextContent()).toContain('Release');
            const composed = { projects: { include: [project], exclude: [] }, agents: { include: [agent], exclude: [] },
                sections: { include: [section], exclude: [] } };
            expect(current?.filters).toMatchObject(composed);
            const expectMatchingRow = async () => waitForSessionListQueryState(() => {
                expect(currentPane?.query?.statesByServerId[home]?.phase).toBe('ready');
                expect(currentPane?.visibleSessionListIndex?.flatMap(item => item.type === 'session'
                    ? [{ serverId: item.serverId, sessionId: item.sessionId }] : []))
                    .toEqual([{ serverId: home, sessionId: session.id }]);
                expect(currentPane?.filterResult?.matchedCount).toBe(1);
            });
            await expectMatchingRow();
            for (const id of ['projects', 'agents', 'sections']) expect(screen.findByTestId(`collection-filter-condition:${id}:is`)).not.toBeNull();
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            const executor = createDefaultActionExecutor();
            const actionContext = { surface: 'agent' as const, serverId: home };
            expect(await executor.execute('session.list.view.get', {}, actionContext)).toMatchObject({ ok: true, result: { filters: composed } });
            await act(async () => { expect(await executor.execute('session.list.view.reset', {}, actionContext)).toEqual({ ok: true, result: { ok: true } }); });
            expect(current?.filters.agents).toBeUndefined();
            await act(async () => { expect(await executor.execute('session.list.view.set', { filters: composed }, actionContext)).toEqual({ ok: true, result: { ok: true } }); });
            expect(current?.filters).toMatchObject(composed);
            await expectMatchingRow();
            for (const id of ['projects', 'agents', 'sections']) expect(screen.findByTestId(`collection-filter-condition:${id}:is`)).not.toBeNull();
            await screen.unmount();
        } finally { standardCleanup(); await boundary.dispose(); }
    });

});
