import { readPortablePathSegmentViolation } from '@happier-dev/protocol/filesystem/portablePathSegment';

const SAFE_OUTPUT_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/u;

export function readRequiredString(value: string, field: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        throw new Error(`${field} must be a non-empty string`);
    }
    return trimmed;
}

export function readOutputPathSegment(value: string, field: string): string {
    const trimmed = readRequiredString(value, field);
    if (
        trimmed === '.'
        || trimmed === '..'
        || !SAFE_OUTPUT_SEGMENT_PATTERN.test(trimmed)
        || readPortablePathSegmentViolation(trimmed) !== null
    ) {
        throw new Error(`${field} must be a safe output path segment`);
    }
    return trimmed;
}

export function readRelativeBuildPath(value: string, field: string): string {
    const trimmed = readRequiredString(value, field);
    let normalized = trimmed;
    while (normalized.startsWith('./')) {
        normalized = normalized.slice(2);
    }
    const segments = normalized.split('/');
    if (
        normalized.length === 0
        || normalized.startsWith('/')
        || normalized.includes('\\')
        || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    ) {
        throw new Error(`${field} must be a relative path without parent traversal`);
    }
    return normalized;
}
