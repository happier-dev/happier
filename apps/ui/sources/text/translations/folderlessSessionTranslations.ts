// Tooling aggregate. Product locale roots import only their locale payload.
import { folderlessSessionTranslations as en } from './features/en';
import { folderlessSessionTranslations as ca } from './features/ca';
import { folderlessSessionTranslations as de } from './features/de';
import { folderlessSessionTranslations as es } from './features/es';
import { folderlessSessionTranslations as fr } from './features/fr';
import { folderlessSessionTranslations as it } from './features/it';
import { folderlessSessionTranslations as ja } from './features/ja';
import { folderlessSessionTranslations as pl } from './features/pl';
import { folderlessSessionTranslations as pt } from './features/pt';
import { folderlessSessionTranslations as ru } from './features/ru';
import { folderlessSessionTranslations as zh_Hans } from './features/zh-Hans';
import { folderlessSessionTranslations as zh_Hant } from './features/zh-Hant';

export const folderlessSessionTranslations = {
    ...en.folderlessSessionTranslations,
    ...ca.folderlessSessionTranslations,
    ...de.folderlessSessionTranslations,
    ...es.folderlessSessionTranslations,
    ...fr.folderlessSessionTranslations,
    ...it.folderlessSessionTranslations,
    ...ja.folderlessSessionTranslations,
    ...pl.folderlessSessionTranslations,
    ...pt.folderlessSessionTranslations,
    ...ru.folderlessSessionTranslations,
    ...zh_Hans.folderlessSessionTranslations,
    ...zh_Hant.folderlessSessionTranslations,
};
