import { z } from 'zod';

export const PeerFlowKindV1Schema = z.enum([
  'bounded_transfer',
  'tcp_tunnel',
  'voice_media',
  'live_stream',
  'machine_rpc',
]);

export type PeerFlowKindV1 = z.infer<typeof PeerFlowKindV1Schema>;
