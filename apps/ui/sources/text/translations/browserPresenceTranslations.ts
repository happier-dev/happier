// Tooling aggregate. Product locale roots import only their locale payload.
import { browserPresenceTranslations as en } from './features/en';
import { browserPresenceTranslations as ca } from './features/ca';
import { browserPresenceTranslations as de } from './features/de';
import { browserPresenceTranslations as es } from './features/es';
import { browserPresenceTranslations as fr } from './features/fr';
import { browserPresenceTranslations as it } from './features/it';
import { browserPresenceTranslations as ja } from './features/ja';
import { browserPresenceTranslations as pl } from './features/pl';
import { browserPresenceTranslations as pt } from './features/pt';
import { browserPresenceTranslations as ru } from './features/ru';
import { browserPresenceTranslations as zh_Hans } from './features/zh-Hans';
import { browserPresenceTranslations as zh_Hant } from './features/zh-Hant';

export const browserPresenceTranslations = {
    ...en.browserPresenceTranslations,
    ...ca.browserPresenceTranslations,
    ...de.browserPresenceTranslations,
    ...es.browserPresenceTranslations,
    ...fr.browserPresenceTranslations,
    ...it.browserPresenceTranslations,
    ...ja.browserPresenceTranslations,
    ...pl.browserPresenceTranslations,
    ...pt.browserPresenceTranslations,
    ...ru.browserPresenceTranslations,
    ...zh_Hans.browserPresenceTranslations,
    ...zh_Hant.browserPresenceTranslations,
};
