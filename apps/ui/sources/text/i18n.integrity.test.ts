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

import { auditTranslations } from '../../tools/i18n/translationAudit';

const IGNORED_UNTRANSLATED_KEYS = new Set([
    'promptLibrary.supportingFilePathPlaceholder',
    'files.sourceControlOperations.update.remotes.namePlaceholder',
    'settingsSession.handoff.includeIgnoredMode.globsPlaceholder',
    'connectedServices.detail.prompts.accessTokenPlaceholder',
    'connectedServices.serviceNames.github',
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
    'session.workState.goal.budgetToggle',
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
                return englishSample && localeSample === englishSample
                    ? [`${code}: ${key} = ${JSON.stringify(localeSample)}`]
                    : [];
            });
        });

        expect(untranslated).toEqual([]);
    });
});
