/** @moduleRealm daemon */
import {
    ActionExecuteAfterHookPayloadSchema as canonicalActionExecuteAfterHookPayloadSchema,
    ActionExecuteBeforeHookPayloadSchema as canonicalActionExecuteBeforeHookPayloadSchema,
    AgentToolExecuteAfterHookPayloadSchema as canonicalAgentToolExecuteAfterHookPayloadSchema,
    AgentToolExecuteBeforeHookPayloadSchema as canonicalAgentToolExecuteBeforeHookPayloadSchema,
    getPluginHookDefinitionV1 as canonicalGetPluginHookDefinitionV1,
    PLUGIN_HOOK_CATALOG_V1 as canonicalPluginHookCatalogV1,
    PLUGIN_HOOK_IDS_V1 as canonicalPluginHookIdsV1,
    PLUGIN_HOOK_PAYLOAD_SCHEMAS_BY_ID_V1 as canonicalPluginHookPayloadSchemasById,
    PluginAgentCompositionRequestV1Schema as canonicalPluginAgentCompositionRequestV1Schema,
    PluginAgentCompositionResultV1Schema as canonicalPluginAgentCompositionResultV1Schema,
    PluginExecutionCallerSchema as canonicalPluginExecutionCallerSchema,
    PluginExecutionInterceptionCapabilitySchema as canonicalPluginExecutionInterceptionCapabilitySchema,
    PluginExecutionInterceptionResultSchema as canonicalPluginExecutionInterceptionResultSchema,
    validatePluginHookPayloadV1 as canonicalValidatePluginHookPayloadV1,
    validatePluginHookResultV1 as canonicalValidatePluginHookResultV1,
} from '@happier-dev/protocol/plugins/hooks';

import type { JsonValue } from './identity.js';

export type PluginHookIdV1 =
    | 'session.spawned'
    | 'session.message.send'
    | 'session.input.transform'
    | 'executionRun.started'
    | 'executionRun.messageSent'
    | 'executionRun.stopped'
    | 'executionRun.completed'
    | 'agent.resolvePrerequisites'
    | 'agent.spawnEnv.augment'
    | 'agent.context.before'
    | 'agent.request.before'
    | 'agent.composition.resolve'
    | 'agent.stream.token'
    | 'action.execute.before'
    | 'action.execute.after'
    | 'agent.tool.execute.before'
    | 'agent.tool.execute.after';
export type PluginHookId = PluginHookIdV1;

export type PluginHookScopeV1 =
    | 'machine'
    | 'project'
    | 'session'
    | 'agent'
    | 'daemon'
    | 'tool'
    | 'resource'
    | 'plugin';
export type PluginHookScope = PluginHookScopeV1;

export type PluginHookAggregationKindV1 =
    | 'none'
    | 'orderedList'
    | 'mergeObject'
    | 'firstDecision'
    | 'allDecisions'
    | 'replace';
export type PluginHookAggregationKind = PluginHookAggregationKindV1;
export type PluginHookFailureModeV1 = 'bestEffort' | 'failClosed';
export type PluginHookFailureMode = PluginHookFailureModeV1;
export type PluginHookPurityV1 = 'observer' | 'participant';
export type PluginHookPurity = PluginHookPurityV1;
export type PluginHookSupportedRuntimeFamilyV1 =
    | 'hostSession'
    | 'acpSession'
    | 'pluginSession'
    | 'executionRun';
export type PluginHookSupportedRuntimeFamily = PluginHookSupportedRuntimeFamilyV1;
export type HookCategoryV1 = 'integration' | 'lifecycle' | 'augmentation' | 'decision';
export type HookExecutionKindV1 = 'integrate' | 'observe' | 'augment' | 'decide';

export type PluginHookDecisionResultV1 =
    | Readonly<{ decision: 'allow' }>
    | Readonly<{ decision: 'deny'; reasonCode?: string; errorMessage?: string }>
    | Readonly<{ decision: 'abstain' }>;
export type PluginHookDecisionResult = PluginHookDecisionResultV1;

export type PluginExecutionInterceptionCapability = 'interceptable' | 'observable';
export type PluginExecutionCaller =
    | Readonly<{ kind: 'host' }>
    | Readonly<{ kind: 'plugin'; pluginId: string }>;
export type PluginExecutionInterceptionResult =
    | Readonly<{ status: 'continue'; input: JsonValue }>
    | Readonly<{ status: 'rejected'; code?: string; message?: string }>;

