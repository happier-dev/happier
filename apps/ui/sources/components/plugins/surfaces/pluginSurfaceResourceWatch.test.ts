import type { PluginResourceContextV1 } from '@happier-dev/protocol';
import {
    type
    PluginUiResourceSubscriptionEventV1,
    PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';
import type { ResourceSubscriptionEvent } from '@happier-dev/plugin-sdk/ui';
import { createElement } from 'react';
import renderer, { act } from 'react-test-renderer';
import { useLivePluginResource, type PluginUiResourceSnapshot } from '@happier-dev/plugin-ui/hostApi';
import { createPluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import { PluginHostApiProviderInternal } from '../../../../../../packages/plugin-ui/src/hostApi/context';
import { describe, expect, it, vi } from 'vitest';

import { createCanonicalPluginReactNativeHostApiAdapter } from '@/components/plugins/reactNative/hostApi';
import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import type {
    MachinePluginUiResourceWatchNextResult,
    MachinePluginUiResourceWatchOpenResult,
} from '@/sync/ops/machineContributionRegistryProjection';

import {
    createPluginContextualResourceWatchClient,
    type PluginSurfaceResourceWatchTransport,
} from './pluginSurfaceResourceWatch';

// The real watch owner remains beneath this genuine daemon RPC boundary.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async () => { throw new Error('Unexpected daemon RPC in an injected watch transport test'); },
}));

const surfaceContext: PluginUiSurfaceContextV1 = {
    pluginId: 'acme.preview',
    contributionId: 'native-preview',
    surfaceId: 'surface_1',
    sessionId: 'session-1',
    placement: 'sessionPane',
    platform: 'ios',
    channel: 'internal',
    resourceScope: [],
    diagnostics: [],
};

const canonicalSurface = createPluginSurfaceContextFixture({
    mount: {
        kind: 'destination',
        destination: { pluginId: 'acme.preview', localId: 'native-preview' },
        container: 'rightPane',
    },
    target: { kind: 'session', sessionId: 'session-1' },
});

type ResourceDigest = Extract<PluginUiResourceSubscriptionEventV1, { kind: 'invalidated' }>['digest'];

const DIGEST_A: ResourceDigest = `sha256:${'a'.repeat(64)}`;
const DIGEST_B: ResourceDigest = `sha256:${'b'.repeat(64)}`;
const CURRENT_ACCOUNT_LIFETIME = Object.freeze({
    scope: { serverId: 'server-1', accountId: 'account-a' },
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose: () => {} }),
});
const TARGETED_RESOURCE_CONTEXT: PluginResourceContextV1 = Object.freeze({
    kind: 'surface',
    mountInstanceKey: 'targeted-surface:v1:review:mount-a',
    launchInput: { reviewId: 'review-a' },
});

type FakeDaemon = Readonly<{
    transport: PluginSurfaceResourceWatchTransport;
    /** Deliver one daemon-side poll answer to whichever poll is parked. */
    answerNext: (result: MachinePluginUiResourceWatchNextResult) => Promise<void>;
    opens: { subscriptionId: string; resource: unknown; context?: unknown }[];
    closes: string[];
    nextSignals: AbortSignal[];
    openSignals: (AbortSignal | undefined)[];
    parkOpen: () => void;
    setOpenResult: (result: MachinePluginUiResourceWatchOpenResult) => void;
}>;

/**
 * The daemon machine RPC is a genuine process boundary, so it is the only thing
 * substituted here. It answers with the exact
 * `DaemonPluginUiResourceWatch*Response` shapes the daemon parses; everything
 * below it — the mount handler, the bound controller's invalidation sink, the
 * canonical React Native adapter and its subscription registry — is real.
 */
