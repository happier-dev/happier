// Tooling aggregate. Product locale roots import only their locale payload.
import { inboxWorkTranslations as en } from './features/en';
import { inboxWorkTranslations as ca } from './features/ca';
import { inboxWorkTranslations as de } from './features/de';
import { inboxWorkTranslations as es } from './features/es';
import { inboxWorkTranslations as fr } from './features/fr';
import { inboxWorkTranslations as it } from './features/it';
import { inboxWorkTranslations as ja } from './features/ja';
import { inboxWorkTranslations as pl } from './features/pl';
import { inboxWorkTranslations as pt } from './features/pt';
import { inboxWorkTranslations as ru } from './features/ru';
import { inboxWorkTranslations as zh_Hans } from './features/zh-Hans';
import { inboxWorkTranslations as zh_Hant } from './features/zh-Hant';

export const inboxWorkTranslations = {
    ...en.inboxWorkTranslations,
    ...ca.inboxWorkTranslations,
    ...de.inboxWorkTranslations,
    ...es.inboxWorkTranslations,
    ...fr.inboxWorkTranslations,
    ...it.inboxWorkTranslations,
    ...ja.inboxWorkTranslations,
    ...pl.inboxWorkTranslations,
    ...pt.inboxWorkTranslations,
    ...ru.inboxWorkTranslations,
    ...zh_Hans.inboxWorkTranslations,
    ...zh_Hant.inboxWorkTranslations,
};
