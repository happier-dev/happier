import { describe, expect, it } from 'vitest';

import { VOICE_MACHINE_ERROR_TRANSLATION_KEYS } from '@/voice/runtime/machine/voiceMachineErrorCopy';

import { ca } from './translations/ca';
import { de } from './translations/de';
import { en } from './translations/en';
import { es } from './translations/es';
import { fr } from './translations/fr';
import { it as itLocale } from './translations/it';
import { ja } from './translations/ja';
import { pl } from './translations/pl';
import { pt } from './translations/pt';
import { ru } from './translations/ru';
import { zhHans } from './translations/zh-Hans';
import { zhHant } from './translations/zh-Hant';

const supportedLocales = [
    { code: 'en', root: en },
    { code: 'de', root: de },
    { code: 'fr', root: fr },
    { code: 'ru', root: ru },
    { code: 'pl', root: pl },
    { code: 'es', root: es },
    { code: 'it', root: itLocale },
    { code: 'pt', root: pt },
    { code: 'ca', root: ca },
    { code: 'zh-Hans', root: zhHans },
    { code: 'zh-Hant', root: zhHant },
    { code: 'ja', root: ja },
] as const;

function readTranslation(root: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((value, segment) => (
        value !== null && typeof value === 'object'
            ? (value as Readonly<Record<string, unknown>>)[segment]
            : undefined
    ), root);
}

describe('voice machine error translations', () => {
    it('keeps machine error labels present in every supported locale', () => {
        for (const { code, root } of supportedLocales) {
            for (const [kind, translationKey] of Object.entries(
                VOICE_MACHINE_ERROR_TRANSLATION_KEYS,
            )) {
                const translation = readTranslation(root, translationKey);
                const label: unknown = typeof translation === 'function'
                    ? translation({ service: 'SERVICE' })
                    : translation;
                expect(label, `${code}.${kind}`).toEqual(expect.any(String));
                expect(typeof label === 'string' ? label.trim() : '', `${code}.${kind}`).not.toHaveLength(0);
                if (kind === 'provider_setup_required') {
                    expect(label, `${code}.${kind}`).toContain('SERVICE');
                }
            }
        }
    });
});
