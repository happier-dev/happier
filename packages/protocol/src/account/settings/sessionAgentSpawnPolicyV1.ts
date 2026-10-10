import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { SESSION_PERMISSION_MODES } from '../../sessions/metadata/sessionPermissionModes.js';

const SessionAgentSpawnPermissionCeilingV1Schema = lazyZodSchema(() => z
  .enum(SESSION_PERMISSION_MODES)
  .nullable()
  .default(null));

// The V1 durable shape is also read by released 0.2 strict readers.
export const SessionAgentSpawnPolicyV1StrictSchema = lazyZodSchema(() => z.object({
  v: z.literal(1).default(1),
  allowCustomDirectory: z.boolean().default(true),
  allowCrossMachine: z.boolean().default(true),
  allowBackendTargetOverride: z.boolean().default(true),
  allowModelOverride: z.boolean().default(true),
  allowPermissionModeOverride: z.boolean().default(true),
  allowAgentModeOverride: z.boolean().default(true),
  allowConfigOptionOverrides: z.boolean().default(true),
  allowProfileOverride: z.boolean().default(true),
  allowEnvironmentVariables: z.boolean().default(true),
  allowConnectedServicesOverride: z.boolean().default(true),
  allowMcpSelectionOverride: z.boolean().default(true),
  allowTranscriptStorageOverride: z.boolean().default(true),
  permissionCeiling: SessionAgentSpawnPermissionCeilingV1Schema,
}).strict());

// Recover each malformed field through its own default; never erase other
// restrictions because one field is invalid or a newer writer added a key.
export const SessionAgentSpawnPolicyV1Schema = lazyZodSchema(() => z.preprocess((raw) => {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(SessionAgentSpawnPolicyV1StrictSchema.shape).map(([key, schema]) => [
    key, schema.safeParse(record[key]).success ? record[key] : undefined,
  ]));
}, SessionAgentSpawnPolicyV1StrictSchema.strip()));

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
  mcpSelection?: boolean;
  transcriptStorage?: boolean;
  requiredPermissionMode?: unknown;
}>;
