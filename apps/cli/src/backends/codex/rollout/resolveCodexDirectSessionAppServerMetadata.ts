import type { DirectSessionCandidateV1, DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { findCodexDirectSessionCandidateViaAppServer } from '../appServer/session/findCodexDirectSessionCandidateViaAppServer';

import { homes as resolveHomes } from '../externalSessions/homes';

type CodexDirectSessionAppServerMetadata = Readonly<{
  updatedAtMs: number;
  previewText: string | null;
  workingDirectory: string | null;
}>;

function toPreviewText(candidate: DirectSessionCandidateV1 | null): string | null {
  const title = typeof candidate?.title === 'string' ? candidate.title.trim() : '';
  return title ? title : null;
}

export async function resolveCodexDirectSessionAppServerMetadata(params: Readonly<{
  source: DirectSessionsSource;
  activeServerDir: string;
  remoteSessionId: string;
  env?: NodeJS.ProcessEnv;
}>): Promise<CodexDirectSessionAppServerMetadata | null> {
  const env = params.env ?? process.env;
  const homes = await resolveHomes({
    source: params.source,
    activeServerDir: params.activeServerDir,
    env,
  });

  let best: CodexDirectSessionAppServerMetadata | null = null;
  for (const home of homes) {
    let candidate: DirectSessionCandidateV1 | null = null;
    try {
      candidate = await findCodexDirectSessionCandidateViaAppServer({
        codexHome: home,
        remoteSessionId: params.remoteSessionId,
        env,
      });
    } catch {
      candidate = null;
    }
    if (!candidate) continue;

    const updatedAtMs = Number.isFinite(candidate.updatedAtMs) ? Math.trunc(candidate.updatedAtMs) : NaN;
    if (!Number.isFinite(updatedAtMs) || updatedAtMs < 0) continue;

    if (!best || updatedAtMs > best.updatedAtMs) {
      const cwd =
        candidate?.details && typeof candidate.details === 'object' && !Array.isArray(candidate.details)
          ? typeof (candidate.details as Record<string, unknown>).cwd === 'string'
            ? String((candidate.details as Record<string, unknown>).cwd).trim() || null
            : null
          : null;
      best = {
        updatedAtMs,
        previewText: toPreviewText(candidate),
        workingDirectory: cwd,
      };
    }
  }

  return best;
}

export function mapCodexDirectSessionAppServerPreviewToMessage(params: Readonly<{
  remoteSessionId: string;
  metadata: CodexDirectSessionAppServerMetadata;
}>): DirectTranscriptRawMessageV1 | null {
  const previewText = typeof params.metadata.previewText === 'string' ? params.metadata.previewText.trim() : '';
  if (!previewText) return null;
  const stableId = `codex:app-server:${params.remoteSessionId}:${params.metadata.updatedAtMs}`;
  return {
    id: stableId,
    localId: stableId,
    createdAtMs: params.metadata.updatedAtMs,
    raw: {
      role: 'agent',
      content: {
        type: 'codex',
        data: {
          type: 'message',
          message: previewText,
        },
      },
    },
  };
}
