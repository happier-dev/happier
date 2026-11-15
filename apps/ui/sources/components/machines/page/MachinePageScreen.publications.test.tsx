import * as React from 'react';
import 'fake-indexeddb/auto';
import type { ReactTestInstance, ReactTestRendererJSON } from 'react-test-renderer';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createServedHomeAccountToken, serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const probe = vi.hoisted(() => ({ commits: {} as Record<string, number>, rpc: vi.fn() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    params: { id: 'publication-machine', serverId: 'srv_page_publications', tab: 'overview' },
}).module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(probe.rpc));
vi.mock('@/components/machines/resources/ask/MachineResourcesAskBlock', async importOriginal => {
    const original = await importOriginal<typeof import('@/components/machines/resources/ask/MachineResourcesAskBlock')>();
    const React = await import('react');
    const { useLayoutPresentationActive } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
    return { ...original, MachineResourcesAskBlock: (props: React.ComponentProps<typeof original.MachineResourcesAskBlock>) => {
        const presented = useLayoutPresentationActive();
        return <React.Profiler id={`Ask ${presented ? 'presented' : 'hidden'}`} onRender={id => {
            probe.commits[id] = (probe.commits[id] ?? 0) + 1;
        }}><original.MachineResourcesAskBlock {...props} /></React.Profiler>;
    } };
});
vi.mock('./MachinePageHeader', async importOriginal => {
    const original = await importOriginal<typeof import('./MachinePageHeader')>();
    const React = await import('react');
    return { ...original, MachinePageHeader: (props: React.ComponentProps<typeof original.MachinePageHeader>) =>
        <React.Profiler id="Machine header" onRender={id => { probe.commits[id] = (probe.commits[id] ?? 0) + 1; }}>
            <original.MachinePageHeader {...props} />
        </React.Profiler> };
});
vi.mock('@/components/machines/vitals/MachineVitalsOverview', async importOriginal => {
    const original = await importOriginal<typeof import('@/components/machines/vitals/MachineVitalsOverview')>();
    const React = await import('react');
    return { ...original, MachineVitalsOverview: (props: React.ComponentProps<typeof original.MachineVitalsOverview>) =>
        <React.Profiler id="Vitals overview" onRender={id => { probe.commits[id] = (probe.commits[id] ?? 0) + 1; }}>
            <original.MachineVitalsOverview {...props} />
        </React.Profiler> };
});
// Call-through instrumentation only: the real retention primitive and every body remain in the tree.
// The profiler is INSIDE the primitive so it counts descendant commits, including subscription updates.
vi.mock('@/components/ui/panels/RetainedPanelSurface', async importOriginal => {
    const original = await importOriginal<typeof import('@/components/ui/panels/RetainedPanelSurface')>();
    const React = await import('react');
    return { ...original, RetainedPanelSurface: (props: React.ComponentProps<typeof original.RetainedPanelSurface>) =>
        <original.RetainedPanelSurface {...props}>
            <React.Profiler id={props.testID ?? 'retained'} onRender={id => {
                probe.commits[id] = (probe.commits[id] ?? 0) + 1;
            }}>{props.children}</React.Profiler>
        </original.RetainedPanelSurface> };
});
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { MachinePageScreen } = await import('./MachinePageScreen');
const { storage } = await import('@/sync/domains/state/storageStore');
const { machineResourceStore } = await import('@/sync/domains/machines/resources/machineResourceStore');
const { machineStorageStore } = await import('@/sync/domains/machines/storage/machineStorageStore');
const { machineProcessesStore } = await import('@/sync/domains/machines/processes/machineProcessesStore');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const { NewSessionEmbeddedHostProvider } = await import('@/components/sessions/new/navigation/newSessionHost');
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { useLayoutPresentationActive } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');

function renderedText(node: ReactTestInstance): string {
    return node.children.map(child => typeof child === 'string' ? child : renderedText(child)).join('');
}

let restoreActEnvironment = () => {};

afterEach(() => {
    restoreActEnvironment();
    standardCleanup();
    machineResourceStore.reset();
    machineStorageStore.reset();
    machineProcessesStore.reset();
    probe.rpc.mockReset();
    probe.commits = {};
});

