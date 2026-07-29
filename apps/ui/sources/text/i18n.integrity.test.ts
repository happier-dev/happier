import { describe, expect, it } from 'vitest';

import { en } from './translations/en';
import { ru } from './translations/ru';
import { pl } from './translations/pl';
import { es } from './translations/es';
import { it as itLocale } from './translations/it';
import { pt } from './translations/pt';
import { ca } from './translations/ca';
import { zhHans } from './translations/zh-Hans';
import { zhHant } from './translations/zh-Hant';
import { ja } from './translations/ja';

import { auditTranslations, flattenTranslationLeaves } from '../../tools/i18n/translationAudit';

const IGNORED_UNTRANSLATED_KEYS = new Set([
    'promptLibrary.supportingFilePathPlaceholder',
    'files.sourceControlOperations.update.remotes.namePlaceholder',
    'settingsSession.handoff.includeIgnoredMode.globsPlaceholder',
    'connectedServices.detail.prompts.accessTokenPlaceholder',
    'connectedServices.serviceNames.github',
    'connectedServices.serviceNames.bitbucket',
    'deps.installable.githubCli.title',
    'newSession.githubCliBanner.title',
    'files.markdown',
    'settingsSession.sessionCreation.modalModeSimpleTitle',
    'settingsSession.sessionCreation.wizardPresentationAutoTitle',
    'settingsSession.promptPersonalization.title',
    'settingsSession.promptPersonalization.footer',
    'settingsSession.promptPersonalization.askAgentToRenameSessionsTitle',
    'settingsSession.promptPersonalization.askAgentToRenameSessionsNeverTitle',
    'settingsSession.promptPersonalization.askAgentToRenameSessionsNeverSubtitle',
    'settingsSession.promptPersonalization.askAgentToRenameSessionsInitialTitle',
    'settingsSession.promptPersonalization.askAgentToRenameSessionsInitialSubtitle',
    'settingsSession.promptPersonalization.askAgentToRenameSessionsOngoingTitle',
    'settingsSession.promptPersonalization.askAgentToRenameSessionsOngoingSubtitle',
    'settingsSession.promptPersonalization.askAgentToRenameSessionsInitialSelectedSubtitle',
    'settingsSession.promptPersonalization.askAgentToRenameSessionsOngoingSelectedSubtitle',
    'settingsSession.promptPersonalization.askAgentToRenameSessionsDisabledSubtitle',
    'settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsTitle',
    'settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsEnabledSubtitle',
    'settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsDisabledSubtitle',
    'newSession.worktree.backToRoot',
    'welcome.welcomeFooterRelay',
    'settingsSession.sessionList.narrowWorkingIndicatorSpinnerTitle',
    'settingsSession.sessionList.workingIndicatorSpinnerTitle',
    'settingsSession.sessionList.identityDisplayAvatarTitle',
]);
const IGNORED_UNTRANSLATED_KEY_PREFIXES = [
    'settingsAppearance.themeProfiles.',
    'settingsKeyboard.',
    'settingsSession.sessionCreation.',
    'settingsSession.promptPersonalization.',
    'commandPalette.commands.',
    'releaseNotes.onboardingShowcase.',
    'sessionsList.',
];
const UNTRANSLATED_PREFIX_BASELINE_COUNTS: Record<string, Record<string, number>> = {
    ru: {
        'settingsAppearance.themeProfiles.': 106,
        'settingsKeyboard.': 33,
        'settingsSession.sessionCreation.': 1,
        'settingsSession.promptPersonalization.': 15,
        'commandPalette.commands.': 35,
        'releaseNotes.onboardingShowcase.': 0,
        'sessionsList.': 22,
    },
    pl: {
        'settingsAppearance.themeProfiles.': 106,
        'settingsKeyboard.': 33,
        'settingsSession.sessionCreation.': 1,
        'settingsSession.promptPersonalization.': 15,
        'commandPalette.commands.': 35,
        'releaseNotes.onboardingShowcase.': 0,
        'sessionsList.': 22,
    },
    es: {
        'settingsAppearance.themeProfiles.': 106,
        'settingsKeyboard.': 33,
        'settingsSession.sessionCreation.': 2,
        'settingsSession.promptPersonalization.': 15,
        'commandPalette.commands.': 35,
        'releaseNotes.onboardingShowcase.': 14,
        'sessionsList.': 22,
    },
    it: {
        'settingsAppearance.themeProfiles.': 106,
        'settingsKeyboard.': 33,
        'settingsSession.sessionCreation.': 1,
        'settingsSession.promptPersonalization.': 15,
        'commandPalette.commands.': 35,
        'releaseNotes.onboardingShowcase.': 14,
        'sessionsList.': 22,
    },
    pt: {
        'settingsAppearance.themeProfiles.': 106,
        'settingsKeyboard.': 33,
        'settingsSession.sessionCreation.': 1,
        'settingsSession.promptPersonalization.': 15,
        'commandPalette.commands.': 35,
        'releaseNotes.onboardingShowcase.': 0,
        'sessionsList.': 22,
    },
    ca: {
        'settingsAppearance.themeProfiles.': 106,
        'settingsKeyboard.': 33,
        'settingsSession.sessionCreation.': 2,
        'settingsSession.promptPersonalization.': 15,
        'commandPalette.commands.': 35,
        'releaseNotes.onboardingShowcase.': 0,
        'sessionsList.': 22,
    },
    'zh-Hans': {
        'settingsAppearance.themeProfiles.': 106,
        'settingsKeyboard.': 33,
        'settingsSession.sessionCreation.': 1,
        'settingsSession.promptPersonalization.': 15,
        'commandPalette.commands.': 35,
        'releaseNotes.onboardingShowcase.': 0,
        'sessionsList.': 22,
    },
    'zh-Hant': {
        'settingsAppearance.themeProfiles.': 106,
        'settingsKeyboard.': 33,
        'settingsSession.sessionCreation.': 1,
        'settingsSession.promptPersonalization.': 15,
        'commandPalette.commands.': 35,
        'releaseNotes.onboardingShowcase.': 0,
        'sessionsList.': 22,
    },
    ja: {
        'settingsAppearance.themeProfiles.': 106,
        'settingsKeyboard.': 33,
        'settingsSession.sessionCreation.': 1,
        'settingsSession.promptPersonalization.': 15,
        'commandPalette.commands.': 35,
        'releaseNotes.onboardingShowcase.': 0,
        'sessionsList.': 22,
    },
};

