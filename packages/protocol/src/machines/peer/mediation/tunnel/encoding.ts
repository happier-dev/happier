import { z } from 'zod';

export const PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1 = 'json_base64_v1' as const;
export const PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2 = 'binary_frame_v2' as const;

export const PeerTcpTunnelEncodingSchema = z.enum([
  PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1,
  PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
]);
export type PeerTcpTunnelEncoding = z.infer<typeof PeerTcpTunnelEncodingSchema>;

export type NegotiatePeerTcpTunnelEncodingResult =
  | Readonly<{ ok: true; encoding: PeerTcpTunnelEncoding }>
  | Readonly<{ ok: false; reasonCode: 'encoding_unsupported' }>;

export function negotiatePeerTcpTunnelEncoding(input: Readonly<{
  clientSupported: readonly string[];
  serverSupported: readonly string[];
  allowV1Fallback: boolean;
}>): NegotiatePeerTcpTunnelEncodingResult {
  const client = new Set(input.clientSupported);
  const server = new Set(input.serverSupported);
  if (
    client.has(PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2)
    && server.has(PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2)
  ) {
    return { ok: true, encoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2 };
  }
  if (
    input.allowV1Fallback
    && client.has(PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1)
    && server.has(PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1)
  ) {
    return { ok: true, encoding: PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1 };
  }
  return { ok: false, reasonCode: 'encoding_unsupported' };
}
