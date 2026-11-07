import { lazyZodSchema } from '../../../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { createCanonicalJsonSigningInput } from '../../../../crypto/canonicalJson.js';
import { decodeBase64, encodeBase64 } from '../../../../crypto/base64.js';
import {
  MachineLiveStreamDecodedEnvelopeV1Schema,
  MachineLiveStreamRelayEnvelopeV1Schema,
  getMachineLiveStreamPayloadDecodedByteLength,
  type MachineLiveStreamRelayEnvelopeV1,
  type MachineLiveStreamWireEnvelopeV1,
} from './v1.js';

/** Existing MachineEncryption/CLI MachineContentCodec; this codec owns no keys or cipher. */
export type MachineLiveStreamContentV1 = Readonly<{
  mode: 'plain' | 'e2ee';
  cipher?: Readonly<{
    encryptRaw: (value: unknown) => string | Promise<string>;
    decryptRaw: (value: string) => unknown | Promise<unknown>;
  }>;
}>;
export type MachineLiveStreamPayloadErrorCodeV1 =
  | 'stream_payload_invalid' | 'stream_payload_mode_mismatch'
  | 'stream_encryption_material_unavailable' | 'stream_encryption_mode_unavailable'
  | 'stream_payload_authentication_failed' | 'stream_payload_binding_mismatch'
  | 'stream_encryption_failed' | 'stream_transport_unavailable';
export class MachineLiveStreamPayloadErrorV1 extends Error {
  constructor(readonly code: MachineLiveStreamPayloadErrorCodeV1) { super(code); }
}
type Result<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; code: MachineLiveStreamPayloadErrorCodeV1 }>;
const AuthenticatedContentSchema = lazyZodSchema(() => z.strictObject({
  purpose: z.literal('machine_live_stream_v1'), envelope: MachineLiveStreamDecodedEnvelopeV1Schema,
}));

export function hasMachineLiveStreamSensitiveContentV1(envelope: MachineLiveStreamRelayEnvelopeV1 | MachineLiveStreamWireEnvelopeV1): boolean {
  return envelope.message.kind === 'frame' || envelope.message.kind === 'sideband_control';
}

function projectPayload(envelope: MachineLiveStreamRelayEnvelopeV1, ciphertext?: string): MachineLiveStreamWireEnvelopeV1 {
  const message = envelope.message;
  if (message.kind === 'frame') {
    const { payloadBase64, payloadSizeBytes: _decodedSize, ...header } = message.frame;
    const payload = ciphertext === undefined
      ? { t: 'plain' as const, v: payloadBase64 } : { t: 'encrypted' as const, c: ciphertext };
    return MachineLiveStreamRelayEnvelopeV1Schema.parse({ ...envelope, message: { kind: 'frame', frame: {
      ...header, payload, payloadSizeBytes: getMachineLiveStreamPayloadDecodedByteLength(ciphertext ?? payloadBase64),
    } } });
  }
  if (message.kind === 'sideband_control') {
    return MachineLiveStreamRelayEnvelopeV1Schema.parse({ ...envelope, message: { kind: 'sideband_control', control: {
      v: 1, streamId: message.control.streamId,
      payload: ciphertext === undefined ? { t: 'plain', v: message.control } : { t: 'encrypted', c: ciphertext },
    } } });
  }
  return MachineLiveStreamRelayEnvelopeV1Schema.parse(envelope);
}

export async function sealMachineLiveStreamEnvelopeV1(
  input: unknown, content: MachineLiveStreamContentV1,
): Promise<Result<MachineLiveStreamWireEnvelopeV1>> {
  const parsed = MachineLiveStreamDecodedEnvelopeV1Schema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'stream_payload_invalid' };
  if (!hasMachineLiveStreamSensitiveContentV1(parsed.data) || content.mode === 'plain') {
    try { return { ok: true, value: projectPayload(parsed.data) }; }
    catch { return { ok: false, code: 'stream_payload_invalid' }; }
  }
  if (!content.cipher) return { ok: false, code: 'stream_encryption_material_unavailable' };
  try {
    const c = await content.cipher.encryptRaw({ purpose: 'machine_live_stream_v1', envelope: parsed.data });
    return { ok: true, value: projectPayload(parsed.data, c) };
  } catch { return { ok: false, code: 'stream_encryption_failed' }; }
}

