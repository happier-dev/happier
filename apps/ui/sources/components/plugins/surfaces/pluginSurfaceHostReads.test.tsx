import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { createActionExecutor, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol';
import { UsageFileResultSchema } from '@happier-dev/protocol/usage/usageExport';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { PluginUiHostApiWireEnvelopeV1Schema, PluginUiJsonValueV1Schema, type PluginUiJsonObjectV1 } from '@happier-dev/protocol/plugins/ui';
import { useLivePluginResource, type PluginUiResourceSnapshot } from '@happier-dev/plugin-ui/hostApi';
import type { PluginUiResourceEntry } from '@happier-dev/plugin-ui/advanced';
import { PluginHostApiProviderInternal } from '../../../../../../packages/plugin-ui/src/hostApi/context';
import { createDeferred, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { decodeUsageQueryResource, getUsageQueryResourceStore, invalidateUsageQueryResources, readUiUsageQueryBatch } from '@/sync/api/account/usageQueryResource';
import { createCanonicalPluginReactNativeHostApiAdapter } from '@/components/plugins/reactNative/hostApi';
import { createPluginHostedWebHostApiBridgeHandler } from '@/components/plugins/hostApi/hostedWebAdapter';
import { createBoundPluginSurfaceController } from './boundPluginSurfaceController';
import { UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol';

const reference = { hostRead: 'usage.query' as const, input: { queries: [{}] } };
const quotaReference = { hostRead: 'connectedServices.quota.get' as const, input: { source: { bindingKind: 'account' as const,
    ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' } } } };
const accounting = (input: number): UsageAnalyticsQueryResponse => ({ v: 1, totals: { eventCount: 1,
    tokens: { input, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: input + 5 },
    cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } } });
let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
const controllers: ReturnType<typeof createBoundPluginSurfaceController>[] = [];
afterEach(() => {
    standardCleanup();
    for (const controller of controllers.splice(0)) controller.dispose();
    retireActiveServerAccountScopeLifetime(); home?.dispose(); home = undefined;
});

async function mount(route: Parameters<typeof serveAccountHomes>[0]['route'], enabled: boolean | (() => boolean) = true,
    resource = reference) {
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://mounted-usage.test', accountId: 'account-a' }], route });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Missing captured test Account');
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ isActionEnabled: () => typeof enabled === 'function' ? enabled() : enabled,
        usageActions: { query: async (input, options) => {
            const context = await captureLazyActionAccountContext(lifetime.scope.serverId);
            try { return await readUiUsageQueryBatch(context, input, options.signal); }
            finally { context.dispose(); }
        } },
    }));
    const controller = createBoundPluginSurfaceController({ facts: {
        pluginId: 'acme.usage', contributionId: 'summary', surfaceId: 'usage-mount', placement: 'browserSurface', platform: 'web',
        machineId: 'machine-1', occurrenceId: 'bundled-summary-current', serverId: lifetime.scope.serverId,
        accountLifetime: lifetime, interactionEnabled: true, daemonInteractionEnabled: false,
    }, binding: { executeHostAction: Object.assign(executor.execute, { prepare: executor.prepare }) } });
    controllers.push(controller);
    const context = await captureLazyActionAccountContext(lifetime.scope.serverId);
    const hostEntry = getUsageQueryResourceStore(context).getEntry(resource);
    context.dispose();
    const native = createCanonicalPluginReactNativeHostApiAdapter({ surface: createPluginSurfaceContextFixture({
        mount: { kind: 'destination', destination: { pluginId: 'acme.usage', localId: 'summary' }, container: 'appPage' }, target: { kind: 'app' },
    }), requestSurface: controller.surfaceContext, requestIdPrefix: 'usage-native', handleRequest: controller.hostApi.handleRequest,
        installedMethods: controller.installedMethods });
    return { controller, native, hostEntry, lifetime };
}

function hosted(controller: ReturnType<typeof createBoundPluginSurfaceController>) {
    const identity = { instanceId: 'usage-frame', mountNonce: 'usage-frame-nonce' };
    const pushes: unknown[] = [];
    const bridge = createPluginHostedWebHostApiBridgeHandler({ surface: controller.surfaceContext, identity,
        requestIdPrefix: 'usage-hosted', handleRequest: controller.hostApi.handleRequest, isCurrent: controller.isCurrent,
        canonicalHostApi: { identity, surface: {}, methods: controller.installedMethods }, postToFrame: event => { pushes.push(event); } });
    const unwatch = controller.subscribeResourceInvalidations(event => bridge.publishResourceSubscriptionEvent(event));
    let sequence = 0;
    let ready = false;
    const send = async (message: PluginUiJsonObjectV1) => {
        let result: Awaited<ReturnType<typeof bridge>> | undefined;
        await act(async () => {
            if (!ready) {
                await bridge({ version: 1, identity, sequence: ++sequence, kind: 'ready', payload: {} });
                ready = true;
            }
            const payload = PluginUiHostApiWireEnvelopeV1Schema.parse({ ...message, wireVersion: 1, identity });
            result = await bridge({ version: 1, identity, sequence: ++sequence, kind: 'hostApi', payload: PluginUiJsonValueV1Schema.parse(payload) });
        });
        if (!result) throw new Error('Hosted request did not settle');
        return result;
    };
    return { pushes, send, dispose() { unwatch(); bridge.dispose(); } };
}

async function settleUsageDetail(entry: PluginUiResourceEntry) {
    await expect.poll(() => {
        const snapshot = entry.getSnapshot();
        if (!snapshot.value || snapshot.pending !== 'idle') return 'pending';
        return decodeUsageQueryResource(snapshot.value).results[0]?.sources.find(source => source.source === 'work')?.status ?? 'pending';
    }).not.toBe('pending');
}

describe('mounted native and hosted host reads', () => {
    it('exports only selected fields through native and hosted executeAction, and refuses denied or retired mounts', async () => {
        let enabled = true;
        const { controller, native } = await mount(request => request.path === '/v2/usage/query'
            ? Response.json(accounting(10)) : undefined, () => enabled);
        const frame = hosted(controller);
        const input = { query: {}, format: 'json', fields: ['totals'] } as const;
        const bytes = (value: unknown) => JSON.parse(new TextDecoder().decode(decodeBase64(UsageFileResultSchema.parse(value).base64)));
        try {
            const exported = await native.api.executeAction('usage.export', input);
            expect(bytes(exported)).toMatchObject({ accounting: { totals: accounting(10).totals } });
            expect(Object.keys(bytes(exported).accounting)).toEqual(['totals']);
            await frame.send({ kind: 'negotiate', apiRange: '*' });
            const hostedExport = await frame.send({ kind: 'request', method: 'executeAction', requestId: 'export',
                payload: { action: 'usage.export', input } });
            expect(hostedExport.payload).toMatchObject({ kind: 'result' });
            const payload = hostedExport.payload as { result: unknown };
            expect(bytes(payload.result)).toEqual(bytes(exported));
            enabled = false;
            await expect(native.api.executeAction('usage.export', input)).rejects.toMatchObject({ code: 'unavailable' });
            expect((await frame.send({ kind: 'request', method: 'executeAction', requestId: 'denied-export',
                payload: { action: 'usage.export', input } })).payload).toMatchObject({ kind: 'error', error: { code: 'unavailable' } });
            controller.dispose();
            await expect(native.api.executeAction('usage.export', input)).rejects.toMatchObject({ code: 'stale_surface' });
            expect(await frame.send({ kind: 'request', method: 'executeAction', requestId: 'retired-export',
                payload: { action: 'usage.export', input } })).toMatchObject({ kind: 'error', payload: { code: 'stale_surface' } });
        } finally { frame.dispose(); native.dispose(); }
    });
    it('delivers ready accounting to native and hosted readers while its comparison is still pending', async () => {
        const comparison = createDeferred<Response>();
        const resource = { hostRead: 'usage.query' as const, input: { queries: [{ period: { startMs: 1000, endMs: 2000 } }] } };
        const { controller, native, hostEntry, lifetime } = await mount(request => {
            if (request.path !== '/v2/usage/query') return undefined;
            return UsageAnalyticsQueryRequestSchema.parse(request.body).dateRange?.startMs === 1000
                ? Response.json(accounting(10)) : comparison.promise;
        }, true, resource);
        const unwatchHost = hostEntry.subscribe(() => {}, true);
        const frame = hosted(controller);
        try {
            await expect.poll(() => hostEntry.getSnapshot().value !== undefined).toBe(true);
            expect(decodeUsageQueryResource(hostEntry.getSnapshot().value!).results[0]?.accounting).toEqual(accounting(10));
            expect(hostEntry.getSnapshot().pending).toBe('initial');
            const nativeRead = await native.api.readResource(resource);
            expect(nativeRead.digest).toBe(hostEntry.getSnapshot().digest);
            const snapshots: PluginUiResourceSnapshot[] = [];
            function Probe() { snapshots.push(useLivePluginResource(resource).resource); return null; }
            const screen = await renderScreen(<PluginHostApiProviderInternal hostApi={native.api} resourceStore={controller.resourceStore}
                accountLifetime={lifetime} mountedPluginId="acme.usage"><Probe /></PluginHostApiProviderInternal>);
            try {
                await frame.send({ kind: 'negotiate', apiRange: '*' });
                const watch = await frame.send({ kind: 'subscribe', method: 'watchResource', requestId: 'held-watch',
                    subscriptionId: 'held-watch', payload: { resource } });
                expect(watch.payload).toMatchObject({ kind: 'result', result: { digest: hostEntry.getSnapshot().digest } });
                const before = hostEntry.getSnapshot().digest;
                comparison.resolve(Response.json(accounting(20)));
                await act(async () => { await expect.poll(() => hostEntry.getSnapshot().pending).toBe('idle'); });
                await flushHookEffects();
                expect(snapshots.at(-1)).toBe(hostEntry.getSnapshot());
                expect(hostEntry.getSnapshot().digest).not.toBe(before);
                expect(frame.pushes).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ kind: 'subscription',
                    event: expect.objectContaining({ kind: 'invalidated', digest: hostEntry.getSnapshot().digest }) }) }));
                const read = await frame.send({ kind: 'request', method: 'readResource', requestId: 'held-read', payload: { resource } });
                expect(read.payload).toMatchObject({ kind: 'result', result: { digest: hostEntry.getSnapshot().digest } });
            } finally { await act(async () => screen.tree.unmount()); }
        } finally { comparison.resolve(Response.json(accounting(20))); frame.dispose(); native.dispose(); unwatchHost(); }
    });

    it('borrows the host widget entry for a native live hook and delivers the same progressive hosted read', async () => {
        let tokens = 10;
        const { controller, native, hostEntry, lifetime } = await mount(request => request.path === '/v2/usage/query'
            ? Response.json(accounting(tokens)) : undefined);
        // Keep the real host-widget demand active while native and hosted consumers join.
        const unwatchHost = hostEntry.subscribe(() => {}, true);
        await settleUsageDetail(hostEntry);
        await native.api.readResource(reference);
        const queriesBefore = home!.requests.filter(request => request.path === '/v2/usage/query').length;
        const snapshots: PluginUiResourceSnapshot[] = [];
        function Probe() { snapshots.push(useLivePluginResource(reference).resource); return null; }
        const screen = await renderScreen(<PluginHostApiProviderInternal hostApi={native.api} resourceStore={controller.resourceStore}
            accountLifetime={lifetime} mountedPluginId="acme.usage"><Probe /></PluginHostApiProviderInternal>);
        await flushHookEffects({ cycles: 20 });
        expect(snapshots.at(-1)?.value).toBeDefined();
        expect(snapshots.at(-1)).toBe(hostEntry.getSnapshot());
        const frame = hosted(controller);
        try {
            await frame.send({ kind: 'negotiate', apiRange: '*' });
            const watch = await frame.send({ kind: 'subscribe', method: 'watchResource', requestId: 'watch', subscriptionId: 'usage-watch', payload: { resource: reference } });
            expect(watch.payload).toMatchObject({ kind: 'result', result: { digest: hostEntry.getSnapshot().digest } });
            const read = await frame.send({ kind: 'request', method: 'readResource', requestId: 'read', payload: { resource: reference } });
            expect(read.payload).toMatchObject({ kind: 'result', result: { digest: hostEntry.getSnapshot().digest } });
            expect(home!.requests.filter(request => request.path === '/v2/usage/query')).toHaveLength(queriesBefore);
            const beforeDigest = hostEntry.getSnapshot().digest;
            await act(async () => { tokens = 20; invalidateUsageQueryResources(lifetime);
                await expect.poll(() => hostEntry.getSnapshot().digest).not.toBe(beforeDigest); });
            await flushHookEffects({ cycles: 20 });
            expect(snapshots.at(-1)).toBe(hostEntry.getSnapshot());
            expect(home!.requests.filter(request => request.path === '/v2/usage/query')).toHaveLength(queriesBefore + 1);
            expect(frame.pushes).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ kind: 'subscription',
                event: expect.objectContaining({ kind: 'invalidated', digest: hostEntry.getSnapshot().digest }) }) }));
            const progressive = await frame.send({ kind: 'request', method: 'readResource', requestId: 'progressive-read', payload: { resource: reference } });
            expect(progressive.payload).toMatchObject({ kind: 'result', result: { digest: hostEntry.getSnapshot().digest } });
            expect(home!.requests.filter(request => request.path === '/v2/usage/query')).toHaveLength(queriesBefore + 1);
            await act(async () => { controller.dispose(); });
            await flushHookEffects();
            expect(snapshots.at(-1)?.value).toBeUndefined();
            expect(hostEntry.getSnapshot().value).toBeDefined();
            await expect(native.api.readResource(reference)).rejects.toMatchObject({ code: 'stale_surface' });
            await expect(native.api.watchResource(reference, () => {})).rejects.toMatchObject({ code: 'stale_surface' });
            const retiredMessages: readonly PluginUiJsonObjectV1[] = [
                { kind: 'request', method: 'readResource', requestId: 'retired-read', payload: { resource: reference } },
                { kind: 'subscribe', method: 'watchResource', requestId: 'retired-watch', subscriptionId: 'retired-watch', payload: { resource: reference } },
            ];
            for (const message of retiredMessages) {
                expect(await frame.send(message)).toMatchObject({ kind: 'error', payload: { code: 'stale_surface' } });
            }
        } finally { frame.dispose(); await act(async () => { screen.tree.unmount(); }); native.dispose(); unwatchHost(); }
    });

    it('refuses native and hosted reads and watches when canonical Action settings deny admission', async () => {
        const { controller, native } = await mount(() => undefined, false);
        for (const resource of [reference, quotaReference]) {
            await expect(native.api.readResource(resource)).rejects.toMatchObject({ code: 'unavailable' });
            await expect(native.api.watchResource(resource, () => {})).rejects.toMatchObject({ code: 'unavailable' });
            const snapshot = await controller.resourceStore!.getEntry(resource).refresh();
            expect(snapshot).toMatchObject({ error: { code: 'action_disabled' } });
            expect(snapshot.value).toBeUndefined();
        }
        const frame = hosted(controller);
        try {
            await frame.send({ kind: 'negotiate', apiRange: '*' });
            for (const [index, resource] of [reference, quotaReference].entries()) {
                const deniedMessages: readonly PluginUiJsonObjectV1[] = [
                    { kind: 'request', method: 'readResource', requestId: `denied-read-${index}`, payload: { resource } },
                    { kind: 'subscribe', method: 'watchResource', requestId: `denied-watch-${index}`, subscriptionId: `denied-watch-${index}`, payload: { resource } },
                ];
                for (const message of deniedMessages) {
                    const result = await frame.send(message);
                    expect(result.payload).toMatchObject({ kind: 'error', error: { code: 'unavailable' } });
                }
            }
            expect(home!.requests.filter(request => request.path === '/v2/usage/query' || request.path.includes('/provider-account-usage/'))).toEqual([]);
        } finally { frame.dispose(); native.dispose(); }
    });

    it('borrows the canonical quota entry for native hooks and hosted reads and watches', async () => {
        const { controller, native, lifetime } = await mount(request => {
            if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') return Response.json({ error: 'not_found' }, { status: 404 });
            if (request.path === '/v2/pending/reset-starts/read') return Response.json({ entries: [] });
            return undefined;
        });
        const account = await captureLazyActionAccountContext(lifetime.scope.serverId);
        const hostEntry = getUsageQueryResourceStore(account).getEntry(quotaReference);
        account.dispose();
        const read = await native.api.readResource(quotaReference);
        expect(JSON.parse(new TextDecoder().decode(read.bytes))).toMatchObject({ source: quotaReference.input.source, current: null });
        const snapshots: PluginUiResourceSnapshot[] = [];
        function Probe() { snapshots.push(useLivePluginResource(quotaReference).resource); return null; }
        const screen = await renderScreen(<PluginHostApiProviderInternal hostApi={native.api} resourceStore={controller.resourceStore}
            accountLifetime={lifetime} mountedPluginId="acme.usage"><Probe /></PluginHostApiProviderInternal>);
        await flushHookEffects({ cycles: 20 });
        expect(snapshots.at(-1)).toBe(hostEntry.getSnapshot());
        const frame = hosted(controller);
        try {
            await frame.send({ kind: 'negotiate', apiRange: '*' });
            const watch = await frame.send({ kind: 'subscribe', method: 'watchResource', requestId: 'quota-watch', subscriptionId: 'quota-watch', payload: { resource: quotaReference } });
            expect(watch.payload).toMatchObject({ kind: 'result', result: { digest: hostEntry.getSnapshot().digest } });
            const result = await frame.send({ kind: 'request', method: 'readResource', requestId: 'quota-read', payload: { resource: quotaReference } });
            expect(result.payload).toMatchObject({ kind: 'result', result: { digest: read.digest } });
            expect(home!.requests.filter(request => request.path.includes('/provider-account-usage/'))
                .every(request => request.method === 'GET')).toBe(true);
        } finally { frame.dispose(); await act(async () => { screen.tree.unmount(); }); native.dispose(); }
    });

    it('withdraws native and hosted visibility when Action admission is revoked before a progressive update', async () => {
        let enabled = true;
        let tokens = 10;
        const { controller, native, hostEntry, lifetime } = await mount(request => request.path === '/v2/usage/query'
            ? Response.json(accounting(tokens)) : undefined, () => enabled);
        await native.api.readResource(reference);
        const snapshots: PluginUiResourceSnapshot[] = [];
        function Probe() { snapshots.push(useLivePluginResource(reference).resource); return null; }
        const screen = await renderScreen(<PluginHostApiProviderInternal hostApi={native.api} resourceStore={controller.resourceStore}
            accountLifetime={lifetime} mountedPluginId="acme.usage"><Probe /></PluginHostApiProviderInternal>);
        await flushHookEffects({ cycles: 20 });
        expect(snapshots.at(-1)?.value).toBeDefined();
        const frame = hosted(controller);
        try {
            await frame.send({ kind: 'negotiate', apiRange: '*' });
            await frame.send({ kind: 'subscribe', method: 'watchResource', requestId: 'watch', subscriptionId: 'revoked-watch', payload: { resource: reference } });
            await act(async () => { enabled = false; tokens = 99; invalidateUsageQueryResources(lifetime); });
            await expect.poll(() => controller.resourceStore!.getEntry(reference).getSnapshot().error?.code).toBe('action_disabled');
            await flushHookEffects({ cycles: 20 });
            expect(snapshots.at(-1)?.value).toBeUndefined();
            expect(snapshots.at(-1)?.error?.code).toBe('action_disabled');
            expect(frame.pushes).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ kind: 'subscription',
                event: expect.objectContaining({ kind: 'error', code: 'denied' }) }) }));
            expect(frame.pushes).not.toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ kind: 'subscription',
                event: expect.objectContaining({ kind: 'invalidated', digest: hostEntry.getSnapshot().digest }) }) }));
        } finally { frame.dispose(); await act(async () => { screen.tree.unmount(); }); native.dispose(); }
    });

    it('does not reuse an earlier admission for a subsequent cached native or hosted read', async () => {
        let enabled = true;
        const { controller, native, hostEntry } = await mount(request => request.path === '/v2/usage/query'
            ? Response.json(accounting(10)) : undefined, () => enabled);
        const unwatchHost = hostEntry.subscribe(() => {}, true);
        await settleUsageDetail(hostEntry);
        await native.api.readResource(reference);
        const queriesBefore = home!.requests.filter(request => request.path === '/v2/usage/query').length;
        enabled = false;
        await expect(native.api.readResource(reference)).rejects.toMatchObject({ code: 'unavailable' });
        const frame = hosted(controller);
        try {
            await frame.send({ kind: 'negotiate', apiRange: '*' });
            const result = await frame.send({ kind: 'request', method: 'readResource', requestId: 'cached-read', payload: { resource: reference } });
            expect(result.payload).toMatchObject({ kind: 'error', error: { code: 'unavailable' } });
            expect(home!.requests.filter(request => request.path === '/v2/usage/query')).toHaveLength(queriesBefore);
        } finally { frame.dispose(); native.dispose(); unwatchHost(); }
    });

    it('cancels an in-flight native read and withholds a late result after mount retirement', async () => {
        const delayed = createDeferred<Response>();
        const { controller, native } = await mount(request => request.path === '/v2/usage/query' ? delayed.promise : undefined);
        const abort = new AbortController();
        const pending = native.api.readResource(reference, { signal: abort.signal });
        const rejected = expect(pending).rejects.toMatchObject({ code: 'unavailable' });
        await expect.poll(() => home!.requests.filter(request => request.path === '/v2/usage/query').length).toBe(1);
        abort.abort(); controller.dispose(); delayed.resolve(Response.json(accounting(99)));
        await rejected;
        await flushHookEffects({ cycles: 20 });
        expect(controller.resourceStore!.getEntry(reference).getSnapshot().value).toBeUndefined();
        native.dispose();
    });
});
