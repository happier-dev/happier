import type {
    HostEventEnvelope as ProtocolHostEventEnvelope,
    HostEventId as ProtocolHostEventId,
    HostEventPayloadById as ProtocolHostEventPayloadById,
    HostEventScope as ProtocolHostEventScope,
    HostEventScopeById as ProtocolHostEventScopeById,
    HostEventTarget as ProtocolHostEventTarget,
    EventSubscriptionTargetV1 as ProtocolEventSubscriptionTargetV1,
} from '@happier-dev/protocol';

import {
    createPluginEventAutomationSetupResultV1JsonSchema as canonicalCreatePluginEventAutomationSetupResultV1JsonSchema,
    PluginEventAutomationSetupResultV1Schema as canonicalPluginEventAutomationSetupResultV1Schema,
} from '@happier-dev/protocol/automations/event-setup-result';
import type {
    PluginEventAutomationSetupResultV1,
} from '@happier-dev/protocol/automations/event-setup-result';
export type {
    PluginEventAutomationSetupResultV1,
} from '@happier-dev/protocol/automations/event-setup-result';
import {
    PluginEventAutomationHistoryGapResetActionInputV1Schema as canonicalPluginEventAutomationHistoryGapResetActionInputV1Schema,
    PluginEventAutomationHistoryGapResetActionResultV1Schema as canonicalPluginEventAutomationHistoryGapResetActionResultV1Schema,
    PluginEventAutomationHistoryGapResetActionInputV1JsonSchema as canonicalPluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
    PluginEventAutomationHistoryGapResetActionResultV1JsonSchema as canonicalPluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
} from '@happier-dev/protocol/automations/event-history-gap-reset-action';
import type {
    PluginEventAutomationHistoryGapResetActionInputV1,
    PluginEventAutomationHistoryGapResetActionResultV1,
} from '@happier-dev/protocol/automations/event-history-gap-reset-action';
export type {
    PluginEventAutomationHistoryGapResetActionInputV1,
    PluginEventAutomationHistoryGapResetActionResultV1,
} from '@happier-dev/protocol/automations/event-history-gap-reset-action';
export type {
    PluginEventContributionV1 as EventContribution,
} from '@happier-dev/protocol';
export type { PluginEventHandler } from './activation.js';

import type { JsonValue, PluginContributionRef, PluginJsonSchema } from './identity.js';
import type { Disposable, PluginCancellationOptions } from './lifecycle.js';

export const PluginEventAutomationSetupResultV1Schema: Readonly<{
    parse(value: unknown): PluginEventAutomationSetupResultV1;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: PluginEventAutomationSetupResultV1 }>
        | Readonly<{ success: false; error: unknown }>;
}> = canonicalPluginEventAutomationSetupResultV1Schema;

export const createPluginEventAutomationSetupResultV1JsonSchema: (
    sourceContractVersion: number,
    sourceConfigSchema: PluginJsonSchema,
) => PluginJsonSchema = canonicalCreatePluginEventAutomationSetupResultV1JsonSchema;

export const PluginEventAutomationHistoryGapResetActionInputV1Schema: Readonly<{
    parse(value: unknown): PluginEventAutomationHistoryGapResetActionInputV1;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: PluginEventAutomationHistoryGapResetActionInputV1 }>
        | Readonly<{ success: false; error: unknown }>;
}> = canonicalPluginEventAutomationHistoryGapResetActionInputV1Schema;

export const PluginEventAutomationHistoryGapResetActionInputV1JsonSchema: PluginJsonSchema =
    canonicalPluginEventAutomationHistoryGapResetActionInputV1JsonSchema;

export const PluginEventAutomationHistoryGapResetActionResultV1JsonSchema: PluginJsonSchema =
    canonicalPluginEventAutomationHistoryGapResetActionResultV1JsonSchema;

export const PluginEventAutomationHistoryGapResetActionResultV1Schema: Readonly<{
    parse(value: unknown): PluginEventAutomationHistoryGapResetActionResultV1;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: PluginEventAutomationHistoryGapResetActionResultV1 }>
        | Readonly<{ success: false; error: unknown }>;
}> = canonicalPluginEventAutomationHistoryGapResetActionResultV1Schema;

/** @realm daemon */
export type PluginEventEmitResult = Readonly<{
    status: 'admitted';
    sequence: number;
    subscriberCount: number;
}>;

export type PluginEventEnvelope = Readonly<{
    ref: PluginContributionRef;
    payload: JsonValue;
    sequence: number;
}>;

export interface PluginEvents {
    emit(
        localId: string,
        payload: JsonValue,
        options?: PluginCancellationOptions,
    ): Promise<PluginEventEmitResult>;
    subscribe(
        event: PluginContributionRef,
        listener: (event: PluginEventEnvelope) => void | Promise<void>,
    ): Disposable;
}

export type HostEventId = ProtocolHostEventId;
export type HostEventPayloadById = ProtocolHostEventPayloadById;
export type HostEventScopeById = ProtocolHostEventScopeById;
export type HostEventScope = ProtocolHostEventScope;
export type HostEventTarget<Id extends HostEventId = HostEventId> = ProtocolHostEventTarget<Id>;
export type HostEventEnvelope<Id extends HostEventId = HostEventId> = ProtocolHostEventEnvelope<Id>;

export interface HostEvents {
    subscribe<Id extends HostEventId>(
        target: HostEventTarget<Id>,
        listener: (event: HostEventEnvelope<Id>) => void | Promise<void>,
    ): Disposable;
}

export interface EventsService {
    readonly plugin: PluginEvents;
    readonly host: HostEvents;
}

export type EventSubscriptionTarget = ProtocolEventSubscriptionTargetV1;
