import {
  findCodexRolloutFileByIdSync,
  normalizeCodexVendorResumeId,
  resolveCodexNativeSessionsRoot,
} from '@/backends/codex/utils/codexSessionFiles';

function readMetadataRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

export function resolveCodexConnectedServiceCandidatePersistedSessionFile(input: Readonly<{
  metadata: unknown;
  env?: NodeJS.ProcessEnv;
}>): string | null {
  const metadata = readMetadataRecord(input.metadata);
  if (!metadata) return null;
  if (metadata.codexBackendMode !== 'appServer') return null;
  const vendorResumeId = normalizeCodexVendorResumeId(metadata.codexSessionId);
  if (!vendorResumeId) return null;

  return findCodexRolloutFileByIdSync({
    sessionsRoot: resolveCodexNativeSessionsRoot(input.env ?? process.env),
    vendorResumeId,
  });
}
