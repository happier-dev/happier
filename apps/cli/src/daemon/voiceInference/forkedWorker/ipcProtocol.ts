/**
 * IPC boundary for the FORKED voice-inference worker (Lane L7.T7).
 *
 * The daemon and a forked child process exchange length-prefixed JSON frames over a
 * byte stream (the child's stdio). This module owns the wire contract: the frame
 * shapes plus an incremental, binary-safe codec. It deliberately knows nothing about
 * child processes or the engine — it is pure so the protocol can be unit-tested without
 * spawning anything.
 *
 * Wire format: each frame is a 4-byte big-endian unsigned length prefix followed by
 * exactly that many bytes of payload. This survives partial reads and never relies
 * on a delimiter appearing inside arbitrary payloads. The payload is UTF-8 JSON, except
 * for `stt_stream_append`, whose PCM travels as raw bytes: a 0x00 marker (JSON never starts
 * with it), a 4-byte big-endian JSON header length, the JSON header, then the raw PCM bytes.
 * The frame ceiling covers the whole payload in both forms.
 *
 * Request/response is correlated by `id` and every request receives exactly one terminal
 * `result` or `error` frame. Streaming STT uses its explicit start/append/finish requests.
 */

import { DaemonVoiceInferenceAudioOutputSchema, DaemonVoiceInferenceModelRuntimeStateSchema, DaemonVoiceInferenceNormalizationDecisionSchema, DaemonVoiceInferenceSttStreamEventSchema, DaemonVoiceInferenceSttStreamPcmFormatSchema } from '@happier-dev/protocol/daemon/voiceInference';
import { VoiceModelPackRuntimeV1Schema } from '@happier-dev/protocol/voice/modelPacks/contributionV1';
import { VoiceModelPackSupportArtifactV1Schema } from '@happier-dev/protocol/voice/modelPacks/artifactRolesV1';
import type { DaemonVoiceInferenceAudioOutput, DaemonVoiceInferenceModelRuntimeState, DaemonVoiceInferenceNormalizationDecision, DaemonVoiceInferenceSttStreamEvent, DaemonVoiceInferenceSttStreamPcmFormat, ModelPackManifest, VoiceModelPackRuntimeV1, VoiceModelPackSupportArtifactV1 } from '@happier-dev/protocol';
import { z } from 'zod/mini';

export const VOICE_INFERENCE_WORKER_IPC_VERSION = 1 as const;

type VoiceInferenceWorkerPackContract = Readonly<{
  runtimeDescriptor?: VoiceModelPackRuntimeV1 | null;
  supportArtifacts?: readonly VoiceModelPackSupportArtifactV1[];
}>;

/** Daemon → child. Each method of the engine boundary maps to one request kind. */
export type VoiceInferenceWorkerRequestFrame =
  | (Readonly<{
      kind: 'warm'; id: string; packId: string; packDir: string; manifest: ModelPackManifest;
    }> & VoiceInferenceWorkerPackContract)
  | (Readonly<{
      kind: 'prime'; id: string; packId: string; packDir: string; manifest: ModelPackManifest;
    }> & VoiceInferenceWorkerPackContract)
  | (Readonly<{
      kind: 'release'; id: string; packId: string; packDir: string; manifest: ModelPackManifest;
    }> & VoiceInferenceWorkerPackContract)
  | (Readonly<{
      kind: 'synthesize';
      id: string;
      requestId: string;
      text: string;
      packId: string;
      packDir: string;
      manifest: ModelPackManifest;
      voiceId: string | null;
      speed: number | null;
      output: DaemonVoiceInferenceAudioOutput;
    }> & VoiceInferenceWorkerPackContract)
  | (Readonly<{
      kind: 'transcribe';
      id: string;
      requestId: string;
      filePath: string;
      inputMimeType: string;
      packId: string;
      packDir: string;
      manifest: ModelPackManifest;
      language: string | null;
      normalization: DaemonVoiceInferenceNormalizationDecision;
    }> & VoiceInferenceWorkerPackContract)
  | (Readonly<{
      kind: 'stt_stream_start';
      id: string;
      requestId: string;
      packId: string;
      packDir: string;
      manifest: ModelPackManifest;
      language: string | null;
      format: DaemonVoiceInferenceSttStreamPcmFormat;
    }> & VoiceInferenceWorkerPackContract)
  | Readonly<{
      kind: 'stt_stream_append';
      id: string;
      sessionId: string;
      seq: number;
      pcm16Bytes: Uint8Array;
    }>
  | Readonly<{
      kind: 'stt_stream_finish';
      id: string;
      sessionId: string;
      finalSeq: number;
    }>
  | Readonly<{
      kind: 'stt_stream_cancel';
      id: string;
      sessionId: string;
    }>
  /** Cooperative cancellation: maps the daemon-side D12 AbortSignal to a child-side abort. */
  | Readonly<{ kind: 'abort'; id: string; targetId: string }>;

