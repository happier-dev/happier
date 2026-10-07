// Tooling aggregate. Product locale roots import only their locale payload.
import { personalizeTranslations as en } from './features/en';
import { personalizeTranslations as ca } from './features/ca';
import { personalizeTranslations as de } from './features/de';
import { personalizeTranslations as es } from './features/es';
import { personalizeTranslations as fr } from './features/fr';
import { personalizeTranslations as it } from './features/it';
import { personalizeTranslations as ja } from './features/ja';
import { personalizeTranslations as pl } from './features/pl';
import { personalizeTranslations as pt } from './features/pt';
import { personalizeTranslations as ru } from './features/ru';
import { personalizeTranslations as zh_Hans } from './features/zh-Hans';
import { personalizeTranslations as zh_Hant } from './features/zh-Hant';

export const personalizeTranslations = {
    ...en.personalizeTranslations,
    ...ca.personalizeTranslations,
    ...de.personalizeTranslations,
    ...es.personalizeTranslations,
    ...fr.personalizeTranslations,
    ...it.personalizeTranslations,
    ...ja.personalizeTranslations,
    ...pl.personalizeTranslations,
    ...pt.personalizeTranslations,
    ...ru.personalizeTranslations,
    ...zh_Hans.personalizeTranslations,
    ...zh_Hant.personalizeTranslations,
};