function createFakeDaemon(): FakeDaemon {
    const opens: { subscriptionId: string; resource: unknown }[] = [];
    const closes: string[] = [];
    const nextSignals: AbortSignal[] = [];
    const openSignals: (AbortSignal | undefined)[] = [];
    let openResult: MachinePluginUiResourceWatchOpenResult = {
        supported: true,
        result: { ok: true, subscriptionId: 'unused', digest: DIGEST_A },
    };
    let parked: ((result: MachinePluginUiResourceWatchNextResult) => void) | null = null;
    let parkOpen = false;
    return {
        opens,
        closes,
        setOpenResult: (result) => { openResult = result; },
        parkOpen: () => { parkOpen = true; },
        answerNext: async (result) => {
            await vi.waitFor(() => { expect(parked).toBeTypeOf('function'); });
            const resolve = parked!;
            parked = null;
            resolve(result);
            await Promise.resolve();
        },
        transport: {
            open: async (_machineId, opts) => {
                openSignals.push(opts.signal);
                if (parkOpen) {
                    return await new Promise<MachinePluginUiResourceWatchOpenResult>((resolve) => {
                        opts.signal?.addEventListener('abort', () => {
                            resolve({ supported: false, reason: 'aborted' });
                        }, { once: true });
                    });
                }
                opens.push({
                    subscriptionId: opts.subscriptionId,
                    resource: opts.resource,
                    ...(opts.context === undefined ? {} : { context: opts.context }),
                });
                return openResult.supported && openResult.result.ok
                    ? {
                        supported: true,
                        result: { ...openResult.result, subscriptionId: opts.subscriptionId },
                    }
                    : openResult;
            },
            next: async (_machineId, opts) => await new Promise<MachinePluginUiResourceWatchNextResult>((resolve) => {
                if (opts.signal) nextSignals.push(opts.signal);
                parked = resolve;
                opts.signal?.addEventListener('abort', () => {
                    if (parked === resolve) parked = null;
                    resolve({ supported: false, reason: 'aborted' });
                }, { once: true });
            }),
            close: async (_machineId, opts) => { closes.push(opts.subscriptionId); },
        },
        nextSignals,
        openSignals,
    };
}

async function createMountedSurface(
    daemon: FakeDaemon,
    resourceContext?: PluginResourceContextV1,
) {
    const { createBoundPluginSurfaceController } = await import('./boundPluginSurfaceController');
    const facts = {
        pluginId: surfaceContext.pluginId,
        contributionId: surfaceContext.contributionId,
        surfaceId: surfaceContext.surfaceId,
        sessionId: surfaceContext.sessionId,
        placement: surfaceContext.placement,
        platform: surfaceContext.platform,
        channel: surfaceContext.channel,
        machineId: 'machine-1',
        serverId: null,
        projectionGeneration: 7,
        occurrenceId: 'occurrence-7',
        resourceCapability: { readable: true, dynamic: true },
        accountLifetime: CURRENT_ACCOUNT_LIFETIME,
        interactionEnabled: true,
        daemonInteractionEnabled: true,
        ...(resourceContext === undefined ? {} : { resourceContext }),
    };
    const controller = createBoundPluginSurfaceController({
        facts,
        binding: { watchResource: daemon.transport },
    });
    const adapter = createCanonicalPluginReactNativeHostApiAdapter({
        surface: canonicalSurface,
        requestSurface: controller.surfaceContext,
        requestIdPrefix: 'rn-watch',
        handleRequest: controller.hostApi.handleRequest,
        installedMethods: controller.hostApi.installedMethods,
    });
    // The one wiring `PluginSurfaceHost` performs: the mount's invalidation sink
    // reaches the adapter's existing subscription registry.
    const unsubscribe = controller.subscribeResourceInvalidations(
        (event) => { adapter.publishResourceSubscriptionEvent(event); },
    );
    return { controller, adapter, unsubscribe };
}

