import * as React from 'react';
import { t } from '@/text';
import * as Unistyles from 'react-native-unistyles';
import { expect, it, vi } from 'vitest';
import { WidgetDefinitionV1Schema, type WidgetInputBindingsV1, type WidgetInstanceV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { createDeferred, renderScreen, renderHook, flushHookEffects } from '@/dev/testkit';
import { useConfiguredWidgetTarget } from '@/sync/domains/widgets/useConfiguredWidgetTarget';
import type { ConfiguredWidgetTargetResolution } from '@/sync/domains/widgets/widgetBinding';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary, createLayoutArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { SessionSystemRecordStoredPageResponseSchema, SessionSystemRecordStoredReadResponseSchema } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { buildWidgetDefinitionArtifactHeaderV1 } from '@happier-dev/protocol/widgets/widgetDefinitionArtifactV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { decryptSocketNewArtifactUpdate, type ArtifactDataKeyCache } from '@/sync/engine/artifacts/syncArtifacts';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { ProjectBuiltinWidgetBody } from '@/components/projects/widgets/ProjectBuiltinWidgetBody';
import { WidgetSurface } from './WidgetSurface';
import { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { describeAuthoredWidgetDefinitionV1, readWidgetDescriptor, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { Text } from '@/components/ui/text/Text';
import { HostedHtmlSurfaceAdapter } from '@/components/ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { readInputPath } from '@happier-dev/protocol/inputs';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { SessionSystemRecordStoredSchema, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol';
import { HappierDataMetric, StackedSeriesChart, type HappierSeries } from '@happier-dev/plugin-ui/presentation';
import { invalidateUsageQueryResources } from '@/sync/api/account/usageQueryResource';
import { readUsageWidgetPageContext, readUsageWidgetPageScope } from '@/components/settings/usage/usageWidgetPageContext';
import { ConfiguredWidgetRefusal } from '@/components/widgets/InstalledWidgetSurface';
import { SessionSurfaceItemV1Schema } from '@happier-dev/protocol/sessions/board';
import { createSessionBoardSourceAvailabilityResolver } from '@/components/sessions/board/sessionBoardItemPresentation';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storage';
import { loadPluginUiHostSupport } from '@/components/plugins/hostApi/loadPluginUiHostSupport';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';
import { widgetProjectionOf, widgetInstalledPackage } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { unionPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import { darkTheme, lightTheme } from '@/theme';
import { createWorkBoardV1, WorkBoardV1Schema } from '@happier-dev/protocol/boards/workBoardV1';
import { buildWorkBoardArtifactHeaderV1 } from '@happier-dev/protocol/boards/workBoardArtifactV1';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { resolveUiAccountActionFallbackMachineId } from '@/sync/ops/actions/accountActionDeps';
import { recordMachineRequestFailed, recordMachineRequestSucceeded } from '@/sync/domains/machines/reachability/machineReachability';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createWorkBoardArtifactBoundary } from '@/dev/testkit/harness/workBoardArtifactBoundary';
import { createWorkBoardAccountStore } from '@/components/boards/model/workBoardAccountStore';
import { useBoardWidgets } from '@/components/boards/model/useBoardContent';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { useWidgetFrameTitle } from '@/components/widgets/frame/widgetFrameTitle';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';

// Statically imported surface consumers reach Sync; install its external Socket boundary before that graph loads.
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

// The physical browser frame is the platform boundary; the bundle, renderer,
// viewer runtime, capability admission and bridge remain real.
vi.mock('@/components/browser/frame/BrowserViewFrame.web', () => ({
    BrowserViewFrame: () => React.createElement('BrowserViewFrame', { testID: 'html-copy-frame' }),
}));

installDisconnectedServerSocketBoundary();

it('settles the frame title from the installed body read without a second definition request', async () => {
    const http = createHomeHubArtifactHttpBoundary('viewer');
    const request = vi.spyOn(http, 'request');
    const definitionReads = () => request.mock.calls.filter(([url]) => new URL(String(url)).pathname.startsWith('/v1/artifacts/')).length;
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://widget-title-settlement.test', accountId: 'viewer', request: http.request });
    const scope = { ...getActiveServerAccountScope()!, owner: { kind: 'home' as const } };
    const instance: WidgetInstanceV1 = { v: 1, id: 'unavailable-title', definition: {
        kind: 'installed', surface: { pluginId: 'missing-plugin', localId: 'home' },
    }, bindings: {} };
    const runtime = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'establishing' as const,
        interactionEnabled: false, machineId: null, serverId: scope.serverId, platform: 'web' as const,
        accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' as const },
        reloadClientExecutables() {}, reloadConnectedAccountProjection() {} };
    let title: ReturnType<typeof useWidgetFrameTitle>['title'] = '';
    function Frame(props: { runtime: React.ComponentProps<typeof AppShellPluginUiProjectionValueProvider>['value'] }) {
        const frame = useWidgetFrameTitle(instance, null);
        title = frame.title;
        return <WidgetSurface scope={scope} instance={instance} descriptor={null} providedContext={{}}
            appRuntime={props.runtime} recordRevision="title:1" presentation="content" testID="title-body"
            onDefinitionRead={frame.onDefinitionRead} />;
    }
    const render = (value: React.ComponentProps<typeof AppShellPluginUiProjectionValueProvider>['value']) =>
        <AppShellPluginUiProjectionValueProvider value={value}><Frame runtime={value} /></AppShellPluginUiProjectionValueProvider>;
    const screen = await renderScreen(render(runtime));
    try {
        expect(typeof title).not.toBe('string');
        expect(definitionReads()).toBe(0);
        await screen.update(render({ ...runtime, phase: 'unavailable', unavailableReasonCode: 'plugin_runtime_unavailable' }));
        expect(screen.tree.root.findAllByType(SurfaceStateCard).map(card => card.props.kind)).toContain('unavailable');
        expect(title).toBe(t('sessionBoard.item.pluginUnavailable.title'));
        expect(definitionReads()).toBe(0);
    } finally { await screen.unmount(); await connection.dispose(); }
});

it('says another Account\u2019s saved definition is unavailable as one durable sentence, never as a start-up state', async () => {
    const http = createHomeHubArtifactHttpBoundary('viewer');
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://private-definition.test', accountId: 'viewer', request: http.request });
    const viewer = getActiveServerAccountScope()!;
    const runtime = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'current' as const, interactionEnabled: true,
        machineId: 'machine-1', serverId: viewer.serverId, platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime(),
        clientExecutableActivation: { status: 'ready' as const }, reloadClientExecutables: () => {}, reloadConnectedAccountProjection: () => {} };
    const screen = await renderScreen(<WidgetSurface scope={{ serverId: viewer.serverId, accountId: 'dashboard-owner', owner: { kind: 'home' } }}
        instance={{ v: 1, id: 'private-copy', definition: { kind: 'artifact', artifactId: 'owner-private-definition' }, bindings: {} }} descriptor={null}
        providedContext={{}} appRuntime={runtime} recordRevision="private:1" presentation="content" testID="private-definition" />);
    try {
        const cards = screen.tree.root.findAllByType(SurfaceStateCard);
        expect(cards).toHaveLength(1);
        expect(cards[0]!.props).toMatchObject({ kind: 'unavailable', title: t('projects.widgets.definitionUnavailable') });
        expect(cards[0]!.props.reason).toBeUndefined();
    } finally { await screen.unmount(); await connection.dispose(); }
});

it('mounts the exact installed app widget from a multi-machine Home union and retires on viewer loss', async () => {
    const http = createHomeHubArtifactHttpBoundary('viewer');
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://installed-widget-union.test', accountId: 'viewer', request: http.request });
    const viewer = getActiveServerAccountScope()!;
    const definition = { kind: 'installed', surface: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: 'latest' } } as const;
    const union = unionPluginUiProjections([
        { machineId: 'origin-a', serverId: viewer.serverId, phase: 'current', interactionEnabled: true,
            projection: widgetProjectionOf([{ ...definition.surface, target: 'app', homeDefault: 'shown' }], {
                [definition.surface.pluginId]: widgetInstalledPackage(definition.surface.pluginId, 'PRs & Issues'),
            }) },
        { machineId: 'origin-b', serverId: viewer.serverId, phase: 'current', interactionEnabled: true, projection: EMPTY_PLUGIN_UI_PROJECTION },
    ]);
    const runtime = { ...union, pluginBrowserProjection: null, platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime() };
    const descriptor = readWidgetDescriptor(union.pluginUiProjection, definition);
    expect(descriptor).not.toBeNull();
    const screen = await renderScreen(<WidgetSurface scope={{ ...viewer, owner: { kind: 'home' } }}
        instance={{ v: 1, id: 'latest-copy', definition, bindings: {} }} descriptor={descriptor}
        providedContext={{}} appRuntime={runtime} recordRevision="latest:1" presentation="content"
        reference={<Text testID="latest-admitted-reference">Open PRs &amp; Issues</Text>} testID="latest-union" />);
    let disconnected = false;
    try {
        expect(screen.tree.root.findAllByType(ConfiguredWidgetRefusal)).toHaveLength(0);
        expect(screen.tree.root.findAllByProps({ testID: 'latest-admitted-reference' }).length).toBeGreaterThan(0);
        await React.act(async () => { await connection.dispose(); disconnected = true; });
        expect(screen.tree.root.findAllByProps({ testID: 'latest-admitted-reference' })).toHaveLength(0);
        expect(http.writes).toEqual([]);
    } finally { await screen.unmount(); if (!disconnected) await connection.dispose(); }
});

