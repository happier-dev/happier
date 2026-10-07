// Tooling aggregate. Product locale roots import only their locale payload.
import { turnChangesTranslations as en } from './features/en';
import { turnChangesTranslations as ca } from './features/ca';
import { turnChangesTranslations as de } from './features/de';
import { turnChangesTranslations as es } from './features/es';
import { turnChangesTranslations as fr } from './features/fr';
import { turnChangesTranslations as it } from './features/it';
import { turnChangesTranslations as ja } from './features/ja';
import { turnChangesTranslations as pl } from './features/pl';
import { turnChangesTranslations as pt } from './features/pt';
import { turnChangesTranslations as ru } from './features/ru';
import { turnChangesTranslations as zh_Hans } from './features/zh-Hans';
import { turnChangesTranslations as zh_Hant } from './features/zh-Hant';

export const turnChangesTranslations = {
    ...en.turnChangesTranslations,
    ...ca.turnChangesTranslations,
    ...de.turnChangesTranslations,
    ...es.turnChangesTranslations,
    ...fr.turnChangesTranslations,
    ...it.turnChangesTranslations,
    ...ja.turnChangesTranslations,
    ...pl.turnChangesTranslations,
    ...pt.turnChangesTranslations,
    ...ru.turnChangesTranslations,
    ...zh_Hans.turnChangesTranslations,
    ...zh_Hant.turnChangesTranslations,
};
