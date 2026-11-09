import { describe, expect, it, vi } from 'vitest';

import {
    AutomationRunStateChangedHostEventV1Schema,
    AutomationRunCauseSchema,
    type ParsedPluginEventContributionV1,
} from '@happier-dev/protocol';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { type PluginContributionRef } from '@happier-dev/plugin-sdk';

import type { PluginInvocationServicesSeed } from './types';
import { resolvePluginActionCaller } from './actionCaller';
import {
    bindDeclaredEventSubscriptions,
    createStablePluginEventsBroker,
    createPluginInvocationHostEventsService,
    createPluginInvocationPluginEventsService,
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
        occurrenceId: '7',
        correlationId: `${pluginId}-correlation`,
        surface: 'cli',
        signal: controller.signal,
        isOccurrenceCurrent: () => !controller.signal.aborted,
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
    it('binds an active subscriber before its declared publisher activates without granting cold emission authority', async () => {
        const broker = createStablePluginEventsBroker();
        const activePluginIds = new Set(['acme.subscriber']);
        const host = { broker, activePluginIds, declarationsByPluginId: new Map([
            ['acme.publisher', publisherDeclarations], ['acme.subscriber', subscriberDeclarations],
        ]) };
        const publisher = createPluginInvocationPluginEventsService({ ...host, seed: seed('acme.publisher') });
        const subscriber = createPluginInvocationPluginEventsService({ ...host, seed: seed('acme.subscriber') });
        const received: unknown[] = [];
        const binding = subscriber.subscribe({ pluginId: 'acme.publisher', localId: 'changed' }, event => { received.push(event.payload); });
        try {
            await expect(publisher.emit('changed', { value: 1 })).rejects.toMatchObject({ code: 'plugin_events_generation_retired' });
            activePluginIds.add('acme.publisher');
            await publisher.emit('changed', { value: 2 });
            await vi.waitFor(() => expect(received).toEqual([{ value: 2 }]));
        } finally {
            binding.dispose();
        }
    });
    it('delivers the Account Discussion invalidation through the public SDK Host Events service and retires it with the occurrence', async () => {
        const broker = createStablePluginEventsBroker();
        const controller = new AbortController();
        const service = createPluginInvocationHostEventsService({ seed: seed('acme.subscriber', controller), broker });
        const events: unknown[] = [];
        const subscription = service.subscribe({ eventId: '@happier/session/discussion-invalidated', scope: { kind: 'account' } },
            event => { events.push(event); });
        broker.publishHostEventEnvelope({ eventId: '@happier/session/discussion-invalidated', scope: { kind: 'account' },
            payload: { discussionId: 'discussion-a', revision: 9 } });
        await vi.waitFor(() => expect(events).toHaveLength(1));
        expect(events).toEqual([{ eventId: '@happier/session/discussion-invalidated', scope: { kind: 'account' },
            payload: { discussionId: 'discussion-a', revision: 9 } }]);
        broker.publishHostEventEnvelope({ eventId: '@happier/automation/event-sources-invalidated', scope: { kind: 'account' }, payload: {} });
        expect(events).toHaveLength(1);
        controller.abort();
        broker.publishHostEventEnvelope({ eventId: '@happier/session/discussion-invalidated', scope: { kind: 'account' },
            payload: { discussionId: 'discussion-a', revision: 10 } });
        expect(events).toHaveLength(1);
        subscription.dispose();
    });
    it('carries host event origin into nested Actions without trusting payload claims or leaking it to later events', async () => {
        const broker = createStablePluginEventsBroker();
        const declarationsByPluginId = new Map([
            ['acme.publisher', publisherDeclarations], ['acme.subscriber', subscriberDeclarations],
        ]);
        const host = { broker, declarationsByPluginId, activePluginIds: new Set(['acme.publisher', 'acme.subscriber']) };
        const origin = { kind: 'automationRun' as const, runId: 'host-origin', automationId: 'automation',
            cause: AutomationRunCauseSchema.parse({ kind: 'manual', invokedAt: 1 }) };
        const publisher = createPluginInvocationPluginEventsService({ ...host,
            seed: { ...seed('acme.publisher'), initiatingActionCaller: origin } });
        const independent = createPluginInvocationPluginEventsService({ ...host, seed: seed('acme.publisher') });
        const subscriberSeed = seed('acme.subscriber');
        const subscriber = createPluginInvocationPluginEventsService({ ...host, seed: subscriberSeed });
        const callers: unknown[] = [];
        const subscription = subscriber.subscribe({ pluginId: 'acme.publisher', localId: 'changed' }, () => {
            callers.push(resolvePluginActionCaller(subscriberSeed)?.initiatingCaller);
        });
        await publisher.emit('changed', { originRunId: 'payload-is-not-provenance' });
        await independent.emit('changed', { originRunId: 'host-origin' });
        await vi.waitFor(() => expect(callers).toHaveLength(2));
        expect(callers).toEqual([origin, undefined]);
        expect(resolvePluginActionCaller(subscriberSeed)?.initiatingCaller).toBeUndefined();
        subscription.dispose();
    });
    it('binds declared subscription registrations with schema filtering, priority order, and occurrenceId disposal', async () => {
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
                { pluginId: 'acme.second', pluginVersion: '1', occurrenceId: '7', localId: 'watch', handler: async () => { order.push('second'); } },
                { pluginId: 'acme.first', pluginVersion: '1', occurrenceId: '7', localId: 'watch', handler: async (_payload, context) => { order.push(context.contribution.qualifiedId); } },
            ],
            isOccurrenceCurrent: () => current,
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

    it('binds a static Host Event handler through the same broker and occurrenceId lifecycle', async () => {
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
                occurrenceId: '7',
                localId: 'watch-turn',
                handler,
            }],
            isOccurrenceCurrent: () => current,
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

    it('auto-disposes subscriptions with the invocation occurrenceId', async () => {
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

    it('delivers a burst beyond the old queue count to every current subscriber in order', async () => {
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
        const received: unknown[] = [];
        const slow = subscriber.subscribe({ pluginId: 'acme.publisher', localId: 'changed' }, async event => {
            await blocked;
            received.push(event.payload);
        });
        const peer = vi.fn();
        const fast = subscriber.subscribe({ pluginId: 'acme.publisher', localId: 'changed' }, peer);
        try {
            for (let index = 0; index < 300; index += 1) {
                await expect(publisher.emit('changed', { index })).resolves.toMatchObject({ status: 'admitted', sequence: index + 1, subscriberCount: 2 });
            }
            expect(queueSamples.at(-1)).toMatchObject({ queuedItems: 300, backpressured: false });
            release();
            await vi.waitFor(() => expect(received).toHaveLength(300));
            expect(received).toEqual(Array.from({ length: 300 }, (_, index) => ({ index })));
            expect(peer.mock.calls.map(([event]) => event.payload)).toEqual(received);
        } finally { release(); slow.dispose(); fast.dispose(); }
    });

    it('delivers a valid payload beyond the old encoded byte ceiling without truncation', async () => {
        const ref: PluginContributionRef = { pluginId: 'acme.publisher', localId: 'changed' };
        const baseBytes = Buffer.byteLength(JSON.stringify({
            event: { ref, payload: '', sequence: 1 },
            identity: {
                pluginId: 'acme.publisher',
                pluginVersion: '1.0.0',
                contributionId: 'run',
                contributionQualifiedId: 'acme.publisher/actions/run',
                occurrenceId: '7',
                correlationId: 'acme.publisher-correlation',
                surface: 'cli',
            },
        }), 'utf8');
        const exactPayload = 'x'.repeat((1024 * 1024) - baseBytes);

        const overflowSamples: Array<{ queuedBytes: number; backpressured: boolean }> = [];
        const overflowBroker = createStablePluginEventsBroker({
            recordRuntimeLimitMeasurement: (sample) => {
                if (sample.family === 'plugin-event-broker') overflowSamples.push(sample);
            },
        });
        const overflowPublisher = services({ broker: overflowBroker, pluginId: 'acme.publisher' });
        const overflowSubscriber = services({ broker: overflowBroker, pluginId: 'acme.subscriber' });
        const listener = vi.fn();
        const subscription = overflowSubscriber.subscribe(ref, listener);
        await expect(overflowPublisher.emit('changed', `${exactPayload}x`)).resolves.toMatchObject({ status: 'admitted' });
        await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
        expect(listener.mock.calls[0]?.[0].payload.length).toBe(exactPayload.length + 1);
        expect(overflowSamples.at(-1)).toMatchObject({
            queuedItems: 1,
            queuedBytes: (1024 * 1024) + 1,
            backpressured: false,
        });
        subscription.dispose();
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
        const payload = AutomationRunStateChangedHostEventV1Schema.parse({
            runId: 'run-1',
            automationId: 'automation-1',
            runCause: {
                kind: 'trigger',
                triggerId: 'trigger-schedule-1',
                triggerRevision: 1,
                triggerKind: 'schedule',
                occurrenceKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
                occurredAt: 1,
                evidence: { scheduledFor: 1 },
            },
            previousState: null,
            currentState: 'queued',
            transitionedAt: 1,
            claimedByMachineId: null,
        });

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

    it('binds dynamic Host Event subscriptions to invocation session and occurrenceId lifetime', async () => {
        const broker = createStablePluginEventsBroker();
        const controller = new AbortController();
        let generationCurrent = true;
        const host = createPluginInvocationHostEventsService({
            broker,
            seed: Object.freeze({
                ...seed('acme.subscriber', controller),
                session: Object.freeze({ id: 'session-1' }),
                isOccurrenceCurrent: () => generationCurrent,
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

    it('delivers a host-event burst, isolates listener failure, and stops after retirement or disposal', async () => {
        const failed = vi.fn();
        const broker = createStablePluginEventsBroker({
            onHostListenerError: failed,
        });
        let current = true;
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => { release = resolve; });
        const subscription = broker.subscribeHost({
            target: { eventId: '@happier/runtime/turn-complete', scope: { kind: 'session', sessionId: 'session-1' } },
            listener: async () => { await blocked; delivered += 1; },
            isCurrent: () => current,
        });
        let delivered = 0;
        const event = {
            sequence: 1,
            sessionId: 'session-1',
            emittedAtMs: 2,
            kind: 'turn-complete',
            turnId: 'turn-1',
        } as const;
        for (let index = 0; index < 300; index += 1) {
            expect(() => broker.publishHostEvent({ ...event, sequence: index + 1 })).not.toThrow();
        }
        release();
        await vi.waitFor(() => expect(delivered).toBe(300));
        current = false;
        broker.publishHostEvent({ ...event, sequence: 258 });
        expect(delivered).toBe(300);
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
