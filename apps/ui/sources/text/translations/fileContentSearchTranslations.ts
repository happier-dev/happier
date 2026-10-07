// Tooling aggregate. Product locale roots import only their locale payload.
import { fileContentSearchTranslations as en } from './features/en';
import { fileContentSearchTranslations as ca } from './features/ca';
import { fileContentSearchTranslations as de } from './features/de';
import { fileContentSearchTranslations as es } from './features/es';
import { fileContentSearchTranslations as fr } from './features/fr';
import { fileContentSearchTranslations as it } from './features/it';
import { fileContentSearchTranslations as ja } from './features/ja';
import { fileContentSearchTranslations as pl } from './features/pl';
import { fileContentSearchTranslations as pt } from './features/pt';
import { fileContentSearchTranslations as ru } from './features/ru';
import { fileContentSearchTranslations as zh_Hans } from './features/zh-Hans';
import { fileContentSearchTranslations as zh_Hant } from './features/zh-Hant';

export const fileContentSearchTranslations = {
    ...en.fileContentSearchTranslations,
    ...ca.fileContentSearchTranslations,
    ...de.fileContentSearchTranslations,
    ...es.fileContentSearchTranslations,
    ...fr.fileContentSearchTranslations,
    ...it.fileContentSearchTranslations,
    ...ja.fileContentSearchTranslations,
    ...pl.fileContentSearchTranslations,
    ...pt.fileContentSearchTranslations,
    ...ru.fileContentSearchTranslations,
    ...zh_Hans.fileContentSearchTranslations,
    ...zh_Hant.fileContentSearchTranslations,
};
