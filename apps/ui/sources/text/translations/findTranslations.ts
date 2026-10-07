// Tooling aggregate. Product locale roots import only their locale payload.
import { findTranslations as en } from './features/en';
import { findTranslations as ca } from './features/ca';
import { findTranslations as de } from './features/de';
import { findTranslations as es } from './features/es';
import { findTranslations as fr } from './features/fr';
import { findTranslations as it } from './features/it';
import { findTranslations as ja } from './features/ja';
import { findTranslations as pl } from './features/pl';
import { findTranslations as pt } from './features/pt';
import { findTranslations as ru } from './features/ru';
import { findTranslations as zh_Hans } from './features/zh-Hans';
import { findTranslations as zh_Hant } from './features/zh-Hant';

export const findTranslations = {
    ...en.findTranslations,
    ...ca.findTranslations,
    ...de.findTranslations,
    ...es.findTranslations,
    ...fr.findTranslations,
    ...it.findTranslations,
    ...ja.findTranslations,
    ...pl.findTranslations,
    ...pt.findTranslations,
    ...ru.findTranslations,
    ...zh_Hans.findTranslations,
    ...zh_Hant.findTranslations,
};
