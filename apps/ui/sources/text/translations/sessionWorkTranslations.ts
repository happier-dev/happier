// Tooling aggregate. Product locale roots import only their locale payload.
import { sessionWorkTranslations as en } from './features/en';
import { sessionWorkTranslations as ca } from './features/ca';
import { sessionWorkTranslations as de } from './features/de';
import { sessionWorkTranslations as es } from './features/es';
import { sessionWorkTranslations as fr } from './features/fr';
import { sessionWorkTranslations as it } from './features/it';
import { sessionWorkTranslations as ja } from './features/ja';
import { sessionWorkTranslations as pl } from './features/pl';
import { sessionWorkTranslations as pt } from './features/pt';
import { sessionWorkTranslations as ru } from './features/ru';
import { sessionWorkTranslations as zh_Hans } from './features/zh-Hans';
import { sessionWorkTranslations as zh_Hant } from './features/zh-Hant';

export const notify = {
    ...en.notify,
    ...ca.notify,
    ...de.notify,
    ...es.notify,
    ...fr.notify,
    ...it.notify,
    ...ja.notify,
    ...pl.notify,
    ...pt.notify,
    ...ru.notify,
    ...zh_Hans.notify,
    ...zh_Hant.notify,
};

export const runNotify = {
    ...en.runNotify,
    ...ca.runNotify,
    ...de.runNotify,
    ...es.runNotify,
    ...fr.runNotify,
    ...it.runNotify,
    ...ja.runNotify,
    ...pl.runNotify,
    ...pt.runNotify,
    ...ru.runNotify,
    ...zh_Hans.runNotify,
    ...zh_Hant.runNotify,
};

export const sessionWorkTranslations = {
    ...en.sessionWorkTranslations,
    ...ca.sessionWorkTranslations,
    ...de.sessionWorkTranslations,
    ...es.sessionWorkTranslations,
    ...fr.sessionWorkTranslations,
    ...it.sessionWorkTranslations,
    ...ja.sessionWorkTranslations,
    ...pl.sessionWorkTranslations,
    ...pt.sessionWorkTranslations,
    ...ru.sessionWorkTranslations,
    ...zh_Hans.sessionWorkTranslations,
    ...zh_Hant.sessionWorkTranslations,
};
