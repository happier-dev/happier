import type { ACPProvider } from './sessionMessageTypes';
import type { CommittedTranscriptAdmission } from './transcriptPort';
import {
  createStreamedTranscriptWriter,
  type StreamedTranscriptFlushSummary,
  type StreamedTranscriptWriter,
  type StreamedTranscriptWriterSession,
} from './streamedTranscriptWriter';

type FlushReason = 'tool-call-boundary' | 'turn-end' | 'abort';

type KeyedStreamArgs = Readonly<{
  streamKey: string;
  sidechainId: string | null;
  messageId?: string;
  foregroundTurnId?: string;
}>;

export function createKeyedStreamedTranscriptBridge<TArgs extends KeyedStreamArgs>(params: Readonly<{
  provider: ACPProvider;
  createSessionForStream: (args: TArgs) => StreamedTranscriptWriterSession;
  initialCheckpointDelayMs?: number | null;
  checkpointIntervalMs?: number | null;
  checkpointMinChars?: number | null;
  liveSnapshotIntervalMs?: number | null;
  liveSnapshotMinChars?: number | null;
  durableCommitsRequireExplicitEnable?: boolean | ((args: TArgs) => boolean);
}>) {
  const writerByStreamKey = new Map<string, Readonly<{ writer: StreamedTranscriptWriter; args: TArgs }>>();

  const getOrCreateWriter = (args: TArgs): StreamedTranscriptWriter => {
    const existing = writerByStreamKey.get(args.streamKey);
    if (existing) return existing.writer;

    const durableCommitsRequireExplicitEnable = typeof params.durableCommitsRequireExplicitEnable === 'function'
      ? params.durableCommitsRequireExplicitEnable(args)
      : params.durableCommitsRequireExplicitEnable;
    const messageId = args.messageId;
    const writer = createStreamedTranscriptWriter({
      provider: params.provider,
      session: params.createSessionForStream(args),
      ...(args.foregroundTurnId ? { runtimeTurnId: args.foregroundTurnId } : {}),
      ...(messageId ? { makeLocalId: () => messageId } : {}),
      initialCheckpointDelayMs: params.initialCheckpointDelayMs,
      checkpointIntervalMs: params.checkpointIntervalMs,
      checkpointMinChars: params.checkpointMinChars,
      liveSnapshotIntervalMs: params.liveSnapshotIntervalMs,
      liveSnapshotMinChars: params.liveSnapshotMinChars,
      durableCommitsRequireExplicitEnable,
    });
    writerByStreamKey.set(args.streamKey, { writer, args });
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

    enableDurableCommitsForStream(args: TArgs) {
      getOrCreateWriter(args).enableDurableCommits();
    },

    async finalizeSegment(args: TArgs & Readonly<{
      channel: 'assistant' | 'reasoning';
      text: string;
      sourceMessageId: string;
      unnamedStreamKey?: string;
      admission?: CommittedTranscriptAdmission;
    }>) {
      // A native identity takes precedence over the foreground unnamed handoff.
      // Both paths finalize through the same writer, including empty corrections.
      const streamKey = writerByStreamKey.has(args.streamKey)
        ? args.streamKey
        : args.unnamedStreamKey;
      if (streamKey === undefined) return null;
      const entry = writerByStreamKey.get(streamKey);
      if (!entry || (streamKey !== args.streamKey && entry.args.messageId)) return null;
      const summary = await entry.writer.finalizeSegment({
        kind: args.channel === 'assistant' ? 'assistant' : 'thinking',
        sidechainId: args.sidechainId,
        text: args.text,
        sourceMessageId: args.sourceMessageId,
        admission: args.admission,
        // The final source fact can omit turn scope while naming an already
        // foreground-owned message. Its exact receipt still belongs to that turn.
        retainForTurnEnd: entry.args.foregroundTurnId !== undefined,
      });
      if (!entry.writer.hasPendingSegments()) writerByStreamKey.delete(streamKey);
      return summary;
    },

    async flushAll(args: Readonly<{ reason: FlushReason; interruptedReason?: string; selectStream?: (stream: TArgs) => boolean }>) {
      const summaries: readonly StreamedTranscriptFlushSummary[] = await Promise.all(
        Array.from(writerByStreamKey.values())
          .filter((entry) => !args.selectStream || args.selectStream(entry.args))
          .map((entry) => entry.writer.flushAll({
            ...args,
            // Save text before the tool while the named native message still owns
            // this row and its source timestamps.
            keepOpen: args.reason === 'tool-call-boundary' && entry.args.messageId !== undefined,
          })),
      );
      for (const [streamKey, { writer }] of writerByStreamKey) {
        if (!writer.hasPendingSegments()) writerByStreamKey.delete(streamKey);
      }
      return summaries;
    },

    clear() {
      for (const { writer } of writerByStreamKey.values()) {
        writer.discard();
      }
      writerByStreamKey.clear();
    },
  };
}
