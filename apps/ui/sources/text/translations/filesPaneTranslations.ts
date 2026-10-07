// Tooling aggregate. Product locale roots import only their locale payload.
import { filesPaneTranslations as en } from './features/en';
import { filesPaneTranslations as ca } from './features/ca';
import { filesPaneTranslations as de } from './features/de';
import { filesPaneTranslations as es } from './features/es';
import { filesPaneTranslations as fr } from './features/fr';
import { filesPaneTranslations as it } from './features/it';
import { filesPaneTranslations as ja } from './features/ja';
import { filesPaneTranslations as pl } from './features/pl';
import { filesPaneTranslations as pt } from './features/pt';
import { filesPaneTranslations as ru } from './features/ru';
import { filesPaneTranslations as zh_Hans } from './features/zh-Hans';
import { filesPaneTranslations as zh_Hant } from './features/zh-Hant';

export const filesPaneTranslations = {
    ...en.filesPaneTranslations,
    ...ca.filesPaneTranslations,
    ...de.filesPaneTranslations,
    ...es.filesPaneTranslations,
    ...fr.filesPaneTranslations,
    ...it.filesPaneTranslations,
    ...ja.filesPaneTranslations,
    ...pl.filesPaneTranslations,
    ...pt.filesPaneTranslations,
    ...ru.filesPaneTranslations,
    ...zh_Hans.filesPaneTranslations,
    ...zh_Hant.filesPaneTranslations,
};
