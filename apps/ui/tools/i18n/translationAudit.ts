export type TranslationLeaf =
    | Readonly<{
        key: string;
        kind: 'string';
        value: string;
    }>
    | Readonly<{
        key: string;
        kind: 'function';
        value: Function;
    }>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function flattenTranslationLeaves(root: unknown): ReadonlyArray<TranslationLeaf> {
    const out: TranslationLeaf[] = [];

    const visit = (node: unknown, path: string[]): void => {
        if (typeof node === 'string') {
            out.push({ key: path.join('.'), kind: 'string', value: node });
            return;
        }

        if (typeof node === 'function') {
            out.push({ key: path.join('.'), kind: 'function', value: node });
            return;
        }

        if (!isRecord(node)) return;

        for (const key of Object.keys(node)) {
            visit(node[key], [...path, key]);
        }
    };

    visit(root, []);
    return out;
}

export type UntranslatedString = Readonly<{
    locale: string;
    key: string;
    en: string;
    value: string;
}>;

const ALLOW_SAME_STRING_VALUES = new Set<string>([
    'OK',
    'GitHub',
    'OAuth',
    'API',
    'CLI',
    'URL',
    'JSON',
    'HTTP',
    'HTTPS',
    'WebSocket',
    'SSH',
    'TCP',
    'UDP',
    'Happier',
    // Proper nouns / product feature names that are intentionally not localized.
    'Zen',
    'Codex',
    'Codex ACP',
    'Claude Code',
    'Gemini CLI',
    'Auggie CLI',
    'Tmux',
    'Windows',
    'Happier Voice',
    // Technical ids that should remain unchanged across locales.
    'Xenova/all-MiniLM-L6-v2',
]);

const ALLOW_SAME_KEY_PREFIXES: ReadonlyArray<string> = [
    // Agent / model / provider labels are intentionally not localized.
    'agentInput.agent.',
    'agentInput.permissionMode.',
    'agentInput.codexPermissionMode.',
    'agentInput.codexModel.',
    'agentInput.geminiPermissionMode.',
    'agentInput.geminiModel.',
    'profiles.builtInNames.',
];

const ALLOW_SAME_STRING_KEYS_BY_LOCALE: Readonly<Record<string, ReadonlySet<string>>> = {
    // These are correctly translated in some locales even though they match English.
    'common.no': new Set(['es', 'it', 'ca']),
    'common.error': new Set(['es', 'ca']),
    'tools.fullView.error': new Set(['es', 'ca']),
    'status.error': new Set(['es']),
};

function isUrlLike(value: string): boolean {
    return /^([a-z]+):\/\//i.test(value);
}

function hasLikelyUserFacingLetters(value: string): boolean {
    // Must contain at least one letter; exclude pure punctuation/numbers.
    return /[A-Za-z]/.test(value);
}

function isAllCapsToken(value: string): boolean {
    // Allow strings like "EULA", "YOLO", "ACP", "TTS".
    return /^[A-Z0-9][A-Z0-9 ._-]*$/.test(value) && !/[a-z]/.test(value);
}

function isPlaceholderLike(value: string): boolean {
    // Examples: "XXXXX-XXXXX", "agent_...", "xi-api-key", "happier://terminal?..."
    if (value.includes('...')) return true;
    if (/^X{2,}/.test(value)) return true;
    if (value.startsWith('$ ')) return true;
    if (/^xi-[a-z0-9-]+$/i.test(value)) return true;
    return false;
}

export function findUntranslatedStrings(
    enRoot: unknown,
    locale: { code: string; root: unknown }
): ReadonlyArray<UntranslatedString> {
    const enLeaves = flattenTranslationLeaves(enRoot);
    const localeLeaves = flattenTranslationLeaves(locale.root);

    const enByKey = new Map(enLeaves.map((l) => [l.key, l]));
    const localeByKey = new Map(localeLeaves.map((l) => [l.key, l]));

    const out: UntranslatedString[] = [];

    for (const [key, enLeaf] of enByKey) {
        if (enLeaf.kind !== 'string') continue;

        const localeLeaf = localeByKey.get(key);
        if (!localeLeaf || localeLeaf.kind !== 'string') continue;

        const enValue = enLeaf.value;
        const localeValue = localeLeaf.value;

        if (enValue !== localeValue) continue;
        if (!hasLikelyUserFacingLetters(enValue)) continue;

        // These values are intentionally shared across locales (brands/abbreviations).
        if (ALLOW_SAME_STRING_VALUES.has(enValue)) continue;
        if (isUrlLike(enValue)) continue;
        if (isAllCapsToken(enValue)) continue;
        if (isPlaceholderLike(enValue)) continue;
        if (ALLOW_SAME_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
        if (ALLOW_SAME_STRING_KEYS_BY_LOCALE[key]?.has(locale.code)) continue;

        out.push({ locale: locale.code, key, en: enValue, value: localeValue });
    }

    return out;
}

export type LocaleAuditReport = Readonly<{
    untranslatedStrings: ReadonlyArray<UntranslatedString>;
}>;

export function auditTranslations(args: Readonly<{
    en: unknown;
    locales: ReadonlyArray<{ code: string; root: unknown }>;
}>): Record<string, LocaleAuditReport> {
    const out: Record<string, LocaleAuditReport> = {};

    for (const locale of args.locales) {
        if (locale.code === 'en') continue;
        out[locale.code] = {
            untranslatedStrings: findUntranslatedStrings(args.en, locale),
        };
    }

    return out;
}
