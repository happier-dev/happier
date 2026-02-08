import { z } from 'zod';

export const E2eScenarioTierSchema = z.enum(['smoke', 'extended']);

const TierListsSchema = z.object({
  smoke: z.array(z.string().min(1)),
  extended: z.array(z.string().min(1)),
});

export const E2eCliProviderScenarioRegistryV1Schema = z.object({
  v: z.literal(1),
  tiers: TierListsSchema,
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
