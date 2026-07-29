import { describe, expect, it, vi } from 'vitest';

import type { ParsedPluginEventContributionV1 } from '@happier-dev/protocol';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { type PluginContributionRef } from '@happier-dev/plugin-sdk/runtime';

import type { PluginInvocationServicesSeed } from './types';
import {
    bindDeclaredEventSubscriptions,
    createStablePluginEventsBroker,
    createPluginInvocationEventsService,
    measureStablePluginEventPublicationBytes,
    STABLE_PLUGIN_EVENT_QUEUE_LIMITS,
} from './events';

const publisherDeclarations: readonly ParsedPluginEventContributionV1[] = Object.freeze([
    Object.freeze({ id: 'changed', kind: 'event', title: 'Changed' }),
    Object.freeze({ id: 'turn-start', kind: 'event', title: 'Reserved runtime event' }),
    Object.freeze({ id: 'input-accepted', kind: 'event', title: 'Reserved custody event' }),
]);
const subscriberDeclarations: readonly ParsedPluginEventContributionV1[] = Object.freeze([
    Object.freeze({
        id: 'watch-changed',
        kind: 'subscription',
        event: Object.freeze({ pluginId: 'acme.publisher', localId: 'changed' }),
    }),
]);

function seed(pluginId: string, controller = new AbortController()): PluginInvocationServicesSeed {
    return Object.freeze({
        plugin: Object.freeze({ id: pluginId, version: '1.0.0' }),
        contribution: Object.freeze({ id: 'run', qualifiedId: `${pluginId}/actions/run` }),
        generation: '7',
        correlationId: `${pluginId}-correlation`,
        surface: 'cli',
        signal: controller.signal,
        isGenerationCurrent: () => !controller.signal.aborted,
    });
}

function services(params: Readonly<{
    broker: ReturnType<typeof createStablePluginEventsBroker>;
    pluginId: 'acme.publisher' | 'acme.subscriber';
    controller?: AbortController;
}>) {
    const declarationsByPluginId = new Map([
        ['acme.publisher', publisherDeclarations],
        ['acme.subscriber', subscriberDeclarations],
    ]);
    const permissionDeclarationsByPluginId = new Map([
        ['acme.publisher', Object.freeze([])],
        ['acme.subscriber', Object.freeze([Object.freeze({
            capability: 'events.plugin.subscribe',
            scope: 'acme.publisher',
            reason: 'Observe publisher events',
        })])],
    ]);
    return createPluginInvocationEventsService({
        seed: seed(params.pluginId, params.controller),
        broker: params.broker,
        declarationsByPluginId,
        permissionDeclarationsByPluginId,
        activePluginIds: new Set(['acme.publisher', 'acme.subscriber']),
    });
}

