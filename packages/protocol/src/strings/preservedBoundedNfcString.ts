import { z } from '../zodRuntimePolicy.js';

const UTF8_ENCODER = new TextEncoder();

/** Exact-preserving identity string: validates but never trims or normalizes accepted bytes. */
export function preservedBoundedNfcString(maxBytes: number, label: string): z.ZodMiniString<string> {
  return z.string().check(z.refine((value) => value === value.normalize('NFC'), `${label} must be NFC-normalized`), z.refine((value) => value.trim().length > 0, `${label} must not be blank`), z.refine((value) => UTF8_ENCODER.encode(value).byteLength <= maxBytes, `${label} exceeds its UTF-8 byte limit`));
}
