import { randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT, DaemonVoiceInferenceSttAppendDiagnosticSchema } from '@happier-dev/protocol/daemon/voiceInference';
import { MACHINE_STREAM_KEY_BYTES_V1, createMachineStreamKeyAadV1, createMachineStreamKeyNonceV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/payloadV1';
import { createSpeechTranscriptionApplicationAuthorityDigestV1 } from '@happier-dev/protocol/machines/peer/mediation/voiceMediaV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { DaemonVoiceInferenceError, DaemonVoiceInferenceSttStreamCancelRequest, DaemonVoiceInferenceSttStreamCancelResponse, DaemonVoiceInferenceSttStreamChunkRequest, DaemonVoiceInferenceSttStreamChunkResponse, DaemonVoiceInferenceSttStreamEvent, DaemonVoiceInferenceSttStreamFinishRequest, DaemonVoiceInferenceSttStreamFinishResponse, DaemonVoiceInferenceSttStreamStartRequest, DaemonVoiceInferenceSttStreamStartResponse, VoiceSpeechDiagnosticsCaptureContextV1, VoiceMediaApplicationAuthorityV1 } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { toVoiceInferenceError } from '@/api/machine/voiceInferenceRpcResponses';
import { resolveVoiceInferencePaths } from '@/daemon/voiceInference/voiceInferencePaths';
import type { VoiceInferenceWorkerStreamingTranscriptionSession } from '@/daemon/voiceInference/voiceInferenceWorker.execution';
import type { VoiceDiagnosticsController } from '@/daemon/voiceDiagnostics/controller';
import { openAes256GcmBytes, sealAes256GcmBytes } from '@happier-dev/transfers/node';

/** Issued only inside an E2EE Machine RPC start response; plain Accounts have none. */
type StreamKeySession = {
  key: Uint8Array;
  aad: Uint8Array;
  /** Strictly contiguous per stream, so no key/nonce pair seals twice. */
  lastSequence: number;
};

type CompatibilityChunk = Readonly<{
  pcm: Buffer;
  result: Promise<DaemonVoiceInferenceSttStreamChunkResponse>;
  resolve: (response: DaemonVoiceInferenceSttStreamChunkResponse) => void;
}>;

type BaseStreamSession = {
  requestId: string;
  streamId: string;
  generation: number;
  packId: string | null;
  language: string | null;
  ackSeq: number;
  admittedSeq: number;
  totalBytes: number;
  admittedTotalBytes: number;
  pendingFrames: number;
  pendingBytes: number;
  compatibilityChunks: Map<number, CompatibilityChunk>;
  state: 'open' | 'finishing' | 'closed';
  tail: Promise<void>;
  abortController: AbortController;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  diagnostics: VoiceSpeechDiagnosticsCaptureContextV1 | null;
  diagnosticWavFilePath: string | null;
  diagnosticCapturePromise: Promise<void> | null;
  streamKey: StreamKeySession | null;
};

type UploadBridgeStreamSession = BaseStreamSession & Readonly<{
  mode: 'upload_bridge';
  wavFilePath: string;
}>;

type RuntimeStreamSession = BaseStreamSession & Readonly<{
  mode: 'runtime';
  runtimeSession: VoiceInferenceWorkerStreamingTranscriptionSession;
}>;

type StreamSession = UploadBridgeStreamSession | RuntimeStreamSession;

export type VoiceInferenceSpeechStreamWorker = Readonly<{
  transcribeAudio: (input: Readonly<{
    requestId: string;
    uploadId: string;
    filePath: string;
    inputMimeType: string;
    packId: string | null;
    language: string | null;
    normalization: {
      inputTransport: 'upload_transfer';
      strategy: 'ui_pretranscoded_pcm16_fallback';
      systemFfmpegAllowed: false;
    };
    signal?: AbortSignal | null;
    onTranscribed?: () => Promise<void>;
  }>) => Promise<Readonly<{
    requestId: string;
    text: string;
    language: string | null;
    modelPackId: string | null;
  }>>;
  createStreamingTranscriptionSession?: (input: Readonly<{
    requestId: string;
    packId: string | null;
    language: string | null;
    format: typeof DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT;
    signal?: AbortSignal | null;
  }>) => Promise<VoiceInferenceWorkerStreamingTranscriptionSession>;
}>;

export type VoiceInferenceSpeechStreamManager = Readonly<{
  start: (
    input: DaemonVoiceInferenceSttStreamStartRequest,
    signal?: AbortSignal,
    options?: Readonly<{ issueStreamKey?: boolean }>,
  ) => Promise<DaemonVoiceInferenceSttStreamStartResponse>;
  appendCompatibilityChunk: (input: DaemonVoiceInferenceSttStreamChunkRequest) => Promise<DaemonVoiceInferenceSttStreamChunkResponse>;
  appendPcm16Bytes: (input: Readonly<{
    streamId: string;
    generation: number;
    seq: number;
    pcm16Bytes: Uint8Array;
    streamKeyOpened?: true;
    voiceMediaApplicationAuthority?: VoiceMediaApplicationAuthorityV1;
  }>) => Promise<DaemonVoiceInferenceSttStreamChunkResponse>;
  /** One tunnel data payload: sealed bytes for a keyed stream, raw PCM otherwise. */
  appendTunnelFrame: (input: Readonly<{
    streamId: string;
    generation: number;
    seq: number;
    payloadBytes: Uint8Array;
    voiceMediaApplicationAuthority: VoiceMediaApplicationAuthorityV1;
  }>) => Promise<DaemonVoiceInferenceSttStreamChunkResponse | Uint8Array>;
  finish: (input: DaemonVoiceInferenceSttStreamFinishRequest) => Promise<DaemonVoiceInferenceSttStreamFinishResponse>;
  cancel: (input: DaemonVoiceInferenceSttStreamCancelRequest) => Promise<DaemonVoiceInferenceSttStreamCancelResponse>;
  cancelForTransportLoss: (input: Readonly<{
    voiceMediaApplicationAuthority: VoiceMediaApplicationAuthorityV1;
  }> & (
    | DaemonVoiceInferenceSttStreamCancelRequest
    | Readonly<{ streamId?: never; generation?: never }>
  )) => Promise<DaemonVoiceInferenceSttStreamCancelResponse>;
  dispose: () => Promise<void>;
}>;

export type CreateVoiceInferenceSpeechStreamManagerOptions = Readonly<{
  voiceInferenceWorker: VoiceInferenceSpeechStreamWorker;
  voiceDiagnostics?: Pick<VoiceDiagnosticsController, 'captureFile'>;
  streamRoot?: string;
  sessionTtlMs?: number;
  maxAdmittedFrames?: number;
  maxAdmittedBytes?: number;
}>;

function errorResponse(error: unknown, retryable?: boolean): DaemonVoiceInferenceError {
  return {
    ...toVoiceInferenceError(error),
    ...(typeof retryable === 'boolean' ? { retryable } : {}),
  };
}

function streamError(
  errorCode: 'stream_not_found' | 'invalid_stream_state',
  error: string,
): DaemonVoiceInferenceError {
  return {
    ok: false,
    errorCode,
    error,
    retryable: errorCode !== 'stream_not_found',
  };
}

function encodeWavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(44);
  const sampleRate = DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT.sampleRateHz;
  const channels = DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT.channelCount;
  const bitsPerSample = DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT.bitsPerSample;
  const blockAlign = channels * bitsPerSample / 8;
  const byteRate = sampleRate * blockAlign;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function decodePcm16Base64(value: string): Buffer | null {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return null;
  }
  const decoded = Buffer.from(normalized, 'base64');
  if (decoded.byteLength === 0 || decoded.byteLength % 2 !== 0) {
    return null;
  }
  const canonical = decoded.toString('base64').replace(/=+$/u, '');
  if (canonical !== normalized.replace(/=+$/u, '')) {
    return null;
  }
  return decoded;
}