describe('mounted plugin surface live resource invalidation (EU-4b)', () => {
    it.each(['opaque', 'missing'] as const)('refuses a %s shared Resource digest at the strict watch crossing without narrowing the generic store', async (kind) => {
        let digest: string | undefined = kind === 'opaque' ? 'opaque-resource-version' : undefined;
        const externalWatches: { signal: AbortSignal; disposed: boolean }[] = [];
        const store = createPluginUiResourceStore({ pluginId: 'acme.preview', client: {
            readResource: async () => {
                const content = { contentType: 'application/json', digest: digest ?? '', bytes: new TextEncoder().encode('1') };
                // This genuine external read boundary also supplies a malformed remote payload; no internal store is mocked.
                if (digest === undefined) Reflect.deleteProperty(content, 'digest');
                return content;
            },
            watchResource: async (_resource, _listener, options) => {
                if (!options?.signal) throw new Error('Expected the actual store-owned external watch signal');
                const watch = { signal: options.signal, disposed: false };
                externalWatches.push(watch);
                return { dispose() { watch.disposed = true; } };
            },
        } });
        const daemon = createFakeDaemon();
        const client = createPluginContextualResourceWatchClient({ pluginId: 'acme.preview',
            resource: { machineId: 'machine-1', expectedCallerOccurrenceId: 'occurrence-7', store },
            subscriptionIdPrefix: 'shared-digest', transport: daemon.transport });
        const events: ResourceSubscriptionEvent[] = [];
        const entry = store.getEntry('live-status');
        let subscription: Readonly<{ dispose(): void }> | undefined;
        try {
            await expect(client.watchResource('live-status', event => { events.push(event); }))
                .rejects.toMatchObject({ code: 'plugin_resource_digest_invalid', retryable: false });
            expect(entry.getSnapshot().digest).toBe(digest);
            expect(entry.getSnapshot().value).toBeDefined();
            expect(events.filter(event => event.kind === 'invalidated')).toHaveLength(0);
            expect(externalWatches.length).toBeGreaterThan(0);
            expect(externalWatches.every(watch => watch.signal.aborted || watch.disposed)).toBe(true);

            events.length = 0;
            digest = DIGEST_A;
            await entry.refresh();
            expect(events).toHaveLength(0);
            subscription = await client.watchResource('live-status', event => { events.push(event); });
            expect(subscription).toMatchObject({ admittedDigest: DIGEST_A });
            await vi.waitFor(() => { expect(externalWatches.filter(watch => !watch.signal.aborted && !watch.disposed)).toHaveLength(1); });
            events.length = 0;
            digest = DIGEST_B;
            await entry.refresh();
            expect(events).toEqual([expect.objectContaining({ kind: 'invalidated', digest: DIGEST_B })]);

            digest = kind === 'opaque' ? 'next-opaque-version' : undefined;
            await entry.refresh();
            expect(events).toHaveLength(2);
            expect(events[1]).toMatchObject({ kind: 'error', code: 'unavailable', diagnostics: ['plugin_resource_digest_invalid'] });
            expect(entry.getSnapshot().digest).toBe(digest);
            expect(entry.getSnapshot().value).toBeDefined();
            expect(externalWatches.every(watch => watch.signal.aborted || watch.disposed)).toBe(true);
            events.length = 0;
            digest = DIGEST_A;
            await entry.refresh();
            expect(events).toHaveLength(0);
            subscription = await client.watchResource('live-status', event => { events.push(event); });
            expect(subscription).toMatchObject({ admittedDigest: DIGEST_A });
            expect(daemon.opens).toHaveLength(0);
        } finally { subscription?.dispose(); store.dispose(); }
        expect(externalWatches.every(watch => watch.signal.aborted || watch.disposed)).toBe(true);
    });

    it('suspends the actual daemon pump for a retained authored Resource and resumes fresh', async () => {
        const daemon = createFakeDaemon();
        const mounted = await createMountedSurface(daemon);
        let digest = DIGEST_A;
        // Only snapshot RPC bytes are supplied at the external host boundary;
        // subscription admission, registry, store and long-poll pump stay real.
        const hostApi = { ...mounted.adapter.api, readResource: async () => ({
            contentType: 'application/json', digest, bytes: new TextEncoder().encode('1'),
        }) };
        let snapshot: PluginUiResourceSnapshot | undefined;
        function Probe() { snapshot = useLivePluginResource('live-status').resource; return null; }
        const content = (active?: boolean) => createElement(PluginHostApiProviderInternal, {
            hostApi, mountedPluginId: 'acme.preview',
            ...(active === undefined ? {} : { surfaceActivity: { active } }),
        }, createElement(Probe));
        let tree: renderer.ReactTestRenderer | undefined;
        try {
            await act(async () => { tree = renderer.create(content(true)); });
            await vi.waitFor(() => { expect(daemon.nextSignals).toHaveLength(1); });
            const value = snapshot?.value;
            expect(value).toBeDefined();
            await act(async () => { tree?.update(content(false)); });
            expect(daemon.nextSignals[0]?.aborted).toBe(true);
            await vi.waitFor(() => { expect(daemon.closes).toHaveLength(1); });
            expect(snapshot?.value).toBe(value);
            digest = DIGEST_B;
            daemon.setOpenResult({ supported: true, result: { ok: true, subscriptionId: 'replaced', digest } });
            await act(async () => { tree?.update(content(true)); });
            await vi.waitFor(() => { expect(daemon.nextSignals).toHaveLength(2); });
            expect(daemon.nextSignals[1]?.aborted).toBe(false);
            expect(snapshot?.digest).toBe(DIGEST_B);
            expect(daemon.opens[1]?.subscriptionId).not.toBe(daemon.opens[0]?.subscriptionId);
            await act(async () => { tree?.update(content()); });
            expect(daemon.nextSignals).toHaveLength(2);
        } finally {
            await act(async () => { tree?.unmount(); });
            mounted.unsubscribe();
            mounted.controller.dispose();
        }
    });

    it('keeps a Session watch under the exact contextual Resource binding', async () => {
        const daemon = createFakeDaemon();
        const client = createPluginContextualResourceWatchClient({
            pluginId: 'acme.preview',
            resource: {
                machineId: 'machine-1',
                serverId: null,
                expectedCallerOccurrenceId: 'occurrence-7',
                context: { kind: 'session', sessionId: 'session-a' },
            },
            subscriptionIdPrefix: 'transcript-activity:session-a',
            transport: daemon.transport,
        });

        const subscription = await client.watchResource(
            'live-status',
            () => undefined,
        );

        try {
            expect(daemon.opens).toEqual([expect.objectContaining({
                resource: { pluginId: 'acme.preview', localId: 'live-status' },
                context: { kind: 'session', sessionId: 'session-a' },
            })]);
            expect(subscription).toMatchObject({ admittedDigest: DIGEST_A });
        } finally {
            subscription.dispose();
            await vi.waitFor(() => { expect(daemon.closes).toEqual([daemon.opens[0]!.subscriptionId]); });
        }
    });

    it('aborts a parked contextual Resource poll when its subscriber disposes', async () => {
        const daemon = createFakeDaemon();
        const client = createPluginContextualResourceWatchClient({
            pluginId: 'acme.preview',
            resource: {
                machineId: 'machine-1',
                serverId: null,
                expectedCallerOccurrenceId: 'occurrence-7',
                context: { kind: 'session', sessionId: 'session-a' },
            },
            subscriptionIdPrefix: 'transcript-activity:session-a',
            transport: daemon.transport,
        });

        const subscription = await client.watchResource('live-status', () => undefined);
        await vi.waitFor(() => { expect(daemon.nextSignals).toHaveLength(1); });
        const [signal] = daemon.nextSignals;
        expect(signal?.aborted).toBe(false);

        subscription.dispose();

        // The caller's disposal must synchronously abort the parked long poll;
        // the close RPC remains the daemon-side subscription cleanup.
        expect(signal?.aborted).toBe(true);
        await vi.waitFor(() => { expect(daemon.closes).toEqual([daemon.opens[0]!.subscriptionId]); });
        expect(daemon.opens).toHaveLength(1);
    });

    it('aborts a contextual Resource reconnect backoff when its subscriber disposes', async () => {
        const daemon = createFakeDaemon();
        const backoffStarted = (() => {
            let resolve!: (signal: AbortSignal | undefined) => void;
            return {
                promise: new Promise<AbortSignal | undefined>((nextResolve) => { resolve = nextResolve; }),
                resolve,
            };
        })();
        let backoffAbortCount = 0;
        const client = createPluginContextualResourceWatchClient({
            pluginId: 'acme.preview',
            resource: {
                machineId: 'machine-1',
                serverId: null,
                expectedCallerOccurrenceId: 'occurrence-7',
                context: { kind: 'session', sessionId: 'session-a' },
            },
            subscriptionIdPrefix: 'transcript-activity:session-a',
            transport: daemon.transport,
            delayMs: (_ms, signal?: AbortSignal) => new Promise<void>((resolve) => {
                backoffStarted.resolve(signal);
                signal?.addEventListener('abort', () => {
                    backoffAbortCount += 1;
                    resolve();
                }, { once: true });
            }),
        });
        let subscription: Readonly<{ dispose(): void }> | undefined;
        try {
            subscription = await client.watchResource('live-status', () => undefined);
            await vi.waitFor(() => { expect(daemon.nextSignals).toHaveLength(1); });

            await daemon.answerNext({ supported: false, reason: 'error' });
            const backoffSignal = await backoffStarted.promise;

            // Retiring the mounted subscription must cancel a pending reconnect
            // wait immediately. Otherwise an abandoned timer remains live until
            // its backoff expires even though the Resource store is disposed.
            expect(backoffSignal).toBeDefined();
            subscription.dispose();
            expect(backoffSignal?.aborted).toBe(true);
            expect(backoffAbortCount).toBe(1);
        } finally {
            subscription?.dispose();
        }
    });

    it('forwards the exact host-stamped surface context to a targeted Resource watch', async () => {
        const daemon = createFakeDaemon();
        const mounted = await createMountedSurface(daemon, TARGETED_RESOURCE_CONTEXT);

        const subscription = await mounted.adapter.api.watchResource(
            'live-status',
            () => undefined,
        );

        expect(daemon.opens).toEqual([expect.objectContaining({
            resource: { pluginId: 'acme.preview', localId: 'live-status' },
            context: TARGETED_RESOURCE_CONTEXT,
        })]);

        subscription.dispose();
        await vi.waitFor(() => { expect(daemon.closes).toEqual([daemon.opens[0]!.subscriptionId]); });
        mounted.unsubscribe();
        mounted.controller.dispose();
    });

    it('aborts a targeted Resource watch when its host context retires', async () => {
        const daemon = createFakeDaemon();
        const mounted = await createMountedSurface(daemon, TARGETED_RESOURCE_CONTEXT);
        await mounted.adapter.api.watchResource(
            'live-status',
            () => undefined,
        );
        await vi.waitFor(() => { expect(daemon.nextSignals).toHaveLength(1); });
        const [signal] = daemon.nextSignals;

        // A same-mount A→B launch-input replacement retires the old bound
        // controller. Its existing watch owner must cancel the parked poll
        // rather than let B inherit or receive A's invalidation.
        mounted.controller.dispose();

        expect(signal?.aborted).toBe(true);
        await vi.waitFor(() => { expect(daemon.closes).toEqual([daemon.opens[0]!.subscriptionId]); });
        // The retired controller already owns and closed this subscription; a
        // second public unsubscribe would correctly reject as stale.
        mounted.unsubscribe();
    });

    it('aborts a targeted Resource watch establishment when its host context retires', async () => {
        const daemon = createFakeDaemon();
        daemon.parkOpen();
        const mounted = await createMountedSurface(daemon, TARGETED_RESOURCE_CONTEXT);
        const pending = mounted.adapter.api.watchResource(
            'live-status',
            () => undefined,
        );
        await vi.waitFor(() => { expect(daemon.openSignals).toHaveLength(1); });

        mounted.controller.dispose();

        expect(daemon.openSignals[0]).toBeDefined();
        expect(daemon.openSignals[0]?.aborted).toBe(true);
        await expect(pending).rejects.toMatchObject({ code: 'unavailable' });
        mounted.unsubscribe();
    });

    it('composes the mount lifetime with an author cancellation while establishing, without AbortSignal.any', async () => {
        // The mount lifetime and an author-held signal are both live here, which
        // is the only path that has to compose two signals. `AbortSignal.any` is
        // a browser-only static, so the composition may not depend on it.
        const daemon = createFakeDaemon();
        daemon.parkOpen();
        const mounted = await createMountedSurface(daemon, TARGETED_RESOURCE_CONTEXT);
        const author = new AbortController();
        const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
        Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });

        try {
            const pending = mounted.adapter.api.watchResource(
                'live-status',
                () => undefined,
                { signal: author.signal },
            );
            await vi.waitFor(() => { expect(daemon.openSignals).toHaveLength(1); });
            // A composition that simply forwarded the mount lifetime would already
            // be aborted-free here and would stay so after the author cancels.
            expect(daemon.openSignals[0]).toBeDefined();
            expect(daemon.openSignals[0]?.aborted).toBe(false);

            author.abort();

            expect(daemon.openSignals[0]?.aborted).toBe(true);
            await expect(pending).rejects.toMatchObject({ code: 'unavailable' });
        } finally {
            if (anyDescriptor) Object.defineProperty(AbortSignal, 'any', anyDescriptor);
            else Reflect.deleteProperty(AbortSignal, 'any');
            mounted.unsubscribe();
            mounted.controller.dispose();
        }
    });

    it('delivers a daemon invalidation to the author listener through the public host API', async () => {
        const daemon = createFakeDaemon();
        const mounted = await createMountedSurface(daemon);
        const events: ResourceSubscriptionEvent[] = [];

        expect(mounted.controller.hostApi.installedMethods).toContain('watchResource');
        expect(mounted.adapter.api.version().methods).toContain('watchResource');

        const subscription = await mounted.adapter.api.watchResource(
            'live-status',
            (event) => { events.push(event); },
        );
        // The establishment carried the caller-scoped reference the daemon
        // expects — never the declarative session-resource-target vocabulary.
        expect(daemon.opens).toHaveLength(1);
        expect(daemon.opens[0]?.resource).toEqual({ pluginId: 'acme.preview', localId: 'live-status' });
        expect(daemon.opens[0]).not.toHaveProperty('context');

        await daemon.answerNext({
            supported: true,
            result: {
                ok: true,
                status: 'event',
                event: { version: 1, subscriptionId: daemon.opens[0]!.subscriptionId, kind: 'invalidated', digest: DIGEST_B },
            },
        });

        await vi.waitFor(() => { expect(events).toHaveLength(1); });
        expect(events[0]).toMatchObject({ kind: 'invalidated', digest: DIGEST_B });

        subscription.dispose();
        await vi.waitFor(() => { expect(daemon.closes).toEqual([daemon.opens[0]!.subscriptionId]); });
        mounted.unsubscribe();
        mounted.controller.dispose();
    });

    it('does not advertise watchResource on a mount that cannot address the daemon', async () => {
        const { createBoundPluginSurfaceController } = await import('./boundPluginSurfaceController');
        const controller = createBoundPluginSurfaceController({
            facts: {
                pluginId: surfaceContext.pluginId,
                contributionId: surfaceContext.contributionId,
                surfaceId: surfaceContext.surfaceId,
                placement: surfaceContext.placement,
                platform: surfaceContext.platform,
                channel: surfaceContext.channel,
                accountLifetime: CURRENT_ACCOUNT_LIFETIME,
                interactionEnabled: true,
                daemonInteractionEnabled: false,
            },
        });
        expect(controller.hostApi.installedMethods).not.toContain('watchResource');
        // Negative control: the mount is otherwise interactive.
        expect(controller.hostApi.installedMethods).toContain('executeAction');
        controller.dispose();
    });

    it('rejects a cross-plugin subscription before any daemon call', async () => {
        const daemon = createFakeDaemon();
        const mounted = await createMountedSurface(daemon);
        await expect(mounted.adapter.api.watchResource(
            { pluginId: 'other.plugin', localId: 'live-status' },
            () => undefined,
        )).rejects.toMatchObject({ code: 'unavailable' });
        expect(daemon.opens).toHaveLength(0);
        // Positive control: the owning plugin's own reference is admitted.
        await expect(mounted.adapter.api.watchResource(
            { pluginId: 'acme.preview', localId: 'live-status' },
            () => undefined,
        )).resolves.toMatchObject({ dispose: expect.any(Function) });
        mounted.unsubscribe();
        mounted.controller.dispose();
    });

    it('rejects establishment when the daemon refuses, without leaving a subscription behind', async () => {
        const daemon = createFakeDaemon();
        daemon.setOpenResult({
            supported: true,
            result: { ok: false, code: 'plugin_resource_watch_unavailable', reason: 'not_found' },
        });
        const mounted = await createMountedSurface(daemon);
        await expect(mounted.adapter.api.watchResource('packaged-doc', () => undefined))
            .rejects.toMatchObject({ code: 'unavailable' });
        expect(daemon.closes).toHaveLength(0);
        mounted.unsubscribe();
        mounted.controller.dispose();
    });

    it('preserves retryability from initial watch admission for the Resource-store recovery owner', async () => {
        const daemon = createFakeDaemon();
        daemon.setOpenResult({ supported: false, reason: 'error' });
        const transientClient = createPluginContextualResourceWatchClient({
            pluginId: 'acme.preview',
            resource: { machineId: 'machine-1', serverId: null, expectedCallerOccurrenceId: 'occurrence-7' },
            subscriptionIdPrefix: 'initial-open-transient',
            transport: daemon.transport,
        });

        await expect(transientClient.watchResource('live-status', () => undefined)).rejects.toMatchObject({
            code: 'plugin_resource_transport_error',
            retryable: true,
        });

        // A current declaration can be temporarily unavailable at the daemon
        // Resource owner. This is distinct from a missing declaration: the
        // generic Resource store must be allowed to retry the former without
        // making the latter look like a transport outage.
        const unavailableDaemon = createFakeDaemon();
        unavailableDaemon.setOpenResult({
            supported: true,
            result: {
                ok: false,
                code: 'plugin_resource_session_access_unavailable',
                reason: 'unavailable',
            },
        });
        const unavailableClient = createPluginContextualResourceWatchClient({
            pluginId: 'acme.preview',
            resource: { machineId: 'machine-1', serverId: null, expectedCallerOccurrenceId: 'occurrence-7' },
            subscriptionIdPrefix: 'initial-open-unavailable',
            transport: unavailableDaemon.transport,
        });

        await expect(unavailableClient.watchResource('live-status', () => undefined)).rejects.toMatchObject({
            code: 'plugin_resource_session_access_unavailable',
            retryable: true,
        });

        const undeclaredDaemon = createFakeDaemon();
        undeclaredDaemon.setOpenResult({
            supported: true,
            result: {
                ok: false,
                code: 'plugin_resource_not_found',
                reason: 'not_found',
            },
        });
        const undeclaredClient = createPluginContextualResourceWatchClient({
            pluginId: 'acme.preview',
            resource: { machineId: 'machine-1', serverId: null, expectedCallerOccurrenceId: 'occurrence-7' },
            subscriptionIdPrefix: 'initial-open-undeclared',
            transport: undeclaredDaemon.transport,
        });

        await expect(undeclaredClient.watchResource('live-status', () => undefined)).rejects.toMatchObject({
            code: 'plugin_resource_not_found',
            retryable: false,
        });

        const terminalDaemon = createFakeDaemon();
        terminalDaemon.setOpenResult({ supported: false, reason: 'not-supported' });
        const terminalClient = createPluginContextualResourceWatchClient({
            pluginId: 'acme.preview',
            resource: { machineId: 'machine-1', serverId: null, expectedCallerOccurrenceId: 'occurrence-7' },
            subscriptionIdPrefix: 'initial-open-terminal',
            transport: terminalDaemon.transport,
        });

        await expect(terminalClient.watchResource('live-status', () => undefined)).rejects.toMatchObject({
            code: 'plugin_resource_transport_not_supported',
            retryable: false,
        });
        expect(daemon.opens).toHaveLength(1);
        expect(unavailableDaemon.opens).toHaveLength(1);
        expect(undeclaredDaemon.opens).toHaveLength(1);
        expect(terminalDaemon.opens).toHaveLength(1);
    });

    it('resynchronizes through a re-open when the daemon no longer knows the subscription', async () => {
        const daemon = createFakeDaemon();
        const mounted = await createMountedSurface(daemon);
        const events: ResourceSubscriptionEvent[] = [];
        await mounted.adapter.api.watchResource('live-status', (event) => { events.push(event); });

        // The daemon restarted: the poll comes back with a subscription it does
        // not know. The mount must re-open and compare, not go quiet.
        daemon.setOpenResult({
            supported: true,
            result: { ok: true, subscriptionId: 'unused', digest: DIGEST_B },
        });
        await daemon.answerNext({
            supported: true,
            result: { ok: false, code: 'plugin_resource_subscription_unknown', reason: 'unknown_subscription' },
        });

        await vi.waitFor(() => { expect(daemon.opens.length).toBeGreaterThan(1); }, { timeout: 5_000 });
        await vi.waitFor(() => { expect(events).toHaveLength(1); }, { timeout: 5_000 });
        // Last known good was DIGEST_A; the re-open observed DIGEST_B, so the
        // observer is told to re-read rather than being left silently stale.
        expect(events[0]).toMatchObject({ kind: 'invalidated', digest: DIGEST_B });
        mounted.unsubscribe();
        mounted.controller.dispose();
    });

    it('terminates the subscription when the generation the mount is bound to is replaced', async () => {
        const daemon = createFakeDaemon();
        const mounted = await createMountedSurface(daemon);
        const events: ResourceSubscriptionEvent[] = [];
        await mounted.adapter.api.watchResource('live-status', (event) => { events.push(event); });

        await daemon.answerNext({
            supported: true,
            result: { ok: false, code: 'plugin_occurrence_stale', reason: 'stale_occurrence' },
        });

        await vi.waitFor(() => { expect(events).toHaveLength(1); });
        expect(events[0]).toMatchObject({ kind: 'error', code: 'expired_resource' });
        // A terminal arm is not retried: the mount does not re-open a generation
        // that no longer exists.
        expect(daemon.opens).toHaveLength(1);
        mounted.unsubscribe();
        mounted.controller.dispose();
    });
});
