import { z } from 'zod';

import { BackendTargetKeySchema } from '../backendTargets/backendTargetRef.js';
import { SecretStringV1Schema } from '../crypto/settingsSecretStringsV1.js';
import { SESSION_PERMISSION_MODES } from '../sessionMetadata/sessionPermissionModes.js';

const ENV_VAR_NAME_REGEX = /^[A-Z_][A-Z0-9_]*$/;

export const EnvironmentVariableSchema = z.object({
  name: z.string().regex(ENV_VAR_NAME_REGEX, 'Invalid environment variable name'),
  value: z.string(),
  // User override:
  // - true: force secret handling in UI (and hint daemon)
  // - false: force non-secret handling in UI (unless daemon enforces)
  // - undefined: auto classification
  isSecret: z.boolean().optional(),
});

export type EnvironmentVariable = z.infer<typeof EnvironmentVariableSchema>;

const RequiredEnvVarKindSchema = z.enum(['secret', 'config']);

export const EnvVarRequirementSchema = z.object({
  name: z.string().regex(ENV_VAR_NAME_REGEX, 'Invalid environment variable name'),
  kind: RequiredEnvVarKindSchema.default('secret'),
  // Required=true blocks session creation when unsatisfied.
  // Required=false is “optional” (still useful for vault binding, but does not block).
  required: z.boolean().default(true),
});

export type EnvVarRequirement = z.infer<typeof EnvVarRequirementSchema>;

const RequiresMachineLoginSchema = z.string().min(1);
const RequiresMachineLoginTargetKeySchema = BackendTargetKeySchema;

const ProfileCompatibilitySchema = z.record(z.string(), z.boolean()).default({});
const ProfileCompatibilityByTargetKeySchema = z.record(BackendTargetKeySchema, z.boolean()).default({});
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
  defaultPermissionModeByTargetKey: z.record(BackendTargetKeySchema, z.enum(SESSION_PERMISSION_MODES)).default({}),

  // Deprecated per-agent default permission mode overrides. Kept temporarily while UI/CLI call sites migrate.
  defaultPermissionModeByAgent: z.record(z.string(), z.enum(SESSION_PERMISSION_MODES)).default({}),

  // Canonical per-target transcript storage mode overrides for new sessions when this profile is selected.
  defaultPersistenceModeByTargetKey: z.record(BackendTargetKeySchema, SessionTranscriptStorageModeSchema).default({}),

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

export function getProfileEnvironmentVariables(profile: AIBackendProfile): Record<string, string> {
  const envVars: Record<string, string> = {};

  for (const envVar of profile.environmentVariables) {
    envVars[envVar.name] = envVar.value;
  }

  return envVars;
}
