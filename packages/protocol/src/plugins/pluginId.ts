import { z } from 'zod';

const PLUGIN_ID_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const RESERVED_PLUGIN_ID_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function hasReservedPluginIdSegment(id: string): boolean {
  return id.split('.').some((segment) => RESERVED_PLUGIN_ID_SEGMENTS.has(segment));
}

export const PluginIdSchema = z.string().trim().min(1).refine((value) => {
  if (value === '.' || value === '..') return false;
  if (value.includes('/') || value.includes('\\')) return false;
  if (value.startsWith('.') || value.endsWith('.')) return false;
  if (hasReservedPluginIdSegment(value)) return false;

  const segments = value.split('.');
  return segments.length > 0 && segments.every((segment) => PLUGIN_ID_SEGMENT_PATTERN.test(segment));
}, {
  message: 'Plugin id must use dot-delimited filesystem-safe segments',
});
export type PluginId = z.infer<typeof PluginIdSchema>;

export function encodePluginIdForFilesystem(id: string): string {
  return encodeURIComponent(id.trim());
}
