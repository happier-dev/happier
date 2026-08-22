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

export function findMissingKeys(
    enRoot: unknown,
    locale: { code: string; root: unknown },
): ReadonlyArray<Readonly<{ locale: string; key: string }>> {
    const localeKeys = new Set(flattenTranslationLeaves(locale.root).map((leaf) => leaf.key));
    return flattenTranslationLeaves(enRoot)
        .filter((leaf) => !localeKeys.has(leaf.key))
        .map((leaf) => ({ locale: locale.code, key: leaf.key }));
}

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
    'happier',
    // Proper nouns / product feature names that are intentionally not localized.
    'Zen',
    'Codex',
    'Codex ACP',
    'Claude Code',
    'Gemini CLI',
    'Auggie CLI',
    'Tmux',
    'Telegram',
    'Bitbucket',
    'React Native',
    'tmux',
    'macOS',
    'Linux',
    'macOS/Linux',
    'Windows',
    'Windows Terminal',
    'Happier Voice',
    'OpenAI Realtime',
    'Grok Voice · BYOK',
    // HTTP authorization scheme name, used verbatim in every locale.
    'bearer',
    'Happier Cloud',
    'GitHub CLI',
    'Launchpad',
    'xterm.js WebView',
    // Technical ids that should remain unchanged across locales.
    'Xenova/all-MiniLM-L6-v2',
    // Relay access provider feature names that are intentionally not localized.
    'Tailscale Serve',
    'Tailscale Funnel',
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
    // Desktop overlay settings copy is temporarily shared in English across locale files.
    'settingsDesktop.overlay.',
    // Built-in theme preset names are product names, not descriptive UI copy.
    'settingsAppearance.themeProfiles.presets.',
    // Machine transfer exposure labels are technical transport terms.
    'machine.transferExposure.',
];

const ALLOW_SAME_STRING_KEYS = new Set<string>([
    // Literal protocol / command placeholders should remain unchanged.
    'settingsProviders.authoring.credentialHeaderPlaceholder',
    'settingsProviders.authoring.modelsPathPlaceholder',
    'settings.mcpServersHeaderKeyPlaceholder',
    'settings.mcpServersArgsPlaceholder',
    'settings.mcpServersFieldCommandLinePlaceholder',
    'settings.mcpServersImportJsonPlaceholder',
    'settingsNotifications.webhooks.signingSecretPromptPlaceholder',
    'settingsProviders.authoring.publicHeadersPlaceholder',
    'settingsPlugins.accountDataErase.promptPlaceholder',
    'settingsAppearance.themeProfiles.previewCode',
    'settingsKeyboard.setShortcutPromptPlaceholder',
    'settingsSession.transcript.messageActions.template.placeholder',
    // Provider/model examples in replay resume settings are identifiers, not localized UI copy.
    'settingsSession.replayResume.summaryRunner.backendPlaceholder',
    'settingsSession.replayResume.summaryRunner.modelPlaceholder',
    // Onboarding / setup placeholders should remain literal.
    'promptLibrary.supportingFilePathPlaceholder',
    'settingsSession.handoff.includeIgnoredMode.globsPlaceholder',
    'settings.machineSetupRemoteSshTargetPlaceholder',
    'settings.machineSetupRemoteSshUsernamePlaceholder',
    'settings.machineSetupRemoteSshHostPlaceholder',
    // Debug category identifiers are provider-owned technical names.
    'settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.options.hooks.title',
    'settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.options.1p.title',
    // Technical field labels that are commonly shared across locales.
    'settings.relayAccess.fields.tokenLabel',
    // New Live Activities strategy labels are intentionally shared English placeholders for now.
    'settingsNotifications.activitySurfaces.liveActivities.strategyTitle',
    'settingsNotifications.activitySurfaces.liveActivities.dynamicPrimaryTitle',
    'settingsNotifications.activitySurfaces.liveActivities.pinnedPrimaryTitle',
    'settingsNotifications.activitySurfaces.liveActivities.sessionSpecificTitle',
    'settingsFeatures.expLiveActivities',
    'settingsNotifications.activitySurfaces.liveActivities.title',
    'settingsNotifications.activitySurfaces.privacyTitle',
]);