export type ActionExecuteBeforeHookPayload = Readonly<{
    actionId: string;
    input: JsonValue;
    invocation: Readonly<{
        surface: 'ui' | 'voice' | 'agent' | 'mcp' | 'cli' | 'rpc' | 'sdk' | 'plugin';
        sessionId?: string;
        caller: PluginExecutionCaller;
    }>;
    timestampMs: number;
}>;
export type ActionExecuteAfterHookPayload = ActionExecuteBeforeHookPayload & Readonly<{
    outcome:
        | Readonly<{ status: 'succeeded'; result?: JsonValue }>
        | Readonly<{ status: 'failed'; code: string; message?: string }>
        | Readonly<{ status: 'cancelled' }>
        | Readonly<{ status: 'rejected'; code?: string; message?: string }>;
}>;
export type AgentToolExecuteBeforeHookPayload = Readonly<{
    agentId: string;
    runtimeFamily: PluginHookSupportedRuntimeFamilyV1;
    capability: 'interceptable';
    sessionId?: string;
    turnId?: string;
    tool: Readonly<{ callId: string; name: string; input: JsonValue }>;
    timestampMs: number;
}>;
export type AgentToolExecuteAfterHookPayload = Readonly<{
    agentId: string;
    runtimeFamily: PluginHookSupportedRuntimeFamilyV1;
    capability: PluginExecutionInterceptionCapability;
    sessionId?: string;
    turnId?: string;
    tool: Readonly<{ callId: string; name: string; input: JsonValue }>;
    timestampMs: number;
    caller: PluginExecutionCaller;
    outcome: ActionExecuteAfterHookPayload['outcome'];
}>;
export type PluginAgentCompositionRequestV1 = Readonly<{
    sessionId: string;
    agentId: string;
    runtimeFamily: 'hostSession' | 'acpSession';
    declaredToolIds: readonly string[];
    declaredPromptAssetIds: readonly string[];
}>;
export type PluginAgentCompositionRequest = PluginAgentCompositionRequestV1;
export type PluginAgentCompositionResultV1 = Readonly<{
    enabledToolIds?: readonly string[];
    enabledPromptAssetIds?: readonly string[];
    additionalInstructions?: string;
}>;
export type PluginAgentCompositionResult = PluginAgentCompositionResultV1;

/** Catalog facts are host-owned; this is the author-readable structural view. */
export type PluginHookDefinitionV1 = Readonly<{
    id: PluginHookIdV1;
    category: HookCategoryV1;
    scope: PluginHookScopeV1;
    executionKind: HookExecutionKindV1;
    aggregation: PluginHookAggregationKindV1;
    failureMode: PluginHookFailureModeV1;
    purity?: PluginHookPurityV1;
    supportedRuntimes: readonly PluginHookSupportedRuntimeFamilyV1[];
    payloadSchema: Readonly<Record<string, unknown>>;
    resultSchema: Readonly<Record<string, unknown>>;
}>;
export type PluginHookDefinition = PluginHookDefinitionV1;

/** Per-hook payload declarations are intentionally opaque beyond their hook key. */
export type PluginHookPayloadMap = Readonly<Record<PluginHookIdV1, unknown>>;

/** Manifest declaration shape consumed by the existing activation owner. */
export type HookContribution = Readonly<{
    id: string;
    on: PluginHookIdV1;
    hookApiVersion: 1;
    category: HookCategoryV1;
    scope: PluginHookScopeV1;
    executionKind: HookExecutionKindV1;
    filters?: unknown;
    priority?: number;
    hostAccess?: readonly string[];
    compatibility?: Readonly<Record<string, JsonValue>>;
    metadata?: Readonly<Record<string, JsonValue>>;
}>;

