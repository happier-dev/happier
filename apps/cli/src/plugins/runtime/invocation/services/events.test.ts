import { describe, expect, it, vi } from 'vitest';

import type { ParsedPluginEventContributionV1 } from '@happier-dev/protocol';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { type PluginContributionRef } from '@happier-dev/plugin-sdk';

import type { PluginInvocationServicesSeed } from './types';
import {
    bindDeclaredEventSubscriptions,
    createStablePluginEventsBroker,
    createPluginInvocationHostEventsService,
    createPluginInvocationPluginEventsService,
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
        target: Object.freeze({ kind: 'plugin', event: Object.freeze({ pluginId: 'acme.publisher', localId: 'changed' }) }),
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
    return createPluginInvocationPluginEventsService({
        seed: seed(params.pluginId, params.controller),
        broker: params.broker,
        declarationsByPluginId,
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
                target: { kind: 'plugin', event: { pluginId: 'acme.publisher', localId: 'changed' } },
                filterSchema: { type: 'object', properties: { accepted: { const: true } }, required: ['accepted'] },
                priority: -10,
            }]],
            ['acme.second', [{
                id: 'watch',
                kind: 'subscription',
                target: { kind: 'plugin', event: { pluginId: 'acme.publisher', localId: 'changed' } },
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
                activePluginIds: new Set(['acme.publisher', 'acme.first', 'acme.second']),
            },
            registrations: [
                { pluginId: 'acme.second', pluginVersion: '1', generation: '7', localId: 'watch', handler: async () => { order.push('second'); } },
                { pluginId: 'acme.first', pluginVersion: '1', generation: '7', localId: 'watch', handler: async (_payload, context) => { order.push(context.contribution.qualifiedId); } },
            ],
            isGenerationCurrent: () => current,
            createContext: ({ pluginId }) => Object.freeze({
                context: contextFor(pluginId),
                complete() {},
            }),
        });
        const publisher = createPluginInvocationPluginEventsService({
            seed: seed('acme.publisher'),
            broker,
            declarationsByPluginId,
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

    it('binds a static Host Event handler through the same broker and generation lifecycle', async () => {
        const broker = createStablePluginEventsBroker();
        const handler = vi.fn();
        let current = true;
        const binding = bindDeclaredEventSubscriptions({
            host: {
                broker,
                declarationsByPluginId: new Map([['acme.subscriber', [{
                    id: 'watch-turn',
                    kind: 'subscription',
                    target: {
                        kind: 'host',
                        eventId: '@happier/runtime/turn-complete',
                        scope: { kind: 'current-session' },
                    },
                }]]]),
                activePluginIds: new Set(['acme.subscriber']),
            },
            registrations: [{
                pluginId: 'acme.subscriber',
                pluginVersion: '1',
                generation: '7',
                localId: 'watch-turn',
                handler,
            }],
            isGenerationCurrent: () => current,
            createContext: (input) => {
                expect(input.sessionId).toBe('session-1');
                return Object.freeze({
                    context: {} as PluginInvocationContext,
                    complete() {},
                });
            },
        });
        const payload = {
            sequence: 1,
            sessionId: 'session-1',
            emittedAtMs: 2,
            kind: 'turn-complete',
            turnId: 'turn-1',
        } as const;
        broker.publishHostEvent(payload);
        await vi.waitFor(() => expect(handler).toHaveBeenCalledWith(payload, expect.anything()));
        current = false;
        broker.publishHostEvent({ ...payload, sequence: 2 });
        await binding.dispose();
        expect(handler).toHaveBeenCalledOnce();
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
        const declaredSelfSubscriber = createPluginInvocationPluginEventsService({
            seed: seed('acme.publisher'),
            broker,
            declarationsByPluginId: new Map([
                ['acme.publisher', [...publisherDeclarations, {
                    id: 'watch-own',
                    kind: 'subscription' as const,
                    target: { kind: 'plugin', event: { pluginId: 'acme.publisher', localId: 'changed' } },
                }]],
            ]),
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
            .resolves.toMatchObject({ status: 'admitted', subscriberCount: 1 });
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

    it('rejects subscriptions that retire while their broker registration is being established', () => {
        const pluginController = new AbortController();
        const pluginBroker = createStablePluginEventsBroker();
        const pluginRaceBroker = Object.freeze({
            ...pluginBroker,
            subscribe(input: Parameters<typeof pluginBroker.subscribe>[0]) {
                const subscription = pluginBroker.subscribe(input);
                pluginController.abort();
                return subscription;
            },
        });
        const pluginSubscriber = createPluginInvocationPluginEventsService({
            seed: seed('acme.subscriber', pluginController),
            broker: pluginRaceBroker,
            declarationsByPluginId: new Map([
                ['acme.publisher', publisherDeclarations],
                ['acme.subscriber', subscriberDeclarations],
            ]),
            activePluginIds: new Set(['acme.publisher', 'acme.subscriber']),
        });

        expect(() => pluginSubscriber.subscribe(
            { pluginId: 'acme.publisher', localId: 'changed' },
            async () => {},
        )).toThrowError(expect.objectContaining({ code: 'plugin_events_generation_retired' }));

        const hostController = new AbortController();
        const hostBroker = createStablePluginEventsBroker();
        const hostRaceBroker = Object.freeze({
            ...hostBroker,
            subscribeHost(input: Parameters<typeof hostBroker.subscribeHost>[0]) {
                const subscription = hostBroker.subscribeHost(input);
                hostController.abort();
                return subscription;
            },
        });
        const hostEvents = createPluginInvocationHostEventsService({
            seed: Object.freeze({
                ...seed('acme.subscriber', hostController),
                session: Object.freeze({ id: 'session-1' }),
            }),
            broker: hostRaceBroker,
        });

        expect(() => hostEvents.subscribe({
            eventId: '@happier/runtime/turn-complete',
            scope: { kind: 'current-session' },
        }, async () => {})).toThrowError(
            expect.objectContaining({ code: 'plugin_events_generation_retired' }),
        );
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

    it('routes Host Events by current and explicit session without awaiting listeners', async () => {
        const broker = createStablePluginEventsBroker();
        const current = vi.fn();
        const explicit = vi.fn();
        broker.subscribeHost({
            target: { eventId: '@happier/runtime/turn-complete', scope: { kind: 'current-session' } },
            currentSessionId: 'session-1',
            listener: current,
            isCurrent: () => true,
        });
        broker.subscribeHost({
            target: { eventId: '@happier/runtime/turn-complete', scope: { kind: 'session', sessionId: 'session-2' } },
            listener: explicit,
            isCurrent: () => true,
        });

        expect(() => broker.publishHostEvent({
            sequence: 1,
            sessionId: 'session-1',
            emittedAtMs: 2,
            kind: 'turn-complete',
            turnId: 'turn-1',
        })).not.toThrow();
        await vi.waitFor(() => expect(current).toHaveBeenCalledOnce());
        expect(explicit).not.toHaveBeenCalled();
        expect(current).toHaveBeenCalledWith(expect.objectContaining({
            eventId: '@happier/runtime/turn-complete',
            scope: { kind: 'session', sessionId: 'session-1' },
        }));
    });

    it('routes a server-stamped Account lifecycle envelope only to Account-scoped observers', async () => {
        const broker = createStablePluginEventsBroker();
        const accountObserver = vi.fn();
        const runtimeObserver = vi.fn();
        broker.subscribeHost({
            target: {
                eventId: '@happier/automation/run-state-changed',
                scope: { kind: 'account' },
            },
            listener: accountObserver,
            isCurrent: () => true,
        });
        broker.subscribeHost({
            target: {
                eventId: '@happier/runtime/turn-complete',
                scope: { kind: 'session', sessionId: 'session-1' },
            },
            listener: runtimeObserver,
            isCurrent: () => true,
        });
        const payload = {
            runId: 'run-1',
            automationId: 'automation-1',
            originKind: 'scheduled',
            previousState: null,
            currentState: 'queued',
            transitionedAt: 1,
            claimedByMachineId: null,
        } as const;

        broker.publishHostEventEnvelope({
            eventId: '@happier/automation/run-state-changed',
            scope: { kind: 'account' },
            payload,
        });

        await vi.waitFor(() => expect(accountObserver).toHaveBeenCalledWith({
            eventId: '@happier/automation/run-state-changed',
            scope: { kind: 'account' },
            payload,
        }));
        expect(runtimeObserver).not.toHaveBeenCalled();
    });

    it('binds dynamic Host Event subscriptions to invocation session and generation lifetime', async () => {
        const broker = createStablePluginEventsBroker();
        const controller = new AbortController();
        let generationCurrent = true;
        const host = createPluginInvocationHostEventsService({
            broker,
            seed: Object.freeze({
                ...seed('acme.subscriber', controller),
                session: Object.freeze({ id: 'session-1' }),
                isGenerationCurrent: () => generationCurrent,
            }),
        });
        const listener = vi.fn();
        const disposable = host.subscribe({
            eventId: '@happier/runtime/context-compaction',
            scope: { kind: 'current-session' },
        }, listener);
        broker.publishHostEvent({
            sequence: 1,
            sessionId: 'session-1',
            emittedAtMs: 2,
            kind: 'context-compaction',
            compactionId: 'compact-1',
            phase: 'progress',
            trigger: 'manual',
        });
        await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());

        generationCurrent = false;
        broker.publishHostEvent({
            sequence: 2,
            sessionId: 'session-1',
            emittedAtMs: 3,
            kind: 'context-compaction',
            compactionId: 'compact-1',
            phase: 'completed',
            trigger: 'manual',
        });
        await disposable.dispose();
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(listener).toHaveBeenCalledOnce();
    });

    it('rejects current-session subscriptions without an invocation session', () => {
        const host = createPluginInvocationHostEventsService({
            broker: createStablePluginEventsBroker(),
            seed: seed('acme.subscriber'),
        });
        expect(() => host.subscribe({
            eventId: '@happier/runtime/turn-complete',
            scope: { kind: 'current-session' },
        }, () => {})).toThrowError(expect.objectContaining({
            code: 'plugin_host_events_current_session_unavailable',
        }));
    });

    it('drops bounded Host Event overflow, isolates listener failure, and stops after retirement or disposal', async () => {
        const dropped = vi.fn();
        const failed = vi.fn();
        const broker = createStablePluginEventsBroker({
            onHostDeliveryDropped: dropped,
            onHostListenerError: failed,
        });
        let current = true;
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => { release = resolve; });
        const subscription = broker.subscribeHost({
            target: { eventId: '@happier/runtime/turn-complete', scope: { kind: 'session', sessionId: 'session-1' } },
            listener: async () => await blocked,
            isCurrent: () => current,
        });
        const event = {
            sequence: 1,
            sessionId: 'session-1',
            emittedAtMs: 2,
            kind: 'turn-complete',
            turnId: 'turn-1',
        } as const;
        for (let index = 0; index < STABLE_PLUGIN_EVENT_QUEUE_LIMITS.pendingDeliveriesPerSubscription; index += 1) {
            expect(() => broker.publishHostEvent({ ...event, sequence: index + 1 })).not.toThrow();
        }
        expect(() => broker.publishHostEvent({ ...event, sequence: 257 })).not.toThrow();
        expect(dropped).toHaveBeenCalledWith({
            eventId: '@happier/runtime/turn-complete',
            reason: 'delivery_limit',
        });
        release();
        current = false;
        broker.publishHostEvent({ ...event, sequence: 258 });
        await subscription.dispose();

        const throwing = broker.subscribeHost({
            target: { eventId: '@happier/runtime/turn-complete', scope: { kind: 'session', sessionId: 'session-1' } },
            listener: async () => { throw new Error('listener failed'); },
            isCurrent: () => true,
        });
        broker.publishHostEvent({ ...event, sequence: 259 });
        await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
        await throwing.dispose();
        broker.publishHostEvent({ ...event, sequence: 260 });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(failed).toHaveBeenCalledOnce();
    });
});
