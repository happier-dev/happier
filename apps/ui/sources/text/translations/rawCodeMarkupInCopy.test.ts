import { describe, expect, it } from 'vitest';

import { flattenTranslationLeaves } from '../../../tools/i18n/translationAudit';

import { ca } from './ca';
import { en } from './en';
import { es } from './es';
import { it as itLocale } from './it';
import { ja } from './ja';
import { pl } from './pl';
import { pt } from './pt';
import { ru } from './ru';
import { zhHans } from './zh-Hans';
import { zhHant } from './zh-Hant';

/**
 * Markdown code-span marker. No translation value reaches a Markdown renderer:
 * every `t(...)` consumer renders into a plain `Text`, `Item` title/subtitle,
 * `ItemGroup` footer, or `Modal.alert` body. A backtick in a translation value
 * is therefore displayed to the user verbatim.
 */
const CODE_SPAN_MARKER = String.fromCharCode(96);

const LOCALES = [
    { code: 'en', root: en },
    { code: 'ru', root: ru },
    { code: 'pl', root: pl },
    { code: 'es', root: es },
    { code: 'it', root: itLocale },
    { code: 'pt', root: pt },
    { code: 'ca', root: ca },
    { code: 'zh-Hans', root: zhHans },
    { code: 'zh-Hant', root: zhHant },
    { code: 'ja', root: ja },
] as const satisfies readonly { code: string; root: unknown }[];

describe('translation copy markup', () => {
    it('never ships raw Markdown code spans in user-visible copy', () => {
        const offenders = LOCALES.flatMap(({ code, root }) =>
            flattenTranslationLeaves(root).flatMap((leaf) =>
                leaf.kind === 'string' && leaf.value.includes(CODE_SPAN_MARKER)
                    ? [`${code}: ${leaf.key} — ${leaf.value}`]
                    : []
            )
        );

        expect(offenders).toEqual([]);
    });
});
