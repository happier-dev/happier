import { z } from 'zod';

import {
  BackendTargetKeyV2InputSchema,
  normalizeBackendTargetKeyV2Input,
} from '../../backends/targets/backendTargetRefV2.js';
import { CodingPromptBehaviorOverridesV1Schema } from '../../prompts/codingPromptBehaviorV1.js';
import { SessionModelSelectionV1Schema } from '../../providers/selection/v1.js';
import { SessionExecutionTargetV1Schema } from '../../sessions/creation/sessionSpawnNewResultV1.js';
import { SESSION_PERMISSION_MODES } from '../../sessions/metadata/sessionPermissionModes.js';
import { EnvironmentVariableSchema, EnvVarRequirementSchema } from '../environmentVariables.js';

/**
 * Canonical minimum of routing/auth/model selectors that a launch profile may
 * never own. Agent runtime projections may add more reserved keys at mutation
 * time; the spawn composer remains the final enforcement boundary.
 */
export const LEGACY_AI_LAUNCH_RESERVED_ENV_NAMES_V1 = Object.freeze(new Set([
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL',
  'AZURE_OPENAI_API_KEY',
  'DEEPSEEK_BASE_URL', 'DEEPSEEK_AUTH_TOKEN', 'DEEPSEEK_MODEL',
  'Z_AI_BASE_URL', 'Z_AI_AUTH_TOKEN', 'Z_AI_MODEL',
  'GEMINI_API_KEY', 'GEMINI_MODEL', 'GOOGLE_GENAI_USE_VERTEXAI',
]));

const LaunchProfileModelSelectionV1Schema = z.preprocess((value) => {
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
}, SessionModelSelectionV1Schema);

/**
 * Where a Session authored from this profile should run. This is a
 * PREFERENCE, never a stored resolution: `automatic` is resolved at launch
 * against the persisted project registry, `ask` always prefills the New
 * Session screen, and `fixed` names one execution target. A directory is
 * only expressible inside `fixed`, so a profile cannot carry a path that
 * contradicts — or outlives — the machine it belongs to.
 */
export const LaunchProfilePlacementPreferenceV1Schema = z.union([
  z.literal('automatic'),
  z.literal('ask'),
  z.object({
    fixed: SessionExecutionTargetV1Schema,
    directory: z.string().trim().min(1).max(10_000).optional(),
  }).strict(),
]);
export type LaunchProfilePlacementPreferenceV1 = z.infer<typeof LaunchProfilePlacementPreferenceV1Schema>;

/**
 * How a Session authored from this profile should obtain its checkout.
 * A preference, resolved against the selected project's real worktrees at
 * launch; it stores no worktree identity or path.
 */
export const LaunchProfileCheckoutPreferenceV1Schema = z.enum([
  'reuse_workspace',
  'create_worktree',
  'ask',
]);
export type LaunchProfileCheckoutPreferenceV1 = z.infer<typeof LaunchProfileCheckoutPreferenceV1Schema>;

export const LaunchProfileV2Schema = z.object({
  v: z.literal(2),
  id: z.string().trim().min(1).max(256),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).optional(),
  extraEnvironmentVariables: z.array(EnvironmentVariableSchema).max(256).default([]),
  envVarRequirements: z.array(EnvVarRequirementSchema).max(256).optional(),
  defaultPermissionModeByTargetKey: z.record(BackendTargetKeyV2InputSchema, z.enum(SESSION_PERMISSION_MODES)).default({}),
  defaultPersistenceModeByTargetKey: z.record(BackendTargetKeyV2InputSchema, z.enum(['persisted', 'direct'])).default({}),
  compatibilityByTargetKey: z.record(BackendTargetKeyV2InputSchema, z.boolean()).default({}),
  preferredAgentTargetKey: BackendTargetKeyV2InputSchema.optional(),
  preferredModelSelection: LaunchProfileModelSelectionV1Schema.optional(),
  placement: LaunchProfilePlacementPreferenceV1Schema.optional(),
  checkout: LaunchProfileCheckoutPreferenceV1Schema.optional(),
  codingPromptBehaviorOverrides: CodingPromptBehaviorOverridesV1Schema.optional(),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
}).strict().superRefine((profile, ctx) => {
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
});

export type LaunchProfileV2 = z.infer<typeof LaunchProfileV2Schema>;

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
