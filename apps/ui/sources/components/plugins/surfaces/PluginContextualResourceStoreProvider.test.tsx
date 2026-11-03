import * as React from 'react';
import type { Disposable, PluginAccountApi } from '@happier-dev/plugin-sdk';
import type { PluginActionReadInvalidation } from '@happier-dev/plugin-sdk/actions';
import { PluginError } from '@happier-dev/plugin-sdk';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { publishCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import renderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginUiResourceSnapshot, PluginUiResourceProjection as PluginUiResourceValueProjection } from '@happier-dev/plugin-ui/hostApi';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { createPluginSurfaceActionHostApi } from './pluginSurfaceActionDispatch';
import { createCanonicalPluginReactNativeHostApiAdapter } from '@/components/plugins/reactNative/hostApi';
import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { useLivePluginResource, usePluginResource } from '@happier-dev/plugin-ui/hostApi';
import { createPluginUiResourceStore, createPluginUiHostApiResourceClient } from '@happier-dev/plugin-ui/advanced';
import { widgetProjectionOf, widgetInstalledPackage, widgetExecutionOrigin } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { unionPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import { createBoundPluginSurfaceController } from './boundPluginSurfaceController';
import { createPluginContextualResourceReadClient, createPluginSurfaceResourceReadHandler } from './pluginSurfaceResourceRead';
import { createPluginContextualResourceWatchClient, createPluginSurfaceResourceWatchHandlers } from './pluginSurfaceResourceWatch';
import { DeclarativeWidgetDocument } from '@/components/widgets/DeclarativeWidgetDocument';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { PluginDeclarativeDocumentV1Schema, createWorkBoardV1, buildWorkBoardWidgetKeyV1, type WorkBoardWidgetPlacementV1 } from '@happier-dev/protocol';
import { BoardCanvas, type BoardCanvasWidgetRender } from '@/components/boards/canvas/BoardCanvas';
import { projectBoardMembership } from '@/components/boards/model/boardMembership';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';
import type { WorkBoardEntityBinding } from '@/components/boards/model/workBoardEntityBinding';
import { resolveDeclarativeDataResourceBinding } from './declarativeDataSource';
import { HappierDataMetric } from '@happier-dev/plugin-ui/presentation';
import { createWidgetSnapshotCaptureSlot, WidgetSnapshotCaptureContext } from '@/components/widgets/definitions/widgetSnapshotCapture';
import { WidgetSnapshotConfirmPanel } from '@/components/widgets/definitions/WidgetSnapshotConfirmPanel';
import { t } from '@/text';
import { normalizePluginInstalledUiDeclarations } from '@/sync/domains/plugins/ui/projection';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { WidgetDefinitionV1Schema } from '@happier-dev/protocol/widgets/widgetDefinitionV1';

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);
const connections: Awaited<ReturnType<typeof restoreServerAccountForTest>>[] = [];
afterEach(async () => {
    for (const connection of connections.splice(0).reverse()) await connection.dispose();
});

const machineResourceRpc = vi.hoisted(() => ({
    read: vi.fn(),
    open: vi.fn(),
    next: vi.fn(),
    close: vi.fn(),
}));

// Mock only the daemon network boundary. Keep RPC request/response admission,
// contextual clients, Resource store, and watch pump real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (request: Readonly<{
        machineId: string;
        method: string;
        payload: Readonly<Record<string, unknown>>;
        signal?: AbortSignal;
    }>) => {
        const options = { ...request.payload, signal: request.signal };
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE) {
            await machineResourceRpc.close(request.machineId, options);
            return { ok: true };
        }
        const call = request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ
            ? machineResourceRpc.read
            : request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN
                ? machineResourceRpc.open
                : request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_NEXT
                    ? machineResourceRpc.next
                    : null;
        if (!call) throw new Error(`Unexpected daemon RPC: ${request.method}`);
        const response = await call(request.machineId, options);
        if (!response.supported) throw Object.assign(new Error(response.reason), { name: 'AbortError' });
        return response.result;
    },
}));

import {
    PluginContextualResourceState,
    PluginContextualResourceStoreProvider,
    type PluginContextualResourceBinding,
    usePluginContextualResourceStoreOwner,
    type PluginContextualResourceStoreOwner,
    acquirePluginContextualResourceStore,
    createPluginDeclaredResourceStore,
} from './PluginContextualResourceStoreProvider';

type AccountLifetime = PluginContextualResourceBinding['accountLifetime'];

const RESOURCE_ID = 'control-state';

function resourceResponse(marker: string) {
    return {
        supported: true as const,
        result: {
            ok: true as const,
            resource: { pluginId: 'acme.composer', localId: RESOURCE_ID },
            kind: 'config' as const,
            contentType: 'application/json',
            digest: `sha256:${marker.repeat(64)}`,
            bytesBase64: 'MQ==',
        },
    };
}

function watchOpenResponse(subscriptionId: string, marker: string) {
    return {
        supported: true as const,
        result: {
            ok: true as const,
            subscriptionId,
            digest: `sha256:${marker.repeat(64)}`,
        },
    };
}

function invalidatedResponse(subscriptionId: string, marker: string) {
    return {
        supported: true as const,
        result: {
            ok: true as const,
            status: 'event' as const,
            event: {
                version: 1 as const,
                subscriptionId,
                kind: 'invalidated' as const,
                digest: `sha256:${marker.repeat(64)}`,
            },
        },
    };
}

async function createAccountLifetime(input: Readonly<{
    accountId: string;
}>): Promise<Readonly<{
    lifetime: AccountLifetime;
    http: ReturnType<typeof createHomeHubArtifactHttpBoundary>;
    retire(): void;
}>> {
    await import('@/sync/syncEngine');
    const http = createHomeHubArtifactHttpBoundary(input.accountId);
    connections.push(await restoreServerAccountForTest({ serverUrl: 'http://contextual-resource.test',
        accountId: input.accountId, request: http.request }));
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected real captured Account lifetime');
    return Object.freeze({
        lifetime,
        http,
        retire: retireActiveServerAccountScopeLifetime,
    });
}

function binding(
    accountLifetime: AccountLifetime,
    expectedCallerOccurrenceId = 'occurrence-42',
): PluginContextualResourceBinding {
    return Object.freeze({
        accountLifetime,
        pluginId: 'acme.composer',
        machineId: 'machine-1',
        serverId: accountLifetime.scope.serverId,
        expectedCallerOccurrenceId,
        context: Object.freeze({ kind: 'session' as const, sessionId: 'session-1' }),
    });
}

it('fails factory-backed Resource admission explicitly in an unsupported Account placement', async () => {
    let directReads = 0;
    const harness = await createPortableAccountResourceHarness({
        read() { directReads++; return '{}'; }, observe: () => ({ dispose() {} }),
        createProducer() { throw new Error('Daemon producer must not start in Account placement'); },
    });
    const store = createPluginDeclaredResourceStore(harness.input)!;
    try {
        const snapshot = await store.getEntry('status').refresh();
        expect(snapshot.error?.code).toBe('plugin_resource_producer_placement_unavailable');
        expect(snapshot.value).toBeUndefined();
        expect(directReads).toBe(0);
    } finally { store.dispose(); await harness.dispose(); }
});

async function createPortableAccountResourceHarness(runtime?: PluginDynamicResourceRuntime,
    dependencies: Readonly<Record<string, PluginDynamicResourceRuntime>> = {}, scope: 'global' | 'session' | 'surface' = 'session') {
    const account = await createAccountLifetime({ accountId: 'portable-resource-account' });
    const { createPluginReactNativeBundleCache } = await import('@/components/plugins/reactNative/bundleCache');
    const { createPluginUiCommonJsLoaderBackend } = await import('@/components/plugins/reactNative/commonJsLoaderBackend');
    const { getInstalledPluginUiClientExecutableComposition } = await import('@/components/plugins/reactNative/clientExecutableContributions');
    const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
    const pluginId = 'acme.portable-resource';
    const hostAccountOrigin = { ...account.lifetime.scope, custodyId: 'portable-resource-custody',
        sourceCustody: { kind: 'bundled_first_party' as const, packagedRuntime: { kind: 'source_declaration' as const, packageName: '@acme/portable-resource' } } };
    const target = { realm: 'account' as const, artifactId: 'portable-resource', exportName: 'activate', platform: 'web' as const };
    const declaration = { pluginId, id: 'status', source: 'dynamic' as const, resourceKind: 'config' as const,
        scope, contentType: 'application/json', occurrenceId: hostAccountOrigin.custodyId,
        execution: { target: 'account' as const, account: { artifactId: target.artifactId, exportName: target.exportName } }, hostAccountOrigin };
    const declarations = [declaration, ...Object.keys(dependencies).map(id => ({ ...declaration, id }))];
    const resourcesById = Object.fromEntries(declarations.map(resource => [`${pluginId}/${resource.id}`, resource]));
    const projection = { ...EMPTY_PLUGIN_UI_PROJECTION, resourcesById };
    const unpublish = publishCommittedAppShellPluginUiProjection(() => projection);
    const cache = createPluginReactNativeBundleCache();
    const identity = { pluginId, contributionId: 'resources/status', artifactId: target.artifactId,
        artifactDigest: `sha256:${'a'.repeat(64)}` as const, platform: 'web' as const };
    cache.putInstalledArtifact({ identity, format: 'plainJs', bytes: new TextEncoder().encode(
        "exports.activate = function(api) { let reads = 0; api.resources.registerDynamicResource('status', {read(options) { return JSON.stringify({sessionId: options.context.sessionId, reads: ++reads}); }, observe() { return {dispose() {}}; }}); };",
    ) });
    const composition = getInstalledPluginUiClientExecutableComposition();
    let activationEntered = false;
    let activationError: unknown;
    try {
        const reconciled = await composition.reconcile([{ pluginId, contributes: { resources: declarations }, target,
            executionOrigin: null, occurrenceId: hostAccountOrigin.custodyId, pluginVersion: '1.0.0', accountLifetime: account.lifetime,
            hostUiApiRange: '^1.0.0', cache, identity, moduleReference: { exportName: 'activate' },
            // Executable module loading is the genuine boundary. The registered
            // runtime, Account custody and Resource store below stay real.
            backend: runtime ? { backendId: 'commonJs', available: true, diagnostics: [],
                loadInstalledBundle: async () => (api: PluginAccountApi) => {
                    activationEntered = true;
                    try {
                        api.resources.registerDynamicResource('status', runtime);
                        for (const [id, dependency] of Object.entries(dependencies)) api.resources.registerDynamicResource(id, dependency);
                    } catch (error) { activationError = error; throw error; }
                } }
                : createPluginUiCommonJsLoaderBackend(),
            authority: { kind: 'account', ...account.lifetime.scope, custodyId: hostAccountOrigin.custodyId },
            isCurrent: account.lifetime.isCurrent }]);
        expect(reconciled, JSON.stringify({ results: reconciled.map(row => row.result), activationEntered,
            activationError: activationError instanceof Error ? { name: activationError.name, message: activationError.message, stack: activationError.stack }
                : activationError ?? null })).toMatchObject([{ result: { ok: true } }]);
        const input = { accountLifetime: account.lifetime, pluginId, machineId: null, serverId: account.lifetime.scope.serverId,
            expectedCallerOccurrenceId: hostAccountOrigin.custodyId, resourcesById, resourceDeclarationsComplete: true, sessionId: 'session-portable' };
        return { account, input, composition, pluginId,
            async dispose() { unpublish(); await composition.invalidatePlugin(pluginId); } };
    } catch (error) { unpublish(); await composition.invalidatePlugin(pluginId); throw error; }
}

it('reads a global Account Resource on an app surface when its complete namespace also contains static assets', async () => {
    const harness = await createPortableAccountResourceHarness({
        read: options => JSON.stringify({ context: options.context.kind }),
        observe: () => ({ dispose() {} }),
    }, {}, 'global');
    // Channels publishes global management Resources alongside brand/i18n
    // assets, which have no dynamic context scope (src/manifest.ts).
    const resourcesById = { ...harness.input.resourcesById,
        brand: { id: 'brand-icon', pluginId: harness.pluginId, resourceKind: 'asset' as const,
            path: 'assets/brand.png', contentType: 'image/png' } };
    const projection = widgetProjectionOf([], {}, resourcesById);
    let resourceDeclarations: PluginUiProjectionModel['resourcesById'] | undefined;
    const controller = createBoundPluginSurfaceController({ facts: {
        pluginId: harness.pluginId, contributionId: 'settings', surfaceId: 'settings-native',
        placement: 'appSurface', platform: 'web', channel: 'internal', resourceScope: [],
        accountLifetime: harness.account.lifetime, machineId: 'machine-1', serverId: harness.input.serverId,
        occurrenceId: harness.input.expectedCallerOccurrenceId,
        resourceCapability: { readable: true, dynamic: true },
        resourceContext: { kind: 'surface', mountInstanceKey: 'settings', launchInput: null, target: { kind: 'app' } },
        pluginUiProjection: projection,
        readActionInputFacts: () => ({ pluginUiProjection: projection, resourceDeclarations }),
        interactionEnabled: true, daemonInteractionEnabled: true,
    } });
    // A global daemon Resource rejects a containing surface context; this is
    // the network boundary's real refusal, not a replacement Resource owner.
    machineResourceRpc.read.mockResolvedValue({ supported: true,
        result: { ok: false, reason: 'unavailable', code: 'plugin_resource_context_unavailable' } });
    try {
        // The current mounted target delivers its complete declarations late;
        // the physical surface does not remount or need re-adoption.
        resourceDeclarations = resourcesById;
        controller.updateMountedBindings?.({});
        const entry = controller.resourceStore?.getEntry('status');
        expect(entry).toBeDefined();
        const snapshot = await entry!.refresh();
        expect(snapshot.error).toBeUndefined();
        expect(JSON.parse(new TextDecoder().decode(snapshot.value!.bytes))).toEqual({ context: 'global' });
        expect(machineResourceRpc.read).not.toHaveBeenCalled();
        machineResourceRpc.read.mockResolvedValue(resourceResponse('a'));
        const asset = await controller.resourceStore!.getEntry('brand-icon').refresh();
        expect(asset.error).toBeUndefined();
        expect(asset.value).toBeDefined();
        expect(machineResourceRpc.read).toHaveBeenLastCalledWith('machine-1', expect.objectContaining({ context: { kind: 'global' } }));
    } finally { controller.dispose(); await harness.dispose(); }
});

