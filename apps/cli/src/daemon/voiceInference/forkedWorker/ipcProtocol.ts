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
 * exactly that many bytes of UTF-8 JSON. This survives partial reads and never relies
 * on a delimiter appearing inside arbitrary payloads.
 *
 * Request/response is correlated by `id` and every request receives exactly one terminal
 * `result` or `error` frame. Streaming STT uses its explicit start/append/finish requests.
 */

import {
  DaemonVoiceInferenceAudioOutputSchema,
  DaemonVoiceInferenceModelRuntimeStateSchema,
  DaemonVoiceInferenceNormalizationDecisionSchema,
  DaemonVoiceInferenceSttStreamEventSchema,
  DaemonVoiceInferenceSttStreamPcmFormatSchema,
  VoiceModelPackRuntimeV1Schema,
  VoiceModelPackSupportArtifactV1Schema,
  type DaemonVoiceInferenceAudioOutput,
  type DaemonVoiceInferenceModelRuntimeState,
  type DaemonVoiceInferenceNormalizationDecision,
  type DaemonVoiceInferenceSttStreamEvent,
  type DaemonVoiceInferenceSttStreamPcmFormat,
  type ModelPackManifest,
  type VoiceModelPackRuntimeV1,
  type VoiceModelPackSupportArtifactV1,
} from '@happier-dev/protocol';
import { z } from 'zod';

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
      pcm16Base64: string;
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
  const json = Buffer.from(JSON.stringify(frame), 'utf8');
  if (json.byteLength > maxFrameBytes) {
    throw new Error('voice_inference_worker_frame_too_large');
  }
  const prefix = Buffer.alloc(LENGTH_PREFIX_BYTES);
  prefix.writeUInt32BE(json.byteLength, 0);
  return Buffer.concat([prefix, json]);
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
        const json = buffer.subarray(LENGTH_PREFIX_BYTES, totalLength).toString('utf8');
        buffer = buffer.subarray(totalLength);
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
    name: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('transcribe'),
    text: z.string(),
    language: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('stt_stream_start'),
    sessionId: z.string().min(1),
  }),
  z.object({
    kind: z.literal('stt_stream_append'),
    events: z.array(DaemonVoiceInferenceSttStreamEventSchema),
  }),
  z.object({
    kind: z.literal('stt_stream_finish'),
    text: z.string(),
    language: z.string().nullable(),
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
const ManifestObjectSchema: z.ZodType<ModelPackManifest> = z
  .object({})
  .passthrough() as unknown as z.ZodType<ModelPackManifest>;

const VoiceInferenceWorkerPackContractSchemaShape = {
  runtimeDescriptor: VoiceModelPackRuntimeV1Schema.nullable().optional(),
  supportArtifacts: z.array(VoiceModelPackSupportArtifactV1Schema).max(32).optional(),
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
    voiceId: z.string().nullable(),
    speed: z.number().nullable(),
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
    language: z.string().nullable(),
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
    language: z.string().nullable(),
    format: DaemonVoiceInferenceSttStreamPcmFormatSchema,
    ...VoiceInferenceWorkerPackContractSchemaShape,
  }),
  z.object({
    kind: z.literal('stt_stream_append'),
    id: z.string(),
    sessionId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    pcm16Base64: z.string().min(1),
  }),
  z.object({
    kind: z.literal('stt_stream_finish'),
    id: z.string(),
    sessionId: z.string().min(1),
    finalSeq: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('stt_stream_cancel'),
    id: z.string(),
    sessionId: z.string().min(1),
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