it('renders an exact saved definition while unrelated layout reads remain pending', async () => {
    const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'literal-table', name: 'Orders',
        sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, inputs: { fields: [] },
        inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } },
        body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Exact saved data' } } } });
    const http = createLayoutArtifactHttpBoundary('viewer', { artifactId: definition.id, kind: 'widget-definition.v1',
        defaultLayout: definition, parseLayout: value => WidgetDefinitionV1Schema.parse(value), buildHeader: buildWidgetDefinitionArtifactHeaderV1 });
    http.seed(definition);
    let finishLayout!: (response: Response) => void;
    const pendingLayout = new Promise<Response>(resolve => { finishLayout = resolve; });
    let deleted = false;
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://widget-exact-read.test', accountId: 'viewer', request: (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/artifacts' || path.startsWith('/v1/artifacts/') && !path.startsWith(`/v1/artifacts/${definition.id}`)) return pendingLayout;
        if (deleted && path === `/v1/artifacts/${definition.id}`) return Promise.resolve(Response.json({ error: 'not_found' }, { status: 404 }));
        return http.request(url, init);
    } });
    const viewer = getActiveServerAccountScope()!;
    const reference = { kind: 'artifact' as const, artifactId: definition.id };
    const runtime = { phase: 'establishing' as const, interactionEnabled: false, machineId: null, serverId: null,
        pluginUiProjection: null, pluginBrowserProjection: null, platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime() };
    const screen = await renderScreen(<WidgetSurface scope={{ ...viewer, owner: { kind: 'home' } }}
        instance={{ v: 1, id: 'literal-instance', definition: reference, bindings: {} }}
        descriptor={describeAuthoredWidgetDefinitionV1(definition, reference, null)} providedContext={{}}
        recordRevision="literal" appRuntime={runtime} presentation="content" testID="exact-saved" />);
    try {
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Exact saved data'));
        deleted = true;
        await React.act(async () => { storage.getState().deleteArtifact(definition.id); });
        await vi.waitFor(() => expect(screen.getTextContent()).not.toContain('Exact saved data'));
    } finally {
        finishLayout(Response.json({ error: 'not_found' }, { status: 404 }));
        await screen.unmount();
        await connection.dispose();
    }
});

it('renews a pending exact saved definition read when the same Account lifetime is restored', async () => {
    const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'renewed-definition', name: 'Renewed',
        sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, inputs: { fields: [] },
        inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } },
        body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Renewed saved data' } } } });
    const http = createLayoutArtifactHttpBoundary('viewer', { artifactId: definition.id, kind: 'widget-definition.v1',
        defaultLayout: definition, parseLayout: value => WidgetDefinitionV1Schema.parse(value), buildHeader: buildWidgetDefinitionArtifactHeaderV1 });
    http.seed(definition);
    const inventory = createDeferred<Response>();
    const firstRead = createDeferred<Response>();
    let firstReadSignal: AbortSignal | null | undefined;
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://widget-lifetime-read.test', accountId: 'viewer', request: (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/artifacts' || path.startsWith('/v1/artifacts/') && path !== `/v1/artifacts/${definition.id}`) return inventory.promise;
        if (path === `/v1/artifacts/${definition.id}` && firstReadSignal === undefined) {
            firstReadSignal = init?.signal;
            firstReadSignal?.addEventListener('abort', () => firstRead.reject(firstReadSignal?.reason), { once: true });
            return firstRead.promise;
        }
        return http.request(url, init);
    } });
    const viewer = getActiveServerAccountScope()!;
    const lifetime = captureActiveServerAccountScopeLifetime()!;
    const reference = { kind: 'artifact' as const, artifactId: definition.id };
    const runtime = { phase: 'establishing' as const, interactionEnabled: false, machineId: null, serverId: null,
        pluginUiProjection: null, pluginBrowserProjection: null, platform: 'web' as const, accountLifetime: lifetime };
    const surface = <WidgetSurface scope={{ ...viewer, owner: { kind: 'home' } }}
        instance={{ v: 1, id: 'renewed-instance', definition: reference, bindings: {} }}
        descriptor={describeAuthoredWidgetDefinitionV1(definition, reference, null)} providedContext={{}}
        recordRevision="renewed" appRuntime={runtime} presentation="content" testID="renewed-saved" />;
    const screen = await renderScreen(surface);
    try {
        await vi.waitFor(() => expect(firstReadSignal).toBeInstanceOf(AbortSignal));
        await React.act(async () => {
            // The canonical owner renews even a restored connection to the same Home and Account.
            retireActiveServerAccountScopeLifetime();
            const restored = captureActiveServerAccountScopeLifetime()!;
            expect(restored).not.toBe(lifetime);
            expect(restored.scope).toEqual(viewer);
            await screen.update(React.cloneElement(surface, { appRuntime: { ...runtime, accountLifetime: restored } }));
        });
        expect(firstReadSignal?.aborted).toBe(true);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Renewed saved data'));
    } finally {
        inventory.resolve(Response.json({ error: 'not_found' }, { status: 404 }));
        firstRead.resolve(Response.json({ error: 'not_found' }, { status: 404 }));
        await screen.unmount();
        await connection.dispose();
    }
});

