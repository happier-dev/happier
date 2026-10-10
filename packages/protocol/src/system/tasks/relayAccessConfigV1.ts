import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** Portable relay configuration; credentials stay in live invocation custody. */
export const RelayAccessConfigV1Schema = lazyZodSchema(() => z.discriminatedUnion('providerId', [
  z.object({ providerId: z.literal('localOnly') }).strict(),
  z.object({ providerId: z.literal('lan'), url: z.string().trim().min(1) }).strict(),
  z.object({ providerId: z.literal('tailscaleServe') }).strict(),
  z.object({ providerId: z.literal('tailscaleFunnel') }).strict(),
  z.object({ providerId: z.literal('cloudflareNamed'), hostname: z.string().trim().min(1), token: z.string().trim().min(1) }).strict(),
]));
export type RelayAccessConfigV1 = Readonly<z.output<typeof RelayAccessConfigV1Schema>>;
export type RelayAccessProviderIdV1 = RelayAccessConfigV1['providerId'];
