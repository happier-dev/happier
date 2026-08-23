import {
  DaemonVoiceInferenceTtsStreamAckRequestSchema,
  DaemonVoiceInferenceTtsStreamAckResponseSchema,
  DaemonVoiceInferenceTtsStreamCancelRequestSchema,
  DaemonVoiceInferenceTtsStreamCancelResponseSchema,
  DaemonVoiceInferenceTtsStreamNextRequestSchema,
  DaemonVoiceInferenceTtsStreamNextResponseSchema,
  DaemonVoiceInferenceTtsStreamStartRequestSchema,
  DaemonVoiceInferenceTtsStreamStartResponseSchema,
  DaemonVoiceInferenceTtsStreamStatusRequestSchema,
  DaemonVoiceInferenceTtsStreamStatusResponseSchema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createVoiceInferenceTtsSegmentManager,
  type VoiceInferenceTtsSegmentWorker,
} from '@/daemon/voiceInference/streaming/tts/voiceInferenceTtsSegmentManager';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { VoiceDiagnosticsController } from '@/daemon/voiceDiagnostics/controller';

import {
  parseVoiceInferenceResponse,
  toVoiceInferenceError,
  type VoiceInferenceSchemaParser,
} from './voiceInferenceRpcResponses';

function invalidParameters<T>(schema: VoiceInferenceSchemaParser<T>): T {
  return parseVoiceInferenceResponse(schema, toVoiceInferenceError(new Error('invalid_parameters')));
}

export type MachineVoiceInferenceTtsStreamingRpcRegistration = Readonly<{
  dispose: () => Promise<void>;
}>;

