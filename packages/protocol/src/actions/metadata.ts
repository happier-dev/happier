import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

export {
  ActionInputHintsSchema,
  type ActionInputHints,
} from './actionInputHints.js';

export const ActionSurfaceSchema = lazyZodSchema(() => z.object({
  ui: z.boolean(),
  voice: z.boolean(),
  agent: z.boolean(),
  mcp: z.boolean(),
  cli: z.boolean(),
  rpc: z.boolean(),
  api: z.boolean(),
  plugin: z.boolean(),
}).strict());
export type ActionSurfaces = z.infer<typeof ActionSurfaceSchema>;

/**
 * Host-stamped authority required to admit a host Action. This is deliberately
 * independent from the transport/surface: a PAT and a trusted Plugin carry
 * automation authority, while an interactive host path can carry a present
 * user. Action input never carries this fact.
 */
export const ActionRequiredAuthoritySchema = lazyZodSchema(() => z.enum(['account_automation', 'present_user']));
export type ActionRequiredAuthority = z.infer<typeof ActionRequiredAuthoritySchema>;

/**
 * Canonical owner used by external ingress to resolve an Action's execution
 * target. The target itself remains host routing metadata rather than Action
 * input; `client` executes through the connected app after canonical admission.
 */
export const ActionExecutionPlacementSchema = lazyZodSchema(() => z.enum(['account', 'machine', 'session', 'client']));
export type ActionExecutionPlacement = z.infer<typeof ActionExecutionPlacementSchema>;

export const ActionToolExposureModeSchema = lazyZodSchema(() => z.enum(['direct', 'discoverable_only']));
export type ActionToolExposureMode = z.infer<typeof ActionToolExposureModeSchema>;

export const ActionToolExposureSurfaceSchema = lazyZodSchema(() => z.enum(['agent', 'mcp', 'cli']));
export type ActionToolExposureSurface = z.infer<typeof ActionToolExposureSurfaceSchema>;

export const ActionToolExposureSchema = lazyZodSchema(() => z
  .object({
    agent: ActionToolExposureModeSchema.optional(),
    mcp: ActionToolExposureModeSchema.optional(),
    cli: ActionToolExposureModeSchema.optional(),
  })
  .strict());
export type ActionToolExposure = z.infer<typeof ActionToolExposureSchema>;
