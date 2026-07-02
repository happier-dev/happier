import { z } from 'zod';

function isIpv4LoopbackHost(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4 || parts[0] !== '127') return false;
  return parts.slice(1).every((part) => {
    if (!/^\d+$/.test(part)) return false;
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

function normalizeHost(host: string): string {
  const normalized = host.toLowerCase();
  return normalized.startsWith('[') && normalized.endsWith(']') ? normalized.slice(1, -1) : normalized;
}

export const LocalServiceLoopbackHostV1Schema = z
  .string()
  .trim()
  .min(1)
  .transform(normalizeHost)
  .refine((host) => host === 'localhost' || host === '::1' || isIpv4LoopbackHost(host), {
    message: 'Local service host must be loopback.',
  });
export type LocalServiceLoopbackHostV1 = z.infer<typeof LocalServiceLoopbackHostV1Schema>;