export type VoiceInferenceWorkerRequestKind = VoiceInferenceWorkerRequestFrame['kind'];

/** Child → daemon. Terminal results and readiness telemetry. */
export type VoiceInferenceWorkerResponseFrame =
  | Readonly<{ kind: 'result'; id: string; result: VoiceInferenceWorkerResultPayload }>
  | Readonly<{
      kind: 'error';
      id: string;
      /** Mirrors the daemon-side voice-inference error `code` so the proxy can rethrow cleanly. */
      code: string;
      message: string;
    }>
  /** Unsolicited readiness snapshot the child pushes on engine state transitions. */
  | Readonly<{
      kind: 'snapshot';
      packId: string;
      runtimeState: DaemonVoiceInferenceModelRuntimeState;
    }>;

export type VoiceInferenceWorkerResultPayload =
  | Readonly<{ kind: 'warm' }>
  | Readonly<{ kind: 'prime' }>
  | Readonly<{ kind: 'release' }>
  | Readonly<{
      kind: 'synthesize';
      output: DaemonVoiceInferenceAudioOutput;
      bytesBase64: string;
      name: string | null;
    }>
  | Readonly<{ kind: 'transcribe'; text: string; language: string | null }>
  | Readonly<{ kind: 'stt_stream_start'; sessionId: string }>
  | Readonly<{ kind: 'stt_stream_append'; events: readonly DaemonVoiceInferenceSttStreamEvent[] }>
  | Readonly<{
      kind: 'stt_stream_finish';
      text: string;
      language: string | null;
      events: readonly DaemonVoiceInferenceSttStreamEvent[];
    }>
  | Readonly<{ kind: 'stt_stream_cancel' }>;

export type VoiceInferenceWorkerFrame =
  | VoiceInferenceWorkerRequestFrame
  | VoiceInferenceWorkerResponseFrame;

const LENGTH_PREFIX_BYTES = 4;
/** First payload byte of a frame carrying a raw binary tail; a JSON payload starts with `{`. */
const BINARY_TAIL_MARKER = 0x00;
const BINARY_TAIL_HEADER_BYTES = 1 + 4;

/**
 * Conservative fallback per-frame ceiling (M2). The real ceiling is the centralized
 * `resolveVoiceInferenceWorkerMaxFrameBytes()` knob, injected by the client/runner; this
 * fallback only applies when no bound is passed (e.g. a low-level unit test). It is far
 * below the historical 64 MiB so a single base64-inflated TTS frame cannot balloon daemon
 * memory. Direct TTS with a larger terminal result is rejected by the child with the typed
 * `output_too_large` contract; this IPC has no chunk producer.
 */
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export function encodeVoiceInferenceWorkerFrame(
  frame: VoiceInferenceWorkerFrame,
  maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES,
): Buffer {
  const tail = frame.kind === 'stt_stream_append' ? frame.pcm16Bytes : null;
  const json = Buffer.from(JSON.stringify(frame.kind === 'stt_stream_append' ? { ...frame, pcm16Bytes: undefined } : frame), 'utf8');
  const payloadBytes = tail ? BINARY_TAIL_HEADER_BYTES + json.byteLength + tail.byteLength : json.byteLength;
  if (payloadBytes > maxFrameBytes) {
    throw new Error('voice_inference_worker_frame_too_large');
  }
  const head = Buffer.alloc(LENGTH_PREFIX_BYTES + (tail ? BINARY_TAIL_HEADER_BYTES : 0));
  head.writeUInt32BE(payloadBytes, 0);
  if (!tail) {
    return Buffer.concat([head, json]);
  }
  head.writeUInt8(BINARY_TAIL_MARKER, LENGTH_PREFIX_BYTES);
  head.writeUInt32BE(json.byteLength, LENGTH_PREFIX_BYTES + 1);
  return Buffer.concat([head, json, tail]);
}

/**
 * Incremental decoder. Feed arbitrary byte chunks; receive whole frames as they
 * complete. Robust to a frame split across many chunks and to many frames in one chunk.
 *
 * `maxFrameBytes` caps the declared length of any single frame: a hostile or buggy peer
 * cannot make the decoder allocate or buffer more than this per in-flight frame (M2). The
 * client/runner inject the centralized config bound; the default is a conservative fallback.
 */
