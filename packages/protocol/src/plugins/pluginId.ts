import { z } from 'zod';

const PLUGIN_ID_SEGMENT_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const RESERVED_PLUGIN_ID_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
const RESERVED_HAPPIER_PLUGIN_NAMESPACE = 'happier.';

function hasReservedPluginIdSegment(id: string): boolean {
  return id.split('.').some((segment) => RESERVED_PLUGIN_ID_SEGMENTS.has(segment));
}

export const PluginIdSchema = z.string().trim().min(1).refine((value) => {
  if (value === '.' || value === '..') return false;
  if (value.includes('/') || value.includes('\\')) return false;
  if (value.startsWith('.') || value.endsWith('.')) return false;
  if (hasReservedPluginIdSegment(value)) return false;

  const segments = value.split('.');
  return segments.length >= 2 && segments.every((segment) => PLUGIN_ID_SEGMENT_PATTERN.test(segment));
}, {
  message: 'Plugin id must use a lower-case dot-delimited owner namespace',
});
export type PluginId = z.infer<typeof PluginIdSchema>;

export function isReservedHappierPluginId(id: string): boolean {
  return id.trim().startsWith(RESERVED_HAPPIER_PLUGIN_NAMESPACE);
}

export function encodePluginIdForFilesystem(id: string): string {
  return encodeURIComponent(id.trim());
}
