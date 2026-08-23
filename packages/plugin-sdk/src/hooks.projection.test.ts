import { readFileSync } from 'node:fs';

import { describe, expect, expectTypeOf, it } from 'vitest';

/* @sdk-negative-type-case:src-hooks-projection-test-ts-35:LS0gdjQgZG9lcyBub3QgYXBwcm92ZSBhIGZpbmFsIGFsaWFzIGZvciB0aGlzIHByZWRlY2Vzc29yLW9ubHkgc2NoZW1hIG1hcC4:aW1wb3J0IHR5cGUgeyBQbHVnaW5Ib29rUGF5bG9hZFNjaGVtYU1hcCB9IGZyb20gJy4vaG9va3MuanMnOw */
type PluginHookPayloadSchemaMap = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-hooks-projection-test-ts-36:LS0gdGhlIFByb3RvY29sLW93bmVkIFpvZCBzY2hlbWEgbWFwIGlzIGEgZGVyaXZhdGlvbiBoZWxwZXIsIG5vdCBTREsgYXV0aG9yIEFCSS4:aW1wb3J0IHR5cGUgeyBQbHVnaW5Ib29rUGF5bG9hZFNjaGVtYU1hcFYxIH0gZnJvbSAnLi9ob29rcy5qcyc7 */
type PluginHookPayloadSchemaMapV1 = never; /* @sdk-negative-type-case-end */

import {
    ActionExecuteAfterHookPayloadSchema as canonicalActionExecuteAfterHookPayloadSchema,
    ActionExecuteBeforeHookPayloadSchema as canonicalActionExecuteBeforeHookPayloadSchema,
    AgentToolExecuteAfterHookPayloadSchema as canonicalAgentToolExecuteAfterHookPayloadSchema,
    AgentToolExecuteBeforeHookPayloadSchema as canonicalAgentToolExecuteBeforeHookPayloadSchema,
    PluginAgentCompositionRequestV1Schema as canonicalPluginAgentCompositionRequestSchema,
    PluginAgentCompositionResultV1Schema as canonicalPluginAgentCompositionResultSchema,
    PLUGIN_HOOK_IDS_V1 as canonicalPluginHookIds,
    PLUGIN_HOOK_PAYLOAD_SCHEMAS_BY_ID_V1 as canonicalPluginHookPayloadSchemasById,
    PluginExecutionCallerSchema as canonicalPluginExecutionCallerSchema,
    PluginExecutionInterceptionCapabilitySchema as canonicalPluginExecutionInterceptionCapabilitySchema,
    PluginExecutionInterceptionResultSchema as canonicalPluginExecutionInterceptionResultSchema,
    getPluginHookDefinitionV1 as canonicalGetPluginHookDefinition,
} from '@happier-dev/protocol/plugins/hooks';
import type { HookHandler as CanonicalHookHandler } from './activation.js';
import type { JsonValue } from './identity.js';
import type { HookHandler as RuntimeHookHandler } from './runtime/index.js';

import {
    ActionExecuteAfterHookPayloadSchema,
    ActionExecuteBeforeHookPayloadSchema,
    AgentToolExecuteAfterHookPayloadSchema,
    AgentToolExecuteBeforeHookPayloadSchema,
    PluginAgentCompositionRequestSchema,
    PluginAgentCompositionResultSchema,
    PLUGIN_HOOK_IDS,
    PluginExecutionCallerSchema,
    PluginExecutionInterceptionCapabilitySchema,
    PluginExecutionInterceptionResultSchema,
    getPluginHookDefinition,
    type ActionExecuteAfterHookPayload,
    type ActionExecuteBeforeHookPayload,
    type AgentToolExecuteAfterHookPayload,
    type AgentToolExecuteBeforeHookPayload,
    type PluginAgentCompositionRequest,
    type PluginAgentCompositionResult,
    type HookCategoryV1,
    type HookContribution,
    type HookExecutionKindV1,
    type HookHandler,
    type PluginExecutionCaller,
    type PluginExecutionInterceptionCapability,
    type PluginExecutionInterceptionResult,
    type PluginHookAggregationKind,
    type PluginHookDecisionResult,
    type PluginHookDefinition,
    type PluginHookFailureMode,
    type PluginHookId,
    type PluginHookPayloadMap,
    type PluginHookPurity,
    type PluginHookScope,
    type PluginHookSupportedRuntimeFamily,
} from './hooks.js';
import * as hookProjection from './hooks.js';
import {
    PluginAgentCompositionRequestSchema as publicPluginAgentCompositionRequestSchema,
    PluginAgentCompositionResultSchema as publicPluginAgentCompositionResultSchema,
    type PluginAgentCompositionRequest as PublicPluginAgentCompositionRequest,
    type PluginAgentCompositionResult as PublicPluginAgentCompositionResult,
} from './hooks/index.js';

