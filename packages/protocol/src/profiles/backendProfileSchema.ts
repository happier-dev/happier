import { z } from 'zod';

import { BackendTargetKeyV2InputSchema } from '../backends/targets/backendTargetRefV2.js';
import { SecretStringV1Schema } from '../crypto/settingsSecretStringSchemasV1.js';
import { HistoricalCodingPromptBehaviorProfileOverrideV1Schema } from '../prompts/codingPromptBehaviorV1.js';
import { SESSION_PERMISSION_MODES } from '../sessions/metadata/sessionPermissionModes.js';
import {
  EnvironmentVariableSchema,
  EnvVarRequirementSchema,
} from './environmentVariables.js';

export {
  EnvironmentVariableSchema,
  EnvVarRequirementSchema,
  type EnvironmentVariable,
  type EnvVarRequirement,
} from './environmentVariables.js';

const RequiresMachineLoginSchema = z.string().min(1);
const RequiresMachineLoginTargetKeySchema = BackendTargetKeyV2InputSchema;

const ProfileCompatibilitySchema = z.record(z.string(), z.boolean()).default({});
const ProfileCompatibilityByTargetKeySchema = z.record(BackendTargetKeyV2InputSchema, z.boolean()).default({});
const SessionTranscriptStorageModeSchema = z.enum(['persisted', 'direct']);

export const AIBackendProfileSchema = z.object({
  // Accept both UUIDs (user profiles) and simple strings (built-in profiles like 'anthropic').
  // The isBuiltIn field distinguishes profile types.
  id: z.string().min(1),
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),

  // Environment variables (validated).
  environmentVariables: z.array(EnvironmentVariableSchema).default([]),

  // Legacy default permission mode for this profile (kept for backwards compatibility).
  defaultPermissionMode: z.enum(SESSION_PERMISSION_MODES).optional(),

  // Canonical per-target default permission mode overrides for new sessions when this profile is selected.
  defaultPermissionModeByTargetKey: z.record(BackendTargetKeyV2InputSchema, z.enum(SESSION_PERMISSION_MODES)).default({}),

  // Deprecated per-agent default permission mode overrides. Kept temporarily while UI/CLI call sites migrate.
  defaultPermissionModeByAgent: z.record(z.string(), z.enum(SESSION_PERMISSION_MODES)).default({}),

  // Canonical per-target transcript storage mode overrides for new sessions when this profile is selected.
  defaultPersistenceModeByTargetKey: z.record(BackendTargetKeyV2InputSchema, SessionTranscriptStorageModeSchema).default({}),

  // Deprecated per-agent transcript storage mode overrides. Kept temporarily while UI/CLI call sites migrate.
  defaultPersistenceModeByAgent: z.record(z.string(), SessionTranscriptStorageModeSchema).default({}),

  // Default model mode for this profile.
  defaultModelMode: z.string().optional(),

  // Canonical compatibility metadata.
  compatibilityByTargetKey: ProfileCompatibilityByTargetKeySchema.default({}),

  // Deprecated compatibility metadata keyed by built-in agent id.
  compatibility: ProfileCompatibilitySchema.default({}),

  // Authentication / requirements metadata (used by UI gating).
  // - machineLogin: profile relies on a machine-local CLI login cache
  authMode: z.enum(['machineLogin']).optional(),

  // Canonical machine-login requirement keyed by backend target key.
  requiresMachineLoginTargetKey: RequiresMachineLoginTargetKeySchema.optional(),

  // Deprecated machine-login requirement stored as a machine login key string.
  requiresMachineLogin: RequiresMachineLoginSchema.optional(),

  // Explicit environment variable requirements for this profile at runtime.
  // Secret requirements are satisfied by machine env, vault binding, or “enter once”.
  envVarRequirements: z.array(EnvVarRequirementSchema).default([]),

  // Built-in profile indicator.
  isBuiltIn: z.boolean().default(false),

  // Whether this profile should appear in user-facing pickers by default.
  defaultEnabled: z.boolean().default(true),

  // Metadata.
  createdAt: z.number().default(() => Date.now()),
  updatedAt: z.number().default(() => Date.now()),
  version: z.string().default('1.0.0'),

  // Reader-only predecessor field. The canonical collection reader projects
  // this to V2 codingPromptBehaviorOverrides; V2 is the sole writer.
  codingPromptBehaviorV1: HistoricalCodingPromptBehaviorProfileOverrideV1Schema.optional(),
})
  // NOTE: Zod v4 marks `superRefine` as deprecated in favor of `.check(...)`.
  // We use chained `.refine(...)` here to preserve per-field error paths/messages.
  .refine((profile) => {
    return !(profile.requiresMachineLoginTargetKey && profile.authMode !== 'machineLogin');
  }, {
    path: ['requiresMachineLoginTargetKey'],
    message: 'requiresMachineLoginTargetKey may only be set when authMode=machineLogin',
  })
  .refine((profile) => {
    return !(profile.requiresMachineLogin && profile.authMode !== 'machineLogin');
  }, {
    path: ['requiresMachineLogin'],
    message: 'requiresMachineLogin may only be set when authMode=machineLogin',
  });

export type AIBackendProfile = z.infer<typeof AIBackendProfileSchema>;

export const SavedSecretSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(100),
  kind: z.enum(['apiKey', 'token', 'password', 'other']).default('apiKey'),
  // Secret-at-rest container:
  // - plaintext is set via `encryptedValue.value` (input only; must not be persisted)
  // - ciphertext persists in `encryptedValue.encryptedValue`
  encryptedValue: SecretStringV1Schema,
  createdAt: z.number().default(() => Date.now()),
  updatedAt: z.number().default(() => Date.now()),
}).refine((key) => {
  const hasValue = typeof key.encryptedValue.value === 'string' && key.encryptedValue.value.trim().length > 0;
  const hasEnc = Boolean(
    key.encryptedValue.encryptedValue
      && typeof key.encryptedValue.encryptedValue.c === 'string'
      && key.encryptedValue.encryptedValue.c.length > 0,
  );
  return hasValue || hasEnc;
}, {
  path: ['encryptedValue'],
  message: 'Secret must include a value or encrypted value',
});

export type SavedSecret = z.infer<typeof SavedSecretSchema>;

/**
 * How many SavedSecret records the Account-Settings collection can carry.
 *
 * The canonical Account-Settings reader parses at most this many entries, so a
 * write that stores more persists records no reader can ever resolve. The
 * SavedSecret mutation owner refuses such a write rather than accepting it and
 * letting the read truncate; both must therefore read the ceiling from here.
 */
export const SAVED_SECRET_COLLECTION_MAX_ENTRIES = 256;

export function getProfileEnvironmentVariables(profile: AIBackendProfile): Record<string, string> {
  const envVars: Record<string, string> = {};

  for (const envVar of profile.environmentVariables) {
    envVars[envVar.name] = envVar.value;
  }

  return envVars;
}
