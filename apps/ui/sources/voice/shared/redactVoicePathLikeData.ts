const REDACTED_PATH_TOKEN = '<path_redacted>';

const ABSOLUTE_PATH_PATTERNS = [
    /\/Users\/[^\s"'<>]+/g,
    /\/home\/[^\s"'<>]+/g,
    /\/tmp\/[^\s"'<>]+/g,
    /[A-Za-z]:\\\\[^\s"'<>]+/g,
    /\\\\\\\\[^\s"'<>]+/g,
] as const;

const CANDIDATE_PATH_TOKEN_PATTERN = /[~./A-Za-z0-9_-][A-Za-z0-9._~/-]*[\\/][A-Za-z0-9._~/-]*/g;
const COMMON_RELATIVE_PATH_ROOTS = new Set([
    '.project',
    '.vscode',
    'apps',
    'bin',
    'dist',
    'docs',
    'packages',
    'scripts',
    'skills',
    'sources',
    'src',
    'test',
    'tests',
]);
const PATH_FIELD_KEY_PATTERN = /(?:^|_)(?:path|paths|dir|directory|cwd|root|repo|workspace|location|checkout|worktree)$/i;

function stripWrappingPunctuation(value: string): string {
    return value.replace(/^[("'`[{<]+/, '').replace(/[)"'`\]}>.,!?;:]+$/, '');
}

function isAbsolutePathLike(value: string): boolean {
    return ABSOLUTE_PATH_PATTERNS.some((pattern) => pattern.test(value));
}

function looksLikeRelativePathLike(value: string): boolean {
    if (!value || value.includes('://')) return false;
    const normalized = value.replace(/\\/g, '/');
    if (normalized.startsWith('./') || normalized.startsWith('../') || normalized.startsWith('~/')) {
        return normalized.includes('/');
    }

    const segments = normalized.split('/').filter(Boolean);
    if (segments.length < 2) return false;
    if (segments.length >= 3) return true;

    const first = segments[0]?.toLowerCase() ?? '';
    const last = segments[segments.length - 1] ?? '';
    if (COMMON_RELATIVE_PATH_ROOTS.has(first)) return true;
    if (/\.[A-Za-z0-9]{1,8}$/.test(last)) return true;
    return false;
}

function replaceAbsolutePathPatterns(value: string): string {
    return ABSOLUTE_PATH_PATTERNS.reduce((current, pattern) => current.replace(pattern, REDACTED_PATH_TOKEN), value);
}

function redactPathLikeTokens(value: string): string {
    return value.replace(CANDIDATE_PATH_TOKEN_PATTERN, (candidate) => {
        const trimmed = stripWrappingPunctuation(candidate);
        if (!trimmed) return candidate;
        if (!looksLikeRelativePathLike(trimmed)) return candidate;
        return candidate.replace(trimmed, REDACTED_PATH_TOKEN);
    });
}

function isPathBearingFieldKey(key: string | null): boolean {
    if (!key) return false;
    const normalized = key.trim();
    if (!normalized) return false;
    return PATH_FIELD_KEY_PATTERN.test(normalized);
}

export function redactVoicePathLikeString(value: string): string {
    return redactPathLikeTokens(replaceAbsolutePathPatterns(value));
}

export function redactVoicePathLikeData(input: unknown): unknown {
    const seen = new Set<object>();

    const walk = (value: unknown, depth: number, parentKey: string | null): unknown => {
        if (depth > 20) return value;
        if (typeof value === 'string') {
            if (isPathBearingFieldKey(parentKey) && value.trim()) {
                return REDACTED_PATH_TOKEN;
            }
            return redactVoicePathLikeString(value);
        }
        if (!value || typeof value !== 'object') return value;
        if (seen.has(value as object)) return null;
        seen.add(value as object);

        if (Array.isArray(value)) {
            return value.map((entry) => walk(entry, depth + 1, parentKey));
        }

        const output: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            output[key] = walk(entry, depth + 1, key);
        }
        return output;
    };

    return walk(input, 0, null);
}