// This test is a drift-stopper: it fails if we introduce any *new* untranslated English strings outside
// of explicitly allowlisted scopes in `apps/ui/tools/i18n/translationAudit.ts`.
const MAX_UNTRANSLATED_STRINGS = 263;

const SAMPLED_FUNCTION_TRANSLATIONS: Readonly<Record<string, readonly unknown[]>> = {
    'connectedServices.detail.groups.memberQuotaExhaustedUntil': [{ time: '10:30' }],
    'connectedServices.detail.groups.memberRateLimitedUntil': [{ time: '10:30' }],
    'connectedServices.detail.groups.memberCapacityLimitedUntil': [{ time: '10:30' }],
    'connectedServices.detail.groups.memberAuthInvalidUntil': [{ time: '10:30' }],
    'connectedServices.detail.groups.memberPlanUnavailableUntil': [{ time: '10:30' }],
    'connectedServices.detail.groups.memberValidationBlockedUntil': [{ time: '10:30' }],
    'settingsProviders.detail.modelCount': [{ count: 2 }],
    'settingsProviders.models.experimentalConfirmBody': [{ provider: 'Example Provider', model: 'example-model' }],
    'settingsProviders.local.detectedAtPort': [{ port: '11434' }],
    'settingsProviders.local.possibleAtPort': [{ provider: 'Example Provider', port: '11434' }],
    'settingsProviders.local.defaultConnectionName': [{ provider: 'Example Provider' }],
    'settingsProviders.local.startManaged': [{ provider: 'Example Provider' }],
    'settingsProviders.detail.copyName': [{ name: 'Work' }],
    'settingsProviders.models.invalidModelIds': [{ ids: 'bad-id' }],
    'session.providerBinding.launchDefaultLabel': [{ provider: 'Example Provider' }],
    'session.providerBinding.launchNamedLabel': [{ provider: 'Example Provider', connection: 'Work' }],
    'session.providerBinding.changedBody': [{ provider: 'Example Provider', connection: 'Work' }],
    'session.providerBinding.unavailableBody': [{ provider: 'Example Provider', connection: 'Work' }],
    'session.providerBinding.disabledBody': [{ provider: 'Example Provider', connection: 'Work' }],
    'session.providerBinding.incompatibleBody': [{ provider: 'Example Provider', connection: 'Work' }],
};

