import { sanitizeUrlForLog } from './sanitizeUrlForLog';

function clampMessage(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value;
    return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function sanitizeUrlLikeSegment(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return raw;

    // Strip common trailing punctuation so URL parsing succeeds.
    const match = trimmed.match(/[),.!?:;]+$/);
    const trailing = match ? match[0] : '';
    const withoutTrailing = trailing ? trimmed.slice(0, -trailing.length) : trimmed;

    const sanitized = sanitizeUrlForLog(withoutTrailing);
    if (!sanitized) return raw;
    return `${sanitized}${trailing}`;
}

export function sanitizeEndpointErrorMessage(
    raw: unknown,
    opts?: Readonly<{
        maxLength?: number;
    }>,
): string | null {
    const maxLength = opts?.maxLength ?? 240;
    const value =
        raw instanceof Error
            ? raw.message
            : typeof raw === 'string'
              ? raw
              : raw == null
                ? ''
                : String(raw);
    const trimmed = value.trim();
    if (!trimmed) return null;

    let sanitized = trimmed;

    // Redact auth headers / tokens.
    sanitized = sanitized.replace(/(Authorization:\s*Bearer)\s+([^\s]+)/gi, '$1 [REDACTED]');
    sanitized = sanitized.replace(/\bBearer\s+([A-Za-z0-9._~+/=-]+)\b/g, 'Bearer [REDACTED]');
    sanitized = sanitized.replace(/\bBasic\s+([A-Za-z0-9._~+/=-]+)\b/gi, 'Basic [REDACTED]');

    // Sanitize any URL-like segments so userinfo/query don't leak into logs/UI.
    sanitized = sanitized.replace(/https?:\/\/[^\s"'()<>]+/g, (segment) => sanitizeUrlLikeSegment(segment));

    // Normalize whitespace/newlines.
    sanitized = sanitized.replace(/\s+/g, ' ').trim();

    return clampMessage(sanitized, Math.max(0, maxLength));
}
