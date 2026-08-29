import { describe, expect, expectTypeOf, it } from 'vitest';

import {
    createPluginEventAutomationSetupResultV1JsonSchema as canonicalCreatePluginEventAutomationSetupResultV1JsonSchema,
    PluginEventAutomationSetupResultV1Schema as canonicalPluginEventAutomationSetupResultV1Schema,
} from '@happier-dev/protocol/automations/event-setup-result';
import {
    PluginEventAutomationHistoryGapResetActionInputV1JsonSchema as canonicalPluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
    PluginEventAutomationHistoryGapResetActionInputV1Schema as canonicalPluginEventAutomationHistoryGapResetActionInputV1Schema,
    PluginEventAutomationHistoryGapResetActionResultV1JsonSchema as canonicalPluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
    PluginEventAutomationHistoryGapResetActionResultV1Schema as canonicalPluginEventAutomationHistoryGapResetActionResultV1Schema,
} from '@happier-dev/protocol/automations/event-history-gap-reset-action';
import type {
    PluginEventAutomationSetupResultV1 as CanonicalPluginEventAutomationSetupResultV1,
} from '@happier-dev/protocol/automations/event-setup-result';
import type {
    PluginEventAutomationHistoryGapResetActionInputV1 as CanonicalPluginEventAutomationHistoryGapResetActionInputV1,
    PluginEventAutomationHistoryGapResetActionResultV1 as CanonicalPluginEventAutomationHistoryGapResetActionResultV1,
} from '@happier-dev/protocol/automations/event-history-gap-reset-action';
import * as publicEvents from './events/index.js';
import type {
    EventSubscriptionTarget,
    EventsService,
    HostEventEnvelope,
    HostEventId,
    HostEventPayloadById,
    HostEventScopeById,
    HostEventTarget,
} from './events.js';
import type { EventSubscriptionTargetV1 } from '@happier-dev/protocol';
import type {
    AutomationRunStateChangedHostEventV1,
    HostEventEnvelope as ProtocolHostEventEnvelope,
    HostEventTarget as ProtocolHostEventTarget,
} from '@happier-dev/protocol';
import type {
    PluginEventAutomationHistoryGapResetActionInputV1,
    PluginEventAutomationHistoryGapResetActionResultV1,
    PluginEventAutomationSetupResultV1,
    PluginEventDispositionV1,
    PluginEventObservationV1,
    PluginEventSourceConnectionStatusV1,
} from './events/index.js';
import type { PluginInvocationContext } from './invocation.js';

function sourceDefinition(triggerId: string) {
    return {
        automationId: '11111111-1111-4111-8111-111111111111',
        triggerId,
        triggerRevision: 1,
        eventRef: { pluginId: 'com.example.events', localId: 'message-received' },
        sourceInstanceId: `source:${triggerId}`,
        sourceSelectorId: '22222222-2222-4222-8222-222222222222',
        sourceContractVersion: 1,
        sourceConfig: { v: 1 },
        observationTransport: {
            kind: 'checkpointedPull' as const,
            watcherMaterializationRef: {
                pluginId: 'com.example.events',
                machineId: 'machine-1',
                materializationId: 'materialization-1',
            },
        },
        filter: null,
        maximumObservationAgeMs: null,
    };
}

