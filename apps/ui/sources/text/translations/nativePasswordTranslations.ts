// Tooling aggregate. Product locale roots import only their locale payload.
import { nativePasswordTranslations as en } from './features/en';
import { nativePasswordTranslations as ca } from './features/ca';
import { nativePasswordTranslations as de } from './features/de';
import { nativePasswordTranslations as es } from './features/es';
import { nativePasswordTranslations as fr } from './features/fr';
import { nativePasswordTranslations as it } from './features/it';
import { nativePasswordTranslations as ja } from './features/ja';
import { nativePasswordTranslations as pl } from './features/pl';
import { nativePasswordTranslations as pt } from './features/pt';
import { nativePasswordTranslations as ru } from './features/ru';
import { nativePasswordTranslations as zh_Hans } from './features/zh-Hans';
import { nativePasswordTranslations as zh_Hant } from './features/zh-Hant';

export const nativePasswordTranslations = {
    ...en.nativePasswordTranslations,
    ...ca.nativePasswordTranslations,
    ...de.nativePasswordTranslations,
    ...es.nativePasswordTranslations,
    ...fr.nativePasswordTranslations,
    ...it.nativePasswordTranslations,
    ...ja.nativePasswordTranslations,
    ...pl.nativePasswordTranslations,
    ...pt.nativePasswordTranslations,
    ...ru.nativePasswordTranslations,
    ...zh_Hans.nativePasswordTranslations,
    ...zh_Hant.nativePasswordTranslations,
};
