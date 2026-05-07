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
]);

// This test is a drift-stopper: it fails if we introduce any *new* untranslated English strings outside
// of explicitly allowlisted scopes in `apps/ui/tools/i18n/translationAudit.ts`.
const MAX_UNTRANSLATED_STRINGS = 0;

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

        const untranslated = Object.entries(report)
            .flatMap(([locale, r]) => r.untranslatedStrings.map((u) => ({ ...u, locale })))
            .filter((entry) => !IGNORED_UNTRANSLATED_KEYS.has(entry.key));

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
});
