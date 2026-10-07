// Tooling aggregate. Product locale roots import only their locale payload.
import { sessionConversationSurfaceTranslations as en } from './features/en';
import { sessionConversationSurfaceTranslations as ca } from './features/ca';
import { sessionConversationSurfaceTranslations as de } from './features/de';
import { sessionConversationSurfaceTranslations as es } from './features/es';
import { sessionConversationSurfaceTranslations as fr } from './features/fr';
import { sessionConversationSurfaceTranslations as it } from './features/it';
import { sessionConversationSurfaceTranslations as ja } from './features/ja';
import { sessionConversationSurfaceTranslations as pl } from './features/pl';
import { sessionConversationSurfaceTranslations as pt } from './features/pt';
import { sessionConversationSurfaceTranslations as ru } from './features/ru';
import { sessionConversationSurfaceTranslations as zh_Hans } from './features/zh-Hans';
import { sessionConversationSurfaceTranslations as zh_Hant } from './features/zh-Hant';

export const sessionConversationSurfaceTranslations = {
    ...en.sessionConversationSurfaceTranslations,
    ...ca.sessionConversationSurfaceTranslations,
    ...de.sessionConversationSurfaceTranslations,
    ...es.sessionConversationSurfaceTranslations,
    ...fr.sessionConversationSurfaceTranslations,
    ...it.sessionConversationSurfaceTranslations,
    ...ja.sessionConversationSurfaceTranslations,
    ...pl.sessionConversationSurfaceTranslations,
    ...pt.sessionConversationSurfaceTranslations,
    ...ru.sessionConversationSurfaceTranslations,
    ...zh_Hans.sessionConversationSurfaceTranslations,
    ...zh_Hant.sessionConversationSurfaceTranslations,
};
