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

describe('i18n integrity', () => {
    it('does not ship untranslated English strings in non-English locales', () => {
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
            .flatMap(([locale, r]) => r.untranslatedStrings.map((u) => ({ ...u, locale })));

        if (untranslated.length > 0) {
            const sample = untranslated
                .slice(0, 40)
                .map((u) => `${u.locale}: ${u.key} = ${JSON.stringify(u.value)}`)
                .join('\n');
            throw new Error(
                [
                    `Found ${untranslated.length} untranslated strings identical to English.`,
                    'Translate these strings in the locale files under sources/text/translations/.',
                    '',
                    'Sample:',
                    sample,
                ].join('\n')
            );
        }

        expect(untranslated).toEqual([]);
    });
});
