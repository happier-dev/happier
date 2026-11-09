import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import {
  BackendTargetKeyV2InputSchema,
  normalizeBackendTargetKeyV2Input,
} from '../../backends/targets/backendTargetRefV2.js';
import { CodingPromptBehaviorOverridesV1Schema } from '../../prompts/codingPromptBehaviorV1.js';
import { SessionModelSelectionV1Schema } from '../../providers/selection/v1.js';
import { LaunchProfilePlacementPreferenceV1Schema, LaunchProfileCheckoutPreferenceV1Schema } from '../launchPreferencesV1.js';
import { SESSION_PERMISSION_MODES } from '../../sessions/metadata/sessionPermissionModes.js';
import { EnvironmentVariableSchema, EnvVarRequirementSchema } from '../environmentVariables.js';
import { LaunchProfileIdV2Schema, ProfileRecordIdV1Schema } from './profileId.js';

/**
 * Canonical minimum of routing/auth/model selectors that a launch profile may
 * never own. Agent runtime projections may add more reserved keys at mutation
 * time; the spawn composer remains the final enforcement boundary.
 */
export const LEGACY_AI_LAUNCH_RESERVED_ENV_NAMES_V1 = Object.freeze(new Set([
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL',
  'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_API_VERSION',
  'DEEPSEEK_BASE_URL', 'DEEPSEEK_AUTH_TOKEN', 'DEEPSEEK_MODEL',
  'Z_AI_BASE_URL', 'Z_AI_AUTH_TOKEN', 'Z_AI_MODEL',
  'GEMINI_API_KEY', 'GEMINI_MODEL', 'GOOGLE_GENAI_USE_VERTEXAI',
]));

const LaunchProfileModelSelectionV1Schema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const ref = record.ref;
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return value;
  return {
    ...record,
    ref: {
      ...ref,
      agentTargetKey: normalizeBackendTargetKeyV2Input(
        (ref as Record<string, unknown>).agentTargetKey,
      ),
    },
  };
}), SessionModelSelectionV1Schema));

export {
  LaunchProfilePlacementPreferenceV1Schema, LaunchProfileCheckoutPreferenceV1Schema,
  LaunchProfilePlacementPreferenceV1ProtocolSchema, LaunchProfileCheckoutPreferenceV1ProtocolSchema,
  resolveLaunchProfilePlacementDirectoryIntentV1,
  type LaunchProfilePlacementPreferenceV1, type LaunchProfileCheckoutPreferenceV1,
} from '../launchPreferencesV1.js';

export const LaunchProfileV2Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(2),
  id: LaunchProfileIdV2Schema,
  name: z.string().check(z.trim(), z.minLength(1), z.maxLength(100)),
  description: z.optional(z.string().check(z.maxLength(500))),
  extraEnvironmentVariables: z._default(z.array(EnvironmentVariableSchema).check(z.maxLength(256)), []),
  envVarRequirements: z.optional(z.array(EnvVarRequirementSchema).check(z.maxLength(256))),
  defaultPermissionModeByTargetKey: z._default(z.record(BackendTargetKeyV2InputSchema, z.enum(SESSION_PERMISSION_MODES)), {}),
  defaultPersistenceModeByTargetKey: z._default(z.record(BackendTargetKeyV2InputSchema, z.enum(['persisted', 'direct'])), {}),
  compatibilityByTargetKey: z._default(z.record(BackendTargetKeyV2InputSchema, z.boolean()), {}),
  preferredAgentTargetKey: z.optional(BackendTargetKeyV2InputSchema),
  preferredModelSelection: z.optional(LaunchProfileModelSelectionV1Schema),
  placement: z.optional(LaunchProfilePlacementPreferenceV1Schema),
  checkout: z.optional(LaunchProfileCheckoutPreferenceV1Schema),
  codingPromptBehaviorOverrides: z.optional(CodingPromptBehaviorOverridesV1Schema),
  createdAt: z.number().check(z.nonnegative()),
  updatedAt: z.number().check(z.nonnegative()),
}).check(z.superRefine((profile, ctx) => {
  if (profile.preferredAgentTargetKey !== undefined
    && profile.preferredModelSelection !== undefined
    && profile.preferredAgentTargetKey !== profile.preferredModelSelection.ref.agentTargetKey) {
    ctx.addIssue({
      code: 'custom',
      path: ['preferredModelSelection', 'ref', 'agentTargetKey'],
      message: 'Preferred model selection must target the preferred agent',
    });
  }
  const seen = new Set<string>();
  profile.extraEnvironmentVariables.forEach((entry, index) => {
    if (seen.has(entry.name)) {
      ctx.addIssue({ code: 'custom', path: ['extraEnvironmentVariables', index, 'name'], message: 'Duplicate environment variable' });
    }
    seen.add(entry.name);
    if (LEGACY_AI_LAUNCH_RESERVED_ENV_NAMES_V1.has(entry.name)) {
      ctx.addIssue({ code: 'custom', path: ['extraEnvironmentVariables', index, 'name'], message: 'Environment variable is owned by agent/provider routing' });
    }
  });
  const requirementNames = new Set<string>();
  (profile.envVarRequirements ?? []).forEach((entry, index) => {
    if (requirementNames.has(entry.name)) {
      ctx.addIssue({ code: 'custom', path: ['envVarRequirements', index, 'name'], message: 'Duplicate environment requirement' });
    }
    requirementNames.add(entry.name);
    if (LEGACY_AI_LAUNCH_RESERVED_ENV_NAMES_V1.has(entry.name)) {
      ctx.addIssue({ code: 'custom', path: ['envVarRequirements', index, 'name'], message: 'Environment requirement is owned by agent/provider routing' });
    }
  });
})));

export type LaunchProfileV2 = z.infer<typeof LaunchProfileV2Schema>;

/** Representation changes retain admitted predecessor identity and environment sizes;
 * safeExtend preserves the sole owner's routing, uniqueness and target refinements.
 * New logical Profile authoring continues to use LaunchProfileV2Schema;
 * publication retains the admitted body's identity through this schema. */
export const StoredLaunchProfileV2Schema = lazyZodSchema(() => z.safeExtend(LaunchProfileV2Schema, {
  id: ProfileRecordIdV1Schema,
  name: z.string().check(z.minLength(1), z.maxLength(100)),
  extraEnvironmentVariables: z._default(z.array(EnvironmentVariableSchema), []),
  envVarRequirements: z.optional(z.array(EnvVarRequirementSchema)),
}));

export function validateLaunchProfileV2ReservedEnvironment(
  profile: LaunchProfileV2,
  reservedEnvironmentVariableNames: ReadonlySet<string>,
): void {
  for (const entry of profile.extraEnvironmentVariables) {
    if (reservedEnvironmentVariableNames.has(entry.name)) {
      throw new Error(`Profile environment variable ${entry.name} is reserved by the selected agent runtime`);
    }
  }
  for (const requirement of profile.envVarRequirements ?? []) {
    if (reservedEnvironmentVariableNames.has(requirement.name)) {
      throw new Error(`Profile environment requirement ${requirement.name} is reserved by the selected agent runtime`);
    }
  }
}
