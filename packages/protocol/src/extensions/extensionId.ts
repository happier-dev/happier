import { z } from 'zod';

const EXTENSION_ID_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const RESERVED_EXTENSION_ID_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function hasReservedExtensionIdSegment(id: string): boolean {
    return id.split('.').some((segment) => RESERVED_EXTENSION_ID_SEGMENTS.has(segment));
}

export const ExtensionIdSchema = z.string().trim().min(1).refine((value) => {
    if (value === '.' || value === '..') return false;
    if (value.includes('/') || value.includes('\\')) return false;
    if (value.startsWith('.') || value.endsWith('.')) return false;
    if (hasReservedExtensionIdSegment(value)) return false;

    const segments = value.split('.');
    return segments.length > 0 && segments.every((segment) => EXTENSION_ID_SEGMENT_PATTERN.test(segment));
}, {
    message: 'Extension id must use dot-delimited filesystem-safe segments',
});
export type ExtensionId = z.infer<typeof ExtensionIdSchema>;

export function encodeExtensionIdForFilesystem(id: string): string {
    return encodeURIComponent(id.trim());
}
