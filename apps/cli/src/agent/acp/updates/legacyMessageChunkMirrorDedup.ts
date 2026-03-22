import { extractTextFromContentBlock } from './content';
import type { SessionUpdate } from './types';

export type StructuredAgentMessageChunkMirrorCounts = Map<string, number>;

function readLegacyMessageChunkText(update: SessionUpdate): string | null {
  const textDelta = update.messageChunk?.textDelta;
  if (typeof textDelta !== 'string' || textDelta.length === 0) return null;
  return textDelta;
}

export function buildStructuredAgentMessageChunkMirrorSet(updates: SessionUpdate[]): StructuredAgentMessageChunkMirrorCounts {
  const mirroredTexts = new Map<string, number>();

  for (const update of updates) {
    if (update.sessionUpdate !== 'agent_message_chunk') continue;
    const contentText = extractTextFromContentBlock(update.content);
    if (typeof contentText === 'string' && contentText.length > 0) {
      mirroredTexts.set(contentText, (mirroredTexts.get(contentText) ?? 0) + 1);
      continue;
    }

    const legacyText = readLegacyMessageChunkText(update);
    if (legacyText) {
      mirroredTexts.set(legacyText, (mirroredTexts.get(legacyText) ?? 0) + 1);
    }
  }

  return mirroredTexts;
}

export function shouldSkipLegacyMessageChunkMirror(
  update: SessionUpdate,
  mirroredStructuredTexts: StructuredAgentMessageChunkMirrorCounts,
): boolean {
  if (update.sessionUpdate !== undefined) return false;
  if (update.content !== undefined) return false;
  const legacyText = readLegacyMessageChunkText(update);
  if (!legacyText) return false;
  const remainingMirrors = mirroredStructuredTexts.get(legacyText) ?? 0;
  if (remainingMirrors <= 0) return false;
  if (remainingMirrors === 1) {
    mirroredStructuredTexts.delete(legacyText);
  } else {
    mirroredStructuredTexts.set(legacyText, remainingMirrors - 1);
  }
  return true;
}