it('opens a socket-only saved definition through exact HTTP authority before rendering it', async () => {
    const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'socket-definition', name: 'Socket definition',
        sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, inputs: { fields: [] },
        inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } },
        body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Authenticated saved data' } } } });
    const http = createLayoutArtifactHttpBoundary('viewer', { artifactId: definition.id, kind: 'widget-definition.v1',
        defaultLayout: definition, parseLayout: value => WidgetDefinitionV1Schema.parse(value), buildHeader: buildWidgetDefinitionArtifactHeaderV1 });
    http.seed(definition);
    const inventory = createDeferred<Response>();
    const exactRead = createDeferred<void>();
    let exactReadEntered = false;
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://widget-socket-authority.test', accountId: 'viewer', request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/artifacts' || path.startsWith('/v1/artifacts/') && path !== `/v1/artifacts/${definition.id}`) return inventory.promise;
        if (path === `/v1/artifacts/${definition.id}`) {
            exactReadEntered = true;
            await exactRead.promise;
        }
        return http.request(url, init);
    } });
    const artifactDataKeys: ArtifactDataKeyCache = new Map();
    // Content-only Socket.IO messages carry bytes and revisions, never HTTP owner/grant facts.
    const socketRow = await decryptSocketNewArtifactUpdate({ artifactId: definition.id,
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent(buildWidgetDefinitionArtifactHeaderV1(definition)),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(definition) }),
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, encryption: null, artifactDataKeys });
    expect(socketRow).toMatchObject({ isDecrypted: true, body: JSON.stringify(definition) });
    expect(socketRow?.ownerAccountId).toBeUndefined();
    expect(socketRow?.access).toBeUndefined();
    if (!socketRow) throw new Error('Expected a readable socket Artifact');
    await React.act(async () => { storage.getState().addArtifact(socketRow); });
    const viewer = getActiveServerAccountScope()!;
    const reference = { kind: 'artifact' as const, artifactId: definition.id };
    const runtime = { phase: 'establishing' as const, interactionEnabled: false, machineId: null, serverId: null,
        pluginUiProjection: null, pluginBrowserProjection: null, platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime() };
    const screen = await renderScreen(<WidgetSurface scope={{ ...viewer, owner: { kind: 'home' } }}
        instance={{ v: 1, id: 'socket-instance', definition: reference, bindings: {} }}
        descriptor={describeAuthoredWidgetDefinitionV1(definition, reference, null)} providedContext={{}}
        recordRevision="socket" appRuntime={runtime} presentation="content" testID="socket-saved" />);
    try {
        await vi.waitFor(() => expect(exactReadEntered).toBe(true));
        expect(screen.getTextContent()).not.toContain('Authenticated saved data');
        await React.act(async () => { exactRead.resolve(); });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Authenticated saved data'));
        expect(storage.getState().artifacts[definition.id]).toMatchObject({ ownerAccountId: 'viewer', access: 'owner' });
    } finally {
        exactRead.resolve();
        inventory.resolve(Response.json({ error: 'not_found' }, { status: 404 }));
        await screen.unmount();
        await connection.dispose();
    }
});

