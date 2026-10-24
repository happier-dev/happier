import { z } from 'zod';

import { SecretStringV1Schema } from '../crypto/settingsSecretStringsV1.js';

/**
 * How a configured analysis endpoint bills a request. The daemon never infers "free" from a
 * provider name: a provider is free only when the user declared it so or a live catalog reports a
 * zero price for the selected model.
 *
 * - `free`: no per-request charge (free tier, free model, or local endpoint).
 * - `subscription`: covered by a paid plan (for example OpenCode Go); never treated as free.
 * - `paid`: metered per token.
 */
export const CodeIntelligenceBillingClassV1Schema = z.enum(['free', 'subscription', 'paid']);
export type CodeIntelligenceBillingClassV1 = z.infer<typeof CodeIntelligenceBillingClassV1Schema>;

export const CodeIntelligenceAnalysisProviderKindV1Schema = z.enum([
  'groq',
  'openrouter',
  'opencode_zen',
  'opencode_go',
  'openai_compatible',
]);
export type CodeIntelligenceAnalysisProviderKindV1 = z.infer<typeof CodeIntelligenceAnalysisProviderKindV1Schema>;

export const CodeIntelligenceAnalysisProviderV1Schema = z
  .object({
    id: z.string().trim().min(1).max(200),
    kind: CodeIntelligenceAnalysisProviderKindV1Schema,
    enabled: z.boolean().default(true),
    /** Required for `openai_compatible`; other kinds use their documented default endpoint when null. */
    baseUrl: z.string().trim().url().nullable().default(null),
    apiKey: SecretStringV1Schema.nullable().default(null),
    modelId: z.string().trim().min(1).max(500),
    /** User-declared billing class. Undeclared means `paid`, so nothing is ever assumed free. */
    billing: CodeIntelligenceBillingClassV1Schema.default('paid'),
    /** USD per million tokens, used only for estimates and budget enforcement of non-free models. */
    inputPricePerMillionUsd: z.number().min(0).nullable().default(null),
    outputPricePerMillionUsd: z.number().min(0).nullable().default(null),
  })
  .passthrough()
  .superRefine((provider, ctx) => {
    if (provider.kind === 'openai_compatible' && !provider.baseUrl) {
      ctx.addIssue({ code: 'custom', message: 'baseUrl is required for openai_compatible providers', path: ['baseUrl'] });
    }
  });
export type CodeIntelligenceAnalysisProviderV1 = z.infer<typeof CodeIntelligenceAnalysisProviderV1Schema>;

export const CodeIntelligenceRoutingPolicyV1Schema = z.enum([
  'free_only',
  'free_and_subscription',
  'lowest_cost',
  'manual',
]);
export type CodeIntelligenceRoutingPolicyV1 = z.infer<typeof CodeIntelligenceRoutingPolicyV1Schema>;

export const CodeIntelligenceRemoteAnalysisSettingsV1Schema = z
  .object({
    /** Global consent to send bounded, redacted diffs to a configured remote model. */
    enabled: z.boolean().default(false),
    /** Repositories that may be analyzed remotely. Empty means none, even when `enabled`. */
    allowedRepositoryIds: z.array(z.string().min(1).max(200)).max(1000).default([]),
    routingPolicy: CodeIntelligenceRoutingPolicyV1Schema.default('free_only'),
    /** Paid models are never selected unless this is true and a positive monthly budget exists. */
    allowPaid: z.boolean().default(false),
    monthlyBudgetUsd: z.number().min(0).max(100_000).default(0),
    providers: z.array(CodeIntelligenceAnalysisProviderV1Schema).max(32).default([]),
  })
  .passthrough();
export type CodeIntelligenceRemoteAnalysisSettingsV1 = z.infer<typeof CodeIntelligenceRemoteAnalysisSettingsV1Schema>;

export const CodeIntelligenceSettingsV1Schema = z
  .object({
    v: z.literal(1).default(1),
    /** Master switch for background observation; local-only and off until the user opts in. */
    enabled: z.boolean().default(false),
    /** Observe sessions started outside Happier through the direct-sessions provider stores. */
    externalSessionDiscovery: z.boolean().default(true),
    // Repository-relative path prefixes never scanned or sent for analysis; `*`, `**` and `?` act
    // as globs (for example `**/secrets/`).
    excludedPathPrefixes: z.array(z.string().trim().min(1).max(1000)).max(200).default([]),
    /** Activity events and commit observations older than this are pruned from the local store. */
    retentionDays: z.number().int().min(1).max(3650).default(30),
    remoteAnalysis: CodeIntelligenceRemoteAnalysisSettingsV1Schema.default(() =>
      CodeIntelligenceRemoteAnalysisSettingsV1Schema.parse({})),
  })
  .passthrough();
export type CodeIntelligenceSettingsV1 = z.infer<typeof CodeIntelligenceSettingsV1Schema>;

export const DEFAULT_CODE_INTELLIGENCE_SETTINGS: CodeIntelligenceSettingsV1 = CodeIntelligenceSettingsV1Schema.parse({});

/**
 * Malformed persisted settings degrade to the fail-closed defaults instead of throwing. Writes must
 * not use this: an invalid update is rejected with `CodeIntelligenceSettingsV1Schema.parse` so it
 * can never silently reset a user's configuration.
 */
export function normalizeCodeIntelligenceSettings(raw: unknown): CodeIntelligenceSettingsV1 {
  const parsed = CodeIntelligenceSettingsV1Schema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_CODE_INTELLIGENCE_SETTINGS;
}

/**
 * Settings returned to clients never carry key material: secrets are replaced by a presence
 * marker so a UI can show "configured" without the daemon handing out the key.
 */
export function redactCodeIntelligenceSettingsSecrets(settings: CodeIntelligenceSettingsV1): CodeIntelligenceSettingsV1 {
  return {
    ...settings,
    remoteAnalysis: {
      ...settings.remoteAnalysis,
      providers: settings.remoteAnalysis.providers.map((provider) => ({
        ...provider,
        apiKey: provider.apiKey ? { _isSecretValue: true } : null,
      })),
    },
  };
}
