import type { ACPProvider } from './sessionMessageTypes';
import {
  createStreamedTranscriptWriter,
  type StreamedTranscriptWriter,
  type StreamedTranscriptWriterSession,
} from './streamedTranscriptWriter';

type FlushReason = 'tool-call-boundary' | 'turn-end' | 'abort';

type KeyedStreamArgs = Readonly<{
  streamKey: string;
  sidechainId: string | null;
}>;

export function createKeyedStreamedTranscriptBridge<TArgs extends KeyedStreamArgs>(params: Readonly<{
  provider: ACPProvider;
  createSessionForStream: (args: TArgs) => StreamedTranscriptWriterSession;
  initialCheckpointDelayMs?: number | null;
  checkpointIntervalMs?: number | null;
  checkpointMinChars?: number | null;
  liveSnapshotIntervalMs?: number | null;
  liveSnapshotMinChars?: number | null;
}>) {
  const writerByStreamKey = new Map<string, StreamedTranscriptWriter>();

  const getOrCreateWriter = (args: TArgs): StreamedTranscriptWriter => {
    const existing = writerByStreamKey.get(args.streamKey);
    if (existing) return existing;

    const writer = createStreamedTranscriptWriter({
      provider: params.provider,
      session: params.createSessionForStream(args),
      initialCheckpointDelayMs: params.initialCheckpointDelayMs,
      checkpointIntervalMs: params.checkpointIntervalMs,
      checkpointMinChars: params.checkpointMinChars,
      liveSnapshotIntervalMs: params.liveSnapshotIntervalMs,
      liveSnapshotMinChars: params.liveSnapshotMinChars,
    });
    writerByStreamKey.set(args.streamKey, writer);
    return writer;
  };

  return {
    appendAssistantDelta(args: TArgs & Readonly<{ deltaText: string }>) {
      getOrCreateWriter(args).appendAssistantDelta(args.deltaText, { sidechainId: args.sidechainId });
    },

    appendThinkingDelta(args: TArgs & Readonly<{ deltaText: string }>) {
      getOrCreateWriter(args).appendThinkingDelta(args.deltaText, { sidechainId: args.sidechainId });
    },

    overrideAssistantText(args: TArgs & Readonly<{ text: string }>) {
      getOrCreateWriter(args).overrideAssistantText(args.text, { sidechainId: args.sidechainId });
    },

    overrideThinkingText(args: TArgs & Readonly<{ text: string }>) {
      getOrCreateWriter(args).overrideThinkingText(args.text, { sidechainId: args.sidechainId });
    },

    async flushAll(args: Readonly<{ reason: FlushReason; interruptedReason?: string }>) {
      await Promise.all(Array.from(writerByStreamKey.values(), (writer) => writer.flushAll(args)));
      writerByStreamKey.clear();
    },

    clear() {
      writerByStreamKey.clear();
    },
  };
}
