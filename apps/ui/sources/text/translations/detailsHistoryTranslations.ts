// Tooling aggregate. Product locale roots import only their locale payload.
import { detailsHistoryTranslations as en } from './features/en';
import { detailsHistoryTranslations as ca } from './features/ca';
import { detailsHistoryTranslations as de } from './features/de';
import { detailsHistoryTranslations as es } from './features/es';
import { detailsHistoryTranslations as fr } from './features/fr';
import { detailsHistoryTranslations as it } from './features/it';
import { detailsHistoryTranslations as ja } from './features/ja';
import { detailsHistoryTranslations as pl } from './features/pl';
import { detailsHistoryTranslations as pt } from './features/pt';
import { detailsHistoryTranslations as ru } from './features/ru';
import { detailsHistoryTranslations as zh_Hans } from './features/zh-Hans';
import { detailsHistoryTranslations as zh_Hant } from './features/zh-Hant';

export const detailsHistoryTranslations = {
    ...en.detailsHistoryTranslations,
    ...ca.detailsHistoryTranslations,
    ...de.detailsHistoryTranslations,
    ...es.detailsHistoryTranslations,
    ...fr.detailsHistoryTranslations,
    ...it.detailsHistoryTranslations,
    ...ja.detailsHistoryTranslations,
    ...pl.detailsHistoryTranslations,
    ...pt.detailsHistoryTranslations,
    ...ru.detailsHistoryTranslations,
    ...zh_Hans.detailsHistoryTranslations,
    ...zh_Hant.detailsHistoryTranslations,
};
