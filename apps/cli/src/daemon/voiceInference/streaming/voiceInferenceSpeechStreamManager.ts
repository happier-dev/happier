import { randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT, DaemonVoiceInferenceSttAppendDiagnosticSchema } from '@happier-dev/protocol/daemon/voiceInference';
import { PEER_APPLICATION_ENCRYPTION_DATA_KEY_BYTES_V1, PEER_APPLICATION_ENCRYPTION_INSTALL_CONFIRMATION_V1, PEER_APPLICATION_ENCRYPTION_INSTALL_PROOF_V1, PEER_APPLICATION_ENCRYPTION_SUITE_V1, createPeerApplicationEncryptionAadV1, createPeerApplicationEncryptionNonceV1, createSpeechTranscriptionApplicationAuthorityDigestV1, decodePeerApplicationEncryptedFrameV1, encodePeerApplicationEncryptedFrameV1 } from '@happier-dev/protocol/machines/peer/mediation/peerApplicationEncryptionV1';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { deriveBoxPublicKeyFromSeed } from '@happier-dev/protocol/crypto/boxBundle';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import type { DaemonVoiceInferenceError, DaemonVoiceInferenceSttStreamCancelRequest, DaemonVoiceInferenceSttStreamCancelResponse, DaemonVoiceInferenceSttStreamChunkRequest, DaemonVoiceInferenceSttStreamChunkResponse, DaemonVoiceInferenceSttStreamEvent, DaemonVoiceInferenceSttStreamFinishRequest, DaemonVoiceInferenceSttStreamFinishResponse, DaemonVoiceInferenceSttStreamStartRequest, DaemonVoiceInferenceSttStreamStartResponse, DaemonVoiceInferenceSttStreamStatusRequest, DaemonVoiceInferenceSttStreamStatusResponse, VoiceSpeechDiagnosticsCaptureContextV1, PeerApplicationEncryptionAuthorityBindingV1, PeerApplicationEncryptionPhaseV1, VoiceMediaApplicationAuthorityV1 } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { toVoiceInferenceError } from '@/api/machine/voiceInferenceRpcResponses';
import { resolveVoiceInferencePaths } from '@/daemon/voiceInference/voiceInferencePaths';
import type { VoiceInferenceWorkerStreamingTranscriptionSession } from '@/daemon/voiceInference/voiceInferenceWorker.execution';
import type { VoiceDiagnosticsController } from '@/daemon/voiceDiagnostics/controller';
import { openAes256GcmBytes, sealAes256GcmBytes } from '@happier-dev/transfers/node';

type PeerApplicationEncryptionSession = {
  binding: PeerApplicationEncryptionAuthorityBindingV1;
  recipientSecretKeySeed: Uint8Array;
  contentKey: Uint8Array | null;
  lastCarrierSequence: number;
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
  peerApplicationEncryption: PeerApplicationEncryptionSession | null;
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
  cancelStt: (requestId: string) => Promise<void>;
  createStreamingTranscriptionSession?: (input: Readonly<{
    requestId: string;
    packId: string | null;
    language: string | null;
    format: typeof DAEMON_VOICE_INFERENCE_STT_STREAM_PCM_FORMAT;
    signal?: AbortSignal | null;
  }>) => Promise<VoiceInferenceWorkerStreamingTranscriptionSession>;
}>;

