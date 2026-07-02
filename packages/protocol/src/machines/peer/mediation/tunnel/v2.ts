import { z } from 'zod';

import { PeerTcpTunnelDirectionV1Schema } from './v1.js';

const BinaryFrameKindV2Schema = z.enum(['open', 'data', 'ack', 'close', 'abort']);

export const PeerTcpTunnelBinaryFrameHeaderV2Schema = z
  .object({
    version: z.literal(2),
    kind: BinaryFrameKindV2Schema,
    tunnelId: z.string().min(1),
    substreamId: z.string().min(1).optional(),
    direction: PeerTcpTunnelDirectionV1Schema.optional(),
    sequence: z.number().int().nonnegative().optional(),
    ack: z.number().int().nonnegative().optional(),
    window: z.number().int().nonnegative().optional(),
    halfClose: z.boolean().optional(),
    reasonCode: z.string().min(1).optional(),
    flags: z.array(z.string().min(1)).optional(),
    payloadLength: z.number().int().nonnegative(),
    receiptId: z.string().min(1).optional(),
  })
  .strict();
export type PeerTcpTunnelBinaryFrameHeaderV2 = z.infer<typeof PeerTcpTunnelBinaryFrameHeaderV2Schema>;

export type DecodePeerTcpTunnelBinaryFrameV2Result =
  | Readonly<{ ok: true; header: PeerTcpTunnelBinaryFrameHeaderV2; payload: Uint8Array }>
  | Readonly<{
      ok: false;
      reasonCode:
        | 'frame_too_short'
        | 'header_too_large'
        | 'header_truncated'
        | 'header_json_invalid'
        | 'header_invalid'
        | 'payload_too_large'
        | 'payload_length_mismatch';
    }>;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodePeerTcpTunnelBinaryFrameV2(input: Readonly<{
  header: PeerTcpTunnelBinaryFrameHeaderV2;
  payload?: Uint8Array;
}>): Uint8Array {
  const payload = input.payload ?? new Uint8Array();
  const headerBytes = textEncoder.encode(JSON.stringify(input.header));
  const output = new Uint8Array(4 + headerBytes.byteLength + payload.byteLength);
  new DataView(output.buffer, output.byteOffset, output.byteLength).setUint32(0, headerBytes.byteLength, false);
  output.set(headerBytes, 4);
  output.set(payload, 4 + headerBytes.byteLength);
  return output;
}

export function decodePeerTcpTunnelBinaryFrameV2(input: Readonly<{
  frame: Uint8Array;
  maxHeaderBytes: number;
  maxPayloadBytes: number;
}>): DecodePeerTcpTunnelBinaryFrameV2Result {
  if (input.frame.byteLength < 4) return { ok: false, reasonCode: 'frame_too_short' };

  const view = new DataView(input.frame.buffer, input.frame.byteOffset, input.frame.byteLength);
  const headerLength = view.getUint32(0, false);
  if (headerLength > input.maxHeaderBytes) return { ok: false, reasonCode: 'header_too_large' };
  if (input.frame.byteLength < 4 + headerLength) return { ok: false, reasonCode: 'header_truncated' };

  let headerJson: unknown;
  try {
    headerJson = JSON.parse(textDecoder.decode(input.frame.subarray(4, 4 + headerLength)));
  } catch {
    return { ok: false, reasonCode: 'header_json_invalid' };
  }
  const parsedHeader = PeerTcpTunnelBinaryFrameHeaderV2Schema.safeParse(headerJson);
  if (!parsedHeader.success) return { ok: false, reasonCode: 'header_invalid' };

  const payload = input.frame.subarray(4 + headerLength);
  if (payload.byteLength > input.maxPayloadBytes) return { ok: false, reasonCode: 'payload_too_large' };
  if (payload.byteLength !== parsedHeader.data.payloadLength) {
    return { ok: false, reasonCode: 'payload_length_mismatch' };
  }

  return {
    ok: true,
    header: parsedHeader.data,
    payload,
  };
}