type ExpectedPluginHookId =
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

type ExpectedPluginHookScope =
    | 'machine'
    | 'project'
    | 'session'
    | 'agent'
    | 'daemon'
    | 'tool'
    | 'resource'
    | 'plugin';

type ExpectedPluginHookRuntimeFamily =
    | 'hostSession'
    | 'acpSession'
    | 'pluginSession'
    | 'executionRun';

type ExpectedPluginExecutionCaller =
    | Readonly<{ kind: 'host' }>
    | Readonly<{ kind: 'plugin'; pluginId: string }>;

type ExpectedActionExecuteOutcome =
    | Readonly<{ status: 'succeeded'; result?: JsonValue }>
    | Readonly<{ status: 'failed'; code: string; message?: string }>
    | Readonly<{ status: 'cancelled' }>
    | Readonly<{ status: 'rejected'; code?: string; message?: string }>;

type ExpectedActionExecuteBeforeHookPayload = Readonly<{
    actionId: string;
    input: JsonValue;
    invocation: Readonly<{
        surface: 'ui' | 'voice' | 'agent' | 'mcp' | 'cli' | 'rpc' | 'api' | 'plugin';
        sessionId?: string;
        caller: ExpectedPluginExecutionCaller;
    }>;
    timestampMs: number;
}>;

type ExpectedActionExecuteAfterHookPayload = ExpectedActionExecuteBeforeHookPayload & Readonly<{
    outcome: ExpectedActionExecuteOutcome;
}>;

type ExpectedAgentToolExecuteBeforeHookPayload = Readonly<{
    agentId: string;
    runtimeFamily: ExpectedPluginHookRuntimeFamily;
    capability: 'interceptable';
    sessionId?: string;
    turnId?: string;
    tool: Readonly<{ callId: string; name: string; input: JsonValue }>;
    timestampMs: number;
}>;

type ExpectedAgentToolExecuteAfterHookPayload = Readonly<{
    agentId: string;
    runtimeFamily: ExpectedPluginHookRuntimeFamily;
    capability: 'interceptable' | 'observable';
    sessionId?: string;
    turnId?: string;
    tool: Readonly<{ callId: string; name: string; input: JsonValue }>;
    timestampMs: number;
    caller: ExpectedPluginExecutionCaller;
    outcome: ExpectedActionExecuteOutcome;
}>;

type ExpectedPluginAgentCompositionRequest = Readonly<{
    sessionId: string;
    agentId: string;
    runtimeFamily: 'hostSession' | 'acpSession';
    declaredToolIds: readonly string[];
    declaredPromptAssetIds: readonly string[];
}>;

type ExpectedPluginAgentCompositionResult = Readonly<{
    enabledToolIds?: readonly string[];
    enabledPromptAssetIds?: readonly string[];
    additionalInstructions?: string;
}>;

type ExpectedPluginHookDefinition = Readonly<{
    id: ExpectedPluginHookId;
    category: 'integration' | 'lifecycle' | 'augmentation' | 'decision';
    scope: ExpectedPluginHookScope;
    executionKind: 'integrate' | 'observe' | 'augment' | 'decide';
    aggregation: 'none' | 'orderedList' | 'mergeObject' | 'firstDecision' | 'allDecisions' | 'replace';
    failureMode: 'bestEffort' | 'failClosed';
    purity?: 'observer' | 'participant';
    supportedRuntimes: readonly ExpectedPluginHookRuntimeFamily[];
    payloadSchema: Readonly<Record<string, unknown>>;
    resultSchema: Readonly<Record<string, unknown>>;
}>;