export function registerMachineVoiceInferenceTtsStreamingRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  voiceInferenceWorker: VoiceInferenceTtsSegmentWorker;
  voiceDiagnostics?: Pick<VoiceDiagnosticsController, 'captureFile'>;
  streamRoot?: string;
  ackTimeoutMs?: number;
}>): MachineVoiceInferenceTtsStreamingRpcRegistration {
  /**
   * Segment audio is staged to a daemon-owned file as it is delivered instead of
   * being held until the utterance terminates. A long reply is many segments, and
   * retaining every one of them kept the whole synthesized utterance resident in
   * the daemon for the entire playback. Staging is never awaited on the delivery
   * path, so playback never waits on diagnostics I/O.
   */
  type TtsDiagnosticContext = Readonly<{
    sessionId: string;
    providerId: string;
    requestId: string;
    authorizationId?: string;
    stagingDir: string;
    stagedSegmentPaths: Map<string, string>;
  }> & { staging: Promise<void> };

  const diagnosticContextByStreamId = new Map<string, TtsDiagnosticContext>();

  const discardStaging = async (context: TtsDiagnosticContext): Promise<void> => {
    await context.staging.catch(() => undefined);
    await rm(context.stagingDir, { recursive: true, force: true }).catch(() => undefined);
  };

  const captureStaging = async (context: TtsDiagnosticContext): Promise<void> => {
    try {
      await context.staging.catch(() => undefined);
      for (const [segmentId, filePath] of context.stagedSegmentPaths) {
        await params.voiceDiagnostics?.captureFile({
          direction: 'tts_output',
          format: 'wav',
          filePath,
          durationMs: null,
          sessionId: context.sessionId,
          authorizationId: context.authorizationId,
          providerId: context.providerId,
          attemptId: `${context.requestId}:${segmentId}`,
        }).catch(() => undefined);
      }
    } finally {
      await rm(context.stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  /**
   * The segment manager owns the stream's terminal moment — completion, cancel,
   * error delivery, the ack deadline, the abandonment deadline and dispose all
   * converge on it. Staged private audio is retired from that one notification
   * rather than from each RPC handler guessing when the stream ended.
   */
  const manager = createVoiceInferenceTtsSegmentManager({
    voiceInferenceWorker: params.voiceInferenceWorker,
    ...(params.streamRoot ? { streamRoot: params.streamRoot } : {}),
    ...(typeof params.ackTimeoutMs === 'number' ? { ackTimeoutMs: params.ackTimeoutMs } : {}),
    onStreamClosed: ({ streamId, outcome }) => {
      const context = diagnosticContextByStreamId.get(streamId);
      if (!context) return;
      diagnosticContextByStreamId.delete(streamId);
      void (outcome === 'completed' ? captureStaging(context) : discardStaging(context));
    },
  });

  const diagnosticsStagingRoot = join(manager.streamRoot, 'diagnostics');

  const stageSegment = (
    context: TtsDiagnosticContext,
    segmentId: string,
    contentBase64: string,
  ): void => {
    const filePath = join(context.stagingDir, `${context.stagedSegmentPaths.size}.wav`);
    context.stagedSegmentPaths.set(segmentId, filePath);
    context.staging = context.staging.then(async () => {
      try {
        await mkdir(context.stagingDir, { recursive: true, mode: 0o700 });
        await writeFile(filePath, Buffer.from(contentBase64, 'base64'), { mode: 0o600 });
      } catch {
        // Diagnostics must never break playback: drop only the segment that
        // could not be staged and keep the stream and its other segments.
        context.stagedSegmentPaths.delete(segmentId);
      }
    });
  };

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_START, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceTtsStreamStartRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return invalidParameters(DaemonVoiceInferenceTtsStreamStartResponseSchema);
    }
    const response = parseVoiceInferenceResponse(
      DaemonVoiceInferenceTtsStreamStartResponseSchema,
      await manager.start(parsed.data),
    );
    if (response.ok && parsed.data.diagnostics?.captureAllowed === true) {
      diagnosticContextByStreamId.set(response.streamId, {
        sessionId: parsed.data.diagnostics.sessionId,
        authorizationId: parsed.data.diagnostics.authorizationId,
        providerId: parsed.data.packId ?? 'daemon-default',
        requestId: parsed.data.requestId,
        stagingDir: join(diagnosticsStagingRoot, response.streamId),
        stagedSegmentPaths: new Map<string, string>(),
        staging: Promise.resolve(),
      });
    }
    return response;
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_NEXT, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceTtsStreamNextRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return invalidParameters(DaemonVoiceInferenceTtsStreamNextResponseSchema);
    }
    const response = parseVoiceInferenceResponse(
      DaemonVoiceInferenceTtsStreamNextResponseSchema,
      await manager.next(parsed.data),
    );
    if (response.ok && response.event.type === 'segment') {
      const context = diagnosticContextByStreamId.get(response.streamId);
      if (context && !context.stagedSegmentPaths.has(response.event.segmentId)) {
        stageSegment(context, response.event.segmentId, response.event.audio.contentBase64);
      }
    }
    return response;
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_ACK, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceTtsStreamAckRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return invalidParameters(DaemonVoiceInferenceTtsStreamAckResponseSchema);
    }
    return parseVoiceInferenceResponse(
      DaemonVoiceInferenceTtsStreamAckResponseSchema,
      await manager.ack(parsed.data),
    );
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_CANCEL, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceTtsStreamCancelRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return invalidParameters(DaemonVoiceInferenceTtsStreamCancelResponseSchema);
    }
    return parseVoiceInferenceResponse(
      DaemonVoiceInferenceTtsStreamCancelResponseSchema,
      await manager.cancel(parsed.data),
    );
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_STREAM_STATUS, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceTtsStreamStatusRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return invalidParameters(DaemonVoiceInferenceTtsStreamStatusResponseSchema);
    }
    return parseVoiceInferenceResponse(
      DaemonVoiceInferenceTtsStreamStatusResponseSchema,
      await manager.status(parsed.data),
    );
  });

  return {
    dispose: async () => {
      const contexts = [...diagnosticContextByStreamId.values()];
      diagnosticContextByStreamId.clear();
      await manager.dispose();
      await Promise.all(contexts.map(discardStaging));
    },
  };
}
