import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

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

const RequiresMachineLoginSchema = lazyZodSchema(() => z.string().check(z.minLength(1)));
const RequiresMachineLoginTargetKeySchema = BackendTargetKeyV2InputSchema;

const ProfileCompatibilitySchema = lazyZodSchema(() => z._default(z.record(z.string(), z.boolean()), {}));
const ProfileCompatibilityByTargetKeySchema = lazyZodSchema(() => z._default(z.record(z.union([BackendTargetKeyV2InputSchema, z.literal('agent:custom-acp'), z.literal('agent:customAcp')]), z.boolean()), {}));
const SessionTranscriptStorageModeSchema = lazyZodSchema(() => z.enum(['persisted', 'direct']));

export const AIBackendProfileSchema = lazyZodSchema(() => z.object({
  // Accept both UUIDs (user profiles) and simple strings (built-in profiles like 'anthropic').
  // The isBuiltIn field distinguishes profile types.
  id: z.string().check(z.minLength(1)),
  name: z.string().check(z.minLength(1), z.maxLength(100)),
  description: z.optional(z.string().check(z.maxLength(500))),

  // Environment variables (validated).
  environmentVariables: z._default(z.array(EnvironmentVariableSchema), []),

  // Legacy default permission mode for this profile (kept for backwards compatibility).
  defaultPermissionMode: z.optional(z.enum(SESSION_PERMISSION_MODES)),

  // Canonical per-target default permission mode overrides for new sessions when this profile is selected.
  defaultPermissionModeByTargetKey: z._default(z.record(BackendTargetKeyV2InputSchema, z.enum(SESSION_PERMISSION_MODES)), {}),

  // Deprecated per-agent default permission mode overrides. Kept temporarily while UI/CLI call sites migrate.
  defaultPermissionModeByAgent: z._default(z.record(z.string(), z.enum(SESSION_PERMISSION_MODES)), {}),

  // Canonical per-target transcript storage mode overrides for new sessions when this profile is selected.
  defaultPersistenceModeByTargetKey: z._default(z.record(BackendTargetKeyV2InputSchema, SessionTranscriptStorageModeSchema), {}),

  // Deprecated per-agent transcript storage mode overrides. Kept temporarily while UI/CLI call sites migrate.
  defaultPersistenceModeByAgent: z._default(z.record(z.string(), SessionTranscriptStorageModeSchema), {}),

  // Default model mode for this profile.
  defaultModelMode: z.optional(z.string()),

  // Retained 0.2 preference; current logical Profiles write preferredAgentTargetKey.
  defaultBackendTargetKey: z.optional(BackendTargetKeyV2InputSchema),

  // Canonical compatibility metadata.
  compatibilityByTargetKey: z._default(ProfileCompatibilityByTargetKeySchema, {}),

  // Deprecated compatibility metadata keyed by built-in agent id.
  compatibility: z._default(ProfileCompatibilitySchema, {}),

  // Authentication / requirements metadata (used by UI gating).
  // - machineLogin: profile relies on a machine-local CLI login cache
  authMode: z.optional(z.enum(['machineLogin'])),

  // Canonical machine-login requirement keyed by backend target key.
  requiresMachineLoginTargetKey: z.optional(RequiresMachineLoginTargetKeySchema),

  // Deprecated machine-login requirement stored as a machine login key string.
  requiresMachineLogin: z.optional(RequiresMachineLoginSchema),

  // Explicit environment variable requirements for this profile at runtime.
  // Secret requirements are satisfied by machine env, vault binding, or “enter once”.
  envVarRequirements: z._default(z.array(EnvVarRequirementSchema), []),

  // Built-in profile indicator.
  isBuiltIn: z._default(z.boolean(), false),

  // Whether this profile should appear in user-facing pickers by default.
  defaultEnabled: z._default(z.boolean(), true),

  // Metadata.
  createdAt: z._default(z.number(), () => Date.now()),
  updatedAt: z._default(z.number(), () => Date.now()),
  version: z._default(z.string(), '1.0.0'),

  // Reader-only predecessor field. The canonical collection reader projects
  // this to V2 codingPromptBehaviorOverrides; V2 is the sole writer.
  codingPromptBehaviorV1: z.optional(HistoricalCodingPromptBehaviorProfileOverrideV1Schema),
}).check(z.refine((profile) => {
    return !(profile.requiresMachineLoginTargetKey && profile.authMode !== 'machineLogin');
  }, {
    path: ['requiresMachineLoginTargetKey'],
    message: 'requiresMachineLoginTargetKey may only be set when authMode=machineLogin',
  }), z.refine((profile) => {
    return !(profile.requiresMachineLogin && profile.authMode !== 'machineLogin');
  }, {
    path: ['requiresMachineLogin'],
    message: 'requiresMachineLogin may only be set when authMode=machineLogin',
  })));

export type AIBackendProfile = z.infer<typeof AIBackendProfileSchema>;

export const SavedSecretSchema = lazyZodSchema(() => z.object({
  id: z.string().check(z.minLength(1)),
  name: z.string().check(z.minLength(1), z.maxLength(100)),
  kind: z._default(z.enum(['apiKey', 'token', 'password', 'other']), 'apiKey'),
  // Secret-at-rest container:
  // - plaintext is set via `encryptedValue.value` (input only; must not be persisted)
  // - ciphertext persists in `encryptedValue.encryptedValue`
  encryptedValue: SecretStringV1Schema,
  createdAt: z._default(z.number(), () => Date.now()),
  updatedAt: z._default(z.number(), () => Date.now()),
}).check(z.refine((key) => {
  const hasValue = typeof key.encryptedValue.value === 'string' && key.encryptedValue.value.length > 0;
  const hasEnc = Boolean(
    key.encryptedValue.encryptedValue
      && typeof key.encryptedValue.encryptedValue.c === 'string'
      && key.encryptedValue.encryptedValue.c.length > 0,
  );
  return hasValue || hasEnc;
}, {
  path: ['encryptedValue'],
  message: 'Secret must include a value or encrypted value',
})));

export type SavedSecret = z.infer<typeof SavedSecretSchema>;

/**
 * How many SavedSecret records the Account-Settings collection can carry.
 *
 * New writes share this ceiling with the SavedSecret mutation owner. Stored
 * predecessor collections remain readable above it and are never truncated.
 */
export const SAVED_SECRET_COLLECTION_MAX_ENTRIES = 256;

export function getProfileEnvironmentVariables(profile: AIBackendProfile): Record<string, string> {
  const envVars: Record<string, string> = {};

  for (const envVar of profile.environmentVariables) {
    envVars[envVar.name] = envVar.value;
  }

  return envVars;
}
