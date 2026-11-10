import { maxCodeUnits } from '../strings/maxCodeUnits.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { StrictJsonValueSchema, type JsonValue } from '../json/strictJsonValue.js';
import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 as LIMITS } from './agentSessionLimitsV1.js';

const exactString = (max: number) => z.string().check(z.minLength(1), maxCodeUnits(max), z.refine((value) => value === value.trim(), 'Identifiers must not contain leading or trailing whitespace'));

const PluginContributionRefSchema = lazyZodSchema(() => z.strictObject({
  pluginId: exactString(LIMITS.providerIdMaxCodeUnits),
  localId: exactString(LIMITS.providerIdMaxCodeUnits),
}));

const AgentRuntimeRemediationDataV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('retry') }),
  z.strictObject({ kind: z.literal('openSettings'), path: z.string().check(maxCodeUnits(LIMITS.filePathMaxCodeUnits)) }),
  z.strictObject({ kind: z.literal('selectAccount'), service: PluginContributionRefSchema }),
  z.strictObject({
    kind: z.literal('installDependency'),
    dependencyId: exactString(LIMITS.providerIdMaxCodeUnits),
  }),
  z.strictObject({ kind: z.literal('openUrl'), url: z.string().check(z.url()) }),
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
export const AgentRuntimeDiagnosticDataV1Schema: z.ZodMiniType<AgentRuntimeDiagnosticDataV1> = lazyZodSchema(() => z.strictObject({
  code: exactString(LIMITS.usageSourceMaxCodeUnits),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.optional(z.string().check(maxCodeUnits(LIMITS.descriptionMaxCodeUnits))),
  details: z.optional(StrictJsonValueSchema),
  remediation: z.optional(AgentRuntimeRemediationDataV1Schema),
}));
