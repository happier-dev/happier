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
    'Git',
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
    'Telegram',
    'Windows',
    'Windows Terminal',
    'Happier Voice',
    'happier',
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

const ALLOW_SAME_STRING_KEYS = new Set<string>([
    // Literal protocol / command placeholders should remain unchanged.
    'settings.mcpServersHeaderKeyPlaceholder',
    'settings.mcpServersArgsPlaceholder',
    'settings.mcpServersFieldCommandLinePlaceholder',
    'settings.mcpServersImportJsonPlaceholder',
    'settingsNotifications.webhooks.signingSecretPromptPlaceholder',
    // Provider/model examples in replay resume settings are identifiers, not localized UI copy.
    'settingsSession.replayResume.summaryRunner.backendPlaceholder',
    'settingsSession.replayResume.summaryRunner.modelPlaceholder',
    // Claude debug category ids should remain stable because they map to provider-native categories.
    'settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.hooks.title',
    'settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.1p.title',
]);

const ALLOW_SAME_STRING_KEYS_BY_LOCALE: Readonly<Record<string, ReadonlySet<string>>> = {
    // These are correctly translated in some locales even though they match English.
    'common.no': new Set(['es', 'it', 'ca']),
    'common.error': new Set(['es', 'ca']),
    'tools.fullView.error': new Set(['es', 'ca']),
    'status.error': new Set(['es']),
    // "Terminal" is the correct word in these locales and matches English.
    'machine.cliPath.title': new Set(['pl', 'es', 'fr', 'pt', 'ca', 'de']),
    // Catalan: common noun matches English.
    'tabs.sessions': new Set(['ca']),
    'memorySearchSettings.embeddings.openAi.dimensionsTitle': new Set(['ca']),
    'server.retention.sessions': new Set(['ca']),
    'settingsProviders.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.local.title': new Set([
        'es',
        'ca',
        'pt',
    ]),
    // Italian: "Password" is the Italian word as well.
    'appLock.passwordLabel': new Set(['it']),
    // "Port" is the correct word in these locales as well.
    'appLock.mailPort': new Set(['de', 'fr', 'ca', 'pl']),
    // Italian/Portuguese: Windows "Console" label is correct and matches English.
    'windowsRemoteSessionLaunchMode.console': new Set(['it', 'pt']),
    'windowsRemoteSessionLaunchMode.shortConsole': new Set(['it', 'pt']),
    // Connected Services "Pool"/"Pools" loanwords. The "Accounts | Pools"
    // redesign keeps "Pool"/"Pools" verbatim in these locales as an intentional
    // borrowed term, so an exact match with English is correct, not untranslated.
    // (Italian renders most as the singular "Pool", so only the keys whose
    // localized value is genuinely identical to English are listed per locale.)
    'connectedServices.account.poolsLabel': new Set(['es', 'pt', 'ca']),
    'connectedServices.detail.groupDetail.routeTitle': new Set(['es', 'it', 'pt', 'ca']),
    'connectedServices.detail.groups.title': new Set(['es', 'pt', 'ca']),
    'connectedServices.detail.segments.pools': new Set(['es', 'pt', 'ca']),
    'connectedServices.pools.title': new Set(['es', 'pt', 'ca']),
    'connectedServices.profile.poolsGroupTitle': new Set(['es', 'pt', 'ca']),
    // Loading indicator style names: "Radar" and "Aurora" are the same word in these locales,
    // and French uses "Style" for the picker title.
    'settingsAppearance.loadingIndicatorOptions.radar': new Set(['pl', 'es', 'fr', 'it', 'pt', 'ca', 'de']),
    'settingsAppearance.loadingIndicatorOptions.aurora': new Set(['es', 'it', 'pt', 'ca']),
    'settingsAppearance.loadingIndicatorOptions.hRadar': new Set(['pl', 'es', 'fr', 'it', 'pt', 'ca', 'de']),
    'settingsAppearance.loadingIndicatorOptions.hAurora': new Set(['es', 'it', 'pt', 'ca']),
    'settingsAppearance.loadingIndicatorStyle': new Set(['fr']),
    // "Normal" and "Pause" are the same words in these locales.
    'settingsAppearance.loadingIndicatorSpeedOptions.normal': new Set(['de', 'es', 'pt', 'ca']),
    'settingsAppearance.loadingIndicatorPause': new Set(['de', 'fr']),
};

function isProviderPluginTitleKey(key: string): boolean {
    return /^settingsProviders\.plugins\.[^.]+\.title$/.test(key);
}

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
        if (ALLOW_SAME_STRING_KEYS.has(key)) continue;
        if (ALLOW_SAME_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
        if (isProviderPluginTitleKey(key)) continue;
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