export function createVoiceInferenceWorkerFrameDecoder(
  maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES,
): Readonly<{
  push: (chunk: Buffer) => VoiceInferenceWorkerFrame[];
}> {
  let buffer: Buffer = Buffer.alloc(0);

  return {
    push(chunk: Buffer): VoiceInferenceWorkerFrame[] {
      buffer = buffer.byteLength === 0 ? chunk : Buffer.concat([buffer, chunk]);
      const frames: VoiceInferenceWorkerFrame[] = [];
      while (buffer.byteLength >= LENGTH_PREFIX_BYTES) {
        const frameLength = buffer.readUInt32BE(0);
        if (frameLength > maxFrameBytes) {
          throw new Error('voice_inference_worker_frame_too_large');
        }
        const totalLength = LENGTH_PREFIX_BYTES + frameLength;
        if (buffer.byteLength < totalLength) {
          break;
        }
        const payload = buffer.subarray(LENGTH_PREFIX_BYTES, totalLength);
        buffer = buffer.subarray(totalLength);
        if (payload[0] === BINARY_TAIL_MARKER) {
          // Raw-tail frame: a header length that overruns the payload is corrupt and terminates the channel.
          const jsonLength = payload.byteLength >= BINARY_TAIL_HEADER_BYTES ? payload.readUInt32BE(1) : -1;
          if (jsonLength < 0 || BINARY_TAIL_HEADER_BYTES + jsonLength > payload.byteLength) {
            throw new Error('voice_inference_worker_frame_malformed');
          }
          // The encoder uses the binary tail only for stream-append request frames.
          const header = JSON.parse(payload.subarray(BINARY_TAIL_HEADER_BYTES, BINARY_TAIL_HEADER_BYTES + jsonLength).toString('utf8')) as Omit<
            Extract<VoiceInferenceWorkerRequestFrame, { kind: 'stt_stream_append' }>, 'pcm16Bytes'
          >;
          frames.push({ ...header, pcm16Bytes: payload.subarray(BINARY_TAIL_HEADER_BYTES + jsonLength) });
          continue;
        }
        const json = payload.toString('utf8');
        // A non-JSON payload throws here (SyntaxError). Like an oversized prefix, the daemon-side
        // client routes that throw through channel termination (M2) — it never silently advances
        // past corrupt bytes. Frame-shape validation is layered on top via
        // `parseVoiceInferenceWorkerResponseFrame` at the client chokepoint (L4).
        frames.push(JSON.parse(json) as VoiceInferenceWorkerFrame);
      }
      return frames;
    },
  };
}

/**
 * Schema validation for inbound child→daemon frames (L4). The forked child is the UNtrusted peer
 * on this wire: a corrupt or hostile native engine can emit a well-framed, valid-JSON frame whose
 * SHAPE is wrong — e.g. a terminal synthesize result with an invalid audio-output descriptor.
 * The daemon-side client validates every decoded frame against this response-frame contract at a
 * single chokepoint and terminates the channel on any mismatch, pairing with the M2 decode-error
 * termination so malformed input can never reach the request handlers. Reuses the protocol's
 * canonical audio-output and runtime-state schemas rather than re-describing them here.
 */
const VoiceInferenceWorkerResultPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('warm') }),
  z.object({ kind: z.literal('prime') }),
  z.object({ kind: z.literal('release') }),
  z.object({
    kind: z.literal('synthesize'),
    output: DaemonVoiceInferenceAudioOutputSchema,
    bytesBase64: z.string(),
    name: z.nullable(z.string()),
  }),
  z.object({
    kind: z.literal('transcribe'),
    text: z.string(),
    language: z.nullable(z.string()),
  }),
  z.object({
    kind: z.literal('stt_stream_start'),
    sessionId: z.string().check(z.minLength(1)),
  }),
  z.object({
    kind: z.literal('stt_stream_append'),
    events: z.array(DaemonVoiceInferenceSttStreamEventSchema),
  }),
  z.object({
    kind: z.literal('stt_stream_finish'),
    text: z.string(),
    language: z.nullable(z.string()),
    events: z.array(DaemonVoiceInferenceSttStreamEventSchema),
  }),
  z.object({
    kind: z.literal('stt_stream_cancel'),
  }),
]);

const VoiceInferenceWorkerResponseFrameSchema = z.union([
  z.object({ kind: z.literal('result'), id: z.string(), result: VoiceInferenceWorkerResultPayloadSchema }),
  z.object({ kind: z.literal('error'), id: z.string(), code: z.string(), message: z.string() }),
  z.object({
    kind: z.literal('snapshot'),
    packId: z.string(),
    runtimeState: DaemonVoiceInferenceModelRuntimeStateSchema,
  }),
]);

/**
 * Validate a decoded inbound frame against the child→daemon response-frame contract. Throws a
 * `ZodError` when the frame is malformed; the client treats that exactly like a framing error and
 * terminates the channel so the supervisor respawns a clean child.
 */
export function parseVoiceInferenceWorkerResponseFrame(value: unknown): VoiceInferenceWorkerResponseFrame {
  return VoiceInferenceWorkerResponseFrameSchema.parse(value);
}