it.each([
    { code: 'collection_index_not_ready', composed: false },
    { code: 'collection_update_required', composed: false },
    { code: 'collection_content_mode_mismatch', composed: false },
    { code: 'collection_contract_inconsistent', composed: false },
    { code: 'collection_update_required', composed: true },
])('settles the Account Resource Collection refusal $code (composed=$composed) until its producer changes', async ({ code, composed }) => {
    let refused = true;
    let reads = 0;
    let observations = 0;
    let invalidate: (() => void) | undefined;
    // Only executable-module loading is substituted by the existing harness;
    // registration, Account Resource client and shared Resource store stay real.
    const leaf: PluginDynamicResourceRuntime = {
        read() {
            reads += 1;
            if (refused) throw new PluginError({ code });
            return '{}';
        },
        observe(notify) {
            observations += 1;
            invalidate = notify;
            return { dispose() { invalidate = undefined; } };
        },
    };
    const harness = await createPortableAccountResourceHarness(composed ? {
        async read(options) { return (await options.resources.read('leaf')).bytes; },
        observe(notify, options) { return options.resources.watch('leaf', notify); },
    } : leaf, composed ? { leaf } : {});
    vi.useFakeTimers();
    const store = createPluginDeclaredResourceStore(harness.input)!;
    const entry = store.getEntry('status');
    const release = entry.subscribe(() => {}, true);
    try {
        await vi.advanceTimersByTimeAsync(1_000);
        expect({ reads, observations }).toEqual({ reads: 1, observations: 1 });
        expect(entry.getSnapshot()).toMatchObject({ pending: 'idle', error: { code, retryable: false } });
        expect(invalidate).toBeTypeOf('function');
        refused = false;
        invalidate!();
        await vi.advanceTimersByTimeAsync(0);
        expect(reads).toBe(2);
        expect(entry.getSnapshot()).toMatchObject({ freshness: 'fresh', subscription: 'live' });
    } finally {
        release(); store.dispose();
        await harness.dispose();
        vi.useRealTimers();
    }
});

it('shares one portable Account Resource read for the exact Session and withdraws its retired producer', async () => {
    const harness = await createPortableAccountResourceHarness();
    const { account, input, composition, pluginId } = harness;
    const first = createPluginDeclaredResourceStore(input)!;
    const second = createPluginDeclaredResourceStore(input)!;
    let releaseFirst = () => {};
    let releaseSecond = () => {};
    try {
        const a = first.getEntry('status');
        const b = second.getEntry('status');
        releaseFirst = a.subscribe(() => {}, true);
        releaseSecond = b.subscribe(() => {}, true);
        await vi.waitFor(() => expect(a.getSnapshot().value).toBeDefined());
        expect(b.getSnapshot().value).toBe(a.getSnapshot().value);
        expect(JSON.parse(new TextDecoder().decode(a.getSnapshot().value!.bytes))).toEqual({ sessionId: 'session-portable', reads: 1 });
        expect(machineResourceRpc.read).not.toHaveBeenCalled();
        await composition.invalidatePlugin(pluginId);
        expect(a.getSnapshot().value).toBeUndefined();
        expect(b.getSnapshot().value).toBeUndefined();
        account.retire();
    } finally {
        releaseFirst(); releaseSecond(); first?.dispose(); second?.dispose();
        await harness.dispose();
    }
});

