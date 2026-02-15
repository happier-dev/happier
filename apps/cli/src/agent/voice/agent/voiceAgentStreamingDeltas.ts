import { VOICE_ACTIONS_BLOCK } from '@happier-dev/protocol';

type DeltaEvent = Readonly<{ t: 'delta'; textDelta: string }>;

export function ingestVoiceAgentStreamingDelta(
  stream: Readonly<{
    done: boolean;
    suppressActionDeltas: boolean;
    deltaHold: string;
    events: unknown[];
  }>,
  patch: (next: Readonly<{ suppressActionDeltas?: boolean; deltaHold?: string }>) => void,
  textDelta: string,
): void {
  if (stream.done) return;
  if (stream.suppressActionDeltas) return;

  const startTag = VOICE_ACTIONS_BLOCK.startTag;
  const maxHold = Math.max(0, startTag.length - 1);
  const combined = `${stream.deltaHold}${textDelta}`;
  const tagIndex = combined.indexOf(startTag);
  if (tagIndex >= 0) {
    const emit = combined.slice(0, tagIndex);
    if (emit) stream.events.push({ t: 'delta', textDelta: emit } satisfies DeltaEvent);
    patch({ deltaHold: '', suppressActionDeltas: true });
    return;
  }

  const safeLen = Math.max(0, combined.length - maxHold);
  const emit = combined.slice(0, safeLen);
  const nextHold = combined.slice(safeLen);
  patch({ deltaHold: nextHold });
  if (emit) stream.events.push({ t: 'delta', textDelta: emit } satisfies DeltaEvent);
}