describe('EventsService contract', () => {
    it('keeps typed plugin and Host Event namespaces distinct', () => {
        expectTypeOf<keyof EventsService>().toEqualTypeOf<'plugin' | 'host'>();
        expectTypeOf<'@happier/runtime/turn-complete'>().toMatchTypeOf<HostEventId>();
        expectTypeOf<HostEventPayloadById['@happier/runtime/turn-complete']>()
            .toMatchTypeOf<Readonly<{ kind: 'turn-complete'; sessionId: string }>>();
        expectTypeOf<HostEventScopeById['@happier/runtime/turn-complete']>()
            .toEqualTypeOf<Readonly<{ kind: 'current-session' }> | Readonly<{ kind: 'session'; sessionId: string }>>();
        expectTypeOf<HostEventEnvelope<'@happier/runtime/turn-complete'>['payload']>()
            .toEqualTypeOf<HostEventPayloadById['@happier/runtime/turn-complete']>();
        expectTypeOf<HostEventEnvelope<'@happier/runtime/turn-complete'>['scope']>()
            .toEqualTypeOf<Readonly<{ kind: 'session'; sessionId: string }>>();
        expectTypeOf<'@happier/automation/run-state-changed'>().toMatchTypeOf<HostEventId>();
        expectTypeOf<HostEventScopeById['@happier/automation/run-state-changed']>()
            .toEqualTypeOf<Readonly<{ kind: 'account' }>>();
        expectTypeOf<HostEventEnvelope<'@happier/automation/run-state-changed'>['payload']>()
            .toEqualTypeOf<AutomationRunStateChangedHostEventV1>();
        expectTypeOf<HostEventEnvelope<'@happier/automation/run-state-changed'>['scope']>()
            .toEqualTypeOf<Readonly<{ kind: 'account' }>>();
        expectTypeOf<HostEventTarget>().toEqualTypeOf<ProtocolHostEventTarget>();
        expectTypeOf<HostEventEnvelope>().toEqualTypeOf<ProtocolHostEventEnvelope>();
        expectTypeOf<Readonly<{
            eventId: '@happier/runtime/turn-complete';
            scope: Readonly<{ kind: 'account' }>;
        }>>().not.toMatchTypeOf<HostEventTarget>();
        expect(true).toBe(true);
    });

    it('uses the exact Protocol subscription target shape', () => {
        expectTypeOf<EventSubscriptionTarget>().toEqualTypeOf<EventSubscriptionTargetV1>();
        expectTypeOf<EventSubscriptionTargetV1>().toEqualTypeOf<EventSubscriptionTarget>();
        expect(true).toBe(true);
    });

    it('projects the canonical Automation source setup result through the public Event surface', () => {
        expect(publicEvents.PluginEventAutomationSetupResultV1Schema)
            .toBe(canonicalPluginEventAutomationSetupResultV1Schema);
        expect(publicEvents.createPluginEventAutomationSetupResultV1JsonSchema)
            .toBe(canonicalCreatePluginEventAutomationSetupResultV1JsonSchema);
        expectTypeOf<PluginEventAutomationSetupResultV1>()
            .toEqualTypeOf<CanonicalPluginEventAutomationSetupResultV1>();
    });

    it('exposes one provider-neutral checkpointed Event admission bridge', () => {
        expect(publicEvents.admitCheckpointedPluginEventObservationV1).toBeTypeOf('function');
        expectTypeOf<Parameters<typeof publicEvents.admitCheckpointedPluginEventObservationV1>[0]>()
            .toEqualTypeOf<PluginEventObservationV1>();
        expectTypeOf<Awaited<ReturnType<typeof publicEvents.admitCheckpointedPluginEventObservationV1>>>()
            .toEqualTypeOf<PluginEventDispositionV1>();
    });

    it('exposes the truthful session-socket Event admission bridge with the same observation contract', () => {
        expect(publicEvents.admitSessionSocketPluginEventObservationV1).toBeTypeOf('function');
        expectTypeOf<Parameters<typeof publicEvents.admitSessionSocketPluginEventObservationV1>[0]>()
            .toEqualTypeOf<PluginEventObservationV1>();
        expectTypeOf<Awaited<ReturnType<typeof publicEvents.admitSessionSocketPluginEventObservationV1>>>()
            .toEqualTypeOf<PluginEventDispositionV1>();
    });

    it('projects idle connection readiness and history gaps through the same complete source scan and status owner', async () => {
        const reports: unknown[] = [];
        const context = {
            signal: new AbortController().signal,
            services: {
                actions: {
                    execute: async (actionId: string, input: unknown) => {
                        if (actionId === 'automation.event.sources.list') {
                            return {
                                kind: 'page',
                                revision: '7',
                                definitions: [
                                    {
                                        automationId: '11111111-1111-4111-8111-111111111111',
                                        triggerId: 'trigger-1',
                                        triggerRevision: 2,
                                        eventRef: { pluginId: 'com.example.channels', localId: 'message' },
                                        sourceInstanceId: 'provider:connection:one:source:one',
                                        sourceSelectorId: '22222222-2222-4222-8222-222222222222',
                                        sourceContractVersion: 1,
                                        sourceConfig: { v: 1 },
                                        observationTransport: {
                                            kind: 'socket',
                                            watcherMaterializationRef: {
                                                pluginId: 'com.example.channels',
                                                machineId: 'machine-1',
                                                materializationId: 'materialization-1',
                                            },
                                        },
                                        filter: null,
                                        maximumObservationAgeMs: null,
                                    },
                                    {
                                        automationId: '33333333-3333-4333-8333-333333333333',
                                        triggerId: 'trigger-2',
                                        triggerRevision: 3,
                                        eventRef: { pluginId: 'com.example.channels', localId: 'message' },
                                        sourceInstanceId: 'provider:connection:two:source:two',
                                        sourceSelectorId: '44444444-4444-4444-8444-444444444444',
                                        sourceContractVersion: 1,
                                        sourceConfig: { v: 1 },
                                        observationTransport: {
                                            kind: 'socket',
                                            watcherMaterializationRef: {
                                                pluginId: 'com.example.channels',
                                                machineId: 'machine-1',
                                                materializationId: 'materialization-1',
                                            },
                                        },
                                        filter: null,
                                        maximumObservationAgeMs: null,
                                    },
                                ],
                                nextCursor: null,
                            };
                        }
                        if (actionId === 'automation.event.source.status.report') {
                            reports.push(input);
                            return {};
                        }
                        throw new Error(`unexpected Action ${actionId}`);
                    },
                },
            },
        } as unknown as PluginInvocationContext;

        const input = {
            eventRef: { pluginId: 'com.example.channels', localId: 'message' },
            sourceContractVersion: 1,
            sourceInstanceIdPrefix: 'provider:connection:one:',
            scope: { kind: 'socket' as const },
        };

        await publicEvents.projectPluginEventSourceConnectionStatusV1({
            ...input,
            status: 'ready',
        }, context);
        await publicEvents.projectPluginEventSourceConnectionStatusV1({
            ...input,
            status: 'historyGap',
        }, context);

        expectTypeOf<PluginEventSourceConnectionStatusV1>()
            .toEqualTypeOf<'ready' | 'reconnecting' | 'historyGap'>();
        expect(reports).toEqual([
            {
                kind: 'catalogReconciliation',
                scope: { kind: 'socket' },
                observedRevision: '7',
                adoptedRevision: '7',
                state: 'current',
                scanStartedAt: null,
                nextRetryAt: null,
            },
            expect.objectContaining({
                kind: 'source',
                triggerId: 'trigger-1',
                state: 'observing',
                code: 'none',
                observedDelta: 0,
                admittedDelta: 0,
                skippedDelta: 0,
            }),
            {
                kind: 'catalogReconciliation',
                scope: { kind: 'socket' },
                observedRevision: '7',
                adoptedRevision: '7',
                state: 'current',
                scanStartedAt: null,
                nextRetryAt: null,
            },
            expect.objectContaining({
                kind: 'source',
                triggerId: 'trigger-1',
                state: 'attention',
                code: 'historyGap',
                observedDelta: 0,
                admittedDelta: 0,
                skippedDelta: 0,
            }),
        ]);
        for (const report of reports.filter((candidate) => (
            typeof candidate === 'object'
            && candidate !== null
            && 'kind' in candidate
            && candidate.kind === 'source'
        ))) {
            expect(report).not.toHaveProperty('lastObservedAt');
            expect(report).not.toHaveProperty('lastDispositionAt');
        }
    });

    it('rejects an empty source-list continuation before following its cursor', async () => {
        const actionIds: string[] = [];
        const context = {
            signal: new AbortController().signal,
            services: {
                actions: {
                    execute: async (actionId: string) => {
                        actionIds.push(actionId);
                        if (actionId === 'automation.event.sources.list') {
                            return {
                                kind: 'page',
                                revision: '7',
                                definitions: [],
                                nextCursor: 'page-2',
                            };
                        }
                        throw new Error(`unexpected Action ${actionId}`);
                    },
                },
            },
        } as unknown as PluginInvocationContext;

        await expect(publicEvents.admitCheckpointedPluginEventObservationV1({
            eventRef: { pluginId: 'com.example.events', localId: 'message-received' },
            sourceInstanceId: 'source-1',
            sourceContractVersion: 1,
            occurrenceId: 'occurrence-1',
            occurredAt: 1,
            observationReceivedAt: 1,
            observedDelta: 1,
            payload: {},
        }, context)).resolves.toEqual({ kind: 'unsettled' });
        expect(actionIds).toEqual(['automation.event.sources.list']);
    });

    it.each([
        ['an empty continuation', [
            { kind: 'page', revision: '7', definitions: [], nextCursor: 'page-2' },
        ]],
        ['a revision-drifting continuation', [
            {
                kind: 'page',
                revision: '7',
                definitions: [sourceDefinition('trigger-1')],
                nextCursor: 'page-2',
            },
            {
                kind: 'page',
                revision: '8',
                definitions: [sourceDefinition('trigger-2')],
                nextCursor: null,
            },
        ]],
        ['a repeated continuation cursor', [
            {
                kind: 'page',
                revision: '7',
                definitions: [sourceDefinition('trigger-1')],
                nextCursor: 'page-2',
            },
            {
                kind: 'page',
                revision: '7',
                definitions: [sourceDefinition('trigger-2')],
                nextCursor: 'page-2',
            },
        ]],
    ])('publishes no connection status for %s', async (_name, pages) => {
        const reports: unknown[] = [];
        let pageIndex = 0;
        const context = {
            signal: new AbortController().signal,
            services: {
                actions: {
                    execute: async (actionId: string, input: unknown) => {
                        if (actionId === 'automation.event.sources.list') {
                            const page = pages[pageIndex++];
                            if (page === undefined) throw new Error('unexpected additional source-list page');
                            return page;
                        }
                        if (actionId === 'automation.event.source.status.report') {
                            reports.push(input);
                            return {};
                        }
                        throw new Error(`unexpected Action ${actionId}`);
                    },
                },
            },
        } as unknown as PluginInvocationContext;

        await publicEvents.projectPluginEventSourceConnectionStatusV1({
            eventRef: { pluginId: 'com.example.events', localId: 'message-received' },
            sourceContractVersion: 1,
            sourceInstanceIdPrefix: 'source:',
            scope: { kind: 'checkpointedPull' },
            status: 'ready',
        }, context);

        expect(reports).toEqual([]);
    });

    it('admits the source list through the canonical Protocol result schema before catalog side effects', async () => {
        const actionIds: string[] = [];
        const context = {
            signal: new AbortController().signal,
            services: {
                actions: {
                    execute: async (actionId: string) => {
                        actionIds.push(actionId);
                        if (actionId === 'automation.event.sources.list') {
                            return {
                                kind: 'page',
                                revision: '7',
                                definitions: [],
                                nextCursor: null,
                                unexpected: true,
                            };
                        }
                        throw new Error(`unexpected Action ${actionId}`);
                    },
                },
            },
        } as unknown as PluginInvocationContext;

        await expect(publicEvents.admitCheckpointedPluginEventObservationV1({
            eventRef: { pluginId: 'com.example.events', localId: 'message-received' },
            sourceInstanceId: 'source-1',
            sourceContractVersion: 1,
            occurrenceId: 'occurrence-1',
            occurredAt: 1,
            observationReceivedAt: 1,
            observedDelta: 1,
            payload: {},
        }, context)).resolves.toEqual({ kind: 'unsettled' });
        expect(actionIds).toEqual(['automation.event.sources.list']);
    });
    it('projects the canonical host-filled history-gap recovery Action contract through the public Event surface', () => {
        expect(publicEvents.PluginEventAutomationHistoryGapResetActionInputV1JsonSchema)
            .toBe(canonicalPluginEventAutomationHistoryGapResetActionInputV1JsonSchema);
        expect(publicEvents.PluginEventAutomationHistoryGapResetActionInputV1Schema)
            .toBe(canonicalPluginEventAutomationHistoryGapResetActionInputV1Schema);
        expect(publicEvents.PluginEventAutomationHistoryGapResetActionResultV1JsonSchema)
            .toBe(canonicalPluginEventAutomationHistoryGapResetActionResultV1JsonSchema);
        expect(publicEvents.PluginEventAutomationHistoryGapResetActionResultV1Schema)
            .toBe(canonicalPluginEventAutomationHistoryGapResetActionResultV1Schema);
        expectTypeOf<PluginEventAutomationHistoryGapResetActionInputV1>()
            .toEqualTypeOf<CanonicalPluginEventAutomationHistoryGapResetActionInputV1>();
        expectTypeOf<PluginEventAutomationHistoryGapResetActionResultV1>()
            .toEqualTypeOf<CanonicalPluginEventAutomationHistoryGapResetActionResultV1>();
    });
});
