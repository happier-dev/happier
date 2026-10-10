import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { StrictJsonValueSchema, type JsonValue } from '../json/strictJsonValue.js';
import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 as LIMITS } from './agentSessionLimitsV1.js';

const exactString = (max: number) => z.string().min(1).max(max).refine(
  (value) => value === value.trim(),
  'Identifiers must not contain leading or trailing whitespace',
);

const PluginContributionRefSchema = lazyZodSchema(() => z.object({
  pluginId: exactString(LIMITS.providerIdMaxCodeUnits),
  localId: exactString(LIMITS.providerIdMaxCodeUnits),
}).strict());

const AgentRuntimeRemediationDataV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('retry') }).strict(),
  z.object({ kind: z.literal('openSettings'), path: z.string().max(LIMITS.filePathMaxCodeUnits) }).strict(),
  z.object({ kind: z.literal('selectAccount'), service: PluginContributionRefSchema }).strict(),
  z.object({
    kind: z.literal('installDependency'),
    dependencyId: exactString(LIMITS.providerIdMaxCodeUnits),
  }).strict(),
  z.object({ kind: z.literal('openUrl'), url: z.string().url() }).strict(),
]));

type ReadonlyUnion<T> = T extends unknown ? Readonly<T> : never;
export type AgentRuntimeDiagnosticDataV1 = Readonly<{
  code: string;
  severity: 'info' | 'warning' | 'error';
  message?: string;
  details?: JsonValue;
  remediation?: ReadonlyUnion<z.infer<typeof AgentRuntimeRemediationDataV1Schema>>;
}>;

/** Shared strict diagnostic payload for Agent Session and finite Run runtime events. */
export const AgentRuntimeDiagnosticDataV1Schema: z.ZodType<AgentRuntimeDiagnosticDataV1> = lazyZodSchema(() => z.object({
  code: exactString(LIMITS.usageSourceMaxCodeUnits),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string().max(LIMITS.descriptionMaxCodeUnits).optional(),
  details: StrictJsonValueSchema.optional(),
  remediation: AgentRuntimeRemediationDataV1Schema.optional(),
}).strict());
