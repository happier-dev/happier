import { z } from 'zod';
import { normalizeBugReportProviderUrl } from './bugReports/sanitize.js';

export const OAuthProviderStatusSchema = z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
});

export type OAuthProviderStatus = z.infer<typeof OAuthProviderStatusSchema>;

export const BugReportsFeatureSchema = z.object({
  enabled: z.boolean(),
  providerUrl: z.string().url().nullable(),
  defaultIncludeDiagnostics: z.boolean(),
  maxArtifactBytes: z.number().int().positive(),
  acceptedArtifactKinds: z.array(z.string().min(1)).min(1),
  uploadTimeoutMs: z.number().int().positive(),
  contextWindowMs: z.number().int().min(1000).max(24 * 60 * 60 * 1000),
});

export type BugReportsFeature = z.infer<typeof BugReportsFeatureSchema>;

export const BUG_REPORT_DEFAULT_ACCEPTED_ARTIFACT_KINDS = [
  'ui-mobile',
  'ui-desktop',
  'cli',
  'daemon',
  'server',
  'stack-service',
  'user-note',
] as const;

export const BUG_REPORT_DEFAULT_CONTEXT_WINDOW_MS = 30 * 60 * 1000;

export const DEFAULT_BUG_REPORTS_FEATURE: BugReportsFeature = {
  enabled: false,
  providerUrl: null,
  defaultIncludeDiagnostics: true,
  maxArtifactBytes: 10 * 1024 * 1024,
  acceptedArtifactKinds: [...BUG_REPORT_DEFAULT_ACCEPTED_ARTIFACT_KINDS],
  uploadTimeoutMs: 120000,
  contextWindowMs: BUG_REPORT_DEFAULT_CONTEXT_WINDOW_MS,
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

export function coerceBugReportsFeatureFromFeaturesPayload(payload: unknown): BugReportsFeature {
  const features = isRecord(payload) && isRecord(payload.features) ? payload.features : null;
  const bugReports = features && isRecord(features.bugReports) ? features.bugReports : null;
  if (!bugReports) return DEFAULT_BUG_REPORTS_FEATURE;

  const providerRaw = bugReports.providerUrl;
  const providerUrl = normalizeBugReportProviderUrl(typeof providerRaw === 'string' ? providerRaw : null);
  if (typeof providerRaw === 'string' && providerRaw.trim() && !providerUrl) {
    return DEFAULT_BUG_REPORTS_FEATURE;
  }

  const maxArtifactBytesRaw = Number(bugReports.maxArtifactBytes);
  const uploadTimeoutMsRaw = Number(bugReports.uploadTimeoutMs);
  const contextWindowMsRaw = Number(bugReports.contextWindowMs);
  const acceptedArtifactKinds = Array.isArray(bugReports.acceptedArtifactKinds)
    ? Array.from(
        new Set(
          bugReports.acceptedArtifactKinds
            .map((entry) => String(entry).trim())
            .filter((entry) => entry.length > 0),
        ),
      )
    : DEFAULT_BUG_REPORTS_FEATURE.acceptedArtifactKinds;

  const candidate: BugReportsFeature = {
    enabled: bugReports.enabled !== false,
    providerUrl,
    defaultIncludeDiagnostics: bugReports.defaultIncludeDiagnostics !== false,
    maxArtifactBytes: Number.isFinite(maxArtifactBytesRaw)
      ? Math.max(1024, Math.floor(maxArtifactBytesRaw))
      : DEFAULT_BUG_REPORTS_FEATURE.maxArtifactBytes,
    acceptedArtifactKinds: acceptedArtifactKinds.length > 0 ? acceptedArtifactKinds : DEFAULT_BUG_REPORTS_FEATURE.acceptedArtifactKinds,
    uploadTimeoutMs: Number.isFinite(uploadTimeoutMsRaw)
      ? Math.max(1000, Math.floor(uploadTimeoutMsRaw))
      : DEFAULT_BUG_REPORTS_FEATURE.uploadTimeoutMs,
    contextWindowMs: Number.isFinite(contextWindowMsRaw)
      ? Math.max(1000, Math.min(24 * 60 * 60 * 1000, Math.floor(contextWindowMsRaw)))
      : DEFAULT_BUG_REPORTS_FEATURE.contextWindowMs,
  };

  const parsed = BugReportsFeatureSchema.safeParse(candidate);
  return parsed.success ? parsed.data : DEFAULT_BUG_REPORTS_FEATURE;
}

export const FeaturesResponseSchema = z.object({
  features: z.object({
    bugReports: BugReportsFeatureSchema.optional().default(DEFAULT_BUG_REPORTS_FEATURE),
    sharing: z.object({
      session: z.object({ enabled: z.boolean() }),
      public: z.object({ enabled: z.boolean() }),
      contentKeys: z.object({ enabled: z.boolean() }),
      pendingQueueV2: z.object({ enabled: z.boolean() }),
    }),
    voice: z.object({
      enabled: z.boolean(),
      configured: z.boolean(),
      provider: z.enum(['elevenlabs']).nullable(),
    }),
    social: z.object({
      friends: z.object({
        enabled: z.boolean(),
        allowUsername: z.boolean(),
        requiredIdentityProviderId: z.string().nullable(),
      }),
    }),
    oauth: z.object({
      providers: z.record(OAuthProviderStatusSchema),
    }),
    auth: z.object({
      signup: z.object({
        methods: z.array(z.object({ id: z.string(), enabled: z.boolean() })),
      }),
      login: z.object({
        requiredProviders: z.array(z.string()),
      }),
      recovery: z.object({
        providerReset: z.object({
          enabled: z.boolean(),
          providers: z.array(z.string()),
        }),
      }),
      ui: z.object({
        autoRedirect: z.object({
          enabled: z.boolean(),
          providerId: z.string().nullable(),
        }),
        recoveryKeyReminder: z.object({
          enabled: z.boolean(),
        }),
      }),
      providers: z.record(
        z.object({
          enabled: z.boolean(),
          configured: z.boolean(),
          ui: z
            .object({
              displayName: z.string(),
              iconHint: z.string().nullable().optional(),
              connectButtonColor: z.string().nullable().optional(),
              supportsProfileBadge: z.boolean().optional(),
              badgeIconName: z.string().nullable().optional(),
            })
            .optional(),
          restrictions: z.object({
            usersAllowlist: z.boolean(),
            orgsAllowlist: z.boolean(),
            orgMatch: z.enum(['any', 'all']),
          }),
          offboarding: z.object({
            enabled: z.boolean(),
            intervalSeconds: z.number().int().min(1),
            mode: z.enum(['per-request-cache']),
            source: z.string().min(1),
          }),
        }),
      ),
      misconfig: z.array(
        z.object({
          code: z.string(),
          message: z.string(),
          kind: z.string().optional(),
          providerId: z.string().optional(),
          envVars: z.array(z.string()).optional(),
        }),
      ),
    }),
  }),
});

export type FeaturesResponse = z.infer<typeof FeaturesResponseSchema>;
