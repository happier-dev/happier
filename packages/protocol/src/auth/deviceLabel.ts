import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

/** Pairing's existing presentation-label contract, shared with live App sockets. */
export const DeviceLabelSchema = lazyZodSchema(() => z.nullable(z.pipe(z.string(), z.transform((raw) => {
  const trimmed = raw.trim().replace(/\s+/gu, ' ');
  return trimmed ? trimmed.slice(0, 120) : null;
}))));

export function sanitizeDeviceLabel(raw: unknown): string | null {
  const parsed = DeviceLabelSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
