import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { FEATURE_ID_ENUM } from './featureIds.js';

export const FeatureStateSchema = lazyZodSchema(() => z.enum(['enabled', 'disabled', 'unsupported', 'unknown']));
export type FeatureState = z.infer<typeof FeatureStateSchema>;

export const FeatureAxisSchema = lazyZodSchema(() => z.enum(['client', 'build_policy', 'local_policy', 'server', 'daemon', 'scope', 'dependency']));
export type FeatureAxis = z.infer<typeof FeatureAxisSchema>;

export const FeatureBlockerCodeSchema = lazyZodSchema(() => z.enum([
  'none',
  'not_implemented',
  'build_disabled',
  'flag_disabled',
  'endpoint_missing',
  'feature_disabled',
  'capability_missing',
  'probe_failed',
  'mixed_scope_support',
  'misconfigured',
  'dependency_disabled',
  'dependency_unknown',
]));
export type FeatureBlockerCode = z.infer<typeof FeatureBlockerCodeSchema>;

export const FeatureDecisionScopeSchema = lazyZodSchema(() => z.object({
  scopeKind: z.enum(['runtime', 'main_selection', 'spawn']),
  serverId: z.optional(z.string().check(z.minLength(1))),
  machineId: z.optional(z.string().check(z.minLength(1))),
}));
export type FeatureDecisionScope = z.infer<typeof FeatureDecisionScopeSchema>;

export const FeatureDecisionSchema = lazyZodSchema(() => z
  .object({
    featureId: z.enum(FEATURE_ID_ENUM),
    state: FeatureStateSchema,
    blockedBy: z.nullable(FeatureAxisSchema),
    blockerCode: FeatureBlockerCodeSchema,
    diagnostics: z.array(z.string()),
    evaluatedAt: z.number().check(z.int(), z.nonnegative()),
    scope: FeatureDecisionScopeSchema,
    /**
     * The dependency that decided a `blockedBy: 'dependency'` state (additive, set only by
     * `applyFeatureDependencies`): the first disabled dependency, else the first unknown one.
     * The `dependency:<id>:<state>` diagnostics strings stay for humans; clients read this field.
     */
    blockingDependencyId: z.optional(z.enum(FEATURE_ID_ENUM)),
  }).check(z.superRefine((value, ctx) => {
    if (value.blockingDependencyId !== undefined && value.blockedBy !== 'dependency') {
      ctx.addIssue({
        code: "custom",
        path: ['blockingDependencyId'],
        message: 'blockingDependencyId is set only on decisions blocked by a dependency',
      });
    }
    if (value.state === 'enabled') {
      if (value.blockedBy !== null) {
        ctx.addIssue({
          code: "custom",
          path: ['blockedBy'],
          message: 'enabled feature decisions must not have blockedBy set',
        });
      }
      if (value.blockerCode !== 'none') {
        ctx.addIssue({
          code: "custom",
          path: ['blockerCode'],
          message: 'enabled feature decisions must use blockerCode=none',
        });
      }
    }
  })));

export type FeatureDecision = z.infer<typeof FeatureDecisionSchema>;

export function createFeatureDecision(input: FeatureDecision): FeatureDecision {
  return FeatureDecisionSchema.parse(input);
}