it.each([['artifact', 'home'], ['artifact', 'project'], ['inline', 'sessionBoard']] as const)('renders a saved builtin daily widget through %s on %s with viewer admission and retires its Resource on authority loss', async (kind, owner) => {
    const disposeActionLoader = await installRealActionExecutorModuleLoader();
    const native = readWidgetDescriptor(null, { kind: 'builtin', id: 'usage_daily' })!;
    const saved = WidgetDefinitionV1Schema.parse({ v: 1, id: 'daily-copy', name: 'Saved daily usage',
        body: { kind: 'builtin', id: 'usage_daily' }, inputs: native.inputs, inputSchema: native.inputSchema,
        sizeDeclaration: native.sizeDeclaration, provenance: { source: { kind: 'authored' } } });
    const http = createLayoutArtifactHttpBoundary('viewer', { artifactId: saved.id, kind: 'widget-definition.v1',
        defaultLayout: saved, parseLayout: value => WidgetDefinitionV1Schema.parse(value), buildHeader: buildWidgetDefinitionArtifactHeaderV1 });
    http.seed(saved);
    let total = 15;
    const start = Date.UTC(2026, 9, 10);
    const query = normalizeUsageQuery({ period: { startMs: start, endMs: start + 86_400_000 }, metric: 'tokens', breakdown: [] });
    const reference = kind === 'artifact' ? { kind, artifactId: saved.id } : { kind, definition: saved };
    const instance: WidgetInstanceV1 = { v: 1, id: 'daily-instance', definition: reference,
        bindings: Object.fromEntries(saved.inputs.fields.map(field => [field.path, { kind: 'value', value: StrictJsonValueSchema.parse(readInputPath(query, field.path)) }])) };
    const record = kind === 'inline' ? SessionSystemRecordStoredSchema.parse({ id: 'daily-record',
        address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: instance.id },
        content: { t: 'plain', v: SessionSurfaceItemV1Schema.parse({ v: 1, title: saved.name, frame: 'card',
            height: { mode: 'auto', fallback: 'regular' }, source: { kind: 'widget', instance } }) },
        revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ', createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' }) : null;
    // Session-scoped choices admit the containing Session through the real HTTP reader.
    const containingSession = createPlainSessionCurrentProjectionRecordFixture({ id: 'destination', metadata: null });
    const features = createRootLayoutFeaturesResponse();
    if (!tryWriteServerEnabledBitInPlace(features, 'sessions.board', true)) throw new Error('Expected the Board feature');
    const connection = await restoreServerAccountForTest({ serverUrl: `https://saved-builtin-${owner}.test`, accountId: 'viewer', request: createSessionReadBatchFetchBoundary(async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/machines') return Response.json({ machines: [] });
        if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
        if (path === '/v2/sessions/destination') return Response.json({ session: containingSession });
        if (path === '/v2/sessions/destination/system-records/record') return Response.json(SessionSystemRecordStoredReadResponseSchema.parse({
            record: new URL(String(url)).searchParams.get('localId') === instance.id ? record : null }));
        if (path === '/v2/sessions/destination/system-records') return Response.json(SessionSystemRecordStoredPageResponseSchema.parse({ records: record ? [record] : [], nextCursor: null, hasNext: false }));
        if (path !== '/v2/usage/query') return http.request(url, init);
        const tokens = { input: total - 5, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total };
        const cost = { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' };
        return Response.json({ v: 1, totals: { eventCount: 1, tokens, cost }, series: [{ bucketStartMs: start, bucketEndMs: start + 86_400_000, eventCount: 1, tokens, cost }] });
    }) });
    const viewer = getActiveServerAccountScope();
    if (!viewer) throw new Error('Expected current viewer');
    // Shared Session content is an inline copy, never a foreign private Account reference.
    // Session hosts scope their reads to the current viewer; shared content carries no author Account authority.
    const scope: WidgetSurfaceRefV1 = { ...viewer, owner: owner === 'home' ? { kind: owner }
        : owner === 'project' ? { kind: owner, projectId: 'project-one' } : { kind: owner, sessionId: 'destination' } };
    if (kind === 'inline') {
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const executor = createDefaultActionExecutor();
        const context = { surface: 'mcp' as const, serverId: scope.serverId, expectedAccountId: viewer.accountId };
        const catalog = await executor.execute('widgets.catalog.list', { surface: scope }, context);
        expect(catalog).toMatchObject({ ok: true, result: { entries: expect.arrayContaining([
            expect.objectContaining({ definition: reference, instanceCount: 1, availability: 'available' }),
        ]) } });
        const consumer = { kind: 'widget' as const, surface: scope, definition: reference };
        expect(await executor.execute('action.options.resolve', { consumer, fieldPath: 'metric' }, context))
            .toMatchObject({ ok: true, result: { options: expect.arrayContaining([expect.objectContaining({ value: 'tokens' })]) } });
        const forged = { kind: 'inline' as const, definition: { ...saved, name: 'Unpublished replacement' } };
        expect(await executor.execute('action.options.resolve', { consumer: { ...consumer, definition: forged }, fieldPath: 'metric' }, context))
            .toMatchObject({ ok: false, errorCode: 'input_type_consumer_unavailable' });
    }
    const runtime = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'current' as const,
        interactionEnabled: true, machineId: null, serverId: null, platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime() };
    let containingCurrent = true;
    const isCurrent = () => containingCurrent;
    const body = () => <InjectedAuthProvider credentials={connection.credentials}>
        <WidgetSurface scope={scope} admittedViewer={kind === 'inline' ? viewer : undefined} instance={instance} descriptor={describeAuthoredWidgetDefinitionV1(saved, reference)}
            providedContext={{}} appRuntime={runtime} isCurrent={isCurrent} recordRevision="fixture:1" presentation="content" testID="saved-daily" />
    </InjectedAuthProvider>;
    const screen = await renderScreen(body());
    const values = () => screen.tree.root.findAllByType(StackedSeriesChart).flatMap(chart => chart.props.series.flatMap((series: HappierSeries) => series.points.map(point => point.y)));
    let disconnected = false;
    try {
        await flushHookEffects({ cycles: 30 });
        await vi.waitFor(() => expect(values(), JSON.stringify(screen.tree.toJSON())).toContain(15));
        total = 30;
        await React.act(async () => { invalidateUsageQueryResources(); });
        await vi.waitFor(() => expect(values()).toContain(30));
        containingCurrent = false;
        await screen.update(body());
        expect(values()).not.toContain(30);
        containingCurrent = true;
        await screen.update(body());
        await vi.waitFor(() => expect(values()).toContain(30));
        await React.act(async () => { await connection.dispose(); disconnected = true; });
        await vi.waitFor(() => expect(values()).not.toContain(30));
        expect(http.writes).toEqual([]);
    } finally { await screen.unmount(); if (!disconnected) await connection.dispose(); disposeActionLoader(); invalidateUsageQueryResources(); }
});

it.each(['declarative', 'html', 'installed'] as const)('renders a published inline %s through Session Board presence and real WidgetSurface admission', async kind => {
    const { SessionWidgetHost } = await import('@/components/sessions/board/SessionWidgetHost');
    const http = createHomeHubArtifactHttpBoundary('viewer');
    const connection = await restoreServerAccountForTest({ serverUrl: `https://session-inline-${kind}.test`,
        serverIdentityId: `srv_session_inline_${kind}`, accountId: 'viewer', request: http.request });
    const viewer = getActiveServerAccountScope();
    if (!viewer) throw new Error('Expected current viewer');
    const session = createSessionFixture({ id: 'destination-session', serverId: viewer.serverId,
        access: createSessionAccessFixture('view') });
    storage.getState().applySessions([session]);
    const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'saved-copy', name: 'Independent result',
        sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, inputs: { fields: [] },
        inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } },
        body: kind === 'declarative' ? { kind, document: { version: 1, root: { kind: 'text', text: 'Published result' } } }
            : kind === 'html' ? { kind, source: artifactHtmlBundleFromBodyV1('<main>Published result</main>'), requestedCapabilities: { network: 'none' } }
            : { kind, surface: { pluginId: 'acme.missing', localId: 'widget' } } });
    const item = SessionSurfaceItemV1Schema.parse({ v: 1, title: definition.name, frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
        source: { kind: 'widget', instance: { v: 1, id: 'published-copy', definition: { kind: 'inline', definition }, bindings: {} } } });
    vi.stubGlobal('location', { origin: 'https://app.happier.dev' });
    const body = (executableCurrentness: 'current' | 'stale') => <InjectedAuthProvider credentials={connection.credentials}>
        <SessionWidgetHost serverId={viewer.serverId} sessionId="destination-session"
            item={{ itemId: 'published-copy', revision: 'fixture:1', state: { kind: 'ready', item } }}
            resolveSourceAvailability={createSessionBoardSourceAvailabilityResolver({ hostedHtmlRendererAvailable: true })}
            host="details" primaryHost="details" density="compact" canEdit={false} executableCurrentness={executableCurrentness} testID="published-copy" />
    </InjectedAuthProvider>;
    const screen = await renderScreen(body('current'));
    try {
        if (kind === 'declarative') await vi.waitFor(() => expect(screen.getTextContent()).toContain('Published result'));
        else if (kind === 'html') {
            await React.act(async () => { await loadPluginUiHostSupport(); });
            await vi.waitFor(async () => {
                await flushHookEffects();
                expect(screen.tree.root.findAllByType(HostedHtmlSurfaceAdapter), JSON.stringify(screen.tree.toJSON())).toHaveLength(1);
            });
            expect(screen.tree.root.findByType(HostedHtmlSurfaceAdapter).props.source).toEqual(definition.body.kind === 'html' ? definition.body.source : null);
            await vi.waitFor(() => expect(screen.tree.root.findAllByProps({ testID: 'html-copy-frame' }).length).toBeGreaterThan(0));
            await screen.update(body('stale'));
            await vi.waitFor(() => expect(screen.tree.root.findAllByType(HostedHtmlSurfaceAdapter)).toHaveLength(0));
            expect(screen.tree.root.findAllByProps({ testID: 'html-copy-frame' })).toHaveLength(0);
        } else {
            await vi.waitFor(() => expect(screen.tree.root.findAllByType(WidgetSurface)).toHaveLength(1));
            expect(screen.tree.root.findAllByType(HostedHtmlSurfaceAdapter)).toHaveLength(0);
            expect(screen.tree.root.findAllByType(SurfaceStateCard).some(node => node.props.kind === 'unavailable')).toBe(true);
        }
        expect(http.writes).toEqual([]);
    } finally { await screen.unmount(); await connection.dispose(); vi.unstubAllGlobals(); }
});

