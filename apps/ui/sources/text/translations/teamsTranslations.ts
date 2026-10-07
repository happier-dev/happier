// Tooling aggregate. Product locale roots import only their locale payload.
import { teamsTranslations as en } from './features/en';
import { teamsTranslations as ca } from './features/ca';
import { teamsTranslations as de } from './features/de';
import { teamsTranslations as es } from './features/es';
import { teamsTranslations as fr } from './features/fr';
import { teamsTranslations as it } from './features/it';
import { teamsTranslations as ja } from './features/ja';
import { teamsTranslations as pl } from './features/pl';
import { teamsTranslations as pt } from './features/pt';
import { teamsTranslations as ru } from './features/ru';
import { teamsTranslations as zh_Hans } from './features/zh-Hans';
import { teamsTranslations as zh_Hant } from './features/zh-Hant';

export const teamsTranslations = {
    ...en.teamsTranslations,
    ...ca.teamsTranslations,
    ...de.teamsTranslations,
    ...es.teamsTranslations,
    ...fr.teamsTranslations,
    ...it.teamsTranslations,
    ...ja.teamsTranslations,
    ...pl.teamsTranslations,
    ...pt.teamsTranslations,
    ...ru.teamsTranslations,
    ...zh_Hans.teamsTranslations,
    ...zh_Hant.teamsTranslations,
};