const SAMPLED_FUNCTION_SAME_VALUE_BY_LOCALE: Readonly<Record<string, ReadonlySet<string>>> = {
    // Catalan uses the same plural noun spelling as English.
    'settingsProviders.detail.modelCount': new Set(['ca']),
    // Italian uses “provider” as the standard product term.
    'session.providerBinding.launchDefaultLabel': new Set(['it']),
    'session.providerBinding.launchNamedLabel': new Set(['it']),
    // “Local” has the same spelling in these locales.
    'settingsProviders.local.defaultConnectionName': new Set(['es', 'pt', 'ca']),
};

const EXTERNAL_SESSION_FUNCTION_TRANSLATIONS: Readonly<Record<string, readonly unknown[]>> = {
    'externalSessions.operationImportCountUnknown': [{ imported: 12 }],
    'externalSessions.operationImportCountEstimated': [{ imported: 12, total: 20 }],
    'externalSessions.operationPublishedThrough': [{ sequence: 12 }],
    'externalSessions.externalAgentStatusOnMachine': [{
        agent: 'AGENT_MARKER',
        machine: 'MACHINE_MARKER',
        status: 'STATUS_MARKER',
    }],
    'externalSessions.sharingTranscriptOnMachine': [{ machine: 'MACHINE_MARKER' }],
    'externalSessions.sharingSharedUpTo': [{ time: 'TIME_MARKER' }],
    'externalSessions.sharingSnapshotFrom': [{ time: 'TIME_MARKER' }],
    'externalSessions.settingsIntegrationRemediationOpenSettings': [{ path: 'PATH_MARKER' }],
    'externalSessions.settingsIntegrationRemediationSelectAccount': [{ service: 'SERVICE_MARKER' }],
    'externalSessions.settingsIntegrationRemediationInstallDependency': [{ dependency: 'DEPENDENCY_MARKER' }],
    'externalSessions.settingsIntegrationRemediationOpenUrl': [{ url: 'URL_MARKER' }],
    'externalSessions.settingsIntegrationReviewTitle': [{ agent: 'AGENT_MARKER' }],
    'externalSessions.settingsIntegrationReviewBody': [{ entries: 'ENTRIES_MARKER' }],
    'externalSessions.settingsIntegrationUninstallTitle': [{ agent: 'AGENT_MARKER' }],
    'externalSessions.settingsAgentAutoLinkTitle': [{ agent: 'AGENT_MARKER' }],
    'externalSessions.settingsAgentBrowseTitle': [{ agent: 'AGENT_MARKER' }],
    'externalSessions.browseSearchIncomplete': [{ count: 12 }],
    'externalSessions.browseSourceCodexConnectedServices': [{ service: 'SERVICE_MARKER' }],
    'externalSessions.browseIndexingProgress': [{ scanned: 12, total: 20 }],
};

const EXTERNAL_SESSION_NEIGHBORING_STRING_KEYS = [
    'chatFooter.checkingExternalSessionTakeover',
    'chatFooter.externalSessionTakeoverAvailable',
    'chatFooter.externalSessionMachineOffline',
    'chatFooter.externalSessionStatusUnavailable',
    'chatFooter.externalSessionProcessRunning',
    'chatFooter.externalSessionRecheck',
    'chatFooter.externalSessionTakeoverBlocked',
    'chatFooter.switchingToPersistedTakeover',
    'chatFooter.switchingToDirectTakeover',
    'chatFooter.takeOverDirect',
    'chatFooter.directTakeoverDialogTitle',
    'chatFooter.directTakeoverDialogBody',
    'chatFooter.directTakeoverDialogDirectTitle',
    'chatFooter.directTakeoverDialogDirectBody',
    'chatFooter.directTakeoverDialogPersistTitle',
    'chatFooter.directTakeoverDialogPersistBody',
    'chatFooter.directTakeoverDialogForceStopTitle',
    'chatFooter.directTakeoverDialogForceStopBody',
    'status.workingExternally',
    'status.needsInputExternally',
    'status.retryingExternally',
    'status.ready',
    'status.recentlyActive',
    'status.externalStatusUnknown',
    'sessionsList.storageExternalFilter',
] as const;