describe('stable invocation events service', () => {
    it('measures the selected queue limits against representative settings, notification, and runtime publications', () => {
        const identity = {
            pluginId: 'acme.notifications',
            pluginVersion: '1.0.0',
            contributionId: 'deliver',
            contributionQualifiedId: 'acme.notifications/actions/deliver',
            generation: 'current-generation-00000042',
            correlationId: '01JZQQQQQQQQQQQQQQQQQQQQQQ',
            surface: 'cli' as const,
        };
        const ref = { pluginId: 'acme.notifications', localId: 'changed' };
        const measuredBytes = Object.freeze({
            settingsChanged: measureStablePluginEventPublicationBytes({
                ref,
                identity,
                payload: {
                    contributionId: 'notification-channel/webhook',
                    revision: 42,
                    changedFieldIds: ['webhook.endpoint', 'webhook.enabled'],
                },
            }),
            notificationDelivered: measureStablePluginEventPublicationBytes({
                ref: { pluginId: 'acme.notifications', localId: 'delivery-result' },
                identity,
                payload: {
                    channelId: 'webhook',
                    categoryId: 'activity',
                    deliveryId: '01JZQQQQQQQQQQQQQQQQQQQQQQ',
                    status: 'delivered',
                    attemptedAt: '2026-07-23T07:00:00.000Z',
                    completedAt: '2026-07-23T07:00:00.250Z',
                },
            }),
            runtimeLifecycle: measureStablePluginEventPublicationBytes({
                ref: { pluginId: 'acme.runtime-observer', localId: 'session-state' },
                identity: {
                    ...identity,
                    pluginId: 'acme.runtime-observer',
                    contributionId: 'observe',
                    contributionQualifiedId: 'acme.runtime-observer/subscriptions/observe',
                    surface: 'cli',
                },
                payload: {
                    sessionId: 'session_01JZQQQQQQQQQQQQQQQQQQQQQQ',
                    agentId: 'claude',
                    state: 'active',
                    activity: 'thinking',
                    sequence: 12_345,
                    timestamp: '2026-07-23T07:00:00.000Z',
                },
            }),
        });
        const representativeMaximumBytes = Math.max(...Object.values(measuredBytes));

        expect(measuredBytes).toEqual({
            settingsChanged: 478,
            notificationDelivered: 558,
            runtimeLifecycle: 543,
        });
        expect(STABLE_PLUGIN_EVENT_QUEUE_LIMITS).toEqual({
            pendingDeliveriesPerSubscription: 256,
            pendingBytesPerSubscription: 1024 * 1024,
        });
        expect(
            representativeMaximumBytes * STABLE_PLUGIN_EVENT_QUEUE_LIMITS.pendingDeliveriesPerSubscription,
        ).toBeLessThan(STABLE_PLUGIN_EVENT_QUEUE_LIMITS.pendingBytesPerSubscription);
    });

    it('binds declared subscription registrations with schema filtering, priority order, and generation disposal', async () => {
        const broker = createStablePluginEventsBroker();
        const declarationsByPluginId = new Map<string, readonly ParsedPluginEventContributionV1[]>([
            ['acme.publisher', publisherDeclarations],
            ['acme.first', [{
                id: 'watch',
                kind: 'subscription',
                event: { pluginId: 'acme.publisher', localId: 'changed' },
                filterSchema: { type: 'object', properties: { accepted: { const: true } }, required: ['accepted'] },
                priority: -10,
            }]],
            ['acme.second', [{
                id: 'watch',
                kind: 'subscription',
                event: { pluginId: 'acme.publisher', localId: 'changed' },
                priority: 10,
            }]],
        ]);
        const order: string[] = [];
        let current = true;
        const contextFor = (pluginId: string): PluginInvocationContext => ({
            contribution: { id: 'watch', qualifiedId: `${pluginId}/events/watch` },
        } as PluginInvocationContext); // Boundary fixture: handlers only read the asserted contribution identity.
        const binding = bindDeclaredEventSubscriptions({
            host: {
                broker,
                declarationsByPluginId,
                permissionDeclarationsByPluginId: new Map([
                    ['acme.first', [{ capability: 'events.plugin.subscribe', scope: 'acme.publisher', reason: 'test' }]],
                    ['acme.second', [{ capability: 'events.plugin.subscribe', scope: 'acme.publisher', reason: 'test' }]],
                ]),
                activePluginIds: new Set(['acme.publisher', 'acme.first', 'acme.second']),
            },
            registrations: [
                { pluginId: 'acme.second', pluginVersion: '1', generation: '7', localId: 'watch', handler: async () => { order.push('second'); } },
                { pluginId: 'acme.first', pluginVersion: '1', generation: '7', localId: 'watch', handler: async (_payload, context) => { order.push(context.contribution.qualifiedId); } },
            ],
            isGenerationCurrent: () => current,
            createContext: ({ pluginId }) => contextFor(pluginId),
        });
        const publisher = createPluginInvocationEventsService({
            seed: seed('acme.publisher'),
            broker,
            declarationsByPluginId,
            permissionDeclarationsByPluginId: new Map(),
            activePluginIds: new Set(['acme.publisher', 'acme.first', 'acme.second']),
        });

        await publisher.emit('changed', { accepted: false });
        await vi.waitFor(() => expect(order).toEqual(['second']));
        order.length = 0;
        await publisher.emit('changed', { accepted: true });
        await vi.waitFor(() => expect(order).toEqual(['acme.first/events/watch', 'second']));

        current = false;
        await publisher.emit('changed', { accepted: true });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(order).toEqual(['acme.first/events/watch', 'second']);
        await binding.dispose();
    });

    it('admits declared events with a subscriber snapshot and exact public method parity', async () => {
        const broker = createStablePluginEventsBroker();
        const publisher = services({ broker, pluginId: 'acme.publisher' });
        const subscriber = services({ broker, pluginId: 'acme.subscriber' });
        const delivered: unknown[] = [];
        const disposable = subscriber.subscribe(
            { pluginId: 'acme.publisher', localId: 'changed' },
            async (event) => { delivered.push(event); },
        );

        const result = await publisher.emit('changed', { revision: 1 });

        expect(Object.keys(publisher).sort()).toEqual(['emit', 'subscribe']);
        expect(result).toEqual({ status: 'admitted', sequence: 1, subscriberCount: 1 });
        await vi.waitFor(() => expect(delivered).toEqual([{
            ref: { pluginId: 'acme.publisher', localId: 'changed' },
            payload: { revision: 1 },
            sequence: 1,
        }]));
        expect(Object.isFrozen(disposable)).toBe(true);
        await disposable.dispose();
    });

    it('serializes slow and recursive delivery per subscription while isolating throwing listeners', async () => {
        const broker = createStablePluginEventsBroker();
        const publisher = services({ broker, pluginId: 'acme.publisher' });
        const subscriber = services({ broker, pluginId: 'acme.subscriber' });
        const order: number[] = [];
        subscriber.subscribe({ pluginId: 'acme.publisher', localId: 'changed' }, async (event) => {
            if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
                throw new Error('Expected an object event payload');
            }
            const revision = Reflect.get(event.payload, 'revision');
            if (typeof revision !== 'number') throw new Error('Expected a numeric revision');
            order.push(revision);
            if (revision === 1) await publisher.emit('changed', { revision: 2 });
        });
        subscriber.subscribe({ pluginId: 'acme.publisher', localId: 'changed' }, async () => {
            throw new Error('listener failed');
        });

        await publisher.emit('changed', { revision: 1 });

        await vi.waitFor(() => expect(order).toEqual([1, 2]));
    });

    it('fails closed for undeclared events, undeclared targets, missing rights, stale generations, and non-JSON payloads', async () => {
        const broker = createStablePluginEventsBroker();
        const publisherController = new AbortController();
        const publisher = services({ broker, pluginId: 'acme.publisher', controller: publisherController });
        const subscriber = services({ broker, pluginId: 'acme.subscriber' });

        await expect(publisher.emit('undeclared', null)).rejects.toMatchObject({ code: 'plugin_events_undeclared' });
        await expect(Reflect.apply(publisher.emit, publisher, [42, null])).rejects.toMatchObject({ code: 'plugin_events_invalid_ref' });
        expect(() => Reflect.apply(subscriber.subscribe, subscriber, [null, async () => {}]))
            .toThrowError(PluginError);
        expect(() => subscriber.subscribe(
            { pluginId: 'acme.publisher', localId: 'other' },
            async () => {},
        )).toThrowError(PluginError);
        expect(() => subscriber.subscribe(
            { pluginId: 'acme.subscriber', localId: 'missing' },
            async () => {},
        )).toThrowError(PluginError);
        expect(() => Reflect.apply(subscriber.subscribe, subscriber, [
            { pluginId: '@happier', localId: 'lifecycle/plugin/reload' },
            async () => {},
        ])).toThrowError(PluginError);
        await expect(Reflect.apply(publisher.emit, publisher, [
            '@happier/runtime/reload',
            null,
        ])).rejects.toMatchObject({ code: 'plugin_events_reserved' });
        expect(() => publisher.subscribe(
            { pluginId: 'acme.publisher', localId: 'changed' },
            async () => {},
        )).toThrowError(expect.objectContaining({ code: 'plugin_events_subscription_undeclared' }));
        const declaredSelfSubscriber = createPluginInvocationEventsService({
            seed: seed('acme.publisher'),
            broker,
            declarationsByPluginId: new Map([
                ['acme.publisher', [...publisherDeclarations, {
                    id: 'watch-own',
                    kind: 'subscription' as const,
                    event: { pluginId: 'acme.publisher', localId: 'changed' },
                }]],
            ]),
            permissionDeclarationsByPluginId: new Map(),
            activePluginIds: new Set(['acme.publisher']),
        });
        expect(() => declaredSelfSubscriber.subscribe(
            { pluginId: 'acme.publisher', localId: 'changed' },
            async () => {},
        )).not.toThrow();
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        await expect(Reflect.apply(publisher.emit, publisher, ['changed', cyclic])).rejects.toMatchObject({ code: 'plugin_events_invalid_payload' });
        await expect(Reflect.apply(publisher.emit, publisher, ['changed', Array(1)])).rejects.toMatchObject({ code: 'plugin_events_invalid_payload' });
        let deeplyNested: unknown = null;
        for (let depth = 0; depth < 100; depth += 1) {
            deeplyNested = { value: deeplyNested };
        }
        await expect(Reflect.apply(publisher.emit, publisher, ['changed', deeplyNested]))
            .rejects.toMatchObject({ code: 'plugin_events_invalid_payload' });
        publisherController.abort();
        await expect(publisher.emit('changed', null)).rejects.toMatchObject({ code: 'plugin_events_generation_retired' });
    });

    it('accepts repeated acyclic JSON references with canonical value semantics', async () => {
        const broker = createStablePluginEventsBroker();
        const publisher = services({ broker, pluginId: 'acme.publisher' });
        const subscriber = services({ broker, pluginId: 'acme.subscriber' });
        const delivered: unknown[] = [];
        subscriber.subscribe(
            { pluginId: 'acme.publisher', localId: 'changed' },
            async (event) => { delivered.push(event.payload); },
        );
        const shared = { revision: 1 };

        await publisher.emit('changed', { first: shared, second: shared });

        await vi.waitFor(() => expect(delivered).toEqual([{
            first: { revision: 1 },
            second: { revision: 1 },
        }]));
    });

    it('rejects accessors without invoking author getters', async () => {
        const publisher = services({ broker: createStablePluginEventsBroker(), pluginId: 'acme.publisher' });
        let getterCalls = 0;
        const accessor = Object.defineProperty({}, 'secret', {
            enumerable: true,
            get() {
                getterCalls += 1;
                return 'value';
            },
        });

        await expect(Reflect.apply(publisher.emit, publisher, ['changed', accessor]))
            .rejects.toMatchObject({ code: 'plugin_events_invalid_payload' });
        expect(getterCalls).toBe(0);
    });

    it('reserves canonical agent runtime event ids even when a manifest declares one', async () => {
        const publisher = services({ broker: createStablePluginEventsBroker(), pluginId: 'acme.publisher' });

        await expect(publisher.emit('turn-start', null))
            .rejects.toMatchObject({ code: 'plugin_events_reserved' });
        await expect(publisher.emit('input-accepted', null))
            .rejects.toMatchObject({ code: 'plugin_events_reserved' });
        expect(() => publisher.subscribe(
            { pluginId: 'acme.publisher', localId: 'turn-start' },
            async () => {},
        )).toThrowError(expect.objectContaining({ code: 'plugin_events_reserved' }));
    });

    it('auto-disposes subscriptions with the invocation generation', async () => {
        const broker = createStablePluginEventsBroker();
        const controller = new AbortController();
        const publisher = services({ broker, pluginId: 'acme.publisher' });
        const subscriber = services({ broker, pluginId: 'acme.subscriber', controller });
        const listener = vi.fn();
        subscriber.subscribe({ pluginId: 'acme.publisher', localId: 'changed' }, listener);

        controller.abort();
        const result = await publisher.emit('changed', null);

        expect(result).toEqual({ status: 'admitted', sequence: 1, subscriberCount: 0 });
        expect(listener).not.toHaveBeenCalled();
    });

    it('rejects a non-callable listener at the service boundary', () => {
        const subscriber = services({
            broker: createStablePluginEventsBroker(),
            pluginId: 'acme.subscriber',
        });

        expect(() => Reflect.apply(subscriber.subscribe, subscriber, [
            { pluginId: 'acme.publisher', localId: 'changed' },
            null,
        ])).toThrowError(expect.objectContaining({
            code: 'plugin_events_invalid_listener',
        }));
    });

    it('enforces the internal 256-delivery candidate and admits to all subscribers or none', async () => {
        const queueSamples: Array<{
            family: 'plugin-event-broker';
            queuedItems: number;
            queuedBytes: number;
            backpressured: boolean;
            sequence?: number;
        }> = [];
        const broker = createStablePluginEventsBroker({
            recordRuntimeLimitMeasurement: (sample) => {
                if (sample.family === 'plugin-event-broker') queueSamples.push(sample);
            },
        });
        const publisher = services({ broker, pluginId: 'acme.publisher' });
        const subscriber = services({ broker, pluginId: 'acme.subscriber' });
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => { release = resolve; });
        subscriber.subscribe({ pluginId: 'acme.publisher', localId: 'changed' }, async () => await blocked);
        for (let index = 0; index < 256; index += 1) {
            await expect(publisher.emit('changed', { index })).resolves.toMatchObject({ status: 'admitted' });
        }
        const lateListener = vi.fn();
        subscriber.subscribe({ pluginId: 'acme.publisher', localId: 'changed' }, lateListener);

        await expect(publisher.emit('changed', { index: 256 })).rejects.toMatchObject({
            code: 'plugin_event_backpressure',
        });
        expect(queueSamples.at(-2)).toMatchObject({
            family: 'plugin-event-broker',
            queuedItems: 256,
            backpressured: false,
            sequence: 256,
        });
        expect(queueSamples.at(-1)).toMatchObject({
            family: 'plugin-event-broker',
            queuedItems: 257,
            backpressured: true,
        });
        expect(lateListener).not.toHaveBeenCalled();
        release();
    });

    it('enforces the internal one-MiB encoded delivery candidate at exact and plus-one bytes', async () => {
        const ref: PluginContributionRef = { pluginId: 'acme.publisher', localId: 'changed' };
        const baseBytes = Buffer.byteLength(JSON.stringify({
            event: { ref, payload: '', sequence: 1 },
            identity: {
                pluginId: 'acme.publisher',
                pluginVersion: '1.0.0',
                contributionId: 'run',
                contributionQualifiedId: 'acme.publisher/actions/run',
                generation: '7',
                correlationId: 'acme.publisher-correlation',
                surface: 'cli',
            },
        }), 'utf8');
        const exactPayload = 'x'.repeat((1024 * 1024) - baseBytes);

        const exactSamples: Array<{ queuedBytes: number; backpressured: boolean }> = [];
        const exactBroker = createStablePluginEventsBroker({
            recordRuntimeLimitMeasurement: (sample) => {
                if (sample.family === 'plugin-event-broker') exactSamples.push(sample);
            },
        });
        const exactPublisher = services({ broker: exactBroker, pluginId: 'acme.publisher' });
        const exactSubscriber = services({ broker: exactBroker, pluginId: 'acme.subscriber' });
        exactSubscriber.subscribe(ref, async () => await new Promise<void>(() => {}));
        await expect(exactPublisher.emit('changed', exactPayload)).resolves.toMatchObject({ status: 'admitted' });
        expect(exactSamples.at(-1)).toMatchObject({
            queuedBytes: 1024 * 1024,
            backpressured: false,
        });

        const overflowSamples: Array<{ queuedBytes: number; backpressured: boolean }> = [];
        const overflowBroker = createStablePluginEventsBroker({
            recordRuntimeLimitMeasurement: (sample) => {
                if (sample.family === 'plugin-event-broker') overflowSamples.push(sample);
            },
        });
        const overflowPublisher = services({ broker: overflowBroker, pluginId: 'acme.publisher' });
        const overflowSubscriber = services({ broker: overflowBroker, pluginId: 'acme.subscriber' });
        overflowSubscriber.subscribe(ref, async () => {});
        await expect(overflowPublisher.emit('changed', `${exactPayload}x`)).rejects.toMatchObject({
            code: 'plugin_event_backpressure',
        });
        expect(overflowSamples.at(-1)).toMatchObject({
            queuedItems: 1,
            queuedBytes: (1024 * 1024) + 1,
            backpressured: true,
        });
    });

    it('admits an oversized event when there are no subscriber queues to allocate', async () => {
        const queueSamples: unknown[] = [];
        const publisher = services({
            broker: createStablePluginEventsBroker({
                recordRuntimeLimitMeasurement: (sample) => {
                    if (sample.family === 'plugin-event-broker') queueSamples.push(sample);
                },
            }),
            pluginId: 'acme.publisher',
        });

        await expect(publisher.emit('changed', 'x'.repeat(1024 * 1024)))
            .resolves.toEqual({ status: 'admitted', sequence: 1, subscriberCount: 0 });
        expect(queueSamples).toEqual([]);
    });
});
