import type { ActionSessionReferenceResolution } from '@happier-dev/protocol/actions/executor/types';

import { resolveVoiceSessionReference } from './sessionReference';
import type { VoiceSessionCorpusOptions } from './voiceSessionRows';

function normalizeId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export type VoiceActionSessionReferenceCorpus = Readonly<{
  /** Snapshot owned by the mounted list host that proved the supplied coverage. */
  state: unknown;
  options: VoiceSessionCorpusOptions;
}>;

/**
 * Adapts one explicitly supplied, authorized selected-Home corpus to the
 * canonical Voice reference resolver. It never fetches, paginates, reads focus,
 * or promotes retained rows to completeness.
 */
export async function resolveVoiceActionSessionReference(
  input: Readonly<{
    sessionId?: string;
    sessionTitle?: string;
    serverId?: string | null;
    signal?: AbortSignal;
  }>,
  corpus?: VoiceActionSessionReferenceCorpus | null,
): Promise<ActionSessionReferenceResolution> {
  const sessionId = normalizeId(input.sessionId);
  const serverId = normalizeId(input.serverId);
  if (sessionId && serverId) {
    return { kind: 'unique', address: { serverId, sessionId } };
  }
  if (input.signal?.aborted || corpus?.options.coverage !== 'complete') {
    return { kind: 'incomplete' };
  }

  const resolution = resolveVoiceSessionReference(
    {
      ...(sessionId ? { sessionId } : {}),
      ...(input.sessionTitle ? { sessionTitle: input.sessionTitle } : {}),
      ...(serverId ? { serverId } : {}),
    },
    corpus.state,
    corpus.options,
  );
  if (resolution.kind === 'unique') {
    return { kind: 'unique', address: resolution.address };
  }
  if (resolution.kind === 'ambiguous') {
    return {
      kind: 'ambiguous',
      candidates: resolution.candidates.map((candidate) => candidate.address),
    };
  }
  return resolution;
}