it.each([
    ['follow', 'corePage'], ['pin', 'corePage'], ['pin', 'home'], ['project-follow', 'project'], ['session-follow', 'corePage'], ['pin', 'workBoard'],
] as const)('renders Usage through real %s admission on an unmaterialized %s host', async (bindingKind, host) => {
    const disposeActionLoader = await installRealActionExecutorModuleLoader();
    const http = createHomeHubArtifactHttpBoundary('viewer');
    const board = createWorkBoardV1({ id: 'board-one', name: 'Overview' });
    const boardHttp = createLayoutArtifactHttpBoundary('viewer', { artifactId: board.id, kind: 'work-board.v1',
        defaultLayout: board, parseLayout: value => WorkBoardV1Schema.parse(value), buildHeader: buildWorkBoardArtifactHeaderV1 });
    boardHttp.seed(board);
    let usageReads = 0;
    const connection = await restoreServerAccountForTest({ serverUrl: `https://usage-${bindingKind}-admission.test`,
        accountId: 'viewer', request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/machines') return Response.json({ machines: [] });
            if (host === 'workBoard' && (path === '/v1/features' || path === '/v1/features/authenticated')) return Response.json(createRootLayoutFeaturesResponse());
            if (host === 'workBoard' && path.startsWith(`/v1/artifacts/${board.id}`)) return boardHttp.request(url, init);
            if (path !== '/v2/usage/query') return http.request(url, init);
            usageReads += 1;
            const totals: UsageAnalyticsQueryResponse['totals'] = { eventCount: 1,
                tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
                cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } };
            return Response.json({ v: 1, totals, breakdowns: { agent: [{ key: 'codex', ...totals }] } });
        } });
    const account = getActiveServerAccountScope();
    if (!account) throw new Error('Expected current viewer Account');
    const scope: WidgetSurfaceRefV1 = { ...account, owner: host === 'home' ? { kind: 'home' }
        : host === 'project' ? { kind: 'project', projectId: 'project-one' }
        : host === 'workBoard' ? { kind: 'workBoard', boardId: 'board-one' }
        : { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'overview' } };
    const query = normalizeUsageQuery({ period: host === 'workBoard' ? { relative: '30days' } : { startMs: 1000 }, agents: bindingKind === 'pin' ? ['codex'] : [], metric: 'tokens',
        projects: host === 'project' ? ['project-one'] : [], session: bindingKind === 'session-follow' ? ['session-one'] : null });
    const definition = { kind: 'builtin', id: 'usage_period_summary' } as const;
    const descriptor = readWidgetDescriptor(null, definition)!;
    const bindings: WidgetInputBindingsV1 = Object.fromEntries(descriptor.inputs!.fields.map(field => [field.path,
        (bindingKind === 'follow' || bindingKind === 'session-follow') && field.contextMode === 'follow'
            || bindingKind === 'project-follow' && field.path === 'projects' ? { kind: 'context', slot: field.path }
            : { kind: 'value', value: StrictJsonValueSchema.parse(readInputPath(query, field.path)) }]));
    const runtime = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'current' as const,
        interactionEnabled: true, machineId: null, serverId: null, platform: 'web' as const,
        accountLifetime: captureActiveServerAccountScopeLifetime() };
    let layoutCurrent = true;
    let layoutPending = false;
    const body = (context: ReturnType<typeof readUsageWidgetPageContext>) => <InjectedAuthProvider credentials={connection.credentials}>
        <WidgetSurface scope={scope} instance={{ v: 1, id: 'usage-admission', definition, bindings }} descriptor={descriptor}
            providedContext={context} appRuntime={runtime} recordRevision="fixture:1" presentation="content" testID="usage-admission"
            isCurrent={() => layoutCurrent} isReadPending={() => layoutPending} />
    </InjectedAuthProvider>;
    const pageContext = readUsageWidgetPageContext(readUsageWidgetPageScope(query));
    const providedContext = host === 'home' ? {} : host === 'project' ? { projects: pageContext.projects! } : pageContext;
    if (host === 'workBoard') {
        await getServerFeaturesSnapshot({ serverId: account.serverId });
        storage.getState().applyMachines([createMachineFixture({ id: 'new-relay', activeAt: Date.now() })]);
        recordMachineRequestFailed({ ...account, machineId: 'new-relay' });
        expect(resolveUiAccountActionFallbackMachineId(account)).toBeNull();
    }
    const screen = await renderScreen(body(providedContext));
    let restoreAppearance: (() => void) | undefined;
    try {
        await flushHookEffects({ cycles: 30 });
        await vi.waitFor(() => {
            expect(screen.tree.root.findAllByType(ConfiguredWidgetRefusal).map(node => node.props.resolution)).toEqual([]);
            expect(screen.tree.root.findAllByType(HappierDataMetric).map(node => node.props.value)).toContain(15);
        });
        if (host === 'workBoard') {
            const metrics = screen.tree.root.findAllByType(HappierDataMetric);
            // A native Account input does not acquire Machine identity merely because
            // an unrelated daemon becomes reachable before an appearance render.
            await React.act(async () => { recordMachineRequestSucceeded({ ...account, machineId: 'new-relay' }); });
            expect(resolveUiAccountActionFallbackMachineId(account)).toBe('new-relay');
            await flushHookEffects({ cycles: 30 });
            const reads = usageReads;
            const runtime = Unistyles.useUnistyles();
            const themeBoundary = vi.spyOn(Unistyles, 'useUnistyles');
            restoreAppearance = () => { themeBoundary.mockRestore(); };
            for (const theme of [darkTheme, lightTheme]) {
                themeBoundary.mockReturnValue({ ...runtime, theme });
                await screen.update(body(providedContext));
                await flushHookEffects({ cycles: 10 });
                expect(screen.tree.root.findAllByType(ConfiguredWidgetRefusal)).toEqual([]);
                const currentMetrics = screen.tree.root.findAllByType(HappierDataMetric);
                expect(currentMetrics).toHaveLength(metrics.length);
                currentMetrics.forEach((metric, index) => expect(metric).toBe(metrics[index]));
                expect(usageReads).toBe(reads);
            }
        }
        if (bindingKind === 'follow') {
            // The layout keeps its admitted context while its Artifact is reread.
            // That observation must not unmount the already populated Usage Resource.
            const metrics = screen.tree.root.findAllByType(HappierDataMetric);
            const reads = usageReads;
            layoutCurrent = false;
            layoutPending = true;
            await screen.update(body(providedContext));
            await flushHookEffects({ cycles: 10 });
            const refreshingMetrics = screen.tree.root.findAllByType(HappierDataMetric);
            expect(refreshingMetrics).toHaveLength(metrics.length);
            refreshingMetrics.forEach((metric, index) => expect(metric).toBe(metrics[index]));
            expect(usageReads).toBe(reads);
            layoutCurrent = true;
            layoutPending = false;
            // The page can retain a selected Agent absent from this period's choice inventory.
            const changed = normalizeUsageQuery({ ...query, agents: ['claude'] });
            await screen.update(body(readUsageWidgetPageContext(readUsageWidgetPageScope(changed))));
            await vi.waitFor(() => expect(screen.tree.root.findAllByType(ConfiguredWidgetRefusal)).toEqual([]));
            expect(screen.tree.root.findAllByType(HappierDataMetric).map(node => node.props.value)).toContain(15);
        }
        expect(http.writes).toEqual([]);
    } finally {
        restoreAppearance?.(); await screen.unmount(); await connection.dispose(); disposeActionLoader(); invalidateUsageQueryResources();
    }
});

