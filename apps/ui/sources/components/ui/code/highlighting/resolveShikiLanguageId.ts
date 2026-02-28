import type { BundledLanguage } from 'shiki';
import { bundledLanguages } from 'shiki';

export type ResolvedShikiLanguageId = BundledLanguage | 'text';

const SHIKI_LANGUAGE_ALIASES: Record<string, string> = {
    typescript: 'ts',
    javascript: 'js',
    py: 'python',
    md: 'markdown',
    yml: 'yaml',
    sh: 'bash',
    gql: 'graphql',
};

function isSupportedBundledLanguage(lang: string): boolean {
    if (lang === 'text') return true;
    return Object.prototype.hasOwnProperty.call(bundledLanguages as any, lang);
}

export function resolveShikiLanguageId(language: string): ResolvedShikiLanguageId {
    const raw = String(language ?? '').trim().toLowerCase();
    if (!raw) return 'text';

    const mapped = SHIKI_LANGUAGE_ALIASES[raw] ?? raw;
    if (isSupportedBundledLanguage(mapped)) return mapped as unknown as ResolvedShikiLanguageId;

    // As a last resort, fall back to plain text highlighting to avoid Shiki initialization failures.
    return 'text';
}
