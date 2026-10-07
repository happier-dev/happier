// Tooling aggregate. Product locale roots import only their locale payload.
import { detailsFileTranslations as en } from './features/en';
import { detailsFileTranslations as ca } from './features/ca';
import { detailsFileTranslations as de } from './features/de';
import { detailsFileTranslations as es } from './features/es';
import { detailsFileTranslations as fr } from './features/fr';
import { detailsFileTranslations as it } from './features/it';
import { detailsFileTranslations as ja } from './features/ja';
import { detailsFileTranslations as pl } from './features/pl';
import { detailsFileTranslations as pt } from './features/pt';
import { detailsFileTranslations as ru } from './features/ru';
import { detailsFileTranslations as zh_Hans } from './features/zh-Hans';
import { detailsFileTranslations as zh_Hant } from './features/zh-Hant';

export const detailsFileTranslations = {
    ...en.detailsFileTranslations,
    ...ca.detailsFileTranslations,
    ...de.detailsFileTranslations,
    ...es.detailsFileTranslations,
    ...fr.detailsFileTranslations,
    ...it.detailsFileTranslations,
    ...ja.detailsFileTranslations,
    ...pl.detailsFileTranslations,
    ...pt.detailsFileTranslations,
    ...ru.detailsFileTranslations,
    ...zh_Hans.detailsFileTranslations,
    ...zh_Hant.detailsFileTranslations,
};
