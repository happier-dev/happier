import type { Metadata, PermissionMode } from '@/api/types';
import { resolveLatestPermissionIntent } from '@happier-dev/agents';
import { normalizePermissionModeToIntent } from './permissionModeCanonical';

export async function resolveStartupPermissionModeFromSession(opts: {
  session: {
    getMetadataSnapshot: () => Metadata | null;
    fetchLatestUserPermissionIntentFromTranscript: (opts?: { take?: number }) => Promise<{ intent: PermissionMode; updatedAt: number } | null>;
  };
  take?: number;
}): Promise<{ mode: PermissionMode; updatedAt: number } | null> {
  const metadata = opts.session.getMetadataSnapshot();

  const rawMetadataMode = (metadata as any)?.permissionMode;
  const rawMetadataUpdatedAt = (metadata as any)?.permissionModeUpdatedAt;

  const metadataCandidate = {
    rawMode: rawMetadataMode,
    updatedAt: rawMetadataUpdatedAt,
  };

  const transcript = await opts.session.fetchLatestUserPermissionIntentFromTranscript({ take: opts.take });
  const transcriptCandidate = transcript
    ? { rawMode: transcript.intent, updatedAt: transcript.updatedAt }
    : { rawMode: null, updatedAt: null };

  // Metadata is the intended source of truth for new sessions. However, in practice we can still end up with
  // transcript messages that reflect a newer intent change (e.g. the user sent a message with an updated
  // permission mode but the metadata write failed). To keep attach behavior consistent with the UI, resolve
  // the latest of (metadata snapshot, transcript inference) by timestamp.
  const resolved = resolveLatestPermissionIntent([transcriptCandidate, metadataCandidate]);
  if (!resolved) return null;

  const canonical = normalizePermissionModeToIntent(resolved.intent);
  if (!canonical) return null;

  return { mode: canonical, updatedAt: resolved.updatedAt };
}
