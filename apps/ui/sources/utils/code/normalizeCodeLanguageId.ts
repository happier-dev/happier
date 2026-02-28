const CODE_LANGUAGE_ALIASES: Record<string, string> = {
    ts: 'typescript',
    js: 'javascript',
    md: 'markdown',
    yml: 'yaml',
    py: 'python',
    sh: 'bash',
    gql: 'graphql',
};

export function normalizeCodeLanguageId(language: string | null | undefined): string | null {
    const raw = String(language ?? '').trim().toLowerCase();
    if (!raw) return null;
    return CODE_LANGUAGE_ALIASES[raw] ?? raw;
}
