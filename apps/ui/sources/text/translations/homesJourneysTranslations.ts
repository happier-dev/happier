// Tooling aggregate. Product locale roots import only their locale payload.
import { homesJourneysTranslations as en } from './features/en';
import { homesJourneysTranslations as ca } from './features/ca';
import { homesJourneysTranslations as de } from './features/de';
import { homesJourneysTranslations as es } from './features/es';
import { homesJourneysTranslations as fr } from './features/fr';
import { homesJourneysTranslations as it } from './features/it';
import { homesJourneysTranslations as ja } from './features/ja';
import { homesJourneysTranslations as pl } from './features/pl';
import { homesJourneysTranslations as pt } from './features/pt';
import { homesJourneysTranslations as ru } from './features/ru';
import { homesJourneysTranslations as zh_Hans } from './features/zh-Hans';
import { homesJourneysTranslations as zh_Hant } from './features/zh-Hant';

export const homesJourneysTranslations = {
    ...en.homesJourneysTranslations,
    ...ca.homesJourneysTranslations,
    ...de.homesJourneysTranslations,
    ...es.homesJourneysTranslations,
    ...fr.homesJourneysTranslations,
    ...it.homesJourneysTranslations,
    ...ja.homesJourneysTranslations,
    ...pl.homesJourneysTranslations,
    ...pt.homesJourneysTranslations,
    ...ru.homesJourneysTranslations,
    ...zh_Hans.homesJourneysTranslations,
    ...zh_Hant.homesJourneysTranslations,
};