it('consumes a live U5 widget in the generic Session surface through ordinary usage Resource admission', async () => {
    const http = createHomeHubArtifactHttpBoundary('viewer');
    let total = 15;
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://session-usage-visual.test',
        serverIdentityId: 'srv_session_usage_visual', accountId: 'viewer', request: async (url, init) => {
            if (new URL(String(url)).pathname !== '/v2/usage/query') return http.request(url, init);
            const value: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 1,
                tokens: { input: total - 5, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total },
                cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } } };
            return Response.json(value);
        } });
    const account = getActiveServerAccountScope();
    if (!account) throw new Error('Expected current viewer Account');
    const scope: WidgetSurfaceRefV1 = { ...account, owner: { kind: 'sessionBoard', sessionId: 'session-one' } };
    const query = normalizeUsageQuery({ period: { startMs: 1000 }, metric: 'tokens', breakdown: [] });
    const definition = { kind: 'builtin', id: 'usage_period_summary' } as const;
    const descriptor = readWidgetDescriptor(null, definition);
    if (!descriptor?.inputs) throw new Error('Expected U5 widget input descriptor');
    const bindings: WidgetInputBindingsV1 = {};
    for (const field of descriptor.inputs.fields) {
        bindings[field.path] = { kind: 'value', value: StrictJsonValueSchema.parse(readInputPath(query, field.path)) };
    }
    const instance: WidgetInstanceV1 = { v: 1, id: 'live-usage', definition, bindings };
    const runtime = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'current' as const,
        interactionEnabled: true, machineId: null, serverId: null, platform: 'web' as const,
        accountLifetime: captureActiveServerAccountScopeLifetime() };
    const screen = await renderScreen(<InjectedAuthProvider credentials={connection.credentials}>
        <WidgetSurface scope={scope} instance={instance} descriptor={descriptor}
            providedContext={{}} appRuntime={runtime} recordRevision="fixture:1" presentation="content" testID="live-usage" />
    </InjectedAuthProvider>);
    const shownValues = () => screen.tree.root.findAllByType(HappierDataMetric).map(node => node.props.value);
    let disconnected = false;
    try {
        await flushHookEffects({ cycles: 30 });
        await vi.waitFor(() => expect(shownValues(), JSON.stringify(screen.tree.toJSON())).toContain(15));
        total = 30;
        await React.act(async () => { invalidateUsageQueryResources(); });
        await flushHookEffects({ cycles: 30 });
        await vi.waitFor(() => expect(shownValues()).toContain(30));
        await React.act(async () => { await connection.dispose(); disconnected = true; });
        await vi.waitFor(() => expect(shownValues()).not.toContain(30));
    } finally { await screen.unmount(); if (!disconnected) await connection.dispose(); invalidateUsageQueryResources(); }
});

it('retains exact WorkBoard option admission across delayed responsive remounts and withdraws it on Account retirement', async () => {
    const disposeActionLoader = await installRealActionExecutorModuleLoader();
    const http = createHomeHubArtifactHttpBoundary('viewer');
    const board = createWorkBoardV1({ id: 'responsive-board', name: 'Launch week' });
    const boardHttp = createLayoutArtifactHttpBoundary('viewer', { artifactId: board.id, kind: 'work-board.v1',
        defaultLayout: board, parseLayout: value => WorkBoardV1Schema.parse(value), buildHeader: buildWorkBoardArtifactHeaderV1 });
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://responsive-board-options.test', accountId: 'viewer',
        request: (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/machines') return Promise.resolve(Response.json({ machines: [] }));
            if (path.startsWith(`/v1/artifacts/${board.id}`)) return boardHttp.request(url, init);
            return http.request(url, init);
        } });
    const account = getActiveServerAccountScope();
    if (!account) throw new Error('Expected the restored WorkBoard viewer');
    const lifetime = captureActiveServerAccountScopeLifetime();
    const scope: WidgetSurfaceRefV1 = { ...account, owner: { kind: 'workBoard', boardId: board.id } };
    const definition = { kind: 'builtin', id: 'usage_flow' } as const;
    let descriptor = readWidgetDescriptor(null, definition)!;
    const query = normalizeUsageQuery({ period: { relative: '30days' }, metric: 'tokens', breakdown: [] });
    const instance: WidgetInstanceV1 = { v: 1, id: 'daily', definition,
        bindings: Object.fromEntries(descriptor.inputs!.fields.map(field => [field.path,
            field.path === 'period' ? { kind: 'context', slot: 'period' }
                // A presentation-only field (the flow Style) is not a query path; bind its first declared choice.
                : { kind: 'value', value: StrictJsonValueSchema.parse(readInputPath(query, field.path) === undefined
                    ? field.options?.[0]?.value : readInputPath(query, field.path)) }])) };
    const storedBoard = WorkBoardV1Schema.parse({ ...board, widgets: [{ kind: 'widget', ref: { surface: scope, instanceId: instance.id }, instance, size: 'medium' }] });
    boardHttp.seed(storedBoard);
    const persistence = createWorkBoardArtifactBoundary({ v: 1, boards: [storedBoard] });
    const store = createWorkBoardAccountStore(persistence.transport, () => lifetime?.isCurrent() === true);
    // The canvas is an open view of this Board: an idle store reads no Board body without that demand.
    const releaseBoardView = store.retainView(() => () => {}, `board:${board.id}`);
    await store.refresh();
    const runtime = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'current' as const,
        interactionEnabled: true, machineId: null, serverId: account.serverId, platform: 'web' as const, accountLifetime: lifetime };
    const observed: ConfiguredWidgetTargetResolution[] = [];
    const instances: WidgetInstanceV1[] = [];
    let period = StrictJsonValueSchema.parse(query.period);
    function Probe() {
        // Both BoardCanvas and BoardByStatus receive this canonical placement unchanged.
        const widgets = useBoardWidgets(store.getDisplayedBoard(board.id)!);
        const instance = widgets[0]!.instance;
        instances.push(instance);
        const resolution = useConfiguredWidgetTarget({ scope, instance, descriptor, providedContext: { period: [period] }, appRuntime: runtime });
        observed.push(resolution);
        return null;
    }
    const screen = await renderScreen(<Probe key="desktop" />);
    let disconnected = false;
    try {
        await vi.waitFor(() => expect(observed.at(-1)?.status).toBe('ready'));
        for (const layout of ['phone', 'desktop']) {
            // Canvas has no body subscriber until its new measured span exists.
            await screen.update(<></>);
            await flushHookEffects({ cycles: 2 });
            const before = observed.length;
            await screen.update(<Probe key={layout} />);
            await flushHookEffects({ cycles: 2 });
            expect(observed.slice(before).map(state => state.status)).not.toContain('loading');
            expect(instances.at(-1)).toBe(instances[0]);
        }
        await screen.update(<></>);
        await flushHookEffects({ cycles: 2 });
        period = { relative: '7days' };
        const beforeChangedInput = observed.length;
        await screen.update(<Probe key="changed-context" />);
        // The new context asks for its own choices; the stored value keeps rendering while they load.
        expect(observed.slice(beforeChangedInput).map(state => state.status)).not.toContain('loading');
        await vi.waitFor(() => expect(observed.at(-1)?.status).toBe('ready'));
        await screen.update(<></>);
        await flushHookEffects({ cycles: 2 });
        descriptor = { ...descriptor, inputs: { ...descriptor.inputs!, fields: descriptor.inputs!.fields.map(field =>
            field.path === 'period' ? { ...field, title: 'Reporting period' } : field) } };
        const beforeChangedDeclaration = observed.length;
        await screen.update(<Probe key="changed-declaration" />);
        expect(observed.slice(beforeChangedDeclaration).map(state => state.status)).not.toContain('loading');
        await vi.waitFor(() => expect(observed.at(-1)?.status).toBe('ready'));
        await screen.update(<></>);
        await flushHookEffects({ cycles: 2 });
        await React.act(async () => { await connection.dispose(); disconnected = true; });
        await screen.update(<Probe key="retired" />);
        expect(observed.at(-1)?.status).not.toBe('ready');
    } finally { await screen.unmount(); releaseBoardView(); store.retire(); if (!disconnected) await connection.dispose(); disposeActionLoader(); }
});