const ALLOW_SAME_STRING_KEYS_BY_LOCALE: Readonly<Record<string, ReadonlySet<string>>> = {
    // These are correctly translated in some locales even though they match English.
    'common.no': new Set(['es', 'it', 'ca']),
    'common.error': new Set(['es', 'ca']),
    'tools.fullView.error': new Set(['es', 'ca']),
    'status.error': new Set(['es']),
    // Catalan: common noun matches English.
    'tabs.sessions': new Set(['ca']),
    'sessionsList.storageFilterCategory': new Set(['ca']),
    'memorySearchSettings.embeddings.openAi.dimensionsTitle': new Set(['ca']),
    'server.retention.sessions': new Set(['ca']),
    'settingsAgents.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.local.title': new Set([
        'es',
        'ca',
        'pt',
    ]),
    // Italian/Portuguese: Windows "Console" label is correct and matches English.
    'windowsRemoteSessionLaunchMode.console': new Set(['it', 'pt']),
    'windowsRemoteSessionLaunchMode.shortConsole': new Set(['it', 'pt']),
    // Spanish/Catalan: the UI term "Error" is correctly localized as the same word.
    'settings.relayAccess.statusError': new Set(['es', 'ca']),
    // Portuguese: "Logs" is a commonly used UI term.
    'common.logs': new Set(['pt']),
    // These locale spellings are genuine cognates or established developer UI terms.
    'settingsProviders.detail.machineOnline': new Set(['pl', 'it', 'pt']),
    'settingsProviders.detail.machineOffline': new Set(['pl', 'it', 'pt']),
    'settingsProviders.compatibility.experimental': new Set(['es', 'pt', 'ca']),
    'settingsProviders.compatibility.incompatible': new Set(['es', 'ca']),
    'settingsProviders.models.experimental': new Set(['es', 'pt', 'ca']),
    'settingsProviders.models.manual': new Set(['es', 'pt', 'ca']),
    'browserDiagnostics.host.fields.selector': new Set(['es', 'ca']),
    'settingsProviders.authoring.providerTitle': new Set(['it']),
    'settingsProviders.authoring.destinationAccount': new Set(['it']),
    'settingsSession.sessionList.identityDisplayAvatarTitle': new Set(['it', 'ca']),
    'settingsSession.sessionList.headerIdentityDisplayAvatarTitle': new Set(['it', 'ca']),
    'externalSessions.settingsPrivacyGroupTitle': new Set(['it']),
    'automations.list.manual': new Set(['ca']),
    'automations.detail.runMeta.origin.manual': new Set(['ca']),
    'settingsProviders.detail.modelsTitle': new Set(['ca']),
    'settingsAppearance.themeProfiles.editorMode': new Set(['ca']),
    'settingsAppearance.themeProfiles.groups.chrome': new Set(['fr', 'ca']),
    'settingsAppearance.themeProfiles.groups.surface': new Set(['fr']),
    'settingsAppearance.themeProfiles.groups.composer': new Set(['fr']),
    'settingsAppearance.themeProfiles.groups.message': new Set(['fr']),
    'settingsAppearance.themeProfiles.groups.diff': new Set(['fr']),
    'settingsAppearance.themeProfiles.groups.permission': new Set(['fr']),
    'settingsAppearance.themeProfiles.groups.overlay': new Set(['fr']),
    'settingsAppearance.themeProfiles.groups.text': new Set(['ca']),
    'settingsAppearance.themeProfiles.groups.control': new Set(['ca']),
    'commandPalette.commands.sessionsCategory': new Set(['ca']),
    'directSessions.browseAgents': new Set(['fr', 'ca']),
    'externalSessions.browseAgents': new Set(['fr', 'ca']),
    'agentInput.suggestionGroups.sessions': new Set(['ca']),
    'localServices.source.recent': new Set(['ca']),
    'simulatorPreview.toolbar.recentButton': new Set(['ca']),
    'browserShell.devtools.section.elements': new Set(['ca']),
    'browserDiagnostics.host.families.elements': new Set(['ca']),
    'browserDiagnostics.host.fields.protocol': new Set(['ca']),
    'browserDiagnostics.host.fields.arguments': new Set(['fr', 'ca']),
    'browserDiagnostics.host.fields.nodeCount': new Set(['ca']),
    'browserDiagnostics.host.fields.elementCount': new Set(['ca']),
    'settingsActions.families.session.title': new Set(['ca']),
    'settingsActions.families.general.title': new Set(['ca']),
    'settingsSession.sessionCreation.modalModeSimpleTitle': new Set(['fr', 'ca']),
    'message.runtimeConfigOutcomeKeyModel': new Set(['ca']),
    'usage.efficiency.costPerMtok': new Set(['ca']),
    'commandPalette.commands.navigationCategory': new Set(['fr']),
    'sessionsList.storageDirectTab': new Set(['fr']),
    'sessionsList.moveSheetDestinationLabel': new Set(['fr']),
    'sessionsList.moveSheetDestinations': new Set(['fr']),
    // French: the credential effect "mutation" is the same word in French.
    'settingsVoice.externalCredentials.recipientApprovalEffect.mutation': new Set(['fr']),
    // Spanish/Portuguese/Catalan: "experimental" and "Manual" are the same words, as already
    // ratified for the provider-settings namespace.
    'settingsVoice.realtimeProviders.authentication.openAiCodex.title': new Set(['es', 'pt', 'ca']),
    'settingsVoice.realtimeProviders.options.manual': new Set(['es', 'pt', 'ca']),
    // Catalan: "Model" is the Catalan word too.
    'settingsVoice.realtimeProviders.fields.model.title': new Set(['ca']),
};

function isProviderPluginTitleKey(key: string): boolean {
    return /^settingsAgents\.plugins\.[^.]+\.title$/.test(key);
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
    missingKeys: ReadonlyArray<Readonly<{ locale: string; key: string }>>;
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
            missingKeys: findMissingKeys(args.en, locale),
        };
    }

    return out;
}