type ExpectedHookContribution = Readonly<{
    id: string;
    on: ExpectedPluginHookId;
    hookApiVersion: 1;
    category: 'integration' | 'lifecycle' | 'augmentation' | 'decision';
    scope: ExpectedPluginHookScope;
    executionKind: 'integrate' | 'observe' | 'augment' | 'decide';
    filters?: unknown;
    priority?: number;
    hostAccess?: readonly string[];
    compatibility?: Readonly<Record<string, JsonValue>>;
    metadata?: Readonly<Record<string, JsonValue>>;
}>;

describe('hooks package-local projection', () => {
    it('structurally exposes the payload schema value without publishing its Protocol map helper', () => {
        const source = readFileSync(new URL('./hooks.ts', import.meta.url), 'utf8');

        expect(source).toMatch(/export const PLUGIN_HOOK_PAYLOAD_SCHEMAS_BY_ID_V1:/u);
        expect(source).not.toMatch(
            /export\s*\{[^}]*PLUGIN_HOOK_PAYLOAD_SCHEMAS_BY_ID_V1[^}]*\}\s*from/u,
        );
        expect(hookProjection.PLUGIN_HOOK_PAYLOAD_SCHEMAS_BY_ID_V1)
            .toBe(canonicalPluginHookPayloadSchemasById);
    });

    it('preserves canonical Protocol runtime identities', () => {
        expect(PLUGIN_HOOK_IDS).toBe(canonicalPluginHookIds);
        expect(getPluginHookDefinition).toBe(canonicalGetPluginHookDefinition);
        expect(ActionExecuteAfterHookPayloadSchema).toBe(canonicalActionExecuteAfterHookPayloadSchema);
        expect(ActionExecuteBeforeHookPayloadSchema).toBe(canonicalActionExecuteBeforeHookPayloadSchema);
        expect(AgentToolExecuteAfterHookPayloadSchema).toBe(canonicalAgentToolExecuteAfterHookPayloadSchema);
        expect(AgentToolExecuteBeforeHookPayloadSchema).toBe(canonicalAgentToolExecuteBeforeHookPayloadSchema);
        expect(PluginAgentCompositionRequestSchema).toBe(canonicalPluginAgentCompositionRequestSchema);
        expect(PluginAgentCompositionResultSchema).toBe(canonicalPluginAgentCompositionResultSchema);
        expect(PluginExecutionCallerSchema).toBe(canonicalPluginExecutionCallerSchema);
        expect(PluginExecutionInterceptionCapabilitySchema)
            .toBe(canonicalPluginExecutionInterceptionCapabilitySchema);
        expect(PluginExecutionInterceptionResultSchema)
            .toBe(canonicalPluginExecutionInterceptionResultSchema);
    });

    it('projects declaration-neutral public types while preserving their author contracts', () => {
        expectTypeOf<ActionExecuteAfterHookPayload>()
            .toEqualTypeOf<ExpectedActionExecuteAfterHookPayload>();
        expectTypeOf<ActionExecuteBeforeHookPayload>()
            .toEqualTypeOf<ExpectedActionExecuteBeforeHookPayload>();
        expectTypeOf<AgentToolExecuteAfterHookPayload>()
            .toEqualTypeOf<ExpectedAgentToolExecuteAfterHookPayload>();
        expectTypeOf<AgentToolExecuteBeforeHookPayload>()
            .toEqualTypeOf<ExpectedAgentToolExecuteBeforeHookPayload>();
        expectTypeOf<PluginAgentCompositionRequest>()
            .toEqualTypeOf<ExpectedPluginAgentCompositionRequest>();
        expectTypeOf<PluginAgentCompositionResult>()
            .toEqualTypeOf<ExpectedPluginAgentCompositionResult>();
        expectTypeOf<HookCategoryV1>()
            .toEqualTypeOf<'integration' | 'lifecycle' | 'augmentation' | 'decision'>();
        expectTypeOf<HookContribution>().toEqualTypeOf<ExpectedHookContribution>();
        expectTypeOf<HookExecutionKindV1>()
            .toEqualTypeOf<'integrate' | 'observe' | 'augment' | 'decide'>();
        expectTypeOf<PluginExecutionCaller>().toEqualTypeOf<ExpectedPluginExecutionCaller>();
        expectTypeOf<PluginExecutionInterceptionCapability>()
            .toEqualTypeOf<'interceptable' | 'observable'>();
        expectTypeOf<PluginExecutionInterceptionResult>()
            .toEqualTypeOf<
                | Readonly<{ status: 'continue'; input: JsonValue }>
                | Readonly<{ status: 'rejected'; code?: string; message?: string }>
            >();
        expectTypeOf<PluginHookAggregationKind>()
            .toEqualTypeOf<'none' | 'orderedList' | 'mergeObject' | 'firstDecision' | 'allDecisions' | 'replace'>();
        expectTypeOf<PluginHookDecisionResult>()
            .toEqualTypeOf<
                | Readonly<{ decision: 'allow' }>
                | Readonly<{ decision: 'deny'; reasonCode?: string; errorMessage?: string }>
                | Readonly<{ decision: 'abstain' }>
            >();
        expectTypeOf<PluginHookDefinition>().toEqualTypeOf<ExpectedPluginHookDefinition>();
        expectTypeOf<PluginHookFailureMode>()
            .toEqualTypeOf<'bestEffort' | 'failClosed'>();
        expectTypeOf<PluginHookId>().toEqualTypeOf<ExpectedPluginHookId>();
        expectTypeOf<PluginHookPayloadMap>()
            .toEqualTypeOf<Readonly<Record<ExpectedPluginHookId, unknown>>>();
        expectTypeOf<PluginHookPurity>().toEqualTypeOf<'observer' | 'participant'>();
        expectTypeOf<PluginHookScope>().toEqualTypeOf<ExpectedPluginHookScope>();
        expectTypeOf<PluginHookSupportedRuntimeFamily>()
            .toEqualTypeOf<ExpectedPluginHookRuntimeFamily>();
    });

    it('publishes composition request and result types and schemas through the hooks entrypoint', () => {
        expect(publicPluginAgentCompositionRequestSchema)
            .toBe(canonicalPluginAgentCompositionRequestSchema);
        expect(publicPluginAgentCompositionResultSchema)
            .toBe(canonicalPluginAgentCompositionResultSchema);
        expectTypeOf<PublicPluginAgentCompositionRequest>()
            .toEqualTypeOf<ExpectedPluginAgentCompositionRequest>();
        expectTypeOf<PublicPluginAgentCompositionResult>()
            .toEqualTypeOf<ExpectedPluginAgentCompositionResult>();
    });

    it('makes the final hooks projection source-ready before the atomic package cutover', () => {
        expectTypeOf<HookHandler>().toEqualTypeOf<CanonicalHookHandler>();
        expectTypeOf<RuntimeHookHandler>().toEqualTypeOf<CanonicalHookHandler>();

        const hookSource = readFileSync(new URL('./hooks.ts', import.meta.url), 'utf8');
        expect(hookSource).toMatch(
            /export type \{\s*HookHandler,?\s*\} from '\.\/activation\.js';/,
        );
        expect(hookProjection).not.toHaveProperty('HookHandler');
    });

    it('does not add final aliases for predecessor-only catalog internals', () => {
        expect(hookProjection).not.toHaveProperty('PLUGIN_HOOK_CATALOG');
        expect(hookProjection).not.toHaveProperty('PLUGIN_HOOK_PAYLOAD_SCHEMAS_BY_ID');
        expect(hookProjection).not.toHaveProperty('validatePluginHookPayload');
        expect(hookProjection).not.toHaveProperty('validatePluginHookResult');
    });
});
