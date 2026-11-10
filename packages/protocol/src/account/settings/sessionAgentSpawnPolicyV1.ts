import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { SESSION_PERMISSION_MODES } from '../../sessions/metadata/sessionPermissionModes.js';

const SessionAgentSpawnPermissionCeilingV1Schema = lazyZodSchema(() => z._default(z.nullable(z
  .enum(SESSION_PERMISSION_MODES)), null));

// The V1 durable shape is also read by released 0.2 strict readers.
export const SessionAgentSpawnPolicyV1StrictSchema = lazyZodSchema(() => z.strictObject({
  v: z._default(z.literal(1), 1),
  allowCustomDirectory: z._default(z.boolean(), true),
  allowCrossMachine: z._default(z.boolean(), true),
  allowBackendTargetOverride: z._default(z.boolean(), true),
  allowModelOverride: z._default(z.boolean(), true),
  allowPermissionModeOverride: z._default(z.boolean(), true),
  allowAgentModeOverride: z._default(z.boolean(), true),
  allowConfigOptionOverrides: z._default(z.boolean(), true),
  allowProfileOverride: z._default(z.boolean(), true),
  allowEnvironmentVariables: z._default(z.boolean(), true),
  allowConnectedServicesOverride: z._default(z.boolean(), true),
  /** Released key; governs the complete skill and MCP session selection. */
  allowMcpSelectionOverride: z._default(z.boolean(), true),
  allowTranscriptStorageOverride: z._default(z.boolean(), true),
  permissionCeiling: SessionAgentSpawnPermissionCeilingV1Schema,
}));

// Recover each malformed field through its own default; never erase other
// restrictions because one field is invalid or a newer writer added a key.
export const SessionAgentSpawnPolicyV1Schema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw) => {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(SessionAgentSpawnPolicyV1StrictSchema.shape).map(([key, schema]) => [
    key, schema.safeParse(record[key]).success ? record[key] : undefined,
  ]));
}), (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: undefined }) as z.ZodMiniObject<T['shape'], z.core.$strip>)(SessionAgentSpawnPolicyV1StrictSchema)));

export type SessionAgentSpawnPolicyV1 = z.infer<typeof SessionAgentSpawnPolicyV1Schema>;

export const DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1: SessionAgentSpawnPolicyV1 =
  SessionAgentSpawnPolicyV1Schema.parse({});

export type SessionAgentStartOverridesV1 = Readonly<{
  customDirectory?: boolean;
  crossMachine?: boolean;
  backendTarget?: boolean;
  modelSelection?: boolean;
  permissionMode?: boolean;
  agentModeId?: boolean;
  configOptions?: boolean;
  profileId?: boolean;
  environmentVariables?: boolean;
  connectedServices?: boolean;
  capabilitySelection?: boolean;
  transcriptStorage?: boolean;
  requiredPermissionMode?: unknown;
}>;
