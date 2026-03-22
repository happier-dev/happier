export function clampUtf16(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    return `${value.slice(0, maxChars)}…`;
}

export function coerceNonEmpty(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export function sanitizePromptField(value: string): string {
    return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

export function sanitizeClaudeTeamConfigPathSegment(value: string): string {
    const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '/');
    const segments = cleaned
        .split('/')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..');

    return segments.length > 0 ? segments[segments.length - 1]! : 'team';
}
