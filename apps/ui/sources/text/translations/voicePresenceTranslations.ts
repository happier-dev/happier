// Tooling aggregate. Product locale roots import only their locale payload.
import { voicePresenceTranslations as en } from './features/en';
import { voicePresenceTranslations as ca } from './features/ca';
import { voicePresenceTranslations as de } from './features/de';
import { voicePresenceTranslations as es } from './features/es';
import { voicePresenceTranslations as fr } from './features/fr';
import { voicePresenceTranslations as it } from './features/it';
import { voicePresenceTranslations as ja } from './features/ja';
import { voicePresenceTranslations as pl } from './features/pl';
import { voicePresenceTranslations as pt } from './features/pt';
import { voicePresenceTranslations as ru } from './features/ru';
import { voicePresenceTranslations as zh_Hans } from './features/zh-Hans';
import { voicePresenceTranslations as zh_Hant } from './features/zh-Hant';

export const voicePresenceTranslations = {
    ...en.voicePresenceTranslations,
    ...ca.voicePresenceTranslations,
    ...de.voicePresenceTranslations,
    ...es.voicePresenceTranslations,
    ...fr.voicePresenceTranslations,
    ...it.voicePresenceTranslations,
    ...ja.voicePresenceTranslations,
    ...pl.voicePresenceTranslations,
    ...pt.voicePresenceTranslations,
    ...ru.voicePresenceTranslations,
    ...zh_Hans.voicePresenceTranslations,
    ...zh_Hant.voicePresenceTranslations,
};
