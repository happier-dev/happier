import { z } from 'zod';
import { FEATURE_ID_ENUM } from './featureIds.js';

export const FeatureStateSchema = z.enum(['enabled', 'disabled', 'unsupported', 'unknown']);
export type FeatureState = z.infer<typeof FeatureStateSchema>;

export const FeatureAxisSchema = z.enum(['client', 'build_policy', 'local_policy', 'server', 'daemon', 'scope', 'dependency']);
export type FeatureAxis = z.infer<typeof FeatureAxisSchema>;

export const FeatureBlockerCodeSchema = z.enum([
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
]);
export type FeatureBlockerCode = z.infer<typeof FeatureBlockerCodeSchema>;

export const FeatureDecisionScopeSchema = z.object({
  scopeKind: z.enum(['runtime', 'main_selection', 'spawn']),
  serverId: z.string().min(1).optional(),
  machineId: z.string().min(1).optional(),
});
export type FeatureDecisionScope = z.infer<typeof FeatureDecisionScopeSchema>;

export const FeatureDecisionSchema = z
  .object({
    featureId: z.enum(FEATURE_ID_ENUM),
    state: FeatureStateSchema,
    blockedBy: FeatureAxisSchema.nullable(),
    blockerCode: FeatureBlockerCodeSchema,
    diagnostics: z.array(z.string()),
    evaluatedAt: z.number().int().nonnegative(),
    scope: FeatureDecisionScopeSchema,
  })
  .superRefine((value, ctx) => {
    if (value.state === 'enabled') {
      if (value.blockedBy !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['blockedBy'],
          message: 'enabled feature decisions must not have blockedBy set',
        });
      }
      if (value.blockerCode !== 'none') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['blockerCode'],
          message: 'enabled feature decisions must use blockerCode=none',
        });
      }
    }
  });

export type FeatureDecision = z.infer<typeof FeatureDecisionSchema>;

export function createFeatureDecision(input: FeatureDecision): FeatureDecision {
  return FeatureDecisionSchema.parse(input);
}
