// Tooling aggregate. Product locale roots import only their locale payload.
import { sessionMessageAccountActorTranslations as en } from './features/en';
import { sessionMessageAccountActorTranslations as ca } from './features/ca';
import { sessionMessageAccountActorTranslations as de } from './features/de';
import { sessionMessageAccountActorTranslations as es } from './features/es';
import { sessionMessageAccountActorTranslations as fr } from './features/fr';
import { sessionMessageAccountActorTranslations as it } from './features/it';
import { sessionMessageAccountActorTranslations as ja } from './features/ja';
import { sessionMessageAccountActorTranslations as pl } from './features/pl';
import { sessionMessageAccountActorTranslations as pt } from './features/pt';
import { sessionMessageAccountActorTranslations as ru } from './features/ru';
import { sessionMessageAccountActorTranslations as zh_Hans } from './features/zh-Hans';
import { sessionMessageAccountActorTranslations as zh_Hant } from './features/zh-Hant';

export const sessionMessageAccountActorTranslations = {
    ...en.sessionMessageAccountActorTranslations,
    ...ca.sessionMessageAccountActorTranslations,
    ...de.sessionMessageAccountActorTranslations,
    ...es.sessionMessageAccountActorTranslations,
    ...fr.sessionMessageAccountActorTranslations,
    ...it.sessionMessageAccountActorTranslations,
    ...ja.sessionMessageAccountActorTranslations,
    ...pl.sessionMessageAccountActorTranslations,
    ...pt.sessionMessageAccountActorTranslations,
    ...ru.sessionMessageAccountActorTranslations,
    ...zh_Hans.sessionMessageAccountActorTranslations,
    ...zh_Hant.sessionMessageAccountActorTranslations,
};
