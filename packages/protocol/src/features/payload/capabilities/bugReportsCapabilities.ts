import { z } from 'zod';

import { normalizeBugReportProviderUrl } from '../../../bugReports/sanitize.js';
import { isRecord } from '../isRecord.js';

export const BugReportsCapabilitiesSchema = z.object({
  providerUrl: z.string().url().nullable(),
  defaultIncludeDiagnostics: z.boolean(),
  maxArtifactBytes: z.number().int().positive(),
  acceptedArtifactKinds: z.array(z.string().min(1)).min(1),
  uploadTimeoutMs: z.number().int().positive(),
  contextWindowMs: z.number().int().min(1000).max(24 * 60 * 60 * 1000),
});

export type BugReportsCapabilities = z.infer<typeof BugReportsCapabilitiesSchema>;

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

export const DEFAULT_BUG_REPORTS_CAPABILITIES: BugReportsCapabilities = {
  providerUrl: null,
  defaultIncludeDiagnostics: true,
  maxArtifactBytes: 10 * 1024 * 1024,
  acceptedArtifactKinds: [...BUG_REPORT_DEFAULT_ACCEPTED_ARTIFACT_KINDS],
  uploadTimeoutMs: 120000,
  contextWindowMs: BUG_REPORT_DEFAULT_CONTEXT_WINDOW_MS,
};

export function coerceBugReportsCapabilitiesFromFeaturesPayload(payload: unknown): BugReportsCapabilities {
  const capabilities = isRecord(payload) && isRecord(payload.capabilities) ? payload.capabilities : null;
  const bugReports = capabilities && isRecord(capabilities.bugReports) ? capabilities.bugReports : null;
  if (!bugReports) return DEFAULT_BUG_REPORTS_CAPABILITIES;

  const providerRaw = bugReports.providerUrl;
  const providerUrl = normalizeBugReportProviderUrl(typeof providerRaw === 'string' ? providerRaw : null);
  if (typeof providerRaw === 'string' && providerRaw.trim() && !providerUrl) {
    return DEFAULT_BUG_REPORTS_CAPABILITIES;
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
    : DEFAULT_BUG_REPORTS_CAPABILITIES.acceptedArtifactKinds;

  const candidate: BugReportsCapabilities = {
    providerUrl,
    defaultIncludeDiagnostics: bugReports.defaultIncludeDiagnostics !== false,
    maxArtifactBytes: Number.isFinite(maxArtifactBytesRaw)
      ? Math.max(1024, Math.floor(maxArtifactBytesRaw))
      : DEFAULT_BUG_REPORTS_CAPABILITIES.maxArtifactBytes,
    acceptedArtifactKinds:
      acceptedArtifactKinds.length > 0 ? acceptedArtifactKinds : DEFAULT_BUG_REPORTS_CAPABILITIES.acceptedArtifactKinds,
    uploadTimeoutMs: Number.isFinite(uploadTimeoutMsRaw)
      ? Math.max(1000, Math.floor(uploadTimeoutMsRaw))
      : DEFAULT_BUG_REPORTS_CAPABILITIES.uploadTimeoutMs,
    contextWindowMs: Number.isFinite(contextWindowMsRaw)
      ? Math.max(1000, Math.min(24 * 60 * 60 * 1000, Math.floor(contextWindowMsRaw)))
      : DEFAULT_BUG_REPORTS_CAPABILITIES.contextWindowMs,
  };

  const parsed = BugReportsCapabilitiesSchema.safeParse(candidate);
  return parsed.success ? parsed.data : DEFAULT_BUG_REPORTS_CAPABILITIES;
}

