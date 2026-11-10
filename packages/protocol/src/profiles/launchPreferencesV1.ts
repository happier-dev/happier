import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { SessionDirectoryIntentV1Schema, type SessionDirectoryIntentV1 } from '../sessions/creation/sessionDirectoryIntentV1.js';
import { SessionExecutionTargetV1Schema } from '../sessions/creation/sessionExecutionTargetV1.js';

/** A launch preference, resolved against reachable execution targets at launch. */
export const LaunchProfilePlacementPreferenceV1Schema = lazyZodSchema(() => z.union([
  z.literal('automatic'),
  z.literal('ask'),
  z.strictObject({
    fixed: SessionExecutionTargetV1Schema,
    directory: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(10_000))),
    directoryIntent: z.optional(SessionDirectoryIntentV1Schema),
  }).check(z.refine(value => value.directory === undefined || value.directoryIntent === undefined, {
    message: 'Choose a directory intent or a legacy directory path', path: ['directoryIntent'],
  })),
]));
export type LaunchProfilePlacementPreferenceV1 = z.infer<typeof LaunchProfilePlacementPreferenceV1Schema>;

/** A checkout preference, never a stored worktree identity. */
export const LaunchProfileCheckoutPreferenceV1Schema = lazyZodSchema(() => z.enum([
  'reuse_workspace',
  'create_worktree',
  'ask',
]));
export type LaunchProfileCheckoutPreferenceV1 = z.infer<typeof LaunchProfileCheckoutPreferenceV1Schema>;

export const LaunchProfilePlacementPreferenceV1ProtocolSchema = projectZodProtocolSchema(LaunchProfilePlacementPreferenceV1Schema);
export const LaunchProfileCheckoutPreferenceV1ProtocolSchema = projectZodProtocolSchema(LaunchProfileCheckoutPreferenceV1Schema);

/** Resolve the retained path spelling once; consumers use the directory-intent owner. */
export function resolveLaunchProfilePlacementDirectoryIntentV1(
  placement: LaunchProfilePlacementPreferenceV1 | null | undefined,
): SessionDirectoryIntentV1 | undefined {
  if (!placement || typeof placement === 'string') return undefined;
  return placement.directoryIntent ?? (placement.directory === undefined ? undefined : { kind: 'path', path: placement.directory });
}