it('shows its stored value while its choices are pending, and after the read is refused', async () => {
    const disposeActionLoader = await installRealActionExecutorModuleLoader();
    const http = createHomeHubArtifactHttpBoundary('actor');
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://usage-widget-options.test', accountId: 'actor', request: http.request });
    const scope: WidgetSurfaceRefV1 = { serverId: connection.home.id, accountId: 'actor', owner: { kind: 'home' } };
    const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'options-reader', name: 'Options reader',
        sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
        inputs: { fields: [{ path: 'home', title: 'Home', widget: 'select', optionsSourceId: 'sessions.spawn.servers.available' }] },
        inputSchema: { type: 'object', properties: { home: { type: 'string' } }, additionalProperties: false },
        provenance: { source: { kind: 'authored' } },
        body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'A declared options reader' } } } });
    const reference = { kind: 'inline' as const, definition };
    const instance: WidgetInstanceV1 = { v: 1, id: 'options', definition: reference, bindings: { home: { kind: 'value', value: connection.home.id } } };
    const descriptor = describeAuthoredWidgetDefinitionV1(definition, reference, null);
    const runtime = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'current' as const,
        interactionEnabled: true, machineId: null, serverId: null, platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime() };
    const observed: ConfiguredWidgetTargetResolution[] = [];
    const hook = await renderHook(() => {
        const state = useConfiguredWidgetTarget({ scope, instance, descriptor,
            providedContext: {}, appRuntime: runtime });
        observed.push(state);
        return state;
    });
    try {
        // Choices are needed to pick a value, not to show one: the card never waits on them.
        expect(observed[0]).toMatchObject({ status: 'ready' });
        // This inline definition is not published in the Account catalog, so the real Action refuses
        // the read after discovery. That refusal says nothing about the stored value.
        await flushHookEffects({ cycles: 3 });
        await vi.waitFor(() => expect(observed.length).toBeGreaterThan(1));
        expect(observed.every(state => state.status === 'ready')).toBe(true);
    } finally { await hook.unmount(); await connection.dispose(); disposeActionLoader(); }
});

it('shows its stored value from the retained runtime even when its saved input would need a choices read', async () => {
    const disposeActionLoader = await installRealActionExecutorModuleLoader();
    const http = createHomeHubArtifactHttpBoundary('actor');
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://offline-widget-options.test', accountId: 'actor', request: http.request });
    const scope: WidgetSurfaceRefV1 = { serverId: connection.home.id, accountId: 'actor', owner: { kind: 'home' } };
    const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'offline-options', name: 'Offline options',
        sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
        inputs: { fields: [{ path: 'home', title: 'Home', widget: 'select', optionsSourceId: 'sessions.spawn.servers.available' }] },
        inputSchema: { type: 'object', properties: { home: { type: 'string' } }, additionalProperties: false },
        provenance: { source: { kind: 'authored' } },
        body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'A declared options reader' } } } });
    const reference = { kind: 'inline' as const, definition };
    const instance: WidgetInstanceV1 = { v: 1, id: 'options', definition: reference, bindings: { home: { kind: 'value', value: connection.home.id } } };
    const descriptor = describeAuthoredWidgetDefinitionV1(definition, reference, null);
    // The daemon is unreachable and only the retained snapshot remains: no choices read is demanded, and none is needed.
    const runtime = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'retainedOffline' as const,
        unavailableReasonCode: 'plugin_machine_unreachable', interactionEnabled: false, machineId: null, serverId: null, platform: 'web' as const,
        accountLifetime: captureActiveServerAccountScopeLifetime() };
    const hook = await renderHook(() => useConfiguredWidgetTarget({ scope, instance, descriptor, providedContext: {}, appRuntime: runtime }));
    try {
        await flushHookEffects({ cycles: 3 });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready' });
    } finally { await hook.unmount(); await connection.dispose(); disposeActionLoader(); }
});

