/** @moduleRealm any */

import {
    AutomationConversationAdmitInputV1Schema as canonicalAutomationConversationAdmitInputV1Schema,
    AutomationConversationAdmitResultV1Schema as canonicalAutomationConversationAdmitResultV1Schema,
    AutomationConversationResultDeliveryV1Schema as canonicalAutomationConversationResultDeliveryV1Schema,
    AutomationResultDeliveryInputV1JsonSchema as canonicalAutomationResultDeliveryInputV1JsonSchema,
    AutomationResultDeliveryInputV1Schema as canonicalAutomationResultDeliveryInputV1Schema,
    AutomationResultDeliveryResultV1JsonSchema as canonicalAutomationResultDeliveryResultV1JsonSchema,
    AutomationResultDeliveryResultV1Schema as canonicalAutomationResultDeliveryResultV1Schema,
    AutomationResultDeliverySourceV1JsonSchema as canonicalAutomationResultDeliverySourceV1JsonSchema,
    AutomationResultDeliverySourceV1Schema as canonicalAutomationResultDeliverySourceV1Schema,
} from '@happier-dev/protocol/automations/result-delivery';
import type {
    AutomationIdV1,
    AutomationConversationAdmitInputV1,
    AutomationConversationAdmitResultV1,
    AutomationConversationResultDeliveryV1,
    AutomationResultDeliveryInputV1,
    AutomationResultDeliveryResultV1,
    AutomationResultDeliverySourceV1,
} from '@happier-dev/protocol/automations/result-delivery';
import type { PluginJsonSchema } from './identity.js';

/**
 * Declaration-neutral projection of the canonical immutable automation
 * provenance.  Protocol owns parsing and persistence; the SDK owns this
 * author-facing structural name so an external author's emitted declaration
 * does not name the host-private Protocol package.  Keep the union in lockstep
 * with `AutomationRunCauseSchema` through the invocation contract test.
 */
export type PluginAutomationRunCause =
    | Readonly<{
        kind: 'trigger';
        triggerId: string;
        triggerRevision: number;
        triggerKind: 'schedule';
        occurrenceKey: string;
        occurredAt: number;
        evidence: Readonly<{ scheduledFor: number }>;
    }>
    | Readonly<{
        kind: 'trigger';
        triggerId: string;
        triggerRevision: number;
        triggerKind: 'pluginEvent';
        occurrenceKey: string;
        occurredAt: number;
        evidence: Readonly<{
            eventRef: Readonly<{ pluginId: string; localId: string }>;
            sourceSelectorId: string;
        }>;
    }>
    | Readonly<{
        kind: 'trigger';
        triggerId: string;
        triggerRevision: number;
        triggerKind: 'sessionLifecycle';
        occurrenceKey: string;
        occurredAt: number;
        evidence: Readonly<{
            event: 'parentTurnCompleted';
            sourceSessionId: string;
            sourceTurnId: string;
        }>;
    }>
    | Readonly<{ kind: 'manual'; invokedAt: number }>
    | Readonly<{
        kind: 'conversation';
        occurrenceKey: string;
        occurredAt: number;
    }>;
export {
    AutomationIdV1Schema,
} from '@happier-dev/protocol/automations/result-delivery';
export type {
    AutomationIdV1,
    AutomationConversationAdmitInputV1,
    AutomationConversationAdmitResultV1,
    AutomationConversationResultDeliveryV1,
    AutomationResultDeliveryInputV1,
    AutomationResultDeliveryResultV1,
    AutomationResultDeliverySourceV1,
} from '@happier-dev/protocol/automations/result-delivery';

export const AutomationConversationAdmitInputV1Schema: Readonly<{
    parse(value: unknown): AutomationConversationAdmitInputV1;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: AutomationConversationAdmitInputV1 }>
        | Readonly<{ success: false; error: unknown }>;
}> = canonicalAutomationConversationAdmitInputV1Schema;

export const AutomationConversationAdmitResultV1Schema: Readonly<{
    parse(value: unknown): AutomationConversationAdmitResultV1;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: AutomationConversationAdmitResultV1 }>
        | Readonly<{ success: false; error: unknown }>;
}> = canonicalAutomationConversationAdmitResultV1Schema;

export const AutomationConversationResultDeliveryV1Schema: Readonly<{
    parse(value: unknown): AutomationConversationResultDeliveryV1;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: AutomationConversationResultDeliveryV1 }>
        | Readonly<{ success: false; error: unknown }>;
}> = canonicalAutomationConversationResultDeliveryV1Schema;

export const AutomationResultDeliveryInputV1JsonSchema: PluginJsonSchema =
    canonicalAutomationResultDeliveryInputV1JsonSchema;

export const AutomationResultDeliveryInputV1Schema: Readonly<{
    parse(value: unknown): AutomationResultDeliveryInputV1;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: AutomationResultDeliveryInputV1 }>
        | Readonly<{ success: false; error: unknown }>;
}> = canonicalAutomationResultDeliveryInputV1Schema;

export const AutomationResultDeliveryResultV1Schema: Readonly<{
    parse(value: unknown): AutomationResultDeliveryResultV1;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: AutomationResultDeliveryResultV1 }>
        | Readonly<{ success: false; error: unknown }>;
}> = canonicalAutomationResultDeliveryResultV1Schema;

export const AutomationResultDeliveryResultV1JsonSchema: PluginJsonSchema =
    canonicalAutomationResultDeliveryResultV1JsonSchema;

export const AutomationResultDeliverySourceV1JsonSchema: PluginJsonSchema =
    canonicalAutomationResultDeliverySourceV1JsonSchema;

export const AutomationResultDeliverySourceV1Schema: Readonly<{
    parse(value: unknown): AutomationResultDeliverySourceV1;
    safeParse(value: unknown):
        | Readonly<{ success: true; data: AutomationResultDeliverySourceV1 }>
        | Readonly<{ success: false; error: unknown }>;
}> = canonicalAutomationResultDeliverySourceV1Schema;
