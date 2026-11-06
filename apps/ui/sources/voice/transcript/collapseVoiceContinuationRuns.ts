import type { Message } from '@happier-dev/session-core/messages';

import { readVoiceContinuationProvenance } from './voiceTranscriptNoteMeta';

/**
 * A run of consecutive Voice continuation notes ("Continued on Chrome" after each reconnect) reads as
 * one event: only the newest note of each run stays in the transcript, so the line names the latest
 * device. The notes stay synced as written; this is presentation only. Returns `ids` itself when
 * nothing collapses, so the transcript's derived-item caches keep their identity.
 */
export function collapseVoiceContinuationRuns(
  ids: readonly string[],
  messagesById: Readonly<Record<string, Message | undefined>>,
): readonly string[] {
  let kept: string[] | null = null;
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index]!;
    const nextId = ids[index + 1];
    const superseded =
      nextId !== undefined &&
      readVoiceContinuationProvenance(messagesById[id]?.meta) !== null &&
      readVoiceContinuationProvenance(messagesById[nextId]?.meta) !== null;
    if (superseded) {
      kept ??= ids.slice(0, index);
      continue;
    }
    kept?.push(id);
  }
  return kept ?? ids;
}
