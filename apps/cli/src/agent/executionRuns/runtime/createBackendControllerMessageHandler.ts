import { randomUUID } from 'node:crypto';

import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import { createAcpAgentMessageForwarder } from '@/agent/acp/bridge/createAcpAgentMessageForwarder';
import type { AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import type { ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';
import { computeSidechainStreamText } from '@/agent/executionRuns/runtime/sidechainStreamText';

export function createBackendControllerMessageHandler(args: Readonly<{
  ctrl: ExecutionRunBackendController;
  runId: string;
  sidechainId: string;
  intent: ExecutionRunState['intent'];
  ioMode: ExecutionRunState['ioMode'];
  sendAcp: (provider: ACPProvider, body: ACPMessageData, opts?: { meta?: Record<string, unknown> }) => void;
  parentProvider: ACPProvider;
  runs: Map<string, ExecutionRunState>;
  backendSupportsResume: boolean;
  writeActivityMarker: (runId: string, nowMs: number, opts?: Readonly<{ force?: boolean }>) => Promise<void>;
  getNowMs: () => number;
  onPublicStateUpdated?: (runId: string) => void;
  onModelOutput?: () => void;
}>): AgentMessageHandler {
  const forwarder = createAcpAgentMessageForwarder({
    sendAcp: args.sendAcp,
    provider: args.parentProvider,
    sidechainId: args.sidechainId,
    makeId: () => randomUUID(),
  });

  return (msg) => {
    if (msg.type === 'event' && msg.name === 'vendor_session_id') {
      const vendorSessionId = (msg.payload as any)?.sessionId;
      if (typeof vendorSessionId === 'string' && vendorSessionId.trim().length > 0) {
        args.ctrl.childSessionId = vendorSessionId as SessionId;
        const run = args.runs.get(args.runId);
        if (run?.retentionPolicy === 'resumable' && args.backendSupportsResume) {
          args.runs.set(args.runId, {
            ...run,
            resumeHandle: { kind: 'vendor_session.v1', backendTarget: run.backendTarget, vendorSessionId },
          });
          args.onPublicStateUpdated?.(args.runId);
        }
      }
      return;
    }

    if (
      args.ctrl.streamWriter
      && (
        msg.type === 'tool-call'
        || msg.type === 'tool-result'
        || msg.type === 'fs-edit'
        || msg.type === 'terminal-output'
      )
    ) {
      args.ctrl.streamWriter.flushAll({ reason: 'tool-call-boundary' });
    }

    forwarder.forward(msg as any);

    if (msg.type !== 'model-output') return;
    const prevFullText = args.ctrl.buffer;
    if (typeof (msg as any).fullText === 'string') {
      args.ctrl.buffer = String((msg as any).fullText);
    } else if (typeof (msg as any).textDelta === 'string') {
      args.ctrl.buffer += String((msg as any).textDelta);
    }

    // Streaming: emit best-effort sidechain transcript updates.
    const streamWriter = args.ctrl.streamWriter;
    if (args.ioMode === 'streaming' && streamWriter) {
      const streamKey = `${args.sidechainId}:turn:${args.ctrl.turnCount}`;
      if (!args.ctrl.sidechainStreamKey || args.ctrl.sidechainStreamKey !== streamKey) {
        args.ctrl.sidechainStreamKey = streamKey;
        args.ctrl.sidechainStreamBuffer = '';
      }

      const nextStreamText = computeSidechainStreamText(args.intent, args.ctrl.buffer);
      if (typeof nextStreamText === 'string') {
        const prevStreamText = args.ctrl.sidechainStreamBuffer;

        const delta = (() => {
          if (nextStreamText.startsWith(prevStreamText)) {
            return nextStreamText.slice(prevStreamText.length);
          }

          // Fallback: if the backend reports cumulative fullText but it diverges (vendor bug/restarts),
          // emit the delta between previous and current fullText as best-effort.
          if (args.ctrl.buffer === prevFullText) return '';
          return nextStreamText;
        })();

        if (delta && delta.length > 0) {
          args.ctrl.sidechainStreamBuffer = nextStreamText;
          streamWriter.appendAssistantDelta(delta, { sidechainId: args.sidechainId });
        }
      }
    }

    // Best-effort: reflect activity for machine-wide run listing.
    void args.writeActivityMarker(args.runId, args.getNowMs());
    args.onModelOutput?.();
  };
}