export type VoiceInferenceSpeechStreamManager = Readonly<{
  start: (input: DaemonVoiceInferenceSttStreamStartRequest, signal?: AbortSignal) => Promise<DaemonVoiceInferenceSttStreamStartResponse>;
  appendCompatibilityChunk: (input: DaemonVoiceInferenceSttStreamChunkRequest) => Promise<DaemonVoiceInferenceSttStreamChunkResponse>;
  appendPcm16Bytes: (input: Readonly<{
    streamId: string;
    generation: number;
    seq: number;
    pcm16Bytes: Uint8Array;
    peerApplicationDecrypted?: true;
    voiceMediaApplicationAuthority?: VoiceMediaApplicationAuthorityV1;
  }>) => Promise<DaemonVoiceInferenceSttStreamChunkResponse>;
  appendPeerApplicationFrame: (input: Readonly<{
    binding: PeerApplicationEncryptionAuthorityBindingV1;
    streamId: string;
    generation: number;
    substreamId: string;
    carrierSequence: number;
    payloadBytes: Uint8Array;
  }>) => Promise<Uint8Array>;
  finish: (input: DaemonVoiceInferenceSttStreamFinishRequest & Readonly<{
    peerApplicationDecrypted?: true;
  }>) => Promise<DaemonVoiceInferenceSttStreamFinishResponse>;
  cancel: (input: DaemonVoiceInferenceSttStreamCancelRequest) => Promise<DaemonVoiceInferenceSttStreamCancelResponse>;
  cancelForTransportLoss: (input: Readonly<{
    peerApplicationEncryption?: PeerApplicationEncryptionAuthorityBindingV1;
    voiceMediaApplicationAuthority: VoiceMediaApplicationAuthorityV1;
  }> & (
    | DaemonVoiceInferenceSttStreamCancelRequest
    | Readonly<{ streamId?: never; generation?: never }>
  )) => Promise<DaemonVoiceInferenceSttStreamCancelResponse>;
  status: (input: DaemonVoiceInferenceSttStreamStatusRequest) => Promise<DaemonVoiceInferenceSttStreamStatusResponse>;
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

function samePeerApplicationBinding(
  left: PeerApplicationEncryptionAuthorityBindingV1,
  right: PeerApplicationEncryptionAuthorityBindingV1,
): boolean {
  return left.v === right.v
    && left.suite === right.suite
    && left.flowKind === right.flowKind
    && left.routeKind === right.routeKind
    && left.authorityDigest === right.authorityDigest
    && left.accountId === right.accountId
    && left.machineId === right.machineId
    && left.tunnelId === right.tunnelId
    && left.applicationKind === right.applicationKind
    && left.applicationAttemptId === right.applicationAttemptId
    && left.applicationAuthorityDigest === right.applicationAuthorityDigest;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let mismatch = 0;
  for (let index = 0; index < left.byteLength; index += 1) mismatch |= left[index]! ^ right[index]!;
  return mismatch === 0;
}

function parseEncryptedFinishRequest(bytes: Uint8Array): DaemonVoiceInferenceSttStreamFinishRequest | null {
  try {
    const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (Object.keys(record).length !== 1 || !Number.isSafeInteger(record.finalSeq) || (record.finalSeq as number) < 0) {
      return null;
    }
    return { streamId: '', generation: 0, finalSeq: record.finalSeq as number };
  } catch {
    return null;
  }
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
    'requestId' | 'streamId' | 'generation' | 'abortController' | 'peerApplicationEncryption'
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
    session.peerApplicationEncryption?.recipientSecretKeySeed.fill(0);
    session.peerApplicationEncryption?.contentKey?.fill(0);
    if (session.peerApplicationEncryption) session.peerApplicationEncryption.contentKey = null;
    if (session.mode === 'runtime') {
      if (closeOptions?.cancelWorker === true) {
        await session.runtimeSession.cancel().catch(() => undefined);
      }
      await session.runtimeSession.close().catch(() => undefined);
    }
    if (closeOptions?.cancelWorker === true) {
      await options.voiceInferenceWorker.cancelStt(session.requestId).catch(() => undefined);
    }
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
    start: async (input, signal) => {
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
        if (
          input.peerApplicationEncryption
          && (
            input.peerApplicationEncryption.applicationKind !== 'speech_transcription'
            || input.peerApplicationEncryption.applicationAttemptId !== input.requestId
            || input.peerApplicationEncryption.applicationAuthorityDigest
              !== createSpeechTranscriptionApplicationAuthorityDigestV1(input.requestId)
          )
        ) {
          throw Object.assign(
            new Error('voice_inference_stream_application_authority_mismatch'),
            { code: 'invalid_stream_state' },
          );
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
        const peerApplicationEncryption: PeerApplicationEncryptionSession | null = input.peerApplicationEncryption
          ? {
              binding: input.peerApplicationEncryption,
              recipientSecretKeySeed: new Uint8Array(randomBytes(PEER_APPLICATION_ENCRYPTION_DATA_KEY_BYTES_V1)),
              contentKey: null,
              lastCarrierSequence: -1,
            }
          : null;
        startAbortController = abortController;
        pendingStarts.set(input.requestId, {
          requestId: input.requestId, streamId, generation: 0, abortController, peerApplicationEncryption,
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
            peerApplicationEncryption,
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
            peerApplicationEncryption,
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
          ...(peerApplicationEncryption ? {
            peerApplicationEncryption: {
              v: 1 as const,
              suite: PEER_APPLICATION_ENCRYPTION_SUITE_V1,
              recipientPublicKeyBase64Url: encodeBase64(
                deriveBoxPublicKeyFromSeed(peerApplicationEncryption.recipientSecretKeySeed),
                'base64url',
              ),
            },
          } : {}),
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
    appendPeerApplicationFrame: async (input) => {
      const session = getSession(input.streamId, input.generation);
      const encryption = session?.peerApplicationEncryption ?? null;
      if (!session || !encryption || session.state !== 'open') {
        throw Object.assign(new Error('daemon_voice_inference_encrypted_stream_not_found'), { code: 'stream_not_found' });
      }
      if (!samePeerApplicationBinding(encryption.binding, input.binding)) {
        throw Object.assign(new Error('daemon_voice_inference_encryption_authority_mismatch'), { code: 'invalid_stream_state' });
      }
      const expectedSubstreamId = `daemon.voiceInference.stt.${session.streamId}.${session.generation}`;
      if (input.substreamId !== expectedSubstreamId || input.carrierSequence !== encryption.lastCarrierSequence + 1) {
        throw Object.assign(new Error('daemon_voice_inference_encryption_sequence_mismatch'), { code: 'invalid_stream_state' });
      }
      const frame = decodePeerApplicationEncryptedFrameV1(input.payloadBytes);
      if (!frame) {
        throw Object.assign(new Error('daemon_voice_inference_encryption_frame_invalid'), { code: 'invalid_stream_state' });
      }
      const phase: PeerApplicationEncryptionPhaseV1 = frame.kind;
      const requestNonce = createPeerApplicationEncryptionNonceV1({
        direction: 'client_to_daemon',
        phase,
        sequence: input.carrierSequence,
      });
      if (!sameBytes(decodeBase64(frame.nonceBase64Url, 'base64url'), requestNonce)) {
        throw Object.assign(new Error('daemon_voice_inference_encryption_nonce_mismatch'), { code: 'invalid_stream_state' });
      }
      const aadBase = {
        authorityDigest: input.binding.authorityDigest,
        accountId: input.binding.accountId,
        machineId: input.binding.machineId,
        tunnelId: input.binding.tunnelId,
        applicationKind: input.binding.applicationKind,
        applicationAttemptId: input.binding.applicationAttemptId,
        applicationAuthorityDigest: input.binding.applicationAuthorityDigest,
        streamId: session.streamId,
        generation: session.generation,
        substreamId: input.substreamId,
        sequence: input.carrierSequence,
        phase,
      } as const;
      let contentKey = encryption.contentKey;
      if (frame.kind === 'install') {
        if (contentKey || input.carrierSequence !== 0 || !frame.encryptedDataKeyEnvelopeBase64Url) {
          throw Object.assign(new Error('daemon_voice_inference_encryption_install_invalid'), { code: 'invalid_stream_state' });
        }
        contentKey = openEncryptedDataKeyEnvelopeV1({
          envelope: decodeBase64(frame.encryptedDataKeyEnvelopeBase64Url, 'base64url'),
          recipientSecretKeyOrSeed: encryption.recipientSecretKeySeed,
        });
        if (!contentKey || contentKey.byteLength !== PEER_APPLICATION_ENCRYPTION_DATA_KEY_BYTES_V1) {
          contentKey?.fill(0);
          throw Object.assign(new Error('daemon_voice_inference_encryption_key_invalid'), { code: 'invalid_stream_state' });
        }
      } else if (!contentKey) {
        throw Object.assign(new Error('daemon_voice_inference_encryption_not_installed'), { code: 'invalid_stream_state' });
      }

      let plaintext: Uint8Array;
      try {
        plaintext = openAes256GcmBytes({
          key: contentKey,
          nonce: requestNonce,
          aad: createPeerApplicationEncryptionAadV1({ ...aadBase, direction: 'client_to_daemon' }),
          ciphertext: decodeBase64(frame.ciphertextBase64Url, 'base64url'),
        });
      } catch {
        if (frame.kind === 'install') contentKey.fill(0);
        throw Object.assign(new Error('daemon_voice_inference_encryption_authentication_failed'), { code: 'invalid_stream_state' });
      }

      let response: unknown;
      const processingStartedAt = process.env.HAPPIER_WEB_LATENCY_TRACE === '1' ? performance.now() : null;
      // Native append/finalization can retire the stream and wipe its key before
      // returning a typed failure. Retain only this admitted response's key until
      // it is sealed, so cleanup cannot turn that failure into corrupt ciphertext.
      const responseKey = frame.kind === 'install' ? contentKey : new Uint8Array(contentKey);
      try {
        if (frame.kind === 'install') {
          if (new TextDecoder().decode(plaintext) !== PEER_APPLICATION_ENCRYPTION_INSTALL_PROOF_V1) {
            contentKey.fill(0);
            throw Object.assign(new Error('daemon_voice_inference_encryption_confirmation_failed'), { code: 'invalid_stream_state' });
          }
          encryption.contentKey = contentKey;
          response = PEER_APPLICATION_ENCRYPTION_INSTALL_CONFIRMATION_V1;
        } else if (phase === 'data') {
          response = await manager.appendPcm16Bytes({
            streamId: session.streamId,
            generation: session.generation,
            seq: input.carrierSequence - 1,
            pcm16Bytes: plaintext,
            peerApplicationDecrypted: true,
          });
        } else {
          const finish = parseEncryptedFinishRequest(plaintext);
          if (!finish) {
            throw Object.assign(new Error('daemon_voice_inference_encrypted_finish_invalid'), { code: 'invalid_stream_state' });
          }
          response = await manager.finish({
            streamId: session.streamId,
            generation: session.generation,
            finalSeq: finish.finalSeq,
            peerApplicationDecrypted: true,
          });
        }
        encryption.lastCarrierSequence = input.carrierSequence;
        const responsePlaintext = typeof response === 'string'
          ? new TextEncoder().encode(response)
          : new TextEncoder().encode(JSON.stringify(response));
        const responseNonce = createPeerApplicationEncryptionNonceV1({
          direction: 'daemon_to_client',
          phase,
          sequence: input.carrierSequence,
        });
        const responseCiphertext = sealAes256GcmBytes({
          key: responseKey,
          nonce: responseNonce,
          aad: createPeerApplicationEncryptionAadV1({ ...aadBase, direction: 'daemon_to_client' }),
          plaintext: responsePlaintext,
        });
        return encodePeerApplicationEncryptedFrameV1({
          v: 1,
          kind: phase,
          nonceBase64Url: encodeBase64(responseNonce, 'base64url'),
          ciphertextBase64Url: encodeBase64(responseCiphertext, 'base64url'),
        });
      } finally {
        if (responseKey !== contentKey) responseKey.fill(0);
        if (processingStartedAt !== null) {
          try { logger.debug('[VoiceInference] Relay application frame settled', {
            tunnelId: input.binding.tunnelId, substreamId: input.substreamId,
            sequence: input.carrierSequence, phase,
            elapsedMs: performance.now() - processingStartedAt,
            ok: typeof response === 'string'
              || (response !== null && typeof response === 'object' && 'ok' in response && response.ok === true),
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
      if (!session || session.state !== 'open' || session.peerApplicationEncryption || input.seq <= session.admittedSeq) {
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
      if (session.peerApplicationEncryption && input.peerApplicationDecrypted !== true) {
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
      if (session.peerApplicationEncryption && input.peerApplicationDecrypted !== true) {
        return streamError('invalid_stream_state', 'daemon_voice_inference_stream_encryption_required');
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
        || (
          session.peerApplicationEncryption
          && (
            !input.peerApplicationEncryption
            || !samePeerApplicationBinding(
              session.peerApplicationEncryption.binding,
              input.peerApplicationEncryption,
            )
          )
        )
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
    status: async (input) => {
      const session = getSession(input.streamId, input.generation);
      if (!session) {
        return streamError('stream_not_found', 'daemon_voice_inference_stream_not_found');
      }
      return {
        ok: true,
        streamId: session.streamId,
        generation: session.generation,
        ackSeq: session.ackSeq,
        state: session.state,
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