/** @realm any */
export const PLUGIN_HOOK_IDS: readonly PluginHookIdV1[] = canonicalPluginHookIdsV1;
export const PLUGIN_HOOK_IDS_V1: readonly PluginHookIdV1[] = canonicalPluginHookIdsV1;
export const PLUGIN_HOOK_CATALOG_V1: readonly PluginHookDefinitionV1[] = canonicalPluginHookCatalogV1;
export const ActionExecuteAfterHookPayloadSchema: Readonly<{ parse(value: unknown): ActionExecuteAfterHookPayload; safeParse(value: unknown): Readonly<{ success: true; data: ActionExecuteAfterHookPayload }> | Readonly<{ success: false; error: unknown }> }> = canonicalActionExecuteAfterHookPayloadSchema;
export const ActionExecuteBeforeHookPayloadSchema: Readonly<{ parse(value: unknown): ActionExecuteBeforeHookPayload; safeParse(value: unknown): Readonly<{ success: true; data: ActionExecuteBeforeHookPayload }> | Readonly<{ success: false; error: unknown }> }> = canonicalActionExecuteBeforeHookPayloadSchema;
export const AgentToolExecuteAfterHookPayloadSchema: Readonly<{ parse(value: unknown): AgentToolExecuteAfterHookPayload; safeParse(value: unknown): Readonly<{ success: true; data: AgentToolExecuteAfterHookPayload }> | Readonly<{ success: false; error: unknown }> }> = canonicalAgentToolExecuteAfterHookPayloadSchema;
export const AgentToolExecuteBeforeHookPayloadSchema: Readonly<{ parse(value: unknown): AgentToolExecuteBeforeHookPayload; safeParse(value: unknown): Readonly<{ success: true; data: AgentToolExecuteBeforeHookPayload }> | Readonly<{ success: false; error: unknown }> }> = canonicalAgentToolExecuteBeforeHookPayloadSchema;
export const PluginAgentCompositionRequestV1Schema: Readonly<{ parse(value: unknown): PluginAgentCompositionRequestV1; safeParse(value: unknown): Readonly<{ success: true; data: PluginAgentCompositionRequestV1 }> | Readonly<{ success: false; error: unknown }> }> = canonicalPluginAgentCompositionRequestV1Schema;
export const PluginAgentCompositionRequestSchema: Readonly<{ parse(value: unknown): PluginAgentCompositionRequest; safeParse(value: unknown): Readonly<{ success: true; data: PluginAgentCompositionRequest }> | Readonly<{ success: false; error: unknown }> }> = PluginAgentCompositionRequestV1Schema;
export const PluginAgentCompositionResultV1Schema: Readonly<{ parse(value: unknown): PluginAgentCompositionResultV1; safeParse(value: unknown): Readonly<{ success: true; data: PluginAgentCompositionResultV1 }> | Readonly<{ success: false; error: unknown }> }> = canonicalPluginAgentCompositionResultV1Schema;
export const PluginAgentCompositionResultSchema: Readonly<{ parse(value: unknown): PluginAgentCompositionResult; safeParse(value: unknown): Readonly<{ success: true; data: PluginAgentCompositionResult }> | Readonly<{ success: false; error: unknown }> }> = PluginAgentCompositionResultV1Schema;
export const PluginExecutionCallerSchema: Readonly<{ parse(value: unknown): PluginExecutionCaller; safeParse(value: unknown): Readonly<{ success: true; data: PluginExecutionCaller }> | Readonly<{ success: false; error: unknown }> }> = canonicalPluginExecutionCallerSchema;
export const PluginExecutionInterceptionCapabilitySchema: Readonly<{ parse(value: unknown): PluginExecutionInterceptionCapability; safeParse(value: unknown): Readonly<{ success: true; data: PluginExecutionInterceptionCapability }> | Readonly<{ success: false; error: unknown }> }> = canonicalPluginExecutionInterceptionCapabilitySchema;
export const PluginExecutionInterceptionResultSchema: Readonly<{ parse(value: unknown): PluginExecutionInterceptionResult; safeParse(value: unknown): Readonly<{ success: true; data: PluginExecutionInterceptionResult }> | Readonly<{ success: false; error: unknown }> }> = canonicalPluginExecutionInterceptionResultSchema;
export const PLUGIN_HOOK_PAYLOAD_SCHEMAS_BY_ID_V1: Readonly<{
    [K in PluginHookIdV1]: Readonly<{
        parse(value: unknown): PluginHookPayloadMap[K];
        safeParse(value: unknown):
            | Readonly<{ success: true; data: PluginHookPayloadMap[K] }>
            | Readonly<{ success: false; error: unknown }>;
    }>;
}> = canonicalPluginHookPayloadSchemasById;
export const getPluginHookDefinitionV1: (id: string) => PluginHookDefinitionV1 | null = canonicalGetPluginHookDefinitionV1;
export const getPluginHookDefinition: (id: string) => PluginHookDefinition | null = getPluginHookDefinitionV1;
export const validatePluginHookPayloadV1: (params: Readonly<{
    hookId: string;
    payload: unknown;
}>) => Readonly<
    | { success: true; payload: unknown }
    | { success: false; message: string }
> = canonicalValidatePluginHookPayloadV1;
export const validatePluginHookResultV1: (params: Readonly<{
    hookId: string;
    result: unknown;
}>) => Readonly<
    | { success: true; result: unknown }
    | { success: false; message: string }
> = canonicalValidatePluginHookResultV1;

export type { HookHandler } from './activation.js';

export type PluginHookPayloadEnvelope = Readonly<{ payload?: unknown }>;

export function toPluginHookPayloadEnvelope<
    TEnvelope extends PluginHookPayloadEnvelope = PluginHookPayloadEnvelope,
>(value: unknown): TEnvelope {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {} as TEnvelope;
    }
    const record = value as Readonly<Record<string, unknown>>;
    return (
        Object.prototype.hasOwnProperty.call(record, 'payload')
            ? { payload: record.payload }
            : { payload: value }
    ) as TEnvelope;
}

export function toPluginHookObjectContext<TContext>(value: unknown): TContext | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as TContext
        : undefined;
}