it('attributes real page publications, suspends plugin-free hidden bodies, and reveals their current retained data', async () => {
    const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const { HappierStorageSummaryV1Schema } = await import('@happier-dev/protocol/storage/storageV1');
    const { MachineProcessesAnswerV1Schema } = await import('@happier-dev/protocol/machines/processes/machineProcessesV1');
    await prepareSessionDraftPersistenceStorage();
    const serverId = 'srv_page_publications';
    const machine = createMachineFixture({ id: 'publication-machine', active: true, activeAt: Date.now(), storageMode: 'plain', isShared: false });
    const token = createServedHomeAccountToken('account-a', true);
    const row = createPlainMachineRowFixture({ id: machine.id, accountId: 'account-a', machine });
    const connection = await serveAccountHomes({
        homes: [{ key: 'page', serverUrl: 'https://page-publications.example.test', serverIdentityId: serverId,
            accountId: 'account-a', credentials: { token }, currentAccount: true }],
        route: request => request.path === '/v1/machines/read-batch'
            ? createMachineReadBatchResponseFixture(request.body, id => id === machine.id ? row : null)
            : request.path === '/v1/machines' ? Response.json([row]) : undefined,
    });
    onTestFinished(() => connection.dispose());
    const accountId = captureActiveServerAccountScopeLifetime()!.scope.accountId;
    storage.setState({ isDataReady: true, isSessionDraftsReady: true });
    await publishMachineInventoryForTest({ serverId: connection.homes.page!.id, accountId }, [machine]);
    let at = Date.now();
    let processMemory = 1_000_000;
    let storageBytes = 4_000_000_000;
    probe.rpc.mockImplementation(({ method }: { method: string }) => {
        if (method.includes('watch') || method.includes('history')) return new Promise(() => {});
        if (method === RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET) return Promise.resolve(HappierStorageSummaryV1Schema.parse({
            revision: at, sizedAt: at, volumes: [], categories: [{ categoryId: 'caches', count: 1,
                size: { allocatedBytes: storageBytes, freesBytes: storageBytes, sharedBytes: 0, sharedExtentsUnmeasured: false, atLeast: false },
                canGoBytes: storageBytes, detailFacts: {} }], suggestionsTop: [],
            pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] }, trash: { count: 0, allocatedBytes: 0 }, wholeDisk: { enabled: false, scans: [] },
        }));
        if (method === RPC_METHODS.MACHINES_PROCESSES_LIST) return Promise.resolve(MachineProcessesAnswerV1Schema.parse({
            v: 1, machineId: machine.id, capturedAtMs: at, state: 'live', platform: 'linux', evidenceModel: 'fenced', owners: [],
            leftBehind: [{ rowId: 'left', ref: 'left', name: 'retained-vite', pid: 20, startedAtMs: 1, level: 'left_behind',
                memoryBytes: processMemory, memoryKind: 'rss', owner: { kind: 'session', sessionId: 'finished' }, confirmedAtMs: 1 }],
            totals: { happier: { processCount: 0, memoryBytes: 0 }, leftBehind: { processCount: 1, memoryBytes: processMemory } },
        }));
        if (method.includes('vitals') && !method.includes('summaries')) return Promise.resolve({ state: 'reporting', sample: {
            v: 1, sampledAt: at, intervalMs: 2_000, cpu: { reported: true, busyPct: at % 100 },
            memory: { reported: true, totalBytes: 100, availableBytes: 80, usedBytes: 20, pressure: { level: 'calm', source: 'psi' } },
            disk: { reported: true, volumes: [] }, network: { reported: true, rxBps: 12, txBps: 3 },
        }, series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] }, attention: { level: 'calm', reasons: [] } });
        return new Promise(() => {});
    });
    const vitalsKey = { serverId, machineId: machine.id, expectedAccountId: accountId, view: 'overview' as const };
    const storageKey = { serverId, machineId: machine.id, expectedAccountId: accountId };
    const processKey = { serverId, machineId: machine.id, accountId, scope: 'happier' as const, view: 'tree' as const };
    const processSummaryKey = { ...processKey, view: 'owners' as const };
    await machineResourceStore.read(vitalsKey);
    await machineStorageStore.read(storageKey);
    await machineProcessesStore.read(processKey);
    await machineProcessesStore.read(processSummaryKey);
    const modelModule = await import('@/components/sessions/new/hooks/useNewSessionScreenModel');
    const actualModel = modelModule.useNewSessionScreenModel;
    let modelCounts: Record<string, number> = {};
    // Install before mount: the presentation read is instrumentation, and must preserve hook order.
    const model = vi.spyOn(modelModule, 'useNewSessionScreenModel').mockImplementation((...args) => {
        const id = `Ask model ${useLayoutPresentationActive() ? 'presented' : 'hidden'} invocations`;
        modelCounts[id] = (modelCounts[id] ?? 0) + 1;
        return actualModel(...args);
    });
    onTestFinished(() => model.mockRestore());
    const screen = await renderScreen(<AuthProvider initialCredentials={{ token }}>
        <React.Profiler id="Machine page" onRender={id => { probe.commits[id] = (probe.commits[id] ?? 0) + 1; }}>
            <MachinePageScreen />
        </React.Profiler>
    </AuthProvider>);
    // React 19.2 act loops forever with three pending sibling Suspense boundaries:
    // https://github.com/react/react/issues/37556. Drive real events with the normal scheduler.
    // React 19 exposes this renderer method, while the external @types surface still targets React 18.
    const flushSync = Reflect.get(screen.tree, 'unstable_flushSync') as (callback: () => void) => void;
    expect(typeof flushSync).toBe('function');
    const wasActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
    restoreActEnvironment = () => { globalThis.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment; };
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    onTestFinished(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment; });
    const settle = async () => {
        await new Promise<void>(resolve => setImmediate(resolve));
        flushSync(() => {});
    };
    const selectTab = async (tab: string) => {
        flushSync(() => screen.pressByTestId(`machine-page-tab:${tab}`));
        await settle();
        await vi.waitFor(() => {
            expect(screen.findByTestId(`machine-page-tab:${tab}`)?.props.accessibilityState?.selected).toBe(true);
            const panel = screen.findHostByTestId(`machine-page-tab-body.${tab}`)!;
            // Selection chrome commits before Suspense's primary tree is revealed by the real scheduler.
            expect(panel.findAll(node => node !== panel && typeof node.type === 'string').length).toBeGreaterThan(0);
            if (tab === 'processes') expect(screen.findByTestId('machine-processes-search')).not.toBeNull();
            if (tab === 'storage') expect(screen.findHostByTestId('machine-storage-category-caches')).not.toBeNull();
            if (tab === 'overview') expect(screen.findByTestId('machine-vitals-sheet')).not.toBeNull();
        });
    };
    await vi.waitFor(() => expect(screen.root.findAllByType(NewSessionEmbeddedHostProvider)).toHaveLength(1));
    const overviewComposerHost = screen.root.findByType(NewSessionEmbeddedHostProvider).props.host;
    await selectTab('processes');
    await vi.waitFor(() => expect(screen.findHostByTestId('machine-page-tab-footer')!
        .findAllByType(NewSessionEmbeddedHostProvider)).toHaveLength(1));
    const footerComposerHost = screen.findHostByTestId('machine-page-tab-footer')!.findByType(NewSessionEmbeddedHostProvider).props.host;
    flushSync(() => screen.changeTextByTestId('machine-processes-search', 'retained-vite'));
    await settle();
    for (const tab of ['storage', 'guard', 'overview']) {
        await selectTab(tab);
        if (tab === 'storage') expect(screen.findHostByTestId('machine-storage-category-caches')).not.toBeNull();
    }
    expect(screen.findByTestId('machine-vitals-sheet')).not.toBeNull();
    // Suspense commits the hidden fallback after the tab chrome changes. Attribute resource
    // publications only after that transition has actually left the rendered host tree.
    await vi.waitFor(() => {
        const visit = (node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): void => {
            if (Array.isArray(node)) { node.forEach(visit); return; }
            if (!node || typeof node === 'string') return;
            if (['processes', 'storage', 'guard'].some(id => node.props.testID === `machine-page-tab-body.${id}`)) {
                expect(node.children, node.props.testID).toBeNull();
            }
            node.children?.forEach(visit);
        };
        visit(screen.tree.toJSON());
    });
    const processHost = screen.findHostByTestId('machine-page-tab-body.processes');
    const storageHost = screen.findHostByTestId('machine-page-tab-body.storage');
    const rows: Record<string, Record<string, number>> = {};
    for (const family of ['vitals', 'processes', 'storage']) {
        probe.commits = {};
        modelCounts = {};
        model.mockClear();
        for (let index = 0; index < 3; index++) {
            at += 2_000;
            if (family === 'vitals') await machineResourceStore.read(vitalsKey);
            if (family === 'processes') {
                processMemory += 1_000_000;
                await Promise.all([machineProcessesStore.read(processKey), machineProcessesStore.read(processSummaryKey)]);
            }
            if (family === 'storage') { storageBytes += 1_000_000_000; await machineStorageStore.read(storageKey); }
            await settle();
        }
        rows[family] = { ...probe.commits, ...modelCounts };
    }
    console.info('FX95b real Machine page committed subtree counts / three separate publications per family', rows);
    expect(rows.vitals?.['Vitals overview']).toBeGreaterThan(0);
    expect(rows.processes?.['Vitals overview']).toBeGreaterThan(0);
    // Only plugin-free bodies suspend. Ask may host external plugin renderers,
    // whose layout-effect lifetime must remain connected even while hidden.
    for (const row of Object.values(rows)) for (const id of ['processes', 'storage', 'guard']) {
        expect(row[`machine-page-tab-body.${id}`] ?? 0, `${id}: ${JSON.stringify(rows)}`).toBe(0);
    }
    expect(screen.findHostByTestId('machine-page-tab-body.overview')!.findByType(NewSessionEmbeddedHostProvider).props.host).toBe(overviewComposerHost);
    await selectTab('processes');
    expect(screen.findHostByTestId('machine-page-tab-body.processes')).toBe(processHost);
    expect(screen.findByTestId('machine-processes-search')?.props.value).toBe('retained-vite');
    expect(machineProcessesStore.getState(processKey).answer?.totals.leftBehind.memoryBytes).toBe(processMemory);
    const { formatProcessMemory } = await import('@/components/machines/processes/processesCollectionAnatomy');
    await vi.waitFor(() => expect(renderedText(screen.findHostByTestId('machine-page-tab-body.processes')!))
        .toContain(formatProcessMemory(processMemory)));
    await selectTab('storage');
    expect(screen.findHostByTestId('machine-page-tab-body.storage')).toBe(storageHost);
    expect(machineStorageStore.getState(storageKey).summary?.categories[0]?.size.allocatedBytes).toBe(storageBytes);
    const { formatMachineBytes } = await import('@/components/machines/vitals/machineVitalsPresentation');
    const cacheRow = screen.findHostByTestId('machine-storage-category-caches');
    expect(cacheRow).not.toBeNull();
    await vi.waitFor(() => expect(renderedText(screen.findHostByTestId('machine-storage-category-caches')!))
        .toContain(formatMachineBytes(storageBytes, 'storage')));
    expect(screen.findHostByTestId('machine-page-tab-footer')!.findByType(NewSessionEmbeddedHostProvider).props.host).toBe(footerComposerHost);
    // Measure the other Ask placement while hidden too. This is a diagnostic
    // number, not a zero-work contract for plugin-bearing retained roots.
    probe.commits = {};
    modelCounts = {};
    for (let index = 0; index < 3; index++) {
        at += 2_000;
        await machineResourceStore.read(vitalsKey);
        await settle();
    }
    console.info('FX95b unsuspended Ask hidden commits / three vitals publications', {
        overview: probe.commits['machine-page-tab-body.overview'] ?? 0,
        footerByFamily: Object.fromEntries(Object.entries(rows).map(([family, row]) => [family, row['machine-page-tab-footer'] ?? 0])),
    });
    await selectTab('overview');
    expect(screen.findHostByTestId('machine-page-tab-body.overview')!.findByType(NewSessionEmbeddedHostProvider).props.host).toBe(overviewComposerHost);
    globalThis.IS_REACT_ACT_ENVIRONMENT = wasActEnvironment;
    await screen.unmount();
});