/**
 * Schema validation for inbound daemon→child REQUEST frames (M2/LB-M2). Symmetric to the
 * response-frame contract above: the child is fed length-prefixed JSON from the daemon's stdio and
 * must NOT trust the decoded shape. A corrupt or hostile parent (or a protocol-version skew) can
 * emit well-framed, valid-JSON frames whose shape is wrong — e.g. a `transcribe` missing its
 * manifest, or a `synthesize` with a non-string `text` — which would otherwise be cast straight
 * into the engine boundary. The child runner validates every decoded frame against this contract at
 * its single inbound chokepoint and rejects mismatches instead of dispatching them.
 *
 * The engine-critical scalar fields (`output`, `normalization`) reuse the protocol's canonical
 * schemas. The `manifest` is validated only as a structural object here, NOT re-validated against
 * the strict published `ModelPackManifestSchema`: the daemon is the manifest's author (it builds it
 * from already-validated catalog data), so deep manifest re-validation belongs at the manifest's own
 * ingestion boundary, not on every IPC frame — and the symmetric response-frame contract likewise
 * does not deep-validate manifests. This guards the wire SHAPE without coupling the IPC contract to
 * the manifest's published schema.
 */
const ManifestObjectSchema: z.ZodMiniType<ModelPackManifest> = z.looseObject({}) as unknown as z.ZodMiniType<ModelPackManifest>;

const VoiceInferenceWorkerPackContractSchemaShape = {
  runtimeDescriptor: z.optional(z.nullable(VoiceModelPackRuntimeV1Schema)),
  supportArtifacts: z.optional(z.array(VoiceModelPackSupportArtifactV1Schema).check(z.maxLength(32))),
} as const;

const VoiceInferenceWorkerRequestFrameSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('warm'),
    id: z.string(),
    packId: z.string(),
    packDir: z.string(),
    manifest: ManifestObjectSchema,
    ...VoiceInferenceWorkerPackContractSchemaShape,
  }),
  z.object({
    kind: z.literal('prime'),
    id: z.string(),
    packId: z.string(),
    packDir: z.string(),
    manifest: ManifestObjectSchema,
    ...VoiceInferenceWorkerPackContractSchemaShape,
  }),
  z.object({
    kind: z.literal('release'),
    id: z.string(),
    packId: z.string(),
    packDir: z.string(),
    manifest: ManifestObjectSchema,
    ...VoiceInferenceWorkerPackContractSchemaShape,
  }),
  z.object({
    kind: z.literal('synthesize'),
    id: z.string(),
    requestId: z.string(),
    text: z.string(),
    packId: z.string(),
    packDir: z.string(),
    manifest: ManifestObjectSchema,
    voiceId: z.nullable(z.string()),
    speed: z.nullable(z.number()),
    output: DaemonVoiceInferenceAudioOutputSchema,
    ...VoiceInferenceWorkerPackContractSchemaShape,
  }),
  z.object({
    kind: z.literal('transcribe'),
    id: z.string(),
    requestId: z.string(),
    filePath: z.string(),
    inputMimeType: z.string(),
    packId: z.string(),
    packDir: z.string(),
    manifest: ManifestObjectSchema,
    language: z.nullable(z.string()),
    normalization: DaemonVoiceInferenceNormalizationDecisionSchema,
    ...VoiceInferenceWorkerPackContractSchemaShape,
  }),
  z.object({
    kind: z.literal('stt_stream_start'),
    id: z.string(),
    requestId: z.string(),
    packId: z.string(),
    packDir: z.string(),
    manifest: ManifestObjectSchema,
    language: z.nullable(z.string()),
    format: DaemonVoiceInferenceSttStreamPcmFormatSchema,
    ...VoiceInferenceWorkerPackContractSchemaShape,
  }),
  z.object({
    kind: z.literal('stt_stream_append'),
    id: z.string(),
    sessionId: z.string().check(z.minLength(1)),
    seq: z.number().check(z.int(), z.nonnegative()),
    pcm16Bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array && value.byteLength > 0),
  }),
  z.object({
    kind: z.literal('stt_stream_finish'),
    id: z.string(),
    sessionId: z.string().check(z.minLength(1)),
    finalSeq: z.number().check(z.int(), z.nonnegative()),
  }),
  z.object({
    kind: z.literal('stt_stream_cancel'),
    id: z.string(),
    sessionId: z.string().check(z.minLength(1)),
  }),
  z.object({ kind: z.literal('abort'), id: z.string(), targetId: z.string() }),
]);

/**
 * Validate a decoded inbound frame against the daemon→child request-frame contract. Throws a
 * `ZodError` when the frame is malformed; the child runner rejects the frame (via its `onError`
 * hook) rather than casting it into the engine boundary.
 */
export function parseVoiceInferenceWorkerRequestFrame(value: unknown): VoiceInferenceWorkerRequestFrame {
  return VoiceInferenceWorkerRequestFrameSchema.parse(value);
}