function normalizePcm16Bytes(bytes: Uint8Array): Buffer | null {
  if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) {
    return null;
  }
  return Buffer.from(bytes);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let mismatch = 0;
  for (let index = 0; index < left.byteLength; index += 1) mismatch |= left[index]! ^ right[index]!;
  return mismatch === 0;
}

async function finalizePcm16WavFile(filePath: string, dataBytes: number): Promise<void> {
  const handle = await open(filePath, 'r+');
  try {
    const header = encodeWavHeader(dataBytes);
    const { bytesWritten } = await handle.write(header, 0, header.byteLength, 0);
    if (bytesWritten !== header.byteLength) {
      throw new Error('voice_inference_stream_wav_header_write_incomplete');
    }
  } finally {
    await handle.close();
  }
}

async function cleanupSessionFiles(session: StreamSession): Promise<void> {
  if (session.diagnosticCapturePromise) return;
  const filePaths = session.mode === 'upload_bridge'
    ? [session.wavFilePath]
    : session.diagnosticWavFilePath ? [session.diagnosticWavFilePath] : [];
  await Promise.all(filePaths.map(async (filePath) => {
    await rm(filePath, { force: true }).catch(() => undefined);
  }));
}

export function createVoiceInferenceSpeechStreamManager(
  options: CreateVoiceInferenceSpeechStreamManagerOptions,
): VoiceInferenceSpeechStreamManager {
  const streamRoot = options.streamRoot ?? join(resolveVoiceInferencePaths().tempDir, 'streams');
  const sessions = new Map<string, StreamSession>();
  const sessionTtlMs = typeof options.sessionTtlMs === 'number' && Number.isFinite(options.sessionTtlMs)
    ? Math.max(1_000, Math.trunc(options.sessionTtlMs))
    : Number.isFinite(configuration.filesTransferSessionTtlMs)
      ? Math.max(1_000, Math.trunc(configuration.filesTransferSessionTtlMs))
      : 60_000;
  const maxAdmittedFrames = Math.max(1, Math.trunc(options.maxAdmittedFrames ?? 64));
  const maxAdmittedBytes = Math.max(2, Math.trunc(options.maxAdmittedBytes ?? 2 * 1024 * 1024));
  const activeApplicationAttemptIds = new Set<string>();
  let disposePromise: Promise<void> | null = null;
  let disposed = false;
  const pendingStarts = new Map<string, Pick<BaseStreamSession,
    'requestId' | 'streamId' | 'generation' | 'abortController' | 'streamKey'
  >>();

  function getSession(streamId: string, generation?: number): StreamSession | null {
    const session = sessions.get(streamId) ?? null;
    if (!session || (typeof generation === 'number' && session.generation !== generation)) {
      return null;
    }
    return session;
  }

  function clearExpiry(session: StreamSession): void {
    if (!session.expiryTimer) {
      return;
    }
    clearTimeout(session.expiryTimer);
    session.expiryTimer = null;
  }

  function hasState(session: StreamSession, state: StreamSession['state']): boolean {
    return session.state === state;
  }

  async function closeSession(
    session: StreamSession,
    closeOptions?: Readonly<{ cancelWorker?: boolean }>,
  ): Promise<void> {
    clearExpiry(session);
    session.state = 'closed';
    sessions.delete(session.streamId);
    session.abortController.abort();
    for (const chunk of session.compatibilityChunks.values()) {
      chunk.resolve(streamError('invalid_stream_state', 'daemon_voice_inference_stream_not_open'));
      session.pendingFrames -= 1;
      session.pendingBytes -= chunk.pcm.byteLength;
    }
    session.compatibilityChunks.clear();
    await session.tail.catch(() => undefined);
    session.streamKey?.key.fill(0);
    if (session.mode === 'runtime') {
      if (closeOptions?.cancelWorker === true) {
        await session.runtimeSession.cancel().catch(() => undefined);
      }
      await session.runtimeSession.close().catch(() => undefined);
    }
    // Both modes already cancel through the stream's linked abort signal.
    // Request-id cancellation here can pre-cancel the next utterance on the
    // same admitted call, either after runtime close or before batch recognition.
    await cleanupSessionFiles(session);
    activeApplicationAttemptIds.delete(session.requestId);
  }

  function captureCompletedStream(session: StreamSession, filePath: string): void {
    if (!session.diagnostics || session.diagnostics.captureAllowed !== true || !options.voiceDiagnostics) return;
    session.diagnosticCapturePromise = Promise.resolve()
      .then(async () => await options.voiceDiagnostics!.captureFile({
        direction: 'stt_input',
        format: 'wav',
        filePath,
        durationMs: session.diagnostics!.durationMs,
        sessionId: session.diagnostics!.sessionId,
        authorizationId: session.diagnostics!.authorizationId,
        providerId: 'local_neural',
        attemptId: session.requestId,
      }))
      .then(() => undefined, () => undefined)
      .finally(async () => {
        await rm(filePath, { force: true }).catch(() => undefined);
      });
  }

  async function appendRuntimeDiagnosticPcm(session: RuntimeStreamSession, pcm: Buffer): Promise<void> {
    const filePath = session.diagnosticWavFilePath;
    if (!filePath) return;
    try {
      await appendFile(filePath, pcm);
    } catch {
      // Diagnostics must never make otherwise healthy STT delivery fail. Stop retaining this
      // capture and remove the incomplete daemon-owned staging file.
      session.diagnosticWavFilePath = null;
      await rm(filePath, { force: true }).catch(() => undefined);
    }
  }

  async function finalizeRuntimeDiagnosticCapture(session: RuntimeStreamSession): Promise<void> {
    const filePath = session.diagnosticWavFilePath;
    if (!filePath) return;
    try {
      await finalizePcm16WavFile(filePath, session.totalBytes);
      captureCompletedStream(session, filePath);
    } catch {
      // Keep the transcription result independent from best-effort diagnostic persistence.
      session.diagnosticWavFilePath = null;
      await rm(filePath, { force: true }).catch(() => undefined);
    }
  }

  function scheduleExpiry(session: StreamSession): void {
    clearExpiry(session);
    session.expiryTimer = setTimeout(() => {
      logger.warnLocalFile('[VoiceInference] Streaming STT idle expiry', {
        streamId: session.streamId,
        ackSeq: session.ackSeq,
        admittedSeq: session.admittedSeq,
        pendingFrames: session.pendingFrames,
      });
      void closeSession(session, { cancelWorker: true });
    }, sessionTtlMs);
  }

  const manager: VoiceInferenceSpeechStreamManager = {
    start: async (input, signal, startOptions) => {
      let startAbortController: AbortController | null = null;
      let unlinkRequestAbort = () => {};
      let reservedApplicationAttempt = false;
      let publishedSession = false;
      let session: StreamSession | null = null;
      try {
        if (disposed || signal?.aborted) {
          throw Object.assign(new Error('voice_inference_stream_manager_disposed'), { code: 'cancelled' });
        }
        const streamId = `stream-${randomUUID()}`;
        const mode = input.streamingMode;
        if (!mode) {
          throw Object.assign(new Error('voice_inference_streaming_mode_required'), { code: 'invalid_stream_state' });
        }
        if (activeApplicationAttemptIds.has(input.requestId)) {
          throw Object.assign(
            new Error('voice_inference_stream_application_attempt_already_active'),
            { code: 'invalid_stream_state' },
          );
        }
        activeApplicationAttemptIds.add(input.requestId);
        reservedApplicationAttempt = true;
        const diagnostics = input.diagnostics?.captureAllowed === true ? input.diagnostics : null;
        const abortController = new AbortController();
        if (signal) {
          const abortStart = () => abortController.abort();
          signal.addEventListener('abort', abortStart, { once: true });
          unlinkRequestAbort = () => signal.removeEventListener('abort', abortStart);
          if (signal.aborted) abortStart();
        }
        const streamKey: StreamKeySession | null = startOptions?.issueStreamKey === true
          ? {
              key: new Uint8Array(randomBytes(MACHINE_STREAM_KEY_BYTES_V1)),
              aad: createMachineStreamKeyAadV1({ streamId, generation: 0 }),
              lastSequence: -1,
            }
          : null;
        startAbortController = abortController;
        pendingStarts.set(input.requestId, {
          requestId: input.requestId, streamId, generation: 0, abortController, streamKey,
        });
        if (mode === 'runtime') {
          if (typeof options.voiceInferenceWorker.createStreamingTranscriptionSession !== 'function') {
            throw Object.assign(new Error('voice_inference_streaming_stt_unavailable'), { code: 'runtime_unavailable' });
          }
          const runtimeSession = await options.voiceInferenceWorker.createStreamingTranscriptionSession({
            requestId: input.requestId,
            packId: input.packId,
            language: input.language,
            format: input.format,
            signal: abortController.signal,
          });
          const diagnosticWavFilePath = diagnostics && options.voiceDiagnostics
            ? join(streamRoot, `${streamId}.diagnostic.wav`)
            : null;
          session = {
            mode: 'runtime',
            requestId: input.requestId,
            streamId,
            generation: 0,
            packId: input.packId,
            language: input.language,
            runtimeSession,
            ackSeq: -1,
            admittedSeq: -1,
            totalBytes: 0,
            admittedTotalBytes: 0,
            pendingFrames: 0,
            pendingBytes: 0,
            compatibilityChunks: new Map(),
            state: 'open',
            tail: Promise.resolve(),
            abortController,
            expiryTimer: null,
            diagnostics,
            diagnosticWavFilePath,
            diagnosticCapturePromise: null,
            streamKey,
          };
          if (diagnosticWavFilePath) {
            await mkdir(streamRoot, { recursive: true });
            await writeFile(diagnosticWavFilePath, encodeWavHeader(0), { flag: 'wx', mode: 0o600 });
          }
        } else {
          await mkdir(streamRoot, { recursive: true });
          session = {
            mode: 'upload_bridge',
            requestId: input.requestId,
            streamId,
            generation: 0,
            packId: input.packId,
            language: input.language,
            wavFilePath: join(streamRoot, `${streamId}.wav`),
            ackSeq: -1,
            admittedSeq: -1,
            totalBytes: 0,
            admittedTotalBytes: 0,
            pendingFrames: 0,
            pendingBytes: 0,
            compatibilityChunks: new Map(),
            state: 'open',
            tail: Promise.resolve(),
            abortController,
            expiryTimer: null,
            diagnostics,
            diagnosticWavFilePath: null,
            diagnosticCapturePromise: null,
            streamKey,
          };
          await writeFile(session.wavFilePath, encodeWavHeader(0), { flag: 'wx', mode: 0o600 });
        }
        const createdSession = session;
        if (!createdSession) {
          throw new Error('voice_inference_stream_session_missing');
        }
        if (disposed || abortController.signal.aborted) {
          await closeSession(createdSession, { cancelWorker: true });
          throw Object.assign(new Error('voice_inference_stream_start_cancelled'), { code: 'cancelled' });
        }
        sessions.set(streamId, createdSession);
        publishedSession = true;
        scheduleExpiry(createdSession);
        return {
          ok: true,
          requestId: input.requestId,
          streamId,
          generation: createdSession.generation,
          ackSeq: createdSession.ackSeq,
          format: DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT,
          ...(streamKey ? { streamKeyBase64Url: encodeBase64(streamKey.key, 'base64url') } : {}),
        };
      } catch (error) {
        if (session && session.state !== 'closed') {
          await closeSession(session, { cancelWorker: true });
        }
        return errorResponse(error);
      } finally {
        // Request cancellation owns preparation only. Published streams retain
        // their established explicit/transport-loss cancellation lifecycle.
        unlinkRequestAbort();
        if (reservedApplicationAttempt && !publishedSession) {
          activeApplicationAttemptIds.delete(input.requestId);
        }
        if (startAbortController && pendingStarts.get(input.requestId)?.abortController === startAbortController) {
          pendingStarts.delete(input.requestId);
        }
      }
    },
    appendTunnelFrame: async (input) => {
      const session = getSession(input.streamId, input.generation);
      const streamKey = session?.streamKey ?? null;
      if (!session || !streamKey) {
        // Plain Account: the tunnel payload is the PCM itself, as on every route.
        return await manager.appendPcm16Bytes({
          streamId: input.streamId, generation: input.generation, seq: input.seq,
          pcm16Bytes: input.payloadBytes, voiceMediaApplicationAuthority: input.voiceMediaApplicationAuthority,
        });
      }
      if (session.state !== 'open') {
        throw Object.assign(new Error('daemon_voice_inference_stream_not_open'), { code: 'invalid_stream_state' });
      }
      // Each sequence opens and seals once; a replay or gap never reaches the cipher.
      if (input.seq !== streamKey.lastSequence + 1) {
        throw Object.assign(new Error('daemon_voice_inference_stream_key_sequence_mismatch'), { code: 'invalid_stream_state' });
      }
      let plaintext: Uint8Array;
      try {
        plaintext = openAes256GcmBytes({
          key: streamKey.key,
          nonce: createMachineStreamKeyNonceV1('client_to_daemon', input.seq),
          aad: streamKey.aad,
          ciphertext: input.payloadBytes,
        });
      } catch {
        throw Object.assign(new Error('daemon_voice_inference_stream_key_authentication_failed'), { code: 'invalid_stream_state' });
      }
      streamKey.lastSequence = input.seq;
      // Native append/finalization can retire the stream and wipe its key before
      // returning a typed failure. Retain only this admitted response's key until
      // it is sealed, so cleanup cannot turn that failure into corrupt ciphertext.
      const responseKey = new Uint8Array(streamKey.key);
      const processingStartedAt = process.env.HAPPIER_WEB_LATENCY_TRACE === '1' ? performance.now() : null;
      let response: DaemonVoiceInferenceSttStreamChunkResponse | undefined;
      try {
        response = await manager.appendPcm16Bytes({
          streamId: session.streamId,
          generation: session.generation,
          seq: input.seq,
          pcm16Bytes: plaintext,
          streamKeyOpened: true,
          voiceMediaApplicationAuthority: input.voiceMediaApplicationAuthority,
        });
        return sealAes256GcmBytes({
          key: responseKey,
          nonce: createMachineStreamKeyNonceV1('daemon_to_client', input.seq),
          aad: streamKey.aad,
          plaintext: new TextEncoder().encode(JSON.stringify(response)),
        });
      } finally {
        responseKey.fill(0);
        if (processingStartedAt !== null) {
          try { logger.debug('[VoiceInference] Keyed stream frame settled', {
            streamId: session.streamId, sequence: input.seq,
            elapsedMs: performance.now() - processingStartedAt, ok: response?.ok === true,
          }); } catch { /* Diagnostic only. */ }
        }
      }
    },
    appendCompatibilityChunk: async (input) => {
      const pcm = decodePcm16Base64(input.pcm16Base64);
      if (!pcm) {
        return streamError('invalid_stream_state', 'daemon_voice_inference_stream_invalid_pcm');
      }
      const session = getSession(input.streamId, input.generation);
      if (!session || session.state !== 'open' || session.streamKey || input.seq <= session.admittedSeq) {
        return await manager.appendPcm16Bytes({ ...input, pcm16Bytes: pcm });
      }
      const pending = session.compatibilityChunks.get(input.seq);
      if (pending) {
        return sameBytes(pending.pcm, pcm)
          ? await pending.result
          : streamError('invalid_stream_state', 'daemon_voice_inference_stream_invalid_pcm');
      }
      // Live capture uses pending credit, not the file-transfer upload limit.
      if (session.pendingFrames >= maxAdmittedFrames
        || session.pendingBytes + pcm.byteLength > maxAdmittedBytes) {
        return streamError('invalid_stream_state', 'daemon_voice_inference_stream_invalid_pcm');
      }
      let resolve!: CompatibilityChunk['resolve'];
      const result = new Promise<DaemonVoiceInferenceSttStreamChunkResponse>(done => { resolve = done; });
      session.compatibilityChunks.set(input.seq, { pcm, result, resolve });
      session.pendingFrames += 1;
      session.pendingBytes += pcm.byteLength;
      // Independent RPC admission can finish in a different order at either
      // Home or daemon. Reorder only this compatibility ingress, under the
      // stream's existing credit/expiry/cleanup owner, before contiguous admission.
      let next: CompatibilityChunk | undefined;
      while (session.state === 'open' && (next = session.compatibilityChunks.get(session.admittedSeq + 1))) {
        const chunk = next;
        const seq = session.admittedSeq + 1;
        session.compatibilityChunks.delete(seq);
        session.pendingFrames -= 1;
        session.pendingBytes -= next.pcm.byteLength;
        void manager.appendPcm16Bytes({ streamId: input.streamId, generation: input.generation, seq, pcm16Bytes: next.pcm })
          .then(chunk.resolve, error => chunk.resolve(errorResponse(error)));
      }
      return await result;
    },
    appendPcm16Bytes: async (input) => {
      const session = getSession(input.streamId, input.generation);
      if (!session) {
        return streamError('stream_not_found', 'daemon_voice_inference_stream_not_found');
      }
      if (session.state !== 'open') {
        return streamError('invalid_stream_state', 'daemon_voice_inference_stream_not_open');
      }
      if (
        input.voiceMediaApplicationAuthority
        && (
          input.voiceMediaApplicationAuthority.applicationKind !== 'speech_transcription'
          || input.voiceMediaApplicationAuthority.applicationAttemptId !== session.requestId
          || input.voiceMediaApplicationAuthority.applicationAuthorityDigest
            !== createSpeechTranscriptionApplicationAuthorityDigestV1(session.requestId)
        )
      ) {
        return streamError('invalid_stream_state', 'daemon_voice_inference_stream_application_authority_mismatch');
      }
      if (session.streamKey && input.streamKeyOpened !== true) {
        return streamError('invalid_stream_state', 'daemon_voice_inference_stream_encryption_required');
      }
      if (input.seq <= session.ackSeq) {
        return {
          ok: true,
          streamId: session.streamId,
          generation: session.generation,
          ackSeq: session.ackSeq,
          events: [],
        };
      }
      if (input.seq !== session.admittedSeq + 1) {
        return streamError('invalid_stream_state', 'daemon_voice_inference_stream_noncontiguous_seq');
      }
      const pcm = normalizePcm16Bytes(input.pcm16Bytes);
      if (
        !pcm
        || session.pendingFrames >= maxAdmittedFrames
        || session.pendingBytes + pcm.byteLength > maxAdmittedBytes
      ) {
        return streamError('invalid_stream_state', 'daemon_voice_inference_stream_invalid_pcm');
      }
      session.admittedSeq = input.seq;
      session.admittedTotalBytes += pcm.byteLength;
      session.pendingFrames += 1;
      session.pendingBytes += pcm.byteLength;
      const nextTotalBytes = session.admittedTotalBytes;
      let events: DaemonVoiceInferenceSttStreamEvent[] = [];
      session.tail = session.tail.then(async () => {
        if (session.mode === 'runtime') {
          const appended = await session.runtimeSession.appendPcm16({
            seq: input.seq,
            pcm16Bytes: pcm,
            signal: session.abortController.signal,
          });
          events = [...appended.events];
          await appendRuntimeDiagnosticPcm(session, pcm);
        } else {
          await appendFile(session.wavFilePath, pcm);
        }
        session.ackSeq = input.seq;
        session.totalBytes = nextTotalBytes;
      }).finally(() => {
        session.pendingFrames = Math.max(0, session.pendingFrames - 1);
        session.pendingBytes = Math.max(0, session.pendingBytes - pcm.byteLength);
      });
      try {
        await session.tail;
        if (session.state !== 'open') {
          return streamError('invalid_stream_state', 'daemon_voice_inference_stream_not_open');
        }
        scheduleExpiry(session);
        return {
          ok: true,
          streamId: session.streamId,
          generation: session.generation,
          ackSeq: session.ackSeq,
          events,
        };
      } catch (error) {
        const response = errorResponse(error);
        if (session.mode === 'runtime') {
          const code = DaemonVoiceInferenceSttAppendDiagnosticSchema.shape.code.safeParse(
            error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined,
          );
          response.diagnostic = {
            operation: 'appendPcm16',
            streamId: session.streamId,
            exceptionClass: error instanceof TypeError ? 'TypeError'
              : error instanceof RangeError ? 'RangeError'
                : error instanceof SyntaxError ? 'SyntaxError'
                  : error instanceof ReferenceError ? 'ReferenceError'
                    : error instanceof URIError ? 'URIError'
                      : error instanceof EvalError ? 'EvalError'
                        : error instanceof AggregateError ? 'AggregateError'
                          : error instanceof Error ? 'Error' : 'Unknown',
            code: code.success ? code.data : null,
          };
          logger.warnLocalFile('[VoiceInference] Native streaming STT append failed', response.diagnostic);
        }
        if (!hasState(session, 'closed')) {
          await closeSession(session, { cancelWorker: true });
        }
        return response;
      }
    },
    finish: async (input) => {
      const session = getSession(input.streamId, input.generation);
      if (!session) {
        return streamError('stream_not_found', 'daemon_voice_inference_stream_not_found');
      }
      if (session.state !== 'open') {
        return streamError('invalid_stream_state', 'daemon_voice_inference_stream_not_open');
      }
      if (!(input.finalSeq === session.admittedSeq || (session.admittedSeq === -1 && input.finalSeq === 0))) {
        return streamError('invalid_stream_state', 'daemon_voice_inference_stream_final_seq_unacked');
      }
      session.state = 'finishing';
      clearExpiry(session);
      try {
        await session.tail;
        if (!hasState(session, 'finishing')) {
          return streamError('invalid_stream_state', 'daemon_voice_inference_stream_not_open');
        }
        if (!(input.finalSeq === session.ackSeq || (session.ackSeq === -1 && input.finalSeq === 0))) {
          return streamError('invalid_stream_state', 'daemon_voice_inference_stream_final_seq_unacked');
        }
        if (session.mode === 'runtime') {
          const finished = await session.runtimeSession.finish({
            finalSeq: input.finalSeq,
            signal: session.abortController.signal,
          });
          if (!hasState(session, 'finishing')) {
            return streamError('invalid_stream_state', 'daemon_voice_inference_stream_not_open');
          }
          const modelPackId = session.runtimeSession.modelPackId ?? session.packId;
          const events: DaemonVoiceInferenceSttStreamEvent[] = finished.events.length > 0
            ? [...finished.events]
            : [{
                type: 'final' as const,
                seq: Math.max(0, session.ackSeq),
                text: finished.text,
                language: finished.language,
                modelPackId,
              }];
          await finalizeRuntimeDiagnosticCapture(session);
          await closeSession(session);
          return {
            ok: true,
            streamId: session.streamId,
            generation: session.generation,
            ackSeq: session.ackSeq,
            finalText: finished.text,
            language: finished.language,
            modelPackId,
            events,
          };
        }
        await finalizePcm16WavFile(session.wavFilePath, session.totalBytes);
        const transcribed = await options.voiceInferenceWorker.transcribeAudio({
          requestId: session.requestId,
          uploadId: session.streamId,
          filePath: session.wavFilePath,
          inputMimeType: 'audio/wav',
          packId: session.packId,
          language: session.language,
          normalization: {
            inputTransport: 'upload_transfer',
            strategy: 'ui_pretranscoded_pcm16_fallback',
            systemFfmpegAllowed: false,
          },
          signal: session.abortController.signal,
          onTranscribed: async () => {
            if (!hasState(session, 'finishing')) return;
            captureCompletedStream(session, session.wavFilePath);
            await session.diagnosticCapturePromise;
          },
        });
        if (!hasState(session, 'finishing')) {
          return streamError('invalid_stream_state', 'daemon_voice_inference_stream_not_open');
        }
        await closeSession(session);
        return {
          ok: true,
          streamId: session.streamId,
          generation: session.generation,
          ackSeq: session.ackSeq,
          finalText: transcribed.text,
          language: transcribed.language,
          modelPackId: transcribed.modelPackId,
          events: [{
            type: 'final',
            seq: Math.max(0, session.ackSeq),
            text: transcribed.text,
            language: transcribed.language,
            modelPackId: transcribed.modelPackId,
          }],
        };
      } catch (error) {
        if (!hasState(session, 'closed')) {
          await closeSession(session);
        }
        return errorResponse(error);
      }
    },
    cancel: async (input) => {
      const session = getSession(input.streamId, input.generation);
      if (!session) {
        return streamError('stream_not_found', 'daemon_voice_inference_stream_not_found');
      }
      await closeSession(session, { cancelWorker: true });
      return {
        ok: true,
        streamId: session.streamId,
        generation: session.generation,
      };
    },
    cancelForTransportLoss: async (input) => {
      const authoritySession = [...sessions.values()].find(
        (candidate) =>
          candidate.requestId
            === input.voiceMediaApplicationAuthority.applicationAttemptId,
      ) ?? null;
      const session = authoritySession ?? (
        typeof input.streamId === 'string'
        && typeof input.generation === 'number'
          ? getSession(input.streamId, input.generation)
          : pendingStarts.get(input.voiceMediaApplicationAuthority.applicationAttemptId) ?? null
      );
      if (!session) {
        return streamError('stream_not_found', 'daemon_voice_inference_stream_not_found');
      }
      if (
        input.voiceMediaApplicationAuthority.applicationKind !== 'speech_transcription'
        || input.voiceMediaApplicationAuthority.applicationAttemptId !== session.requestId
        || input.voiceMediaApplicationAuthority.applicationAuthorityDigest
          !== createSpeechTranscriptionApplicationAuthorityDigestV1(session.requestId)
      ) {
        return streamError(
          'invalid_stream_state',
          'daemon_voice_inference_stream_application_authority_mismatch',
        );
      }
      if (((candidate): candidate is StreamSession => 'state' in candidate)(session)) {
        await closeSession(session, { cancelWorker: true });
      } else {
        // The tunnel already owns the exact application authority before native
        // creation settles. Retire that pending start too, so a late native result
        // cannot publish an orphan after its client has gone away.
        session.abortController.abort();
      }
      return {
        ok: true,
        streamId: session.streamId,
        generation: session.generation,
      };
    },
    dispose: async () => {
      if (disposePromise) {
        return await disposePromise;
      }
      disposePromise = (async () => {
        disposed = true;
        for (const pending of pendingStarts.values()) {
          pending.abortController.abort();
        }
        await Promise.all([...sessions.values()].map(async (session) => {
          await closeSession(session, { cancelWorker: true });
        }));
      })();
      return await disposePromise;
    },
  };
  return manager;
}
