// Tooling aggregate. Product locale roots import only their locale payload.
import { glassAppearanceTranslations as en } from './features/en';
import { glassAppearanceTranslations as ca } from './features/ca';
import { glassAppearanceTranslations as de } from './features/de';
import { glassAppearanceTranslations as es } from './features/es';
import { glassAppearanceTranslations as fr } from './features/fr';
import { glassAppearanceTranslations as it } from './features/it';
import { glassAppearanceTranslations as ja } from './features/ja';
import { glassAppearanceTranslations as pl } from './features/pl';
import { glassAppearanceTranslations as pt } from './features/pt';
import { glassAppearanceTranslations as ru } from './features/ru';
import { glassAppearanceTranslations as zh_Hans } from './features/zh-Hans';
import { glassAppearanceTranslations as zh_Hant } from './features/zh-Hant';

export const effectiveTranslations = {
    ...en.effectiveTranslations,
    ...ca.effectiveTranslations,
    ...de.effectiveTranslations,
    ...es.effectiveTranslations,
    ...fr.effectiveTranslations,
    ...it.effectiveTranslations,
    ...ja.effectiveTranslations,
    ...pl.effectiveTranslations,
    ...pt.effectiveTranslations,
    ...ru.effectiveTranslations,
    ...zh_Hans.effectiveTranslations,
    ...zh_Hant.effectiveTranslations,
};

export const glassAppearanceTranslations = {
    ...en.glassAppearanceTranslations,
    ...ca.glassAppearanceTranslations,
    ...de.glassAppearanceTranslations,
    ...es.glassAppearanceTranslations,
    ...fr.glassAppearanceTranslations,
    ...it.glassAppearanceTranslations,
    ...ja.glassAppearanceTranslations,
    ...pl.glassAppearanceTranslations,
    ...pt.glassAppearanceTranslations,
    ...ru.glassAppearanceTranslations,
    ...zh_Hans.glassAppearanceTranslations,
    ...zh_Hant.glassAppearanceTranslations,
};
