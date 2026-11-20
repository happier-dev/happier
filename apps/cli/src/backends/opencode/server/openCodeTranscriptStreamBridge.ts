import { createKeyedStreamedTranscriptBridge } from '@/api/session/createKeyedStreamedTranscriptBridge';
import type { ACPProvider } from '@/api/session/sessionMessageTypes';
import {
  createOpenCodeTranscriptStreamSession,
  type OpenCodeTranscriptStreamSessionSource,
} from './createOpenCodeTranscriptStreamSession';

type FlushReason = 'tool-call-boundary' | 'turn-end' | 'abort';

type StreamArgs = {
  streamKey: string;
  remoteSessionId: string;
  messageId: string;
  sidechainId: string | null;
};

function buildSidechainMeta(params: {
  streamKey: string;
  remoteSessionId: string;
  messageId: string;
  sidechainId: string | null;
}): Record<string, unknown> {
  if (!params.sidechainId) {
    return {
      happierStreamKey: params.streamKey,
      opencodeMessageId: params.messageId,
      opencodeRemoteSessionId: params.remoteSessionId,
    };
  }

  return {
    happierStreamKey: params.streamKey,
    opencodeMessageId: params.messageId,
    opencodeRemoteSessionId: params.remoteSessionId,
    importedFrom: 'acp-sidechain',
    remoteSessionId: params.remoteSessionId,
    sidechainId: params.sidechainId,
    happierSidechainStreamKey: params.streamKey,
  };
}

export function createOpenCodeTranscriptStreamBridge(params: {
  provider: ACPProvider;
  session: OpenCodeTranscriptStreamSessionSource;
  checkpointIntervalMs?: number | null;
  checkpointMinChars?: number | null;
}) {
  const bridge = createKeyedStreamedTranscriptBridge<StreamArgs>({
    provider: params.provider,
    checkpointIntervalMs: params.checkpointIntervalMs,
    checkpointMinChars: params.checkpointMinChars,
    durableCommitsRequireExplicitEnable: (args) => args.sidechainId === null,
    createSessionForStream: (args) => {
      const baseMeta = buildSidechainMeta(args);
      return createOpenCodeTranscriptStreamSession({
        session: params.session,
        baseMeta,
      });
    },
  });

  // OpenCode allocates a message per reasoning step. Keep its message-scoped
  // projection admission, but publish consecutive steps as one Thinking segment.
  type ThinkingRun = {
    args: StreamArgs;
    parts: Map<string, string>;
    publishedText: string;
  };
  const admittedStreams = new Set<string>();
  const runs = new Set<ThinkingRun>();
  const activeRuns = new Map<string, ThinkingRun>();
  let nextRun = 0;
  const scopeKey = (args: StreamArgs) => JSON.stringify([args.remoteSessionId, args.sidechainId]);
  const isAdmitted = (args: StreamArgs, streamKey: string) => args.sidechainId !== null || admittedStreams.has(streamKey);

  const publishRun = (run: ThinkingRun) => {
    const text = Array.from(run.parts)
      .filter(([key]) => isAdmitted(run.args, key))
      .map(([, text]) => text)
      .filter(Boolean)
      .join('\n\n');
    if (text === run.publishedText) return;
    bridge.enableDurableCommitsForStream(run.args);
    if (text.startsWith(run.publishedText)) {
      bridge.appendThinkingDelta({ ...run.args, deltaText: text.slice(run.publishedText.length) });
    } else {
      bridge.overrideThinkingText({ ...run.args, text });
    }
    run.publishedText = text;
  };

  const updateThinking = (args: StreamArgs, text: string, append: boolean) => {
    if (!text) return;
    const scope = scopeKey(args);
    let run = activeRuns.get(scope);
    if (!run) {
      run = { args: { ...args, streamKey: `${args.streamKey}:thinking:${nextRun++}` }, parts: new Map(), publishedText: '' };
      runs.add(run);
      activeRuns.set(scope, run);
    }
    const previousText = run.parts.get(args.streamKey) ?? '';
    run.parts.set(args.streamKey, append ? previousText + text : text);
    // The normal delta path appends only the new bytes; rebuild the run only
    // for snapshot corrections, delayed role admission, or interleaved messages.
    if (append && isAdmitted(args, args.streamKey) && Array.from(run.parts.keys()).at(-1) === args.streamKey) {
      const deltaText = !previousText && run.publishedText ? `\n\n${text}` : text;
      bridge.enableDurableCommitsForStream(run.args);
      bridge.appendThinkingDelta({ ...run.args, deltaText });
      run.publishedText += deltaText;
      return;
    }
    publishRun(run);
  };

  const forgetRunsMatching = (matches: (args: StreamArgs) => boolean) => {
    for (const run of runs) {
      if (!matches(run.args)) continue;
      runs.delete(run);
      if (activeRuns.get(scopeKey(run.args)) === run) activeRuns.delete(scopeKey(run.args));
    }
  };

  return {
    mergeAssistantMeta: bridge.mergeAssistantMeta,
    appendThinkingDelta(args: StreamArgs & { deltaText: string }) {
      updateThinking(args, args.deltaText, true);
    },
    overrideThinkingText(args: StreamArgs & { text: string }) {
      updateThinking(args, args.text, false);
    },
    appendAssistantDelta(args: StreamArgs & { deltaText: string }) {
      if (args.deltaText) activeRuns.delete(scopeKey(args));
      bridge.appendAssistantDelta(args);
    },
    overrideAssistantText(args: StreamArgs & { text: string }) {
      if (args.text) activeRuns.delete(scopeKey(args));
      bridge.overrideAssistantText(args);
    },
    enableDurableCommitsForStream(args: StreamArgs) {
      admittedStreams.add(args.streamKey);
      bridge.enableDurableCommitsForStream(args);
      for (const run of runs) {
        if (run.parts.has(args.streamKey)) publishRun(run);
      }
    },
    discardStream(args: StreamArgs) {
      admittedStreams.delete(args.streamKey);
      bridge.discardStream(args);
      for (const run of runs) {
        if (run.parts.delete(args.streamKey)) publishRun(run);
      }
    },
    flushStreamsMatching(args: { reason: FlushReason; interruptedReason?: string; matches: (args: StreamArgs) => boolean }) {
      forgetRunsMatching(args.matches);
      return bridge.flushStreamsMatching(args);
    },
    flushAll(args: { reason: FlushReason; interruptedReason?: string }) {
      forgetRunsMatching(() => true);
      admittedStreams.clear();
      return bridge.flushAll(args);
    },
    clear() {
      runs.clear();
      activeRuns.clear();
      admittedStreams.clear();
      bridge.clear();
    },
  };
}