it('renders an HTML copy through the shared sandbox with its copied policy and retires on lost viewer admission', async () => {
    const http = createHomeHubArtifactHttpBoundary('viewer');
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://html-widget-copy.test', serverIdentityId: 'srv_html-widget-home', accountId: 'viewer', request: http.request });
    // The advertised identity adopts the routing slug. Layout admission uses
    // the canonical Account scope, not the earlier profile's transport alias.
    const viewer = getActiveServerAccountScope();
    if (!viewer) throw new Error('Expected restored viewer Account');
    const scope: WidgetSurfaceRefV1 = { ...viewer, owner: { kind: 'home' } };
    const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'html', name: 'HTML copy',
        sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
        provenance: { source: { kind: 'authored' } }, networkOverride: { network: 'none' },
        body: { kind: 'html', source: artifactHtmlBundleFromBodyV1('<main>Saved HTML</main>'), requestedCapabilities: { network: 'open', actions: ['session.board.get'] } } });
    const instance: WidgetInstanceV1 = { v: 1, id: 'copy', definition: { kind: 'inline', definition }, bindings: {} };
    const runtime = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'current' as const,
        interactionEnabled: true, machineId: null, serverId: null, platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime() };
    let current = true;
    const body = () => <WidgetSurface scope={scope} instance={instance} descriptor={null} providedContext={{}}
        appRuntime={runtime} presentation="content" recordRevision="copy-revision" isCurrent={() => current} testID="html-copy" />;
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    vi.stubGlobal('location', { origin: 'https://app.happier.dev' });
    try {
        screen = await renderScreen(body());
        await vi.waitFor(() => expect(screen!.tree.root.findAllByType(HostedHtmlSurfaceAdapter)).toHaveLength(1));
        const adapter = screen.tree.root.findByType(HostedHtmlSurfaceAdapter);
        expect(adapter.props.requestedCapabilities).toEqual({ actions: ['session.board.get'], network: 'none' });
        await React.act(async () => { await loadPluginUiHostSupport(); });
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen!.tree.root.findAllByProps({ testID: 'html-copy-frame' }).length,
                JSON.stringify(screen!.tree.toJSON())).toBeGreaterThan(0);
        });
        instance.networkOverride = { networkOrigins: ['https://copy.example.com'] };
        await screen.update(body());
        expect(screen.tree.root.findByType(HostedHtmlSurfaceAdapter).props.requestedCapabilities).toEqual({ actions: ['session.board.get'], networkOrigins: ['https://copy.example.com'] });
        current = false;
        await screen.update(body());
        expect(screen.tree.root.findAllByProps({ testID: 'html-copy-frame' })).toHaveLength(0);
    } finally { await screen?.unmount(); await connection.dispose(); vi.unstubAllGlobals(); }
});

it('retains an admitted native body during layout refresh and removes it when its Account read retires', async () => {
    const http = createHomeHubArtifactHttpBoundary('actor');
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://native-app-widget.test', accountId: 'actor', request: http.request });
    const scope: WidgetSurfaceRefV1 = { serverId: connection.home.id, accountId: 'actor', owner: { kind: 'home' } };
    const instance: WidgetInstanceV1 = { v: 1, id: 'app-copy', definition: { kind: 'builtin', id: 'session_summary' }, bindings: { period: { kind: 'value', value: 7 } } };
    const descriptor: WidgetCandidate = { ...readWidgetDescriptor(null, instance.definition)!, target: 'app',
        inputs: { fields: [{ path: 'period', title: 'Period', widget: 'integer', required: true }] },
        inputSchema: { type: 'object', properties: { period: { type: 'integer' } }, required: ['period'], additionalProperties: false } };
    const runtime = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'current' as const,
        interactionEnabled: true, machineId: null, serverId: null, platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime() };
    let current = false;
    let pending = true;
    let shownScope: WidgetSurfaceRefV1 = scope;
    const body = () => <WidgetSurface scope={shownScope} instance={instance} descriptor={descriptor}
        providedContext={{}} appRuntime={runtime} presentation="content" recordRevision="same-instance" isCurrent={() => current} isReadPending={() => pending}
        reference={<Text testID="native-app-read">7 days</Text>} testID="native-app-widget" />;
    const screen = await renderScreen(body());
    try {
        expect(screen.tree.root.findAllByProps({ testID: 'native-app-read' })).toHaveLength(0);
        expect(screen.tree.root.findAllByProps({ testID: 'native-app-widget-state-rows' }).length).toBeGreaterThan(0);
        current = true;
        pending = false;
        await screen.update(body());
        expect(screen.tree.root.findAllByProps({ testID: 'native-app-read' }).length).toBeGreaterThan(0);
        current = false;
        pending = true;
        await screen.update(body());
        expect(screen.tree.root.findAllByProps({ testID: 'native-app-read' }).length).toBeGreaterThan(0);
        expect(screen.tree.root.findAllByProps({ testID: 'native-app-widget-state-rows' })).toHaveLength(0);
        expect(screen.tree.root.findAllByType(SurfaceStateCard)).toHaveLength(0);
        shownScope = { ...scope, owner: { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'overview' } };
        await screen.update(body());
        expect(screen.tree.root.findAllByProps({ testID: 'native-app-read' })).toHaveLength(0);
        expect(screen.tree.root.findAllByProps({ testID: 'native-app-widget-state-rows' }).length).toBeGreaterThan(0);
        shownScope = scope;
        await screen.update(body());
        expect(screen.tree.root.findAllByProps({ testID: 'native-app-read' })).toHaveLength(0);
        expect(screen.tree.root.findAllByProps({ testID: 'native-app-widget-state-rows' }).length).toBeGreaterThan(0);
        pending = false;
        await screen.update(body());
        expect(screen.tree.root.findByType(SurfaceStateCard).props.kind).toBe('unavailable');
    } finally { await screen.unmount(); await connection.dispose(); }
});

it('does not mount native readers while the containing document admission is suspended', async () => {
    const http = createHomeHubArtifactHttpBoundary('actor');
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://native-widget.test', accountId: 'actor', request: http.request });
    const checkout = { id: 'checkout', serverId: connection.home.id, machineId: 'machine', rootPath: '/repo', createdAtMs: 1 };
    applyProjectAccountRowsFixture(storage, { workspaceRefs: [checkout] });
    const scope: WidgetSurfaceRefV1 = { serverId: connection.home.id, accountId: 'actor', owner: { kind: 'project', projectId: 'project' } };
    const instance: WidgetInstanceV1 = { v: 1, id: 'about', definition: { kind: 'builtin', id: 'project_about' },
        bindings: { checkout: { kind: 'context', slot: 'checkout' } } };
    const runtime = { pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null, phase: 'current' as const,
        interactionEnabled: true, machineId: 'machine', serverId: connection.home.id, platform: 'web' as const,
        accountLifetime: captureActiveServerAccountScopeLifetime() };
    let current = true;
    let groupBindings: WidgetInputBindingsV1 | undefined;
    const body = () => <WidgetSurface scope={scope} instance={instance} descriptor={readWidgetDescriptor(null, instance.definition)}
        providedContext={{ checkout: [checkout] }} appRuntime={runtime} presentation="content" recordRevision="same-instance"
        groupBindings={groupBindings}
        isCurrent={() => current} testID="native-widget" />;
    const screen = await renderScreen(body());
    try {
        expect(screen.tree.root.findAllByType(ProjectBuiltinWidgetBody)).toHaveLength(1);
        groupBindings = { checkout: { kind: 'value', value: { ...checkout, rootPath: '/forged' } } };
        await screen.update(body());
        expect(screen.tree.root.findAllByType(ProjectBuiltinWidgetBody)).toHaveLength(0);
        groupBindings = { checkout: { kind: 'value', value: checkout } };
        await screen.update(body());
        expect(screen.tree.root.findAllByType(ProjectBuiltinWidgetBody)).toHaveLength(1);
        current = false;
        await screen.update(body());
        expect(screen.tree.root.findAllByType(ProjectBuiltinWidgetBody)).toHaveLength(0);
        current = true;
        await screen.update(body());
        expect(screen.tree.root.findAllByType(ProjectBuiltinWidgetBody)).toHaveLength(1);
    } finally { await screen.unmount(); await connection.dispose(); }
});
