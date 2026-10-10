import { lazyZodSchema } from '../../../../lazyZodSchema.js';
import { z } from 'zod';
import { createCanonicalJsonSigningInput } from '../../../../crypto/canonicalJson.js';
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
const AuthenticatedContentSchema = lazyZodSchema(() => z.object({
  purpose: z.literal('machine_live_stream_v1'), envelope: MachineLiveStreamDecodedEnvelopeV1Schema,
}).strict());

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