it('retires nested Account Action read authority immediately while ordinary invalidation retains Resource bytes', async () => {
    const account = await createAccountLifetime({ accountId: 'nested-read-retirement' });
    const { installPortableAccountPluginForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
    const pluginId = 'example.retiring-account-source';
    const execution = { target: 'account', account: { artifactId: 'read-retirement', exportName: 'activate' } };
    const parsed = parsePluginManifest({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Read retirement source',
        engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, contributes: {
            actions: ['source', 'relay'].map(id => ({ id, title: id, scopes: ['global'], surfaces: ['plugin'],
                execution, dangerLevel: 'safe', readOnly: true })),
            resources: [{ id: 'status', source: 'dynamic', scope: 'session', kind: 'config',
                contentType: 'application/json', execution }],
        } });
    if (!parsed.ok) throw new Error(`Invalid authored read fixture: ${JSON.stringify(parsed.diagnostics)}`);
    let nativeReads = 0;
    let holdNative = false;
    let sourceDisposals = 0;
    const invalidations: PluginActionReadInvalidation[] = [];
    const observerSignals: AbortSignal[] = [];
    const nativePending: Array<Readonly<{ gate: ReturnType<typeof createDeferred<{ value: string }>>; signal: AbortSignal }>> = [];
    const source = { pluginId, localId: 'source' };
    const relay = { pluginId, localId: 'relay' };
    const fixture = await installPortableAccountPluginForTest({ manifest: parsed.manifest, accountLifetime: account.lifetime,
        activate(api) {
            api.actions.register('source', async (_input, context) => {
                nativeReads++;
                if (!holdNative) return { value: 'initial-private-value' };
                const gate = createDeferred<{ value: string }>();
                nativePending.push({ gate, signal: context.signal });
                return await gate.promise;
            }, { observeRead(_input, invalidate, context) {
                invalidations.push(invalidate); observerSignals.push(context.signal);
                return { dispose() { sourceDisposals++; } };
            } });
            api.actions.register('relay', async (_input, context) => context.services.actions.execute(source, {}),
                { observeRead: (_input, invalidate, context) => context.services.actions.observe(source, {}, invalidate) });
            api.resources.registerDynamicResource('status', {
                async read(options) {
                    const result = await options.readAction(relay, {}, { signal: options.signal });
                    if (!result.ok) throw new PluginError({ code: result.errorCode });
                    return JSON.stringify(result.result);
                },
                observe: (invalidate, options) => options.observeAction(relay, {}, invalidate, { signal: options.signal }),
            });
        } });
    const unpublish = publishCommittedAppShellPluginUiProjection(() => fixture.projection);
    const declaration = fixture.projection.resourcesById[`${pluginId}/status`];
    if (!declaration) throw new Error('Expected admitted Account Resource declaration');
    const lease = acquirePluginContextualResourceStore({ accountLifetime: account.lifetime, pluginId, machineId: null,
        serverId: account.lifetime.scope.serverId, expectedCallerOccurrenceId: declaration.occurrenceId!,
        accountResource: declaration, context: { kind: 'session', sessionId: 'read-retirement-session' } });
    if (!lease) throw new Error('Expected current Account Resource lease');
    const entry = lease.store.getEntry('status');
    const decode = vi.fn((content: NonNullable<PluginUiResourceSnapshot['value']>, _previous: { text: string } | undefined) => ({
        text: new TextDecoder().decode(content.bytes),
    }));
    const projection: PluginUiResourceValueProjection<{ text: string }> = { decode };
    const selected = entry.select(projection, snapshot => snapshot.value);
    const release = selected.subscribe(() => {}, true);
    try {
        await vi.waitFor(() => expect(selected.getSnapshot()?.text).toContain('initial-private-value'));
        await vi.waitFor(() => expect(entry.getSnapshot().subscription).toBe('live'));
        expect(nativeReads).toBe(1);
        expect(invalidations).toHaveLength(1);
        const oldBytes = entry.getSnapshot().value;
        const oldTypedValue = selected.getSnapshot();
        holdNative = true;
        invalidations[0]!();
        await vi.waitFor(() => expect(nativePending).toHaveLength(1));
        expect(entry.getSnapshot().value).toBe(oldBytes);
        expect(selected.getSnapshot()).toBe(oldTypedValue);

        invalidations[0]!.retire();
        expect(entry.getSnapshot().value).toBeUndefined();
        expect(entry.getSnapshot().digest).toBeUndefined();
        expect(selected.getSnapshot()).toBeUndefined();
        expect(nativePending[0]!.signal.aborted).toBe(true);
        expect(observerSignals[0]!.aborted).toBe(true);
        expect(sourceDisposals).toBe(1);
        expect(account.lifetime.isCurrent()).toBe(true);
        invalidations[0]!.retire(); invalidations[0]!();
        await vi.waitFor(() => expect(nativePending).toHaveLength(2));
        await vi.waitFor(() => expect(invalidations).toHaveLength(2));
        nativePending[0]!.gate.resolve({ value: 'late-old-private-value' });
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        expect(entry.getSnapshot().value).toBeUndefined();
        expect(selected.getSnapshot()).toBeUndefined();
        nativePending[1]!.gate.resolve({ value: 'replacement-private-value' });
        await vi.waitFor(() => expect(selected.getSnapshot()?.text).toContain('replacement-private-value'));
        expect(decode).toHaveBeenLastCalledWith(expect.anything(), undefined);
        expect(entry.getSnapshot().subscription).toBe('live');
        expect(invalidations).toHaveLength(2);
        expect(nativeReads).toBe(3);
        release();
        await vi.waitFor(() => expect(sourceDisposals).toBe(2));
        invalidations[1]!.retire(); invalidations[1]!();
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        expect(nativeReads).toBe(3);
        expect(invalidations).toHaveLength(2);
    } finally {
        release(); lease.dispose();
        for (const pending of nativePending) pending.gate.resolve({ value: 'disposed' });
        unpublish(); await fixture.dispose();
    }
});

it('keeps a portable Resource watch establishing until async attachment succeeds and preserves attach failure', async () => {
    const attached = createDeferred<Disposable>();
    const runtime: PluginDynamicResourceRuntime = { read: () => '{}', observe: () => attached.promise };
    const harness = await createPortableAccountResourceHarness(runtime);
    const store = createPluginDeclaredResourceStore(harness.input)!;
    const entry = store.getEntry('status');
    const release = entry.subscribe(() => {}, true);
    const failure = Object.assign(new Error('Dependency admission failed'), { code: 'dependency_denied', retryable: false });
    try {
        expect(entry.getSnapshot().subscription).toBe('establishing');
        expect(entry.getSnapshot().value).toBeUndefined();
        attached.reject(failure);
        await vi.waitFor(() => expect(entry.getSnapshot().subscription).toBe('ended'));
        expect(entry.getSnapshot().error).toMatchObject({ code: 'dependency_denied' });
    } finally { attached.resolve({ dispose() {} }); release(); store.dispose(); await harness.dispose(); }
});

it.each(['request', 'registration', 'Account'] as const)('disposes a late async Resource observer after %s cancellation', async cause => {
    const attached = createDeferred<Disposable>();
    const observing = createDeferred<void>();
    const dispose = vi.fn();
    const harness = await createPortableAccountResourceHarness({ read: () => '{}', observe() { observing.resolve(); return attached.promise; } });
    const store = createPluginDeclaredResourceStore(harness.input)!;
    const entry = store.getEntry('status');
    const release = entry.subscribe(() => {}, true);
    try {
        expect(entry.getSnapshot().subscription).toBe('establishing');
        await observing.promise;
        if (cause === 'request') release();
        else if (cause === 'registration') await harness.composition.invalidatePlugin(harness.pluginId);
        else harness.account.retire();
        attached.resolve({ dispose });
        await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
        expect(entry.getSnapshot().subscription).not.toBe('live');
    } finally { attached.resolve({ dispose }); release(); store.dispose(); await harness.dispose(); }
});

it('admits a completed async Resource observer and rejects an invalid observer', async () => {
    const attached = createDeferred<Disposable>();
    const dispose = vi.fn();
    const harness = await createPortableAccountResourceHarness({ read: () => '{}', observe: () => attached.promise });
    const store = createPluginDeclaredResourceStore(harness.input)!;
    const entry = store.getEntry('status');
    const release = entry.subscribe(() => {}, true);
    try {
        attached.resolve({ dispose });
        await vi.waitFor(() => expect(entry.getSnapshot().subscription).toBe('live'));
        release(); release();
        expect(dispose).toHaveBeenCalledTimes(1);
    } finally { release(); store.dispose(); await harness.dispose(); }
    const invalid = await createPortableAccountResourceHarness({ read: () => '{}',
        // A trusted JS plugin can still violate its typed runtime boundary.
        observe: () => Promise.resolve({}) as Promise<Disposable> });
    const invalidStore = createPluginDeclaredResourceStore(invalid.input)!;
    const invalidEntry = invalidStore.getEntry('status');
    const releaseInvalid = invalidEntry.subscribe(() => {}, true);
    try { await vi.waitFor(() => expect(invalidEntry.getSnapshot().error).toMatchObject({ code: 'plugin_resource_observation_invalid' })); }
    finally { releaseInvalid(); invalidStore.dispose(); await invalid.dispose(); }
});

it('fails Account watch admission when its shared baseline read fails and releases the attached observer', async () => {
    const failure = Object.assign(new Error('Baseline read denied'), { code: 'baseline_denied', retryable: false });
    const dispose = vi.fn();
    const harness = await createPortableAccountResourceHarness({ read: () => { throw failure; }, observe: () => ({ dispose }) });
    const store = createPluginDeclaredResourceStore(harness.input)!;
    const entry = store.getEntry('status');
    const release = entry.subscribe(() => {}, true);
    try {
        await vi.waitFor(() => expect(entry.getSnapshot().error?.code).toBe('baseline_denied'));
        expect(entry.getSnapshot().subscription).not.toBe('live');
        await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
    } finally { release(); store.dispose(); await harness.dispose(); }
});

it('settles an explicit warm Account Resource refresh when the retained bytes are unchanged', async () => {
    let nextRead: ReturnType<typeof createDeferred<string>> | undefined;
    const unchanged = JSON.stringify({ connections: [] });
    const harness = await createPortableAccountResourceHarness({
        read: () => nextRead?.promise ?? unchanged,
        observe: () => ({ dispose() {} }),
    }, {}, 'global');
    const store = createPluginDeclaredResourceStore(harness.input)!;
    const entry = store.getEntry('status');
    const release = entry.subscribe(() => {}, true);
    try {
        await vi.waitFor(() => expect(entry.getSnapshot()).toMatchObject({
            subscription: 'live', pending: 'idle', freshness: 'fresh',
        }));
        const retained = entry.getSnapshot().value;
        expect(retained).toBeDefined();
        for (let attempt = 0; attempt < 2; attempt += 1) {
            nextRead = createDeferred<string>();
            const refreshed = entry.refresh();
            await vi.waitFor(() => expect(entry.getSnapshot()).toMatchObject({ pending: 'refresh', freshness: 'stale' }));
            expect(entry.getSnapshot().value).toBe(retained);
            nextRead.resolve(unchanged);
            await expect(refreshed).resolves.toMatchObject({ subscription: 'live', pending: 'idle', freshness: 'fresh' });
            expect(entry.getSnapshot().value).toBe(retained);
        }
    } finally {
        nextRead?.resolve(unchanged);
        release(); store.dispose(); await harness.dispose();
    }
});

it('shares a parent Resource dependency with direct UI demand and releases it when parent demand ends', async () => {
    let value = 'first';
    let invalidate = () => {};
    let reads = 0;
    const stopped = vi.fn();
    const harness = await createPortableAccountResourceHarness({
        async read(options) { return (await options.resources.read('relations', { signal: options.signal })).bytes; },
        async observe(changed, options) { return await options.resources.watch('relations', () => changed()); },
    }, { relations: { read() { reads += 1; return JSON.stringify({ value }); },
        observe(changed) { invalidate = changed; return { dispose: stopped }; } } });
    const parent = createPluginDeclaredResourceStore(harness.input)!;
    const direct = createPluginDeclaredResourceStore(harness.input)!;
    const a = parent.getEntry('status');
    const b = direct.getEntry('relations');
    let releaseA = a.subscribe(() => {}, true);
    const releaseB = b.subscribe(() => {}, true);
    try {
        await vi.waitFor(() => {
            expect(a.getSnapshot()).toMatchObject({ subscription: 'live', pending: 'idle' });
            expect(a.getSnapshot().value).toBeDefined();
            expect(b.getSnapshot()).toMatchObject({ subscription: 'live', pending: 'idle' });
        });
        expect(JSON.parse(new TextDecoder().decode(a.getSnapshot().value!.bytes))).toEqual({ value: 'first' });
        expect(a.getSnapshot().value?.bytes).toEqual(b.getSnapshot().value?.bytes);
        expect(reads).toBe(1);
        value = 'second'; invalidate();
        await vi.waitFor(() => expect(JSON.parse(new TextDecoder().decode(a.getSnapshot().value!.bytes))).toEqual({ value: 'second' }));
        expect(reads).toBe(2);
        releaseA();
        expect(stopped).not.toHaveBeenCalled();
        releaseA = a.subscribe(() => {}, true);
        await vi.waitFor(() => expect(a.getSnapshot().subscription).toBe('live'));
        expect(reads).toBe(2);
        releaseB();
        expect(stopped).not.toHaveBeenCalled();
        releaseA();
        expect(stopped).toHaveBeenCalledTimes(1);
    } finally { releaseA(); releaseB(); parent.dispose(); direct.dispose(); await harness.dispose(); }
});

it('isolates own Resource read bytes from the child snapshot shared with direct UI demand', async () => {
    let reads = 0;
    class AliasingBytes extends Uint8Array {
        override slice(): this { return this; }
    }
    const harness = await createPortableAccountResourceHarness({
        async read(options) {
            const child = await options.resources.read('relations', { signal: options.signal });
            child.bytes.fill(0);
            return '{}';
        },
        async observe(changed, options) { return await options.resources.watch('relations', () => changed()); },
    }, { relations: { read() { reads += 1; return new AliasingBytes(new TextEncoder().encode('{"value":"intact"}')); },
        observe: () => ({ dispose() {} }) } });
    const parent = createPluginDeclaredResourceStore(harness.input)!;
    const direct = createPluginDeclaredResourceStore(harness.input)!;
    const a = parent.getEntry('status');
    const b = direct.getEntry('relations');
    const releaseA = a.subscribe(() => {}, true);
    const releaseB = b.subscribe(() => {}, true);
    try {
        await vi.waitFor(() => expect(a.getSnapshot()).toMatchObject({ subscription: 'live', pending: 'idle' }));
        expect(a.getSnapshot().value).toBeDefined();
        expect(JSON.parse(new TextDecoder().decode(b.getSnapshot().value!.bytes))).toEqual({ value: 'intact' });
        expect(reads).toBe(1);
    } finally { releaseA(); releaseB(); parent.dispose(); direct.dispose(); await harness.dispose(); }
});

it.each([false, true])('releases child live demand when its parent becomes static, preserving independent child demand: %s', async directDemand => {
    let invalidate = () => {};
    let reads = 0;
    const stopped = vi.fn();
    const harness = await createPortableAccountResourceHarness({
        async read(options) { return (await options.resources.read('relations', { signal: options.signal })).bytes; },
        async observe(changed, options) { return await options.resources.watch('relations', () => changed()); },
    }, { relations: { read() { reads += 1; return JSON.stringify({ reads }); },
        observe(changed) { invalidate = changed; return { dispose: stopped }; } } });
    const parent = createPluginDeclaredResourceStore(harness.input)!;
    const direct = createPluginDeclaredResourceStore(harness.input)!;
    const a = parent.getEntry('status');
    const b = direct.getEntry('relations');
    const releaseLive = a.subscribe(() => {}, true);
    const releaseStatic = a.subscribe(() => {}, false);
    const releaseDirect = directDemand ? b.subscribe(() => {}, true) : () => {};
    try {
        await vi.waitFor(() => expect(a.getSnapshot()).toMatchObject({ subscription: 'live', pending: 'idle' }));
        expect(reads).toBe(1);
        releaseLive();
        await vi.waitFor(() => expect(a.getSnapshot().subscription).not.toBe('live'));
        expect(a.getSnapshot().value).toBeDefined();
        if (directDemand) {
            expect(stopped).not.toHaveBeenCalled();
            invalidate();
            await vi.waitFor(() => expect(reads).toBe(2));
            expect(JSON.parse(new TextDecoder().decode(a.getSnapshot().value!.bytes))).toEqual({ reads: 1 });
            releaseDirect();
        }
        await vi.waitFor(() => expect(stopped).toHaveBeenCalledTimes(1));
        const settledReads = reads;
        invalidate();
        await Promise.resolve();
        expect(reads).toBe(settledReads);
    } finally { releaseLive(); releaseStatic(); releaseDirect(); parent.dispose(); direct.dispose(); await harness.dispose(); }
});

it('releases an explicitly disposed child watch while its parent remains live', async () => {
    let stopChild: Disposable | undefined;
    const stopped = vi.fn();
    const harness = await createPortableAccountResourceHarness({
        read: () => '{}',
        async observe(_changed, options) {
            stopChild = await options.resources.watch('relations', () => {});
            return { dispose: () => stopChild?.dispose() };
        },
    }, { relations: { read: () => '{}', observe: () => ({ dispose: stopped }) } });
    const store = createPluginDeclaredResourceStore(harness.input)!;
    const entry = store.getEntry('status');
    const release = entry.subscribe(() => {}, true);
    try {
        await vi.waitFor(() => expect(entry.getSnapshot().subscription).toBe('live'));
        await stopChild!.dispose();
        expect(stopped).toHaveBeenCalledTimes(1);
        expect(entry.getSnapshot().subscription).toBe('live');
    } finally { release(); store.dispose(); await harness.dispose(); }
});

it('rejects cyclic own Resource dependencies without leaving attachment pending', async () => {
    const harness = await createPortableAccountResourceHarness({
        async read(options) { return (await options.resources.read('relations')).bytes; },
        async observe(changed, options) { return await options.resources.watch('relations', () => changed()); },
    }, { relations: {
        async read(options) { return (await options.resources.read('status')).bytes; },
        async observe(changed, options) { return await options.resources.watch('status', () => changed()); },
    } });
    const store = createPluginDeclaredResourceStore(harness.input)!;
    const entry = store.getEntry('status');
    const release = entry.subscribe(() => {}, true);
    try { await vi.waitFor(() => expect(entry.getSnapshot().error?.code).toBe('plugin_resource_dependency_cycle')); }
    finally { release(); store.dispose(); await harness.dispose(); }
});

function installLiveResourceRpc(input?: Readonly<{
    read?: (call: number) => ReturnType<typeof resourceResponse>;
    openMarker?: (options: Readonly<{ subscriptionId: string; expectedCallerOccurrenceId: string }>) => string;
    onNext?: (options: Readonly<{ subscriptionId: string; signal: AbortSignal }>) => Promise<unknown>;
}>) {
    const nextSignals: AbortSignal[] = [];
    let reads = 0;
    machineResourceRpc.read.mockReset();
    machineResourceRpc.open.mockReset();
    machineResourceRpc.next.mockReset();
    machineResourceRpc.close.mockReset();
    machineResourceRpc.read.mockImplementation(async () => (
        input?.read?.(++reads) ?? resourceResponse('a')
    ));
    machineResourceRpc.open.mockImplementation(async (
        _machineId: string,
        options: Readonly<{ subscriptionId: string; expectedCallerOccurrenceId: string }>,
    ) => watchOpenResponse(options.subscriptionId, input?.openMarker?.(options) ?? 'a'));
    machineResourceRpc.next.mockImplementation(async (
        _machineId: string,
        options: Readonly<{ subscriptionId: string; signal: AbortSignal }>,
    ) => {
        nextSignals.push(options.signal);
        if (input?.onNext) return await input.onNext(options);
        return await new Promise((resolve) => {
            options.signal.addEventListener('abort', () => {
                resolve({ supported: false as const, reason: 'aborted' as const });
            }, { once: true });
        });
    });
    machineResourceRpc.close.mockResolvedValue(undefined);
    return { nextSignals };
}

function ResourceProbe(props: Readonly<{
    binding: PluginContextualResourceBinding;
    onSnapshot(snapshot: PluginUiResourceSnapshot | null): void;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
}>): React.ReactElement {
    return (
        <PluginContextualResourceState
            binding={props.binding}
            resource={RESOURCE_ID}
            {...(props.signal === undefined ? {} : { signal: props.signal })}
            {...(props.isCurrent === undefined ? {} : { isCurrent: props.isCurrent })}
        >
            {(snapshot) => {
                props.onSnapshot(snapshot);
                return null;
            }}
        </PluginContextualResourceState>
    );
}

describe('PluginContextualResourceStoreProvider', () => {
    it('renders admitted data documents without repeating whole-document admission', async () => {
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const draft = { v: 1, id: 'admitted-metrics', name: 'Metrics',
            sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
            inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false },
            provenance: { source: { kind: 'authored' } },
            body: { kind: 'declarative', document: { version: 1, root: { kind: 'stack', children:
                Array.from({ length: 128 }, (_, index) => ({ kind: 'metric', label: `Metric ${index}`,
                    data: { kind: 'value', value: index }, value: { path: [], type: 'number' } })) } } } };
        // The definition ingress remains strict, including semantic data-field admission.
        expect(WidgetDefinitionV1Schema.safeParse({ ...draft, body: { kind: 'declarative', document: {
            version: 1, root: { kind: 'metric', label: 'Invalid', data: { kind: 'value', value: 'private' },
                value: { path: [], type: 'number' } },
        } } }).success).toBe(false);
        const definition = WidgetDefinitionV1Schema.parse(draft);
        if (definition.body.kind !== 'declarative') throw new Error('Expected declarative definition');
        const document = definition.body.document;
        const runtime = { pluginUiProjection: null, pluginBrowserProjection: null, phase: 'establishing' as const,
            interactionEnabled: false, machineId: null, serverId: null, platform: 'web' as const, accountLifetime: account.lifetime };
        // Observe the real schema; do not replace admission or any rendering logic.
        const admission = vi.spyOn(PluginDeclarativeDocumentV1Schema, 'safeParse');
        let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
        try {
            screen = await renderScreen(<DeclarativeWidgetDocument document={document} input={{}} runtime={runtime}
                accountLifetime={account.lifetime} isCurrent={account.lifetime.isCurrent} testID="admitted-data" />);
            expect(screen.tree.root.findAllByType(HappierDataMetric)).toHaveLength(128);
            await screen.update(<DeclarativeWidgetDocument document={document} input={{}} runtime={runtime}
                accountLifetime={account.lifetime} isCurrent={account.lifetime.isCurrent} testID="admitted-data-update" />);
            expect(screen.tree.root.findAllByType(HappierDataMetric)).toHaveLength(128);
            expect(admission).toHaveBeenCalledTimes(0);
        } finally { admission.mockRestore(); await screen?.unmount(); }
    });

    it('measures Canvas read/watch demand before and after viewport deferral through the real Resource transport', async () => {
        const a = await createAccountLifetime({ accountId: 'account-a' });
        const surface = { ...a.lifetime.scope, owner: { kind: 'workBoard', boardId: 'demand' } } as const;
        const widgets: WorkBoardWidgetPlacementV1[] = ['top', 'bottom', 'right'].map(id => ({ kind: 'widget', size: 'medium',
            ref: { surface, instanceId: id }, instance: { v: 1, id, definition: { kind: 'installed', surface: { pluginId: 'acme.composer', localId: 'widget' } }, bindings: {} } }));
        const positions = { [buildWorkBoardWidgetKeyV1(widgets[0]!.ref)]: { x: 0, y: 0 },
            [buildWorkBoardWidgetKeyV1(widgets[1]!.ref)]: { x: 0, y: 4000 },
            [buildWorkBoardWidgetKeyV1(widgets[2]!.ref)]: { x: 4000, y: 0 } };
        const board = { ...createWorkBoardV1({ id: 'demand', name: 'Demand' }), widgets, positionsByItemRef: positions };
        const entityRuntime = createEntityDragDropRuntime();
        const entityBinding: WorkBoardEntityBinding = { scope: a.lifetime.scope, runtime: entityRuntime, isCurrent: a.lifetime.isCurrent,
            getContext: () => ({ scope: a.lifetime.scope, board, membership: projectBoardMembership(board, { sections: {}, filtered: null, isHomeMounted: () => true }), isHomeMounted: () => true }),
            execute: async () => { throw new Error('This read-demand workload performs no move'); } };
        const document = PluginDeclarativeDocumentV1Schema.parse({ version: 1, root: { kind: 'metric', label: 'Checks',
            data: { kind: 'resource', resource: { pluginId: 'acme.composer', localId: RESOURCE_ID },
                inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'number' } }, value: { path: [], type: 'number' } } });
        const projection = widgetProjectionOf([{ pluginId: 'acme.composer', localId: 'widget', target: 'app' }],
            { 'acme.composer': { ...widgetInstalledPackage('acme.composer', 'Composer'), occurrenceId: 'occurrence-42' } },
            { state: { id: RESOURCE_ID, pluginId: 'acme.composer', resourceKind: 'config', contentType: 'application/json', scope: 'session' } });
        const runtime = { pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current' as const,
            interactionEnabled: true, machineId: 'machine-1', serverId: a.lifetime.scope.serverId, platform: 'web' as const, accountLifetime: a.lifetime };
        async function run(mode: 'eager' | 'demanded') {
            installLiveResourceRpc();
            const renderWidget: BoardCanvasWidgetRender = (widget, state) => <WidgetFrame testID={`demand-frame:${widget.title}`}
                frameStyle="card" placement="board" title={widget.title} menu={state.grip} body={{ kind: 'content',
                    children: mode === 'eager' || state.active ? <DeclarativeWidgetDocument document={document} input={{}} runtime={runtime}
                        accountLifetime={a.lifetime} sessionId={widget.title} isCurrent={a.lifetime.isCurrent} testID={`demand-data:${widget.title}`} /> : null }} />;
            const screen = await renderScreen(<BoardCanvas cards={[]} widgets={widgets.map(placement => ({ key: buildWorkBoardWidgetKeyV1(placement.ref), title: placement.instance.id, placement }))}
                renderWidget={renderWidget} positionsByItemRef={positions} snap binding={entityBinding} onOpen={() => {}} />);
            await act(async () => {
                screen.findHostByTestId('board-canvas')!.props.onLayout({ nativeEvent: { layout: { width: 900, height: 200 } } });
                for (const placement of widgets) {
                    let node = screen.findHostByTestId(`board-canvas-widget:${buildWorkBoardWidgetKeyV1(placement.ref)}`)!;
                    while (!node.props.onLayout) node = node.parent!;
                    node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 100 } } });
                }
            });
            const count = mode === 'eager' ? 3 : 1;
            await vi.waitFor(() => expect(machineResourceRpc.open.mock.calls).toHaveLength(count));
            expect(machineResourceRpc.read.mock.calls).toHaveLength(count);
            expect(screen.tree.root.findAllByType(HappierDataMetric)).toHaveLength(count);
            expect(widgets.every(placement => screen.findHostByTestId(`demand-frame:${placement.instance.id}`))).toBe(true);
            if (mode === 'demanded') {
                await act(async () => { screen.findHostByTestId('board-canvas')!.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 4000 } } }); });
                await vi.waitFor(() => expect(machineResourceRpc.open.mock.calls).toHaveLength(2));
                expect(screen.tree.root.findAllByType(HappierDataMetric)).toHaveLength(1);
                expect(machineResourceRpc.close.mock.calls).toHaveLength(1);
                await act(async () => {
                    screen.findHostByTestId('board-canvas')!.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 0 } } });
                    screen.findHostByTestId('board-canvas-horizontal')!.props.onScroll({ nativeEvent: { contentOffset: { x: 4000, y: 0 } } });
                });
                await vi.waitFor(() => expect(machineResourceRpc.open.mock.calls).toHaveLength(3));
                expect(screen.tree.root.findAllByType(HappierDataMetric)).toHaveLength(1);
                expect(machineResourceRpc.close.mock.calls).toHaveLength(2);
            }
            await act(async () => { screen.tree.unmount(); });
            await vi.waitFor(() => expect(machineResourceRpc.close.mock.calls).toHaveLength(3));
        }
        await run('eager');
        await run('demanded');
    });

    it('renders declared typed Resource data and removes the previous viewer bytes on Account retirement', async () => {
        const firstWatch = installLiveResourceRpc();
        const a = await createAccountLifetime({ accountId: 'account-a' });
        const document = PluginDeclarativeDocumentV1Schema.parse({ version: 1, root: { kind: 'metric', label: 'Checks',
            data: { kind: 'resource', resource: { pluginId: 'acme.composer', localId: RESOURCE_ID },
                inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'number' } },
            value: { path: [], type: 'number' } } });
        const executionOrigin = widgetExecutionOrigin('acme.composer', 'machine-1');
        const projection = widgetProjectionOf([{ pluginId: 'acme.composer', localId: 'widget', target: 'app', occurrenceId: 'occurrence-42' }], { 'acme.composer': { ...widgetInstalledPackage('acme.composer', 'Composer'),
            occurrenceId: 'occurrence-42', executionOrigin } }, { state: { id: RESOURCE_ID, pluginId: 'acme.composer', resourceKind: 'config',
                contentType: 'application/json', scope: 'session' } });
        const runtime = { pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current' as const,
            interactionEnabled: true, machineId: 'machine-1', serverId: a.lifetime.scope.serverId, platform: 'web' as const, accountLifetime: a.lifetime };
        const retained = unionPluginUiProjections([{ machineId: 'machine-1', serverId: a.lifetime.scope.serverId,
            projection, phase: 'retainedOffline', interactionEnabled: false }], new Map([['acme.composer', executionOrigin]]));
        expect(Object.values(retained.pluginUiProjection!.resourcesById)).toEqual(expect.arrayContaining([expect.objectContaining({ id: RESOURCE_ID })]));
        if (document.root.kind !== 'metric') throw new Error('Expected metric');
        const foreign = unionPluginUiProjections([{ machineId: 'machine-1', serverId: 'other-home',
            projection, phase: 'current', interactionEnabled: true }], new Map());
        // Local declarative bodies need no unique AppShell scope, but each live
        // node still denies an origin from another Home before opening a read.
        expect(resolveDeclarativeDataResourceBinding({ projection: foreign.pluginUiProjection, input: {},
            machineId: null, serverId: null, accountLifetime: a.lifetime, sessionId: 'session-1',
            isCurrent: a.lifetime.isCurrent }, document.root)).toBeNull();
        expect(resolveDeclarativeDataResourceBinding({ projection: retained.pluginUiProjection, input: {},
            machineId: 'machine-1', serverId: a.lifetime.scope.serverId, accountLifetime: a.lifetime,
            sessionId: 'session-1', isCurrent: a.lifetime.isCurrent, requireReadAuthority: true }, document.root)).toBeNull();
        const unselected = unionPluginUiProjections([{ machineId: 'machine-1', serverId: a.lifetime.scope.serverId,
            projection, phase: 'current', interactionEnabled: true }], new Map());
        // A descriptive union row cannot borrow the caller's ambient machine authority.
        expect(resolveDeclarativeDataResourceBinding({ projection: unselected.pluginUiProjection, input: {},
            machineId: 'machine-1', serverId: a.lifetime.scope.serverId, accountLifetime: a.lifetime,
            sessionId: 'session-1', isCurrent: a.lifetime.isCurrent }, document.root)).toBeNull();
        const renderA = (pluginUiProjection: typeof projection) => <DeclarativeWidgetDocument document={document} input={{}}
            runtime={{ ...runtime, pluginUiProjection }} accountLifetime={a.lifetime} sessionId="session-1"
            isCurrent={a.lifetime.isCurrent} testID="typed-a" />;
        // Another origin can keep AppShell's coarse state current. Demand for
        // this source must still follow its own exact retained-offline origin.
        const screenA = await renderScreen(renderA(retained.pluginUiProjection!));
        let screenB: Awaited<ReturnType<typeof renderScreen>> | null = null;
        try {
            expect(machineResourceRpc.read).not.toHaveBeenCalled();
            await act(async () => { screenA.tree.update(renderA(projection)); });
            await vi.waitFor(() => { expect(JSON.stringify(screenA.tree.toJSON())).toContain('"1"'); });
            expect(machineResourceRpc.read.mock.calls[0]?.[1]).toMatchObject({ resource: { pluginId: 'acme.composer', localId: RESOURCE_ID },
                context: { kind: 'session', sessionId: 'session-1' }, expectedCallerOccurrenceId: 'occurrence-42' });
            await act(async () => { a.retire(); });
            const b = await createAccountLifetime({ accountId: 'account-b' });
            installLiveResourceRpc({ read: () => ({ ...resourceResponse('b'), result: { ...resourceResponse('b').result, bytesBase64: 'Mg==' } }) });
            await act(async () => {});
            expect(JSON.stringify(screenA.tree.toJSON())).not.toContain('"1"');
            expect(firstWatch.nextSignals.every(signal => signal.aborted)).toBe(true);
            screenB = await renderScreen(<DeclarativeWidgetDocument document={document} input={{}} runtime={{ ...runtime, accountLifetime: b.lifetime }}
                accountLifetime={b.lifetime} sessionId="session-1" isCurrent={b.lifetime.isCurrent} testID="typed-b" />);
            await vi.waitFor(() => { expect(JSON.stringify(screenB!.tree.toJSON())).toContain('"2"'); });
            expect(a.http.writes).toHaveLength(0);
            expect(b.http.writes).toHaveLength(0);
        } finally { await act(async () => { screenA.tree.unmount(); screenB?.tree.unmount(); }); }
    });
    it.each(['transport failure', 'malformed success'] as const)('keeps the same data node and its last good value through %s, says so once and retries', async (failure) => {
        installLiveResourceRpc();
        const a = await createAccountLifetime({ accountId: 'account-a' });
        const document = PluginDeclarativeDocumentV1Schema.parse({ version: 1, root: { kind: 'metric', label: 'Checks',
            data: { kind: 'resource', resource: { pluginId: 'acme.composer', localId: RESOURCE_ID },
                inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'number' } },
            value: { path: [], type: 'number' } } });
        const projection = widgetProjectionOf([{ pluginId: 'acme.composer', localId: 'widget', target: 'app' }], { 'acme.composer': { ...widgetInstalledPackage('acme.composer', 'Composer'),
            occurrenceId: 'occurrence-42' } }, { state: { id: RESOURCE_ID, pluginId: 'acme.composer', resourceKind: 'config',
                contentType: 'application/json', scope: 'session' } });
        const runtime = { pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current' as const,
            interactionEnabled: true, machineId: 'machine-1', serverId: a.lifetime.scope.serverId, platform: 'web' as const, accountLifetime: a.lifetime };
        const captureSlot = createWidgetSnapshotCaptureSlot();
        const screen = await renderScreen(<WidgetFrame testID="kept-frame" frameStyle="card" placement="home" title="Checks" source="Composer"
            meta="As of today" body={{ kind: 'content', children: <WidgetSnapshotCaptureContext.Provider value={captureSlot}>
                <DeclarativeWidgetDocument document={document} input={{}} runtime={runtime}
                    accountLifetime={a.lifetime} sessionId="session-1" isCurrent={a.lifetime.isCurrent} testID="kept" />
            </WidgetSnapshotCaptureContext.Provider> }} />);
        const lease = acquirePluginContextualResourceStore(binding(a.lifetime))!;
        try {
            await vi.waitFor(() => { expect(JSON.stringify(screen.tree.toJSON())).toContain('"1"'); });
            const metric = screen.tree.root.findByType(HappierDataMetric);
            expect(screen.tree.root.findAll(node => node.props.testID === 'kept-freshness')).toHaveLength(0);

            let finishRead!: (value: unknown) => void;
            machineResourceRpc.read.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
            let refreshing!: Promise<PluginUiResourceSnapshot>;
            await act(async () => { refreshing = lease.store.getEntry(RESOURCE_ID).refresh(); });
            await vi.waitFor(() => expect(screen.findAllByTestId('kept-frame.refreshing').length).toBeGreaterThan(0));
            expect(screen.tree.root.findByType(HappierDataMetric)).toBe(metric);
            expect(screen.findAllByTestId('kept-frame.refreshing').map(node => node.props.accessibilityLabel))
                .toContain(t('widgetDefinition.refreshing'));
            expect(screen.getTextContent()).toContain('Composer');
            await act(async () => {
                finishRead(failure === 'transport failure'
                    ? { supported: true, result: { ok: false, reason: 'unavailable', code: 'plugin_resource_unavailable' } }
                    : { ...resourceResponse('b'), result: { ...resourceResponse('b').result, bytesBase64: 'Indyb25nIg==' } });
                await refreshing;
            });
            expect(screen.findAllByTestId('kept-frame.refreshing')).toHaveLength(0);
            await vi.waitFor(() => { expect(screen.tree.root.findAll(node => node.props.testID === 'kept-freshness-action').length).toBeGreaterThan(0); });
            // The retained value stays at full strength in the very same component: no skeleton, no remount.
            expect(screen.tree.root.findByType(HappierDataMetric)).toBe(metric);
            expect(JSON.stringify(screen.tree.toJSON())).toContain('"1"');
            expect(screen.tree.root.findAll(node => typeof node.type === 'string' && node.props.testID === 'kept-freshness')).toHaveLength(1);
            expect(captureSlot.capture()).toMatchObject({ current: false, digests: [`sha256:${'a'.repeat(64)}`] });
            expect([...captureSlot.capture()!.frozenByPath.values()]).toMatchObject([{ data: { kind: 'value', value: 1 } }]);

            machineResourceRpc.read.mockResolvedValue({ ...resourceResponse('c'), result: { ...resourceResponse('c').result, bytesBase64: 'Mw==' } });
            const retry = screen.tree.root.findAll(node => node.props.testID === 'kept-freshness-action')[0]!;
            await act(async () => { retry.props.onPress(); });
            await vi.waitFor(() => { expect(JSON.stringify(screen.tree.toJSON())).toContain('"3"'); });
            expect(screen.tree.root.findAll(node => node.props.testID === 'kept-freshness')).toHaveLength(0);
            expect(screen.tree.root.findByType(HappierDataMetric)).toBe(metric);
        } finally { lease.dispose(); await act(async () => { screen.tree.unmount(); }); }
    });

    it('removes private typed content on server authority loss before the local projection retires', async () => {
        installLiveResourceRpc();
        const a = await createAccountLifetime({ accountId: 'account-a' });
        const document = PluginDeclarativeDocumentV1Schema.parse({ version: 1, root: { kind: 'metric', label: 'Checks',
            data: { kind: 'resource', resource: { pluginId: 'acme.composer', localId: RESOURCE_ID },
                inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'number' } },
            value: { path: [], type: 'number' } } });
        const projection = widgetProjectionOf([{ pluginId: 'acme.composer', localId: 'widget', target: 'app' }],
            { 'acme.composer': { ...widgetInstalledPackage('acme.composer', 'Composer'), occurrenceId: 'occurrence-42' } },
            { state: { id: RESOURCE_ID, pluginId: 'acme.composer', resourceKind: 'config', contentType: 'application/json', scope: 'session' } });
        const runtime = { pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current' as const,
            interactionEnabled: true, machineId: 'machine-1', serverId: a.lifetime.scope.serverId, platform: 'web' as const, accountLifetime: a.lifetime };
        const captureSlot = createWidgetSnapshotCaptureSlot();
        let previewOpen = false;
        const renderDocument = (sessionId: string) => <><WidgetFrame testID="private-frame" frameStyle="card" placement="home" title="Checks"
            body={{ kind: 'content', children: <WidgetSnapshotCaptureContext.Provider value={captureSlot}>
                <DeclarativeWidgetDocument document={document} input={{}} runtime={runtime}
                    accountLifetime={a.lifetime} sessionId={sessionId} isCurrent={a.lifetime.isCurrent} testID="private-data" />
            </WidgetSnapshotCaptureContext.Provider> }} />
            {previewOpen ? <WidgetSnapshotConfirmPanel surface={{ ...a.lifetime.scope, owner: { kind: 'sessionBoard', sessionId: 'session-1' } }}
                title="Checks" sourceLabel="Private checks" capture={captureSlot.capture} watch={captureSlot.watch}
                onCancel={() => {}} onDone={() => {}} testID="private-preview" /> : null}</>;
        const screen = await renderScreen(renderDocument('session-1'));
        const lease = acquirePluginContextualResourceStore(binding(a.lifetime))!;
        try {
            await vi.waitFor(() => expect(screen.tree.root.findAllByType(HappierDataMetric)).toHaveLength(1));
            previewOpen = true;
            await screen.update(renderDocument('session-1'));
            expect(screen.findByTestId('private-preview.preview')).not.toBeNull();
            // The contextual adapter exposes this exact daemon refusal code;
            // the Account and local declaration remain current.
            machineResourceRpc.read.mockResolvedValue({ supported: true,
                result: { ok: false, reason: 'unavailable', code: 'plugin_resource_session_access_unavailable' } });
            await act(async () => { await lease.store.getEntry(RESOURCE_ID).refresh(); });
            expect(a.lifetime.isCurrent()).toBe(true);
            expect(screen.findByTestId('private-preview.preview')).toBeNull();
            expect(screen.findByTestId('private-preview.primary')!.props.disabled).toBe(true);
            expect(screen.tree.root.findAllByType(HappierDataMetric)).toHaveLength(0);
            expect(screen.findAllByTestId('private-frame').length).toBeGreaterThan(0);
            expect(captureSlot.capture()?.frozenByPath.size).toBe(0);
            expect(captureSlot.capture()?.digests).toEqual([]);

            machineResourceRpc.read.mockResolvedValue(resourceResponse('c'));
            await act(async () => { await lease.store.getEntry(RESOURCE_ID).refresh(); });
            await vi.waitFor(() => expect(screen.tree.root.findAllByType(HappierDataMetric)).toHaveLength(1));
            // A recovered source does not silently replace the withdrawn frozen preview.
            expect(screen.findByTestId('private-preview.preview')).toBeNull();
            await screen.pressByTestIdAsync('private-preview.refresh');
            await vi.waitFor(() => expect(screen.findByTestId('private-preview.preview')).not.toBeNull());
            // An exact Session identity change must also clear validated LKG
            // immediately, before the new authority's first read settles.
            machineResourceRpc.read.mockImplementation(() => new Promise(() => {}));
            await act(async () => { screen.tree.update(renderDocument('session-2')); });
            expect(screen.findByTestId('private-preview.preview')).toBeNull();
            expect(screen.findByTestId('private-preview.primary')!.props.disabled).toBe(true);
            expect(screen.tree.root.findAllByType(HappierDataMetric)).toHaveLength(0);
            expect(captureSlot.capture()?.frozenByPath.size).toBe(0);
        } finally { lease.dispose(); await act(async () => { screen.tree.unmount(); }); }
    });
    it('refreshes an actual Home instance through the public Action front door and reports real Resource failure', async () => {
        installLiveResourceRpc({ read: call => resourceResponse(call === 1 ? 'a' : 'b') });
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const instance = { v: 1 as const, id: 'configured-widget', definition: { kind: 'installed' as const,
            surface: { pluginId: 'acme.composer', localId: 'widget' } }, bindings: {} };
        account.http.seed({ v: 1, items: [{ kind: 'widget', instance }], order: [instance.id], hidden: [] });
        const resources = { state: { id: RESOURCE_ID, pluginId: 'acme.composer', resourceKind: 'config' as const,
            contentType: 'application/json', scope: 'global' as const } };
        const executionOrigin = widgetExecutionOrigin('acme.composer', 'machine-1');
        const model = widgetProjectionOf([{ pluginId: 'acme.composer', localId: 'widget', target: 'app',
            occurrenceId: 'occurrence-42', resources: [{ pluginId: 'acme.composer', localId: RESOURCE_ID }] }],
            { 'acme.composer': { ...widgetInstalledPackage('acme.composer', 'Composer'), occurrenceId: 'occurrence-42', executionOrigin } }, resources);
        const projected = unionPluginUiProjections([{ machineId: 'machine-1', serverId: account.lifetime.scope.serverId,
            projection: model, phase: 'current', interactionEnabled: true }], new Map([['acme.composer', executionOrigin]]));
        const store = createPluginDeclaredResourceStore({ ...binding(account.lifetime), resourcesById: model.resourcesById,
            resourceDeclarationsComplete: true })!;
        const entry = store.getEntry(RESOURCE_ID);
        const release = entry.subscribe(() => {}, false);
        await vi.waitFor(() => { expect(entry.getSnapshot().digest).toBe(`sha256:${'a'.repeat(64)}`); });
        let tree: renderer.ReactTestRenderer | null = null;
        try {
            await act(async () => { tree = renderer.create(<AppShellPluginUiProjectionValueProvider value={{ ...projected,
                pluginBrowserProjection: null, platform: 'web', accountLifetime: account.lifetime, clientExecutableActivation: { status: 'ready' },
                reloadClientExecutables() {}, reloadConnectedAccountProjection() {} }}><></></AppShellPluginUiProjectionValueProvider>); });
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            const executor = createDefaultActionExecutor();
            const ref = { surface: { ...account.lifetime.scope, owner: { kind: 'home' as const } }, instanceId: instance.id };
            const context = { serverId: account.lifetime.scope.serverId, expectedAccountId: 'account-a', surface: 'ui' as const };
            expect(await executor.execute('widgets.item.refresh', { ref }, context)).toEqual({ ok: true, result: { ref, status: 'refreshed' } });
            expect(entry.getSnapshot().digest).toBe(`sha256:${'b'.repeat(64)}`);
            machineResourceRpc.read.mockResolvedValue({ supported: true, result: { ok: false, reason: 'unavailable', code: 'plugin_resource_unavailable' } });
            expect(await executor.execute('widgets.item.refresh', { ref }, context)).toMatchObject({ ok: false, errorCode: 'plugin_resource_unavailable' });
            expect(entry.getSnapshot().error?.code).toBe('plugin_resource_unavailable');
            expect(account.http.writes).toHaveLength(0);
        } finally { await act(async () => { tree?.unmount(); }); release(); store.dispose(); }
    });
    it.each([['shared', 'snapshot'], ['shared', 'live'], ['fallback', 'snapshot'], ['fallback', 'live']] as const)('reports native %s %s Resource refresh in the retained frame through the generated surface provider without extra demand or publishing its store', async (owner, mode) => {
        installLiveResourceRpc();
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const lease = owner === 'shared' ? acquirePluginContextualResourceStore(binding(account.lifetime)) : null;
        const entry = lease?.store.getEntry(RESOURCE_ID);
        const release = entry?.subscribe(() => {}, false);
        if (entry) await vi.waitFor(() => { expect(entry.getSnapshot().digest).toBeDefined(); });
        const requestSurface = { pluginId: 'acme.composer', contributionId: 'widget', surfaceId: 'widget-native',
            placement: 'appSurface' as const, platform: 'ios' as const, channel: 'internal' as const,
            resourceScope: [], diagnostics: [] };
        const projected = widgetProjectionOf([{ pluginId: 'acme.composer', localId: 'widget', target: 'app' }],
            { 'acme.composer': widgetInstalledPackage('acme.composer', 'Composer') },
            { state: { id: RESOURCE_ID, pluginId: 'acme.composer', resourceKind: 'config',
                contentType: 'application/json', ...(owner === 'shared' ? { scope: 'session' as const } : {}) } });
        const controller = createBoundPluginSurfaceController({ facts: { ...requestSurface,
            accountLifetime: account.lifetime, machineId: 'machine-1', serverId: account.lifetime.scope.serverId,
            sessionId: 'session-1', occurrenceId: 'occurrence-42',
            resourceCapability: { readable: true, dynamic: true }, pluginUiProjection: projected,
            interactionEnabled: true, daemonInteractionEnabled: true } });
        // The mounted facade includes both shared declarations and its ordinary fallback transport.
        expect(controller.resourceStore).toBeDefined();
        const host = controller.hostApi;
        const surface = createPluginSurfaceContextFixture();
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface, requestSurface, requestIdPrefix: 'shared-native',
            handleRequest: host.handleRequest, installedMethods: host.installedMethods });
        let snapshot: PluginUiResourceSnapshot | null = null;
        const readSnapshot = (): PluginUiResourceSnapshot | null => snapshot;
        let refresh = () => {};
        let privateStore: unknown;
        const useResource = mode === 'live' ? useLivePluginResource : usePluginResource;
        function NativeResourceBody() {
            const resource = useResource(RESOURCE_ID);
            snapshot = resource.resource;
            refresh = resource.refresh;
            return <Text>{snapshot.digest}</Text>;
        }
        const renderSurface = defineUiSurface(context => {
            privateStore = Reflect.get(context, 'resourceStore');
            return <NativeResourceBody />;
        });
        const { PluginReactNativeSurface } = await import('@/components/plugins/reactNative/PluginReactNativeSurface');
        let tree!: renderer.ReactTestRenderer;
        try {
            await act(async () => { tree = renderer.create(<WidgetFrame testID="native-frame" frameStyle="card" placement="board"
                title="Native checks" source="Composer" meta="As of today" body={{ kind: 'content', children: <PluginReactNativeSurface surfaceId="widget-native"
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                module={{ renderSurface: context => {
                    const result = renderSurface(context);
                    if (result === null || React.isValidElement(result)) return result;
                    throw new Error('Expected a React element from the native surface boundary');
                } }} interactionEnabled
                privateHostBindings={{ resourceStore: controller.resourceStore, resourceStoreGeneration: 'occurrence-42',
                    accountLifetime: { isCurrent: account.lifetime.isCurrent, onRetire: account.lifetime.onRetire } }}
                renderContext={{ plugin: { id: 'acme.composer', version: '1.0.0' },
                    surface, hostApi: adapter.api, signal: new AbortController().signal }} /> }} />); });
            await vi.waitFor(() => { expect(snapshot?.digest).toBe(`sha256:${'a'.repeat(64)}`); });
            if (mode === 'live') await vi.waitFor(() => { expect(snapshot).toMatchObject({ subscription: 'live', pending: 'idle' }); });
            expect(privateStore).toBeUndefined();
            if (mode === 'snapshot') expect(machineResourceRpc.read).toHaveBeenCalledTimes(1);
            const baselineReads = machineResourceRpc.read.mock.calls.length;
            const body = tree.root.findByType(NativeResourceBody);
            let finishRead = (_value: ReturnType<typeof resourceResponse>) => {};
            machineResourceRpc.read.mockImplementationOnce(() => new Promise<ReturnType<typeof resourceResponse>>(resolve => { finishRead = resolve; }));
            await act(async () => { refresh(); });
            await vi.waitFor(() => { expect(tree!.root.findAll(node => node.props.testID === 'native-frame.refreshing').length).toBeGreaterThan(0); });
            expect(readSnapshot()?.digest).toBe(`sha256:${'a'.repeat(64)}`);
            expect(tree.root.findByType(NativeResourceBody)).toBe(body);
            expect(tree.root.findAll(node => typeof node.type === 'string' && node.props.testID === 'native-frame.refreshing')
                .map(node => node.props.accessibilityLabel)).toContain(t('widgetDefinition.refreshing'));
            expect(JSON.stringify(tree.toJSON())).toContain('Composer');
            await act(async () => { finishRead(resourceResponse('b')); });
            await vi.waitFor(() => { expect(snapshot?.digest).toBe(`sha256:${'b'.repeat(64)}`); });
            expect(tree.root.findAll(node => node.props.testID === 'native-frame.refreshing')).toHaveLength(0);
            expect(tree.root.findByType(NativeResourceBody)).toBe(body);
            expect(machineResourceRpc.read).toHaveBeenCalledTimes(baselineReads + 1);
            expect(machineResourceRpc.open).toHaveBeenCalledTimes(mode === 'live' ? 1 : 0);
        } finally { await act(async () => { tree?.unmount(); }); adapter.dispose(); controller.dispose(); release?.(); lease?.dispose(); }
    });
    it('does not bind shared transport to its first Action invocation signal', async () => {
        const rpc = installLiveResourceRpc({ read: call => resourceResponse(call === 1 ? 'a' : 'b') });
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const signal = new AbortController();
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const action = await captureLazyActionAccountContext(account.lifetime.scope.serverId, signal.signal);
        if (!action.accountLifetime) throw new Error('Expected real Action lifetime');
        const actionLease = acquirePluginContextualResourceStore(binding(action.accountLifetime))!;
        const entry = actionLease.store.getEntry(RESOURCE_ID);
        const releaseAction = entry.subscribe(() => {}, true);
        await vi.waitFor(() => { expect(entry.getSnapshot().digest).toBe(`sha256:${'a'.repeat(64)}`); });
        const mountLease = acquirePluginContextualResourceStore(binding(account.lifetime))!;
        const mounted = mountLease.store.getEntry(RESOURCE_ID);
        const releaseMount = mounted.subscribe(() => {}, true);
        try {
            signal.abort(); action.dispose(); releaseAction(); actionLease.dispose();
            expect(rpc.nextSignals[0]?.aborted).toBe(false);
            expect((await mounted.refresh()).digest).toBe(`sha256:${'b'.repeat(64)}`);
            account.retire();
            expect(mounted.getSnapshot().value).toBeUndefined();
        } finally { releaseAction(); actionLease.dispose(); releaseMount(); mountLease.dispose(); action.dispose(); }
    });
    it('keeps a producer-complete empty Resource namespace closed without ordinary transport', async () => {
        installLiveResourceRpc();
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const exactBinding = binding(account.lifetime);
        const store = createPluginDeclaredResourceStore({ ...exactBinding, resourcesById: {},
            resourceDeclarationsComplete: true,
            createFallbackStore: () => createPluginUiResourceStore({ pluginId: exactBinding.pluginId,
                accountLifetime: account.lifetime, client: createPluginContextualResourceReadClient({
                    pluginId: exactBinding.pluginId, resource: exactBinding, isCurrent: account.lifetime.isCurrent,
                }) }),
        })!;
        try {
            const result = await store.getEntry(RESOURCE_ID).refresh();
            expect(result.error?.code).toBe('plugin_resource_not_found');
            expect(result.value).toBeUndefined();
            expect(machineResourceRpc.read).not.toHaveBeenCalled();
        } finally { store.dispose(); }
    });

    it('retains ordinary Resource transport until declared scope arrives, then fences it through withdrawal', async () => {
        installLiveResourceRpc();
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const exactBinding = binding(account.lifetime);
        let resourcesById: import('@/sync/domains/plugins/ui/projection').PluginUiProjectionModel['resourcesById'] = {};
        let resourceDeclarationsComplete = false;
        const store = createPluginDeclaredResourceStore({ ...exactBinding,
            get resourcesById() { return resourcesById; },
            get resourceDeclarationsComplete() { return resourceDeclarationsComplete; },
            createFallbackStore: () => createPluginUiResourceStore({
                pluginId: exactBinding.pluginId, accountLifetime: account.lifetime,
                client: createPluginContextualResourceReadClient({ pluginId: exactBinding.pluginId,
                    resource: exactBinding, isCurrent: account.lifetime.isCurrent }),
            }),
        })!;
        try {
            const ordinary = store.getEntry(RESOURCE_ID);
            expect((await ordinary.refresh()).value).toBeDefined();
            resourceDeclarationsComplete = true;
            resourcesById = { state: { id: RESOURCE_ID, pluginId: exactBinding.pluginId,
                resourceKind: 'config', scope: 'global' } };
            expect(ordinary.getSnapshot().value).toBeUndefined();
            const scoped = store.getEntry(RESOURCE_ID);
            expect(scoped).not.toBe(ordinary);
            expect((await scoped.refresh()).value).toBeDefined();
            expect(machineResourceRpc.read).toHaveBeenLastCalledWith('machine-1', expect.objectContaining({ context: { kind: 'global' } }));
            resourcesById = {};
            expect(store.getEntry(RESOURCE_ID).getSnapshot().error?.code).toBe('plugin_resource_not_found');
            expect(store.getEntry(RESOURCE_ID).getSnapshot().value).toBeUndefined();
            expect(scoped.getSnapshot().value).toBeUndefined();
            expect((await ordinary.refresh()).value).toBeUndefined();
        } finally { store.dispose(); }
    });

    it('revalidates cached protocol Resource authority after the read yields', async () => {
        installLiveResourceRpc();
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const exactBinding = binding(account.lifetime);
        let resourcesById: import('@/sync/domains/plugins/ui/projection').PluginUiProjectionModel['resourcesById'] = {
            state: { id: RESOURCE_ID, pluginId: exactBinding.pluginId, resourceKind: 'config', scope: 'global' },
        };
        const store = createPluginDeclaredResourceStore({ ...exactBinding, resourceDeclarationsComplete: true,
            get resourcesById() { return resourcesById; } })!;
        try {
            expect((await store.getEntry(RESOURCE_ID).refresh()).value).toBeDefined();
            const read = createPluginSurfaceResourceReadHandler({ pluginId: exactBinding.pluginId,
                resource: { ...exactBinding, store }, isCurrent: account.lifetime.isCurrent });
            const pending = read({ requestId: 'withdraw-cached-read', method: 'readResource', payload: { resource: RESOURCE_ID } });
            resourcesById = {};
            await expect(pending).resolves.toMatchObject({ code: 'unavailable', diagnostics: ['plugin_resource_not_found'] });
        } finally { store.dispose(); }
    });

    it('establishes an ordinary protocol watch without an initial push and retires it on scoped admission', async () => {
        const rpc = installLiveResourceRpc();
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const exactBinding = binding(account.lifetime);
        let resourcesById: import('@/sync/domains/plugins/ui/projection').PluginUiProjectionModel['resourcesById'] = {};
        let resourceDeclarationsComplete = false;
        const store = createPluginDeclaredResourceStore({ ...exactBinding, get resourcesById() { return resourcesById; },
            get resourceDeclarationsComplete() { return resourceDeclarationsComplete; },
            createFallbackStore: () => createPluginUiResourceStore({ pluginId: exactBinding.pluginId,
                accountLifetime: account.lifetime, client: {
                    ...createPluginContextualResourceReadClient({ pluginId: exactBinding.pluginId,
                        resource: exactBinding, isCurrent: account.lifetime.isCurrent }),
                    ...createPluginContextualResourceWatchClient({ pluginId: exactBinding.pluginId,
                        resource: exactBinding, subscriptionIdPrefix: 'ordinary-transition', isCurrent: account.lifetime.isCurrent }),
                } }),
        })!;
        const events: unknown[] = [];
        const handlers = createPluginSurfaceResourceWatchHandlers({ pluginId: exactBinding.pluginId,
            resource: { ...exactBinding, store }, deliver: event => { events.push(event); }, isCurrent: account.lifetime.isCurrent });
        try {
            await expect(handlers.watchResource({ requestId: 'ordinary-transition', method: 'watchResource',
                payload: { subscriptionId: 'ordinary-transition', resource: RESOURCE_ID } })).resolves.toMatchObject({ digest: `sha256:${'a'.repeat(64)}` });
            await vi.waitFor(() => expect(rpc.nextSignals).toHaveLength(1));
            expect(events).toEqual([]);
            resourceDeclarationsComplete = true;
            resourcesById = { state: { id: RESOURCE_ID, pluginId: exactBinding.pluginId, resourceKind: 'config', scope: 'global' } };
            store.reconcile();
            expect(events).toEqual([expect.objectContaining({ kind: 'error', diagnostics: ['plugin_resource_not_found'] })]);
            expect(rpc.nextSignals[0]?.aborted).toBe(true);
        } finally { handlers.dispose(); store.dispose(); }
    });

    it('keeps ordinary protocol work single-owned and fences its namespace admission in place', async () => {
        const rpc = installLiveResourceRpc();
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const requestSurface = { pluginId: 'acme.composer', contributionId: 'widget', surfaceId: 'widget-native',
            placement: 'appSurface' as const, platform: 'ios' as const, channel: 'internal' as const,
            resourceScope: [], diagnostics: [] };
        let projection = normalizePluginInstalledUiDeclarations({}, 'ios', widgetInstalledPackage('acme.composer', 'Composer'));
        const controller = createBoundPluginSurfaceController({ facts: { ...requestSurface,
            accountLifetime: account.lifetime, machineId: 'machine-1', serverId: account.lifetime.scope.serverId,
            sessionId: 'session-1', occurrenceId: 'occurrence-42',
            resourceCapability: { readable: true, dynamic: true }, pluginUiProjection: projection,
            readActionInputFacts: () => ({ pluginUiProjection: projection }),
            interactionEnabled: true, daemonInteractionEnabled: true } });
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({ surface: createPluginSurfaceContextFixture(),
            requestSurface, requestIdPrefix: 'ordinary-authority', handleRequest: controller.hostApi.handleRequest,
            installedMethods: controller.hostApi.installedMethods });
        const events: unknown[] = [];
        const release = controller.subscribeResourceInvalidations(event => { events.push(event); adapter.publishResourceSubscriptionEvent(event); });
        let finishRead = (_result: ReturnType<typeof resourceResponse>) => {};
        let subscription: Awaited<ReturnType<typeof adapter.api.watchResource>> | undefined;
        try {
            subscription = await adapter.api.watchResource(RESOURCE_ID, () => {});
            await vi.waitFor(() => expect(rpc.nextSignals).toHaveLength(1));
            // The public guest store, not watch admission, owns baseline reads.
            expect(machineResourceRpc.read).not.toHaveBeenCalled();
            machineResourceRpc.read.mockImplementationOnce(() => new Promise<ReturnType<typeof resourceResponse>>(resolve => { finishRead = resolve; }));
            const pending = adapter.api.readResource(RESOURCE_ID);
            await vi.waitFor(() => expect(machineResourceRpc.read).toHaveBeenCalledTimes(1));
            projection = widgetProjectionOf([], { 'acme.composer': widgetInstalledPackage('acme.composer', 'Composer') },
                { state: { id: RESOURCE_ID, pluginId: 'acme.composer', resourceKind: 'config', scope: 'global' } });
            controller.updateMountedBindings?.({});
            expect(events).toEqual([expect.objectContaining({ kind: 'error', diagnostics: ['plugin_resource_not_found'] })]);
            expect(rpc.nextSignals[0]?.aborted).toBe(true);
            finishRead(resourceResponse('a'));
            await expect(pending).rejects.toMatchObject({ code: 'unavailable', diagnostics: [{ code: 'plugin_resource_aborted' }] });
            projection = { ...projection, resourcesById: {} };
            controller.updateMountedBindings?.({});
            await expect(adapter.api.watchResource(RESOURCE_ID, () => {})).rejects.toMatchObject({ code: 'unavailable', diagnostics: [{ code: 'plugin_resource_not_found' }] });
        } finally { finishRead(resourceResponse('a')); subscription?.dispose(); release(); adapter.dispose(); controller.dispose(); }
    });

    it('withdraws a mounted declaration without exposing another consumer\'s retained shared bytes', async () => {
        installLiveResourceRpc();
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const declaration = { id: RESOURCE_ID, pluginId: 'acme.composer', resourceKind: 'config' as const,
            scope: 'global' as const };
        let resourcesById: import('@/sync/domains/plugins/ui/projection').PluginUiProjectionModel['resourcesById'] = { state: declaration };
        const base = { ...binding(account.lifetime), sessionId: 'session-1', resourceDeclarationsComplete: true,
            get resourcesById() { return resourcesById; } };
        const store = createPluginDeclaredResourceStore(base)!;
        const other = createPluginDeclaredResourceStore({ ...base, resourcesById })!;
        const retained = store.getEntry(RESOURCE_ID);
        const shared = other.getEntry(RESOURCE_ID);
        const release = retained.subscribe(() => {}, false);
        const releaseOther = shared.subscribe(() => {}, false);
        try {
            await vi.waitFor(() => expect(retained.getSnapshot().value).toBeDefined());
            resourcesById = {};
            expect(store.getEntry(RESOURCE_ID).getSnapshot().error?.code).toBe('plugin_resource_not_found');
            expect(store.getEntry(RESOURCE_ID).getSnapshot().value).toBeUndefined();
            expect(retained.getSnapshot().value).toBeUndefined();
            expect((await retained.refresh()).error?.code).toBe('plugin_resource_not_found');
            expect(shared.getSnapshot().value).toBeDefined();
            resourcesById = { state: { ...declaration, scope: 'session' } };
            const replacement = store.getEntry(RESOURCE_ID);
            expect(replacement).not.toBe(retained);
            expect((await replacement.refresh()).value).toBeDefined();
            expect(retained.getSnapshot().value).toBeUndefined();
        } finally { release(); releaseOther(); store.dispose(); other.dispose(); }
    });

    it('shares declared global bytes across app and Session mounts while keeping Session A and B distinct', async () => {
        installLiveResourceRpc();
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const resources = { global: { id: 'global-state', pluginId: 'acme.composer', resourceKind: 'config' as const,
            path: 'global-state', contentType: 'application/json', scope: 'global' as const },
            session: { id: 'session-state', pluginId: 'acme.composer', resourceKind: 'config' as const,
                path: 'session-state', contentType: 'application/json', scope: 'session' as const } };
        const base = { ...binding(account.lifetime), resourcesById: resources, resourceDeclarationsComplete: true };
        const app = createPluginDeclaredResourceStore(base)!;
        const sessionA = createPluginDeclaredResourceStore({ ...base, sessionId: 'session-a' })!;
        const sessionB = createPluginDeclaredResourceStore({ ...base, sessionId: 'session-b' })!;
        try {
            const global = app.getEntry('global-state');
            const release = global.subscribe(() => {}, false);
            await vi.waitFor(() => { expect(global.getSnapshot().digest).toBeDefined(); });
            expect(sessionA.getEntry('global-state').getSnapshot()).toBe(global.getSnapshot());
            expect(sessionB.getEntry('global-state').getSnapshot()).toBe(global.getSnapshot());
            machineResourceRpc.read.mockImplementation(async (_machine: string, options: Readonly<{ context: { kind: string; sessionId?: string } }>) =>
                resourceResponse(options.context.sessionId === 'session-a' ? 'a' : 'b'));
            const a = sessionA.getEntry('session-state');
            const b = sessionB.getEntry('session-state');
            const releaseA = a.subscribe(() => {}, false);
            const releaseB = b.subscribe(() => {}, false);
            await vi.waitFor(() => {
                expect(a.getSnapshot().digest).toBe(`sha256:${'a'.repeat(64)}`);
                expect(b.getSnapshot().digest).toBe(`sha256:${'b'.repeat(64)}`);
            });
            expect((await global.refresh()).digest).toBe(`sha256:${'b'.repeat(64)}`);
            expect(sessionA.getEntry('global-state').getSnapshot().digest).toBe(`sha256:${'b'.repeat(64)}`);
            expect(sessionB.getEntry('global-state').getSnapshot().digest).toBe(`sha256:${'b'.repeat(64)}`);
            expect(app.getEntry('session-state').getSnapshot().error?.code).toBe('plugin_resource_context_unavailable');
            expect(app.getEntry('session-state').getSnapshot().value).toBeUndefined();
            expect(app.getEntry('undeclared').getSnapshot().error?.code).toBe('plugin_resource_not_found');
            expect(app.getEntry('undeclared').getSnapshot().value).toBeUndefined();
            release();
            releaseA(); releaseB();
        } finally { app.dispose(); sessionA.dispose(); sessionB.dispose(); }
    });
    it('shares completed refresh bytes through the mounted read/watch IPC bridge without a second daemon read', async () => {
        installLiveResourceRpc({ read: (call) => resourceResponse(call === 1 ? 'a' : 'b') });
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const exactBinding = binding(account.lifetime);
        const lease = acquirePluginContextualResourceStore(exactBinding)!;
        const entry = lease.store.getEntry(RESOURCE_ID);
        const release = entry.subscribe(() => {}, true);
        await vi.waitFor(() => { expect(entry.getSnapshot().digest).toBe(`sha256:${'a'.repeat(64)}`); });
        const events: unknown[] = [];
        const requestSurface = { pluginId: 'acme.composer', contributionId: 'widget', surfaceId: 'widget-one',
            sessionId: 'session-1', placement: 'sessionPane' as const, platform: 'ios' as const,
            channel: 'internal' as const, resourceScope: [], diagnostics: [] };
        const host = createPluginSurfaceActionHostApi({ surfaceContext: requestSurface,
            resource: { machineId: exactBinding.machineId, serverId: exactBinding.serverId,
                expectedCallerOccurrenceId: exactBinding.expectedCallerOccurrenceId, context: exactBinding.context, store: lease.store },
            resourceInvalidation: { deliver: (event) => { adapter.publishResourceSubscriptionEvent(event); } },
            isCurrent: account.lifetime.isCurrent });
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface: createPluginSurfaceContextFixture({ mount: { kind: 'destination',
                destination: { pluginId: 'acme.composer', localId: 'widget' }, container: 'rightPane' },
                target: { kind: 'session', sessionId: 'session-1' } }),
            requestSurface, requestIdPrefix: 'shared-resource', handleRequest: host.handleRequest,
            installedMethods: host.installedMethods });
        // These are the actual guest Resource stores over the public IPC API,
        // not a substituted watcher/reducer. Only daemon/network is replaced.
        const guests = [1, 2].map(() => createPluginUiResourceStore({
            client: createPluginUiHostApiResourceClient(adapter.api), pluginId: 'acme.composer', accountLifetime: account.lifetime }));
        const guestEntries = guests.map(store => store.getEntry(RESOURCE_ID));
        const guestReleases = guestEntries.map(guest => guest.subscribe(() => {}, true));
        try {
            expect((await adapter.api.readResource(RESOURCE_ID)).digest).toBe(`sha256:${'a'.repeat(64)}`);
            await vi.waitFor(() => { for (const guest of guestEntries) expect(guest.getSnapshot()).toMatchObject({ digest: `sha256:${'a'.repeat(64)}`, pending: 'idle' }); });
            const watch = await adapter.api.watchResource(RESOURCE_ID, (event) => { events.push(event); });
            expect((await entry.refresh()).digest).toBe(`sha256:${'b'.repeat(64)}`);
            await vi.waitFor(() => { expect(events).toContainEqual(expect.objectContaining({ kind: 'invalidated', digest: `sha256:${'b'.repeat(64)}` })); });
            expect((await adapter.api.readResource(RESOURCE_ID)).digest).toBe(`sha256:${'b'.repeat(64)}`);
            await vi.waitFor(() => { for (const guest of guestEntries) expect(guest.getSnapshot()).toMatchObject({ digest: `sha256:${'b'.repeat(64)}`, pending: 'idle' }); });
            expect(machineResourceRpc.read).toHaveBeenCalledTimes(2);
            expect(machineResourceRpc.open).toHaveBeenCalledTimes(1);
            const eventsBeforeSameDigest = events.length;
            await entry.refresh();
            await Promise.resolve();
            expect(events).toHaveLength(eventsBeforeSameDigest);
            expect(machineResourceRpc.read).toHaveBeenCalledTimes(3);
            machineResourceRpc.read.mockResolvedValue({ supported: true, result: { ok: false, reason: 'unavailable', code: 'plugin_resource_unavailable' } });
            expect((await entry.refresh()).error?.code).toBe('plugin_resource_unavailable');
            await vi.waitFor(() => { for (const guest of guestEntries) expect(guest.getSnapshot()).toMatchObject({ pending: 'idle', error: { code: 'unavailable' } }); });
            expect(machineResourceRpc.read).toHaveBeenCalledTimes(4);
            watch.dispose();
            account.retire();
            for (const guest of guestEntries) expect(guest.getSnapshot().value).toBeUndefined();
            await expect(adapter.api.readResource(RESOURCE_ID)).rejects.toMatchObject({ code: 'stale_surface' });
        } finally { guestReleases.forEach(release => release()); guests.forEach(store => store.dispose());
            adapter.dispose(); host.dispose?.(); release(); lease.dispose(); }
    });
    it('keeps only visible panes watching while retained hidden panes keep their snapshots and resume fresh', async () => {
        const rpc = installLiveResourceRpc();
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const bindings = Array.from({ length: 12 }, (_, index) => Object.freeze({ ...binding(account.lifetime),
            context: Object.freeze({ kind: 'session' as const, sessionId: `session-${index}` }) }));
        const snapshots = new Map<number, PluginUiResourceSnapshot | null>();
        function App(props: Readonly<{ visibleCount: number }>) {
            return <PluginContextualResourceStoreProvider>{bindings.map((exactBinding, index) =>
                <PluginSurfaceFocusEligibilityProvider key={index} active={index === 0} presentationActive={index < props.visibleCount}>
                    <ResourceProbe binding={exactBinding} onSnapshot={(snapshot) => { snapshots.set(index, snapshot); }} />
                </PluginSurfaceFocusEligibilityProvider>)}
            </PluginContextualResourceStoreProvider>;
        }
        let tree: renderer.ReactTestRenderer | null = null;
        try {
            await act(async () => { tree = renderer.create(<App visibleCount={12} />); });
            await vi.waitFor(() => { expect(rpc.nextSignals).toHaveLength(12); });
            await act(async () => { tree?.update(<App visibleCount={2} />); });
            expect(rpc.nextSignals.filter((signal) => !signal.aborted)).toHaveLength(2);
            await vi.waitFor(() => { expect(machineResourceRpc.close).toHaveBeenCalledTimes(10); });
            expect(snapshots.get(11)?.digest).toBe(`sha256:${'a'.repeat(64)}`);
            const opens = machineResourceRpc.open.mock.calls.length;
            await act(async () => { tree?.update(<App visibleCount={2} />); });
            expect(machineResourceRpc.open.mock.calls.length).toBe(opens);
            await act(async () => { tree?.update(<App visibleCount={3} />); });
            await vi.waitFor(() => { expect(rpc.nextSignals.filter((signal) => !signal.aborted)).toHaveLength(3); });
            expect(machineResourceRpc.open.mock.calls.length).toBe(opens + 1);
        } finally { await act(async () => { tree?.unmount(); }); }
    });
    it('reuses its nearest contextual owner instead of creating a nested Resource store owner', async () => {
        let outerOwner: PluginContextualResourceStoreOwner | null = null;
        let innerOwner: PluginContextualResourceStoreOwner | null = null;

        function OwnerProbe(props: Readonly<{ location: 'outer' | 'inner' }>) {
            const owner = usePluginContextualResourceStoreOwner();
            if (props.location === 'outer') outerOwner = owner;
            else innerOwner = owner;
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <PluginContextualResourceStoreProvider>
                    <OwnerProbe location="outer" />
                    <PluginContextualResourceStoreProvider>
                        <OwnerProbe location="inner" />
                    </PluginContextualResourceStoreProvider>
                </PluginContextualResourceStoreProvider>,
            );
        });

        expect(outerOwner).not.toBeNull();
        expect(innerOwner).toBe(outerOwner);

        await act(async () => { tree?.unmount(); });
    });

    it('shares one exact context across independent providers and disposes its real watch only after the final release', async () => {
        const rpc = installLiveResourceRpc();
        const account = await createAccountLifetime({ accountId: 'ab516d49-4112-4459-857e-7560beffb41a' });
        // Ordinary UUID coordinates must fit the actual daemon watch contract;
        // transport identity must not grow with the serialized context.
        const exactBinding = Object.freeze({
            ...binding(account.lifetime),
            machineId: 'fb489c9b-54f3-4093-9055-70c496253d48',
        });
        let first: PluginUiResourceSnapshot | null = null;
        let second: PluginUiResourceSnapshot | null = null;

        function App(props: Readonly<{ showFirst: boolean; showSecond: boolean }>) {
            return (
                <>
                    <PluginContextualResourceStoreProvider>
                        {props.showFirst ? <ResourceProbe binding={exactBinding} onSnapshot={(snapshot) => { first = snapshot; }} /> : null}
                    </PluginContextualResourceStoreProvider>
                    <PluginContextualResourceStoreProvider>
                        {props.showSecond ? <ResourceProbe binding={exactBinding} onSnapshot={(snapshot) => { second = snapshot; }} /> : null}
                    </PluginContextualResourceStoreProvider>
                </>
            );
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<App showFirst showSecond />);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(first?.digest).toBe(`sha256:${'a'.repeat(64)}`);
            expect(second?.digest).toBe(`sha256:${'a'.repeat(64)}`);
            expect(first?.error).toBeUndefined();
            expect(first).toMatchObject({ subscription: 'live' });
        });
        await vi.waitFor(() => { expect(rpc.nextSignals).toHaveLength(1); });
        expect(machineResourceRpc.read).toHaveBeenCalledTimes(1);
        expect(machineResourceRpc.open).toHaveBeenCalledTimes(1);

        await act(async () => {
            tree?.update(<App showFirst showSecond={false} />);
            await Promise.resolve();
        });
        expect(machineResourceRpc.close).not.toHaveBeenCalled();
        expect(rpc.nextSignals[0]?.aborted).toBe(false);

        await act(async () => {
            tree?.update(<App showFirst={false} showSecond={false} />);
            await Promise.resolve();
        });
        expect(rpc.nextSignals[0]?.aborted).toBe(true);
        await vi.waitFor(() => { expect(machineResourceRpc.close).toHaveBeenCalledTimes(1); });

        await act(async () => { tree?.unmount(); });
    });

    it('keeps Account A and B isolated and fences a late A watch event after synchronous retirement', async () => {
        let resolveLateA: ((value: ReturnType<typeof invalidatedResponse>) => void) | null = null;
        let accountASubscriptionId: string | null = null;
        const rpc = installLiveResourceRpc({
            read: (call) => call === 1 ? resourceResponse('a') : resourceResponse('b'),
            openMarker: (options) => {
                accountASubscriptionId ??= options.subscriptionId;
                return options.subscriptionId === accountASubscriptionId ? 'a' : 'b';
            },
            onNext: async (options) => {
                if (options.subscriptionId === accountASubscriptionId) {
                    return await new Promise<ReturnType<typeof invalidatedResponse>>((resolve) => {
                        resolveLateA = resolve;
                    });
                }
                return await new Promise((resolve) => {
                    options.signal.addEventListener('abort', () => {
                        resolve({ supported: false as const, reason: 'aborted' as const });
                    }, { once: true });
                });
            },
        });
        const accountA = await createAccountLifetime({ accountId: 'account-a' });
        let a: PluginUiResourceSnapshot | null = null;
        const b = { current: null as PluginUiResourceSnapshot | null };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <PluginContextualResourceStoreProvider>
                    <ResourceProbe binding={binding(accountA.lifetime)} onSnapshot={(snapshot) => { a = snapshot; }} />
                </PluginContextualResourceStoreProvider>,
            );
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(a?.digest).toBe(`sha256:${'a'.repeat(64)}`);
        });
        await vi.waitFor(() => { expect(rpc.nextSignals).toHaveLength(1); });

        await act(async () => {
            accountA.retire();
            const accountB = await createAccountLifetime({ accountId: 'account-b' });
            tree?.update(<PluginContextualResourceStoreProvider>
                <ResourceProbe binding={binding(accountA.lifetime)} onSnapshot={(snapshot) => { a = snapshot; }} />
                <ResourceProbe binding={binding(accountB.lifetime)} onSnapshot={(snapshot) => { b.current = snapshot; }} />
            </PluginContextualResourceStoreProvider>);
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(a).toBeNull(); });
        await vi.waitFor(() => { expect(b.current?.digest).toBe(`sha256:${'b'.repeat(64)}`); });
        expect(machineResourceRpc.close).toHaveBeenCalledTimes(1);
        const readsBeforeLateA = machineResourceRpc.read.mock.calls.length;

        await act(async () => {
            resolveLateA!(invalidatedResponse(accountASubscriptionId!, 'c'));
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(a).toBeNull();
        expect(b.current?.digest).toBe(`sha256:${'b'.repeat(64)}`);
        expect(machineResourceRpc.read).toHaveBeenCalledTimes(readsBeforeLateA);

        await act(async () => { tree?.unmount(); });
    });

    it('replaces an observed generation family before an old consumer releases its read and watch', async () => {
        const rpc = installLiveResourceRpc({
            read: (call) => call === 1 ? resourceResponse('a') : resourceResponse('b'),
            openMarker: (options) => options.expectedCallerOccurrenceId === '7' ? 'a' : 'b',
        });
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const generationSeven = binding(account.lifetime, '7');
        const generationEight = binding(account.lifetime, '8');
        let oldSnapshot: PluginUiResourceSnapshot | null = null;
        let newSnapshot: PluginUiResourceSnapshot | null = null;

        function App(props: Readonly<{ showNew: boolean }>) {
            return (
                <PluginContextualResourceStoreProvider>
                    <ResourceProbe binding={generationSeven} onSnapshot={(snapshot) => { oldSnapshot = snapshot; }} />
                    {props.showNew ? <ResourceProbe binding={generationEight} onSnapshot={(snapshot) => { newSnapshot = snapshot; }} /> : null}
                </PluginContextualResourceStoreProvider>
            );
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<App showNew={false} />);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(oldSnapshot?.digest).toBe(`sha256:${'a'.repeat(64)}`); });
        await vi.waitFor(() => { expect(rpc.nextSignals).toHaveLength(1); });
        const oldWatchSignal = rpc.nextSignals[0]!;

        await act(async () => {
            tree?.update(<App showNew />);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(newSnapshot?.digest).toBe(`sha256:${'b'.repeat(64)}`); });
        expect(oldWatchSignal.aborted).toBe(true);
        await vi.waitFor(() => { expect(machineResourceRpc.close).toHaveBeenCalledTimes(1); });
        expect(machineResourceRpc.read).toHaveBeenCalledTimes(2);
        expect(machineResourceRpc.open).toHaveBeenCalledTimes(2);

        await act(async () => { tree?.unmount(); });
    });

    it('returns no lease for a retired captured Account', async () => {
        installLiveResourceRpc();
        const account = await createAccountLifetime({ accountId: 'account-a' });
        account.retire();
        const ownerRef = { current: null as PluginContextualResourceStoreOwner | null };

        function OwnerProbe() {
            ownerRef.current = usePluginContextualResourceStoreOwner();
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <PluginContextualResourceStoreProvider>
                    <OwnerProbe />
                </PluginContextualResourceStoreProvider>,
            );
        });

        expect(ownerRef.current).not.toBeNull();
        if (ownerRef.current === null) throw new Error('expected contextual Resource store owner');
        expect(ownerRef.current.acquire(binding(account.lifetime))).toBeNull();
        expect(machineResourceRpc.read).not.toHaveBeenCalled();
        expect(machineResourceRpc.open).not.toHaveBeenCalled();
        expect(machineResourceRpc.next).not.toHaveBeenCalled();
        expect(machineResourceRpc.close).not.toHaveBeenCalled();

        await act(async () => { tree?.unmount(); });
    });

    it('aborts the real mounted read/watch client when its caller aborts', async () => {
        const rpc = installLiveResourceRpc();
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const controller = new AbortController();
        let observed: PluginUiResourceSnapshot | null = null;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <PluginContextualResourceStoreProvider>
                    <ResourceProbe
                        binding={binding(account.lifetime)}
                        signal={controller.signal}
                        onSnapshot={(snapshot) => { observed = snapshot; }}
                    />
                </PluginContextualResourceStoreProvider>,
            );
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(observed?.value).toBeDefined(); });
        await vi.waitFor(() => { expect(rpc.nextSignals).toHaveLength(1); });

        await act(async () => {
            controller.abort();
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(observed).toBeNull(); });
        expect(rpc.nextSignals[0]?.aborted).toBe(true);
        await vi.waitFor(() => { expect(machineResourceRpc.close).toHaveBeenCalledTimes(1); });

        await act(async () => { tree?.unmount(); });
    });

    it('withholds a snapshot and releases the real lease when caller currentness turns false', async () => {
        const rpc = installLiveResourceRpc();
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const exactBinding = binding(account.lifetime);
        let current = true;
        let observed: PluginUiResourceSnapshot | null = null;

        function App() {
            return (
                <PluginContextualResourceStoreProvider>
                    <ResourceProbe
                        binding={exactBinding}
                        isCurrent={() => current}
                        onSnapshot={(snapshot) => { observed = snapshot; }}
                    />
                </PluginContextualResourceStoreProvider>
            );
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<App />);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(observed?.value).toBeDefined(); });
        await vi.waitFor(() => { expect(rpc.nextSignals).toHaveLength(1); });

        current = false;
        await act(async () => {
            tree?.update(<App />);
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(observed).toBeNull(); });
        expect(rpc.nextSignals[0]?.aborted).toBe(true);
        await vi.waitFor(() => { expect(machineResourceRpc.close).toHaveBeenCalledTimes(1); });

        await act(async () => { tree?.unmount(); });
    });

    it('rebinds a retained native Resource hook when ordinary scope becomes declared and the declaration scope changes', async () => {
        let marker = 'a';
        installLiveResourceRpc({ read: () => resourceResponse(marker), openMarker: () => marker });
        const account = await createAccountLifetime({ accountId: 'account-a' });
        const requestSurface = { pluginId: 'acme.composer', contributionId: 'widget', surfaceId: 'widget-native-scope',
            placement: 'appSurface' as const, platform: 'ios' as const, channel: 'internal' as const,
            resourceScope: [], diagnostics: [] };
        let projection = normalizePluginInstalledUiDeclarations({}, 'ios', widgetInstalledPackage('acme.composer', 'Composer'));
        const controller = createBoundPluginSurfaceController({ facts: { ...requestSurface,
            accountLifetime: account.lifetime, machineId: 'machine-1', serverId: account.lifetime.scope.serverId,
            sessionId: 'session-1', occurrenceId: 'occurrence-42',
            resourceContext: { kind: 'session', sessionId: 'session-1' },
            resourceCapability: { readable: true, dynamic: true }, pluginUiProjection: projection,
            readActionInputFacts: () => ({ pluginUiProjection: projection }),
            interactionEnabled: true, daemonInteractionEnabled: true } });
        const surface = createPluginSurfaceContextFixture();
        const hostApi = controller.hostApi;
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({ surface, requestSurface,
            requestIdPrefix: 'native-scope-transition', handleRequest: hostApi.handleRequest,
            installedMethods: hostApi.installedMethods });
        const lifetime = new AbortController();
        const retirement = controller.onRetire(() => lifetime.abort());
        const renderContext = { plugin: { id: 'acme.composer', version: '1.0.0' },
            surface, hostApi: adapter.api, signal: lifetime.signal };
        let snapshot: PluginUiResourceSnapshot | undefined;
        let refresh = async () => {};
        let mounts = 0;
        function NativeResourceBody() {
            const resource = useLivePluginResource(RESOURCE_ID);
            snapshot = resource.resource;
            refresh = resource.refresh;
            React.useEffect(() => { mounts += 1; }, []);
            return <Text>{snapshot.digest}</Text>;
        }
        const renderSurface = defineUiSurface(() => <NativeResourceBody />);
        const module = { renderSurface: (context: Parameters<typeof renderSurface>[0]) => {
            const result = renderSurface(context);
            if (result === null || React.isValidElement(result)) return result;
            throw new Error('Expected a React element from the native surface boundary');
        } };
        const { PluginReactNativeSurface } = await import('@/components/plugins/reactNative/PluginReactNativeSurface');
        const render = () => <PluginReactNativeSurface surfaceId={requestSurface.surfaceId}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }} module={module} interactionEnabled
            privateHostBindings={{ resourceStore: controller.resourceStore, resourceStoreGeneration: 'occurrence-42',
                accountLifetime: { isCurrent: account.lifetime.isCurrent, onRetire: account.lifetime.onRetire } }}
            renderContext={renderContext} />;
        let tree!: renderer.ReactTestRenderer;
        try {
            await act(async () => { tree = renderer.create(render()); });
            await vi.waitFor(() => expect(snapshot?.digest).toBe(`sha256:${'a'.repeat(64)}`));
            expect(machineResourceRpc.read).toHaveBeenLastCalledWith('machine-1', expect.objectContaining({ context: { kind: 'session', sessionId: 'session-1' } }));
            const body = tree.root.findByType(NativeResourceBody);
            const ordinary = controller.resourceStore!.getEntry(RESOURCE_ID);
            for (const [index, scope] of (['global', 'session'] as const).entries()) {
                const previous = controller.resourceStore!.getEntry(RESOURCE_ID);
                marker = ['b', 'c'][index]!;
                projection = widgetProjectionOf([], { 'acme.composer': widgetInstalledPackage('acme.composer', 'Composer') }, {
                    state: { id: RESOURCE_ID, pluginId: 'acme.composer', resourceKind: 'config', contentType: 'application/json', scope },
                });
                await act(async () => { controller.updateMountedBindings?.({}); tree.update(render()); });
                await vi.waitFor(() => expect(snapshot?.digest).toBe(`sha256:${['b', 'c'][index]!.repeat(64)}`));
                expect(machineResourceRpc.read).toHaveBeenLastCalledWith('machine-1', expect.objectContaining({
                    context: scope === 'global' ? { kind: 'global' } : { kind: 'session', sessionId: 'session-1' },
                }));
                expect(previous.getSnapshot()).toMatchObject({ error: { code: 'plugin_resource_not_found' } });
                expect((await previous.refresh()).value).toBeUndefined();
                expect(tree.root.findByType(NativeResourceBody)).toBe(body);
                expect(controller.hostApi).toBe(hostApi);
                expect(controller.isCurrent()).toBe(true);
                expect(renderContext.signal).toBe(lifetime.signal);
                expect(lifetime.signal.aborted).toBe(false);
                const currentView = controller.resourceStore;
                projection = { ...projection, resourcesById: { ...projection.resourcesById } };
                await act(async () => { controller.updateMountedBindings?.({}); tree.update(render()); });
                expect(controller.resourceStore).toBe(currentView);
                projection = { ...projection, resourcesById: { ...projection.resourcesById,
                    unrelated: { id: RESOURCE_ID, pluginId: 'acme.other', resourceKind: 'config', scope: 'global' } } };
                await act(async () => { controller.updateMountedBindings?.({}); tree.update(render()); });
                expect(controller.resourceStore).toBe(currentView);
            }
            expect(mounts).toBe(1);
            expect(ordinary.getSnapshot().value).toBeUndefined();
            marker = 'd';
            await act(async () => { await refresh(); });
            expect(snapshot?.digest).toBe(`sha256:${'d'.repeat(64)}`);
            const removed = controller.resourceStore!.getEntry(RESOURCE_ID);
            projection = { ...projection, resourcesById: {} };
            await act(async () => { controller.updateMountedBindings?.({}); tree.update(render()); });
            expect(snapshot).toMatchObject({ error: { code: 'plugin_resource_not_found' } });
            expect(snapshot?.value).toBeUndefined();
            const reads = machineResourceRpc.read.mock.calls.length;
            await act(async () => { await refresh(); });
            expect(snapshot?.value).toBeUndefined();
            expect(machineResourceRpc.read.mock.calls).toHaveLength(reads);
            expect((await removed.refresh()).value).toBeUndefined();
            expect(tree.root.findByType(NativeResourceBody)).toBe(body);
            expect(mounts).toBe(1);
            expect(controller.hostApi).toBe(hostApi);
            expect(controller.isCurrent()).toBe(true);
            expect(lifetime.signal.aborted).toBe(false);
        } finally {
            await act(async () => { tree?.unmount(); });
            retirement.dispose(); adapter.dispose(); controller.dispose();
        }
    });
});
