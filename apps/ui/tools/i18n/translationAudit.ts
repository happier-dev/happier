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
    // A file-format name, like JSON: every locale writes it this way.
    'Markdown',
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
    // "Home" is the Happier product term, "Logo" is shared across locales, and the
    // Team name placeholder is a sample company name rather than UI copy.
    'teams.homeLabel',
    'teams.settings.logoSection',
    'teams.create.namePlaceholder',
    // Literal sample address; some locales keep the example.com domain verbatim.
    'teams.invitations.emailPlaceholder',
    // Debug category identifiers are provider-owned technical names.
    'settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.options.hooks.title',
    'settingsAgents.plugins.claude.fields.claudeRemoteDebugCategories.options.1p.title',
    // Technical field labels that are commonly shared across locales.
    'settings.relayAccess.fields.tokenLabel',
    // "Token" is the word developers use unchanged in Polish, Spanish, French,
    // Italian, Portuguese, Catalan and German. Translating the Saved Secret kind
    // would name something none of those ecosystems calls it.
    'secrets.catalog.kinds.token',
]);

const ALLOW_SAME_STRING_KEYS_BY_LOCALE: Readonly<Record<string, ReadonlySet<string>>> = {
    // These are correctly translated in some locales even though they match English.
    'common.no': new Set(['es', 'it', 'ca']),
    // Italian writes "Privacy" as English does.
    'settingsNotifications.activitySurfaces.privacyTitle': new Set(['it']),
    // Desktop overlay: the word each locale's own UI uses is spelled like the English one.
    'settingsDesktop.overlay.compactStylePanelTitle': new Set(['de', 'es', 'pl']), // "Panel" is the German, Spanish and Polish word for a UI panel.
    'settingsDesktop.overlay.densityCompactTitle': new Set(['fr']), // French "Compact" (adjective).
    'settingsDesktop.overlay.interactionTitle': new Set(['fr']), // French "Interaction".
    'settingsDesktop.overlay.placementTitle': new Set(['fr']), // French "Placement".
    // Session settings pages: true cognates, the word each locale uses in its own UI.
    'settingsSessionPages.runtime.terminalSection': new Set(['fr', 'de', 'es', 'pt', 'ca', 'pl']),
    'settingsSessionPages.wizard.steps.backends': new Set(['fr', 'de', 'ca', 'pl']),
    'settingsSessionPages.wizard.steps.models': new Set(['ca', 'pl']),
    'settingsSessionPages.wizard.steps.machines': new Set(['fr']),
    'settingsSessionPages.wizard.steps.paths': new Set(['pl']),
    // German developer UI says "Tools" (the lane's other German strings use it too).
    'settingsSessionPages.transcript.toolsSection': new Set(['de']),
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
    // "Conversations" is the French noun as well as the English one.
    'externalSessions.browseConversations': new Set(['fr']),
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
    // Configuration surfaces (U8): true cognates on the redesigned settings and detail pages, the
    // word each locale's own UI uses. "Agent" as the executable agent (repo vocabulary), "Argument(s)"
    // for command-line arguments, "No" as `common.no`, "Online/Offline", "Team" and "Account" as the
    // ratified product nouns, "Status", "Details", "Name", "Optional", "Person", "Machine".
    'settingsAgents.customAcp.agentSection': new Set(['pl', 'fr', 'ca', 'de']),
    'settingsPlugins.surfaces.kinds.agent': new Set(['pl', 'fr', 'ca', 'de']),
    'settingsAgents.customAcp.argumentPlaceholder': new Set(['pl', 'fr', 'ca', 'de']),
    'settingsAgents.customAcp.argsTitle': new Set(['fr', 'ca']),
    'settingsAgents.customAcp.descriptionTitle': new Set(['fr']),
    'settingsAgents.customAcp.supportsModes': new Set(['fr', 'ca']),
    'settingsAgents.customAcp.hintNo': new Set(['es', 'it', 'ca']),
    'settingsAgents.customAcp.nameTitle': new Set(['de']),
    'settingsAgents.customAcp.optionalPlaceholder': new Set(['de']),
    'machineDetailPage.online': new Set(['pl', 'it', 'pt', 'de']),
    'machineDetailPage.offline': new Set(['pl', 'it', 'pt', 'de']),
    'machineDetailPage.placeholderTitle': new Set(['fr']),
    'machinePools.machinesSection': new Set(['fr']),
    'machinePools.descriptionTitle': new Set(['fr']),
    'profilesPage.descriptionTitle': new Set(['fr']),
    'automationPages.run.statusTitle': new Set(['pt', 'de']),
    'detailPages.person.placeholderTitle': new Set(['de']),
    'sessionPages.info.detailsTitle': new Set(['de']),
    'teams.create.detailsSection': new Set(['it', 'de']),
    'homeGovernance.accountSection': new Set(['it']),
    // Loading indicator style names: "Radar" and "Aurora" are the same word in these locales,
    // and French uses "Style" for the picker title.
    'settingsAppearance.loadingIndicatorOptions.radar': new Set(['pl', 'es', 'fr', 'it', 'pt', 'ca', 'de']),
    'settingsAppearance.loadingIndicatorOptions.aurora': new Set(['es', 'it', 'pt', 'ca']),
    'settingsAppearance.loadingIndicatorStyle': new Set(['fr']),
    // "Normal" and "Pause" are the same words in these locales.
    'settingsAppearance.loadingIndicatorSpeedOptions.normal': new Set(['de', 'es', 'pt', 'ca']),
    'settingsAppearance.loadingIndicatorPause': new Set(['de', 'fr']),
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
