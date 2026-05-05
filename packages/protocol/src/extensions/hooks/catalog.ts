import { z } from 'zod';

import {
  HookCategoryV1Schema,
  type HookCategoryV1,
} from '../../hooks/hookCategories.js';
import {
  HookExecutionKindV1Schema,
  type HookExecutionKindV1,
  resolveHookExecutionKindForCategoryV1,
} from '../../hooks/hookExecutionSemantics.js';

export const ExtensionHookScopeV1Schema = z.enum([
  'machine',
  'project',
  'session',
  'backend',
  'agent',
  'provider',
  'daemon',
  'tool',
  'resource',
  'plugin',
]);
export type ExtensionHookScopeV1 = z.infer<typeof ExtensionHookScopeV1Schema>;

export const ExtensionHookAggregationKindV1Schema = z.enum([
  'none',
  'orderedList',
  'mergeObject',
  'firstDecision',
  'allDecisions',
  'replace',
]);
export type ExtensionHookAggregationKindV1 = z.infer<typeof ExtensionHookAggregationKindV1Schema>;

export const ExtensionHookFailureModeV1Schema = z.enum(['bestEffort', 'failClosed']);
export type ExtensionHookFailureModeV1 = z.infer<typeof ExtensionHookFailureModeV1Schema>;

export const ExtensionHookDefinitionV1Schema = z.object({
  id: z.string().trim().min(1),
  category: HookCategoryV1Schema,
  scope: ExtensionHookScopeV1Schema,
  executionKind: HookExecutionKindV1Schema,
  aggregation: ExtensionHookAggregationKindV1Schema,
  failureMode: ExtensionHookFailureModeV1Schema,
  payloadSchema: z.record(z.string(), z.unknown()).default({}),
  resultSchema: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type ExtensionHookDefinitionV1 = z.infer<typeof ExtensionHookDefinitionV1Schema>;

function defineHookDefinitionV1(input: Readonly<{
  id: string;
  category: HookCategoryV1;
  scope: ExtensionHookScopeV1;
  aggregation: ExtensionHookAggregationKindV1;
  failureMode: ExtensionHookFailureModeV1;
  payloadSchema?: Record<string, unknown>;
  resultSchema?: Record<string, unknown>;
}>): ExtensionHookDefinitionV1 {
  const executionKind = resolveHookExecutionKindForCategoryV1(input.category) as HookExecutionKindV1;
  return ExtensionHookDefinitionV1Schema.parse({
    ...input,
    executionKind,
    payloadSchema: input.payloadSchema ?? {},
    resultSchema: input.resultSchema ?? {},
  });
}

export const EXTENSION_HOOK_CATALOG_V1 = [
  defineHookDefinitionV1({
    id: 'session.spawn_new',
    category: 'lifecycle',
    scope: 'session',
    aggregation: 'orderedList',
    failureMode: 'bestEffort',
  }),
  defineHookDefinitionV1({
    id: 'session.message.send',
    category: 'lifecycle',
    scope: 'session',
    aggregation: 'orderedList',
    failureMode: 'bestEffort',
  }),
  defineHookDefinitionV1({
    id: 'execution_run.start',
    category: 'lifecycle',
    scope: 'session',
    aggregation: 'orderedList',
    failureMode: 'bestEffort',
  }),
  defineHookDefinitionV1({
    id: 'execution_run.send',
    category: 'lifecycle',
    scope: 'session',
    aggregation: 'orderedList',
    failureMode: 'bestEffort',
  }),
  defineHookDefinitionV1({
    id: 'execution_run.stop',
    category: 'lifecycle',
    scope: 'session',
    aggregation: 'orderedList',
    failureMode: 'bestEffort',
  }),
  defineHookDefinitionV1({
    id: 'execution_run.terminal',
    category: 'lifecycle',
    scope: 'session',
    aggregation: 'orderedList',
    failureMode: 'bestEffort',
  }),
  defineHookDefinitionV1({
    id: 'backend.resolveRuntimePrerequisites',
    category: 'decision',
    scope: 'backend',
    aggregation: 'firstDecision',
    failureMode: 'failClosed',
  }),
  defineHookDefinitionV1({
    id: 'spawn.augmentEnv',
    category: 'augmentation',
    scope: 'daemon',
    aggregation: 'mergeObject',
    failureMode: 'bestEffort',
  }),
  defineHookDefinitionV1({
    id: 'provider.request.before',
    category: 'decision',
    scope: 'provider',
    aggregation: 'firstDecision',
    failureMode: 'failClosed',
  }),
  defineHookDefinitionV1({
    id: 'provider.response.after',
    category: 'lifecycle',
    scope: 'provider',
    aggregation: 'orderedList',
    failureMode: 'bestEffort',
  }),
  defineHookDefinitionV1({
    id: 'tool.call.before',
    category: 'decision',
    scope: 'tool',
    aggregation: 'firstDecision',
    failureMode: 'failClosed',
  }),
  defineHookDefinitionV1({
    id: 'tool.result.after',
    category: 'lifecycle',
    scope: 'tool',
    aggregation: 'orderedList',
    failureMode: 'bestEffort',
  }),
  defineHookDefinitionV1({
    id: 'resource.discovery',
    category: 'augmentation',
    scope: 'resource',
    aggregation: 'mergeObject',
    failureMode: 'bestEffort',
  }),
  defineHookDefinitionV1({
    id: 'plugin.reload.before',
    category: 'lifecycle',
    scope: 'plugin',
    aggregation: 'orderedList',
    failureMode: 'bestEffort',
  }),
  defineHookDefinitionV1({
    id: 'plugin.reload.after',
    category: 'lifecycle',
    scope: 'plugin',
    aggregation: 'orderedList',
    failureMode: 'bestEffort',
  }),
] as const satisfies readonly ExtensionHookDefinitionV1[];

export type ExtensionHookIdV1 = (typeof EXTENSION_HOOK_CATALOG_V1)[number]['id'];

const EXTENSION_HOOK_CATALOG_BY_ID_V1: ReadonlyMap<string, ExtensionHookDefinitionV1> = new Map(
  EXTENSION_HOOK_CATALOG_V1.map((entry) => [entry.id, entry]),
);

export function getExtensionHookDefinitionV1(id: string): ExtensionHookDefinitionV1 | null {
  return EXTENSION_HOOK_CATALOG_BY_ID_V1.get(id) ?? null;
}