export async function openMachineLiveStreamEnvelopeV1(
  input: unknown, content: MachineLiveStreamContentV1,
): Promise<Result<MachineLiveStreamRelayEnvelopeV1>> {
  const parsed = MachineLiveStreamRelayEnvelopeV1Schema.safeParse(input);
  if (!parsed.success) return { ok: false, code: 'stream_payload_invalid' };
  const wire = parsed.data;
  const message = wire.message;
  if (message.kind !== 'frame' && message.kind !== 'sideband_control') {
    return { ok: true, value: MachineLiveStreamDecodedEnvelopeV1Schema.parse(wire) };
  }
  const payload = message.kind === 'frame' ? message.frame.payload : message.control.payload;
  if ((content.mode === 'plain') !== (payload.t === 'plain')) return { ok: false, code: 'stream_payload_mode_mismatch' };
  if (payload.t === 'plain') {
    const frameHeader = message.kind === 'frame'
      ? (({ payload: _payload, ...header }) => header)(message.frame) : null;
    const decoded = message.kind === 'frame'
      ? { ...wire, message: { kind: 'frame', frame: {
        ...frameHeader, payloadBase64: payload.v,
      } } }
      : { ...wire, message: { kind: 'sideband_control', control: payload.v } };
    const result = MachineLiveStreamDecodedEnvelopeV1Schema.safeParse(decoded);
    if (!result.success) return { ok: false, code: 'stream_payload_invalid' };
    if (createCanonicalJsonSigningInput(projectPayload(result.data)) !== createCanonicalJsonSigningInput(wire)) {
      return { ok: false, code: 'stream_payload_binding_mismatch' };
    }
    return { ok: true, value: result.data };
  }
  if (!content.cipher) return { ok: false, code: 'stream_encryption_material_unavailable' };
  try {
    const authenticated = AuthenticatedContentSchema.safeParse(await content.cipher.decryptRaw(payload.c));
    if (!authenticated.success) return { ok: false, code: 'stream_payload_authentication_failed' };
    // Reconstruct all clear routing, stream and frame headers from authenticated content.
    // A substituted machine/tab/sequence/stream cannot decrypt into a different live flow.
    if (createCanonicalJsonSigningInput(projectPayload(authenticated.data.envelope, payload.c)) !== createCanonicalJsonSigningInput(wire)) {
      return { ok: false, code: 'stream_payload_binding_mismatch' };
    }
    return { ok: true, value: authenticated.data.envelope };
  } catch { return { ok: false, code: 'stream_payload_authentication_failed' }; }
}

/**
 * Per-stream key for high-rate binary Machine streams (daemon Voice STT).
 *
 * The daemon issues it only when its Machine RPC content mode is E2EE, inside
 * that RPC's sealed response; plain Accounts carry no key and send plain frames.
 * Each tunnel data payload is AES-256-GCM(key) with a nonce derived from the
 * direction and the stream's strictly contiguous carrier sequence, so a key and
 * nonce never seal two plaintexts. The AAD binds the exact stream once.
 * Platform AES-GCM adapters own the cipher; this owner holds no keys.
 */
export const MACHINE_STREAM_KEY_BYTES_V1 = 32;
export const MACHINE_STREAM_KEY_NONCE_BYTES_V1 = 12;
export const MACHINE_STREAM_KEY_TAG_BYTES_V1 = 16;
export type MachineStreamKeyDirectionV1 = 'client_to_daemon' | 'daemon_to_client';

export const MachineStreamKeyBase64UrlV1Schema = lazyZodSchema(() => z.string().check(
  z.regex(/^[A-Za-z0-9_-]{43}$/u),
  z.refine((value) => {
    const decoded = decodeBase64(value, 'base64url');
    return decoded.byteLength === MACHINE_STREAM_KEY_BYTES_V1 && encodeBase64(decoded, 'base64url') === value;
  }),
));

export function createMachineStreamKeyNonceV1(direction: MachineStreamKeyDirectionV1, sequence: number): Uint8Array {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('machine_stream_key_sequence_invalid');
  const nonce = new Uint8Array(MACHINE_STREAM_KEY_NONCE_BYTES_V1);
  nonce[0] = 1;
  nonce[1] = direction === 'client_to_daemon' ? 1 : 2;
  new DataView(nonce.buffer).setBigUint64(4, BigInt(sequence));
  return nonce;
}

export function createMachineStreamKeyAadV1(stream: Readonly<{ streamId: string; generation: number }>): Uint8Array {
  return new TextEncoder().encode(createCanonicalJsonSigningInput({
    v: 1, domain: 'happier.machine-stream-key', streamId: stream.streamId, generation: stream.generation,
  }));
}
