import { z } from 'zod';

export const E2eScenarioTierSchema = z.enum(['smoke', 'extended']);
export const E2eProviderLaneScopeSchema = z.enum(['acp-only', 'declared-scenarios']);
export const E2eProviderDefaultRuntimePathSchema = z.enum(['provider-lane', 'appServer']);
export const E2eProviderAppServerCoverageSchema = z.enum(['excluded', 'not-applicable', 'capability-contract']);
export const E2eProviderAppServerCapabilitySurfaceSchema = z.enum(['modes', 'models', 'speed', 'rollback']);

const TierListsSchema = z.object({
  smoke: z.array(z.string().min(1)),
  extended: z.array(z.string().min(1)),
});

const CoverageExpectationSchema = z.object({
  providerLaneScope: E2eProviderLaneScopeSchema,
  defaultRuntimePath: E2eProviderDefaultRuntimePathSchema,
  appServerCoverage: E2eProviderAppServerCoverageSchema,
  appServerCapabilitySurfaces: z.array(E2eProviderAppServerCapabilitySurfaceSchema).optional(),
});

export const E2eCliProviderScenarioRegistryV1Schema = z.object({
  v: z.literal(1),
  tiers: TierListsSchema,
  coverageExpectation: CoverageExpectationSchema.optional(),
  /**
   * Optional scenario tier overrides keyed by the provider auth mode.
   *
   * This is useful for providers where some scenarios require API-key auth (CI),
   * but local runs can reuse user CLI auth state. In that case, the default `tiers`
   * can represent the local (host) run, and the env-mode overrides can add extra
   * scenarios that only make sense under API-key auth.
   */
  tiersByAuthMode: z
    .object({
      host: TierListsSchema,
      env: TierListsSchema,
    })
    .partial()
    .optional(),
});

export type E2eCliProviderScenarioRegistryV1 = z.infer<typeof E2eCliProviderScenarioRegistryV1Schema>;