const EXTERNAL_SESSION_SAME_VALUE_BY_LOCALE: Readonly<Record<string, ReadonlySet<string>>> = {
    // These standard UI terms have the same spelling in the listed locales.
    'externalSessions.browseAgents': new Set(['ca']),
    'externalSessions.settingsPrivacyGroupTitle': new Set(['it']),
    'externalSessions.settingsMachineOnline': new Set(['it', 'pt']),
    'externalSessions.settingsMachineOffline': new Set(['it', 'pt', 'pl']),
};

function readTranslationLeaf(root: unknown, key: string): unknown {
    return key.split('.').reduce<unknown>((node, part) => {
        return node && typeof node === 'object'
            ? (node as Record<string, unknown>)[part]
            : undefined;
    }, root);
}

function callSampledTranslation(value: unknown, args: readonly unknown[]): string | null {
    if (typeof value !== 'function') return null;
    const result = value(...args);
    return typeof result === 'string' ? result : null;
}

describe('i18n integrity', () => {
    it('keeps the Codex Live account and privacy namespace complete in every supported locale', () => {
        const expected = flattenTranslationLeaves(en.settingsVoice.realtimeProviders.codex)
            .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
            .sort((left, right) => left.key.localeCompare(right.key));
        const locales = [
            { code: 'ru', root: ru },
            { code: 'pl', root: pl },
            { code: 'es', root: es },
            { code: 'it', root: itLocale },
            { code: 'pt', root: pt },
            { code: 'ca', root: ca },
            { code: 'zh-Hans', root: zhHans },
            { code: 'zh-Hant', root: zhHant },
            { code: 'ja', root: ja },
        ];

        const mismatches = locales.flatMap(({ code, root }) => {
            const actual = flattenTranslationLeaves(root.settingsVoice?.realtimeProviders?.codex)
                .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
                .sort((left, right) => left.key.localeCompare(right.key));
            return JSON.stringify(actual) === JSON.stringify(expected)
                ? []
                : [`${code}: ${actual.length}/${expected.length} Codex Live translation leaves`];
        });
        const untranslated = Object.values(auditTranslations({ en, locales }))
            .flatMap((report) => report.untranslatedStrings)
            .filter((entry) => entry.key.startsWith('settingsVoice.realtimeProviders.codex.'));

        expect(mismatches).toEqual([]);
        expect(untranslated).toEqual([]);
    });

    it('keeps selectable provider privacy and local-resumption semantics localized', () => {
        const locales = [
            { code: 'en', root: en, idToken: 'ID', negativeToken: 'does not' },
            { code: 'ru', root: ru, idToken: 'идентификатор', negativeToken: 'не' },
            { code: 'pl', root: pl, idToken: 'identyfikator', negativeToken: 'nie' },
            { code: 'es', root: es, idToken: 'identificador', negativeToken: 'no' },
            { code: 'it', root: itLocale, idToken: 'identificatore', negativeToken: 'non' },
            { code: 'pt', root: pt, idToken: 'identificador', negativeToken: 'não' },
            { code: 'ca', root: ca, idToken: 'identificador', negativeToken: 'no' },
            { code: 'zh-Hans', root: zhHans, idToken: '标识符', negativeToken: '不会' },
            { code: 'zh-Hant', root: zhHant, idToken: '識別碼', negativeToken: '不會' },
            { code: 'ja', root: ja, idToken: 'ID', negativeToken: '削除しません' },
        ];

        const failures = locales.flatMap(({ code, root, idToken, negativeToken }) => {
            const realtimeProviders = root.settingsVoice?.realtimeProviders;
            const disclosures = [
                realtimeProviders?.openai?.privacyDisclosure,
                realtimeProviders?.xai?.privacyDisclosure,
                realtimeProviders?.google?.privacyDisclosure,
                realtimeProviders?.codex?.privacyDisclosure,
            ];
            const resumption = realtimeProviders?.resumption;
            const forgetCopy = [
                resumption?.forgetTitle,
                resumption?.forgetSubtitle,
                resumption?.forgotten,
                resumption?.unsupported,
                resumption?.failed,
            ];
            const combinedForgetCopy = forgetCopy.filter((value) => typeof value === 'string').join(' ');
            const subtitle = typeof resumption?.forgetSubtitle === 'string' ? resumption.forgetSubtitle : '';
            return [
                ...(disclosures.every((value) => typeof value === 'string' && value.trim().length > 0)
                    ? [] : [`${code}: missing provider disclosure`]),
                ...(forgetCopy.every((value) => typeof value === 'string' && value.trim().length > 0)
                    ? [] : [`${code}: incomplete forget copy`]),
                ...(combinedForgetCopy.includes('Happier') && combinedForgetCopy.includes(idToken)
                    ? [] : [`${code}: forget copy does not identify Happier's saved id`]),
                ...(subtitle.includes('xAI') && subtitle.toLocaleLowerCase().includes(negativeToken.toLocaleLowerCase())
                    ? [] : [`${code}: forget subtitle does not disclaim xAI deletion`]),
            ];
        });

        expect(failures).toEqual([]);
    });

    it('keeps the provider settings namespace complete in every supported locale', () => {
        const expected = flattenTranslationLeaves(en.settingsProviders)
            .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
            .sort((left, right) => left.key.localeCompare(right.key));
        const locales = [
            { code: 'ru', root: ru },
            { code: 'pl', root: pl },
            { code: 'es', root: es },
            { code: 'it', root: itLocale },
            { code: 'pt', root: pt },
            { code: 'ca', root: ca },
            { code: 'zh-Hans', root: zhHans },
            { code: 'zh-Hant', root: zhHant },
            { code: 'ja', root: ja },
        ];

        const mismatches = locales.flatMap(({ code, root }) => {
            const actual = flattenTranslationLeaves(root.settingsProviders)
                .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
                .sort((left, right) => left.key.localeCompare(right.key));
            return JSON.stringify(actual) === JSON.stringify(expected)
                ? []
                : [`${code}: ${actual.length}/${expected.length} provider translation leaves`];
        });

        expect(mismatches).toEqual([]);
    });

    it('keeps the provider session namespace complete in every supported locale', () => {
        const expected = flattenTranslationLeaves(en.session.providerBinding)
            .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
            .sort((left, right) => left.key.localeCompare(right.key));
        const locales = [
            { code: 'ru', root: ru },
            { code: 'pl', root: pl },
            { code: 'es', root: es },
            { code: 'it', root: itLocale },
            { code: 'pt', root: pt },
            { code: 'ca', root: ca },
            { code: 'zh-Hans', root: zhHans },
            { code: 'zh-Hant', root: zhHant },
            { code: 'ja', root: ja },
        ];

        const mismatches = locales.flatMap(({ code, root }) => {
            const actual = flattenTranslationLeaves(root.session.providerBinding)
                .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
                .sort((left, right) => left.key.localeCompare(right.key));
            return JSON.stringify(actual) === JSON.stringify(expected)
                ? []
                : [`${code}: ${actual.length}/${expected.length} provider session translation leaves`];
        });

        expect(mismatches).toEqual([]);
    });

    it('keeps plugin-management translations complete without English fallback copy', () => {
        const locales = [
            { code: 'ru', root: ru },
            { code: 'pl', root: pl },
            { code: 'es', root: es },
            { code: 'it', root: itLocale },
            { code: 'pt', root: pt },
            { code: 'ca', root: ca },
            { code: 'zh-Hans', root: zhHans },
            { code: 'zh-Hant', root: zhHant },
            { code: 'ja', root: ja },
        ];
        const expected = flattenTranslationLeaves(en.settingsPlugins)
            .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
            .sort((left, right) => left.key.localeCompare(right.key));
        const mismatches = locales.flatMap(({ code, root }) => {
            const actual = flattenTranslationLeaves(root.settingsPlugins)
                .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
                .sort((left, right) => left.key.localeCompare(right.key));
            return JSON.stringify(actual) === JSON.stringify(expected)
                ? []
                : [`${code}: ${actual.length}/${expected.length} plugin-management translation leaves`];
        });
        const untranslated = Object.values(auditTranslations({ en, locales }))
            .flatMap((report) => report.untranslatedStrings)
            .filter((entry) => entry.key.startsWith('settingsPlugins.'));

        expect(mismatches).toEqual([]);
        expect(untranslated).toEqual([]);
    });

    it('keeps host-rendered plugin-surface translations complete without English fallback copy', () => {
        const locales = [
            { code: 'ru', root: ru },
            { code: 'pl', root: pl },
            { code: 'es', root: es },
            { code: 'it', root: itLocale },
            { code: 'pt', root: pt },
            { code: 'ca', root: ca },
            { code: 'zh-Hans', root: zhHans },
            { code: 'zh-Hant', root: zhHant },
            { code: 'ja', root: ja },
        ];
        const expected = flattenTranslationLeaves(en.pluginSurfaces)
            .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
            .sort((left, right) => left.key.localeCompare(right.key));
        const mismatches = locales.flatMap(({ code, root }) => {
            const actual = flattenTranslationLeaves(root.pluginSurfaces)
                .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
                .sort((left, right) => left.key.localeCompare(right.key));
            return JSON.stringify(actual) === JSON.stringify(expected)
                ? []
                : [`${code}: ${actual.length}/${expected.length} plugin-surface translation leaves`];
        });
        const untranslated = Object.values(auditTranslations({ en, locales }))
            .flatMap((report) => report.untranslatedStrings)
            .filter((entry) => entry.key.startsWith('pluginSurfaces.'));

        expect(mismatches).toEqual([]);
        expect(untranslated).toEqual([]);
    });

    it('keeps permission-review semantics localized in every supported locale', () => {
        const locales = [
            { code: 'ru', root: ru },
            { code: 'pl', root: pl },
            { code: 'es', root: es },
            { code: 'it', root: itLocale },
            { code: 'pt', root: pt },
            { code: 'ca', root: ca },
            { code: 'zh-Hans', root: zhHans },
            { code: 'zh-Hant', root: zhHant },
            { code: 'ja', root: ja },
        ];
        const expected = flattenTranslationLeaves(en.pluginPermissions)
            .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
            .sort((left, right) => left.key.localeCompare(right.key));
        const shapeMismatches = locales.flatMap(({ code, root }) => {
            const actual = flattenTranslationLeaves(root.pluginPermissions)
                .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
                .sort((left, right) => left.key.localeCompare(right.key));
            return JSON.stringify(actual) === JSON.stringify(expected)
                ? []
                : [`${code}: ${actual.length}/${expected.length} permission-review translation leaves`];
        });
        const untranslatedStrings = Object.values(auditTranslations({ en, locales }))
            .flatMap((report) => report.untranslatedStrings)
            .filter((entry) => entry.key.startsWith('pluginPermissions.'))
            .map((entry) => `${entry.locale}: ${entry.key} = ${JSON.stringify(entry.value)}`);
        const englishSummary = en.pluginPermissions.accessibilitySummary({ details: 'DETAILS_MARKER' });
        const untranslatedSummaries = locales.flatMap(({ code, root }) => {
            const localized = root.pluginPermissions.accessibilitySummary({ details: 'DETAILS_MARKER' });
            return localized === englishSummary
                ? [`${code}: pluginPermissions.accessibilitySummary = ${JSON.stringify(localized)}`]
                : [];
        });

        expect(shapeMismatches).toEqual([]);
        expect(untranslatedStrings).toEqual([]);
        expect(untranslatedSummaries).toEqual([]);
    });

    it('keeps External Sessions copy complete without English fallback values', () => {
        const locales = [
            { code: 'ru', root: ru },
            { code: 'pl', root: pl },
            { code: 'es', root: es },
            { code: 'it', root: itLocale },
            { code: 'pt', root: pt },
            { code: 'ca', root: ca },
            { code: 'zh-Hans', root: zhHans },
            { code: 'zh-Hant', root: zhHant },
            { code: 'ja', root: ja },
        ];
        const expected = flattenTranslationLeaves(en.externalSessions)
            .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
            .sort((left, right) => left.key.localeCompare(right.key));
        const shapeMismatches = locales.flatMap(({ code, root }) => {
            const actual = flattenTranslationLeaves(root.externalSessions)
                .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
                .sort((left, right) => left.key.localeCompare(right.key));
            return JSON.stringify(actual) === JSON.stringify(expected)
                ? []
                : [`${code}: ${actual.length}/${expected.length} External Sessions translation leaves`];
        });
        const inheritedFunctionKeys = flattenTranslationLeaves(en.externalSessions)
            .filter((leaf) => leaf.kind === 'function')
            .flatMap((leaf) => locales.flatMap(({ code, root }) => (
                readTranslationLeaf(root, `externalSessions.${leaf.key}`) === leaf.value
                    ? [`${code}: externalSessions.${leaf.key}`]
                    : []
            )));
        const untranslatedStrings = Object.values(auditTranslations({ en, locales }))
            .flatMap((report) => report.untranslatedStrings)
            .filter((entry) => (
                entry.key.startsWith('externalSessions.')
                || EXTERNAL_SESSION_NEIGHBORING_STRING_KEYS.includes(
                    entry.key as typeof EXTERNAL_SESSION_NEIGHBORING_STRING_KEYS[number]
                )
            ))
            .filter((entry) => !EXTERNAL_SESSION_SAME_VALUE_BY_LOCALE[entry.key]?.has(entry.locale))
            .map((entry) => `${entry.locale}: ${entry.key} = ${JSON.stringify(entry.value)}`);
        const untranslatedFunctions = Object.entries(EXTERNAL_SESSION_FUNCTION_TRANSLATIONS)
            .flatMap(([key, args]) => {
                const englishSample = callSampledTranslation(readTranslationLeaf(en, key), args);
                return locales.flatMap(({ code, root }) => {
                    const localeSample = callSampledTranslation(readTranslationLeaf(root, key), args);
                    return englishSample && localeSample === englishSample
                        ? [`${code}: ${key} = ${JSON.stringify(localeSample)}`]
                        : [];
                });
            });
        const placeholderMismatches = Object.entries(EXTERNAL_SESSION_FUNCTION_TRANSLATIONS)
            .flatMap(([key, args]) => {
                const markers = args.flatMap((arg) => (
                    arg && typeof arg === 'object'
                        ? Object.values(arg).map(String)
                        : [String(arg)]
                ));
                return locales.flatMap(({ code, root }) => {
                    const localeSample = callSampledTranslation(readTranslationLeaf(root, key), args);
                    const missing = markers.filter((marker) => !localeSample?.includes(marker));
                    return missing.length > 0
                        ? [`${code}: ${key} missing ${missing.join(', ')}`]
                        : [];
                });
            });

        expect(shapeMismatches).toEqual([]);
        expect(inheritedFunctionKeys).toEqual([]);
        expect(untranslatedStrings).toEqual([]);
        expect(untranslatedFunctions).toEqual([]);
        expect(placeholderMismatches).toEqual([]);
    });

    it('does not increase the number of untranslated English strings', () => {
        const report = auditTranslations({
            en,
            locales: [
                { code: 'ru', root: ru },
                { code: 'pl', root: pl },
                { code: 'es', root: es },
                { code: 'it', root: itLocale },
                { code: 'pt', root: pt },
                { code: 'ca', root: ca },
                { code: 'zh-Hans', root: zhHans },
                { code: 'zh-Hant', root: zhHant },
                { code: 'ja', root: ja },
            ],
        });

        const allUntranslated = Object.entries(report)
            .flatMap(([locale, r]) => r.untranslatedStrings.map((u) => ({ ...u, locale })));
        const baselineIncreases = Object.entries(UNTRANSLATED_PREFIX_BASELINE_COUNTS)
            .flatMap(([locale, counts]) => Object.entries(counts).map(([prefix, max]) => {
                const count = allUntranslated.filter((entry) => entry.locale === locale && entry.key.startsWith(prefix)).length;
                return { locale, prefix, count, max };
            }))
            .filter((entry) => entry.count > entry.max);
        if (baselineIncreases.length > 0) {
            throw new Error(
                [
                    'Found new untranslated strings inside prefix-scoped i18n baselines.',
                    'Translate the new keys or intentionally update the fixed baseline count.',
                    '',
                    ...baselineIncreases.map((entry) => `${entry.locale}: ${entry.prefix} ${entry.count}/${entry.max}`),
                ].join('\n')
            );
        }

        const untranslated = allUntranslated
            .filter((entry) => {
                if (IGNORED_UNTRANSLATED_KEYS.has(entry.key)) return false;
                return !IGNORED_UNTRANSLATED_KEY_PREFIXES.some((prefix) => entry.key.startsWith(prefix));
            });

        if (untranslated.length > MAX_UNTRANSLATED_STRINGS) {
            const sample = untranslated
                .slice(0, 40)
                .map((u) => `${u.locale}: ${u.key} = ${JSON.stringify(u.value)}`)
                .join('\n');
            throw new Error(
                [
                    `Found ${untranslated.length} untranslated strings identical to English.`,
                    `Expected ${MAX_UNTRANSLATED_STRINGS}; translate strings or add explicit allowlist entries for intentional fallbacks.`,
                    'Translate these strings in the locale files under sources/text/translations/.',
                    '',
                    'Sample:',
                    sample,
                ].join('\n')
            );
        }

        expect(untranslated.length).toBeLessThanOrEqual(MAX_UNTRANSLATED_STRINGS);
    });

    it('does not leave sampled function-valued translations as English fallbacks', () => {
        const locales = [
            { code: 'ru', root: ru },
            { code: 'pl', root: pl },
            { code: 'es', root: es },
            { code: 'it', root: itLocale },
            { code: 'pt', root: pt },
            { code: 'ca', root: ca },
            { code: 'zh-Hans', root: zhHans },
            { code: 'zh-Hant', root: zhHant },
            { code: 'ja', root: ja },
        ];
        const untranslated = Object.entries(SAMPLED_FUNCTION_TRANSLATIONS).flatMap(([key, args]) => {
            const englishSample = callSampledTranslation(readTranslationLeaf(en, key), args);
            return locales.flatMap(({ code, root }) => {
                const localeSample = callSampledTranslation(readTranslationLeaf(root, key), args);
                return englishSample
                    && localeSample === englishSample
                    && !SAMPLED_FUNCTION_SAME_VALUE_BY_LOCALE[key]?.has(code)
                    ? [`${code}: ${key} = ${JSON.stringify(localeSample)}`]
                    : [];
            });
        });

        expect(untranslated).toEqual([]);
    });

    it('preserves provider and connection placeholders in every locale', () => {
        const locales = [en, ru, pl, es, itLocale, pt, ca, zhHans, zhHant, ja];
        const samples = [
            { key: 'settingsProviders.models.experimentalConfirmBody', args: { provider: 'PROVIDER_MARKER', model: 'MODEL_MARKER' }, markers: ['PROVIDER_MARKER', 'MODEL_MARKER'] },
            { key: 'settingsProviders.local.startManaged', args: { provider: 'PROVIDER_MARKER' }, markers: ['PROVIDER_MARKER'] },
            { key: 'settingsProviders.models.invalidModelIds', args: { ids: 'MODEL_IDS_MARKER' }, markers: ['MODEL_IDS_MARKER'] },
            { key: 'session.providerBinding.launchDefaultLabel', args: { provider: 'PROVIDER_MARKER' }, markers: ['PROVIDER_MARKER'] },
            { key: 'session.providerBinding.launchNamedLabel', args: { provider: 'PROVIDER_MARKER', connection: 'CONNECTION_MARKER' }, markers: ['PROVIDER_MARKER', 'CONNECTION_MARKER'] },
            { key: 'session.providerBinding.changedBody', args: { provider: 'PROVIDER_MARKER', connection: 'CONNECTION_MARKER' }, markers: ['PROVIDER_MARKER', 'CONNECTION_MARKER'] },
            { key: 'session.providerBinding.unavailableBody', args: { provider: 'PROVIDER_MARKER', connection: 'CONNECTION_MARKER' }, markers: ['PROVIDER_MARKER', 'CONNECTION_MARKER'] },
            { key: 'session.providerBinding.disabledBody', args: { provider: 'PROVIDER_MARKER', connection: 'CONNECTION_MARKER' }, markers: ['PROVIDER_MARKER', 'CONNECTION_MARKER'] },
            { key: 'session.providerBinding.incompatibleBody', args: { provider: 'PROVIDER_MARKER', connection: 'CONNECTION_MARKER' }, markers: ['PROVIDER_MARKER', 'CONNECTION_MARKER'] },
        ] as const;

        const missing = locales.flatMap((root, localeIndex) => samples.flatMap(({ key, args, markers }) => {
            const rendered = callSampledTranslation(readTranslationLeaf(root, key), [args]);
            return rendered && markers.every((marker) => rendered.includes(marker))
                ? []
                : [`locale ${localeIndex}: ${key}`];
        }));

        expect(missing).toEqual([]);
    });
});
