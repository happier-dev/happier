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
    CheckpointedPluginEventDispositionV1,
    CheckpointedPluginEventObservationV1,
    PluginEventAutomationHistoryGapResetActionInputV1,
    PluginEventAutomationHistoryGapResetActionResultV1,
    PluginEventAutomationSetupResultV1,
} from './events/index.js';

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
            .toEqualTypeOf<CheckpointedPluginEventObservationV1>();
        expectTypeOf<Awaited<ReturnType<typeof publicEvents.admitCheckpointedPluginEventObservationV1>>>()
            .toEqualTypeOf<CheckpointedPluginEventDispositionV1>();
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
