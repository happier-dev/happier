// Tooling aggregate. Product locale roots import only their locale payload.
import { sessionReminderTranslations as en } from './features/en';
import { sessionReminderTranslations as ca } from './features/ca';
import { sessionReminderTranslations as de } from './features/de';
import { sessionReminderTranslations as es } from './features/es';
import { sessionReminderTranslations as fr } from './features/fr';
import { sessionReminderTranslations as it } from './features/it';
import { sessionReminderTranslations as ja } from './features/ja';
import { sessionReminderTranslations as pl } from './features/pl';
import { sessionReminderTranslations as pt } from './features/pt';
import { sessionReminderTranslations as ru } from './features/ru';
import { sessionReminderTranslations as zh_Hans } from './features/zh-Hans';
import { sessionReminderTranslations as zh_Hant } from './features/zh-Hant';

export const sessionReminderTranslations = {
    ...en.sessionReminderTranslations,
    ...ca.sessionReminderTranslations,
    ...de.sessionReminderTranslations,
    ...es.sessionReminderTranslations,
    ...fr.sessionReminderTranslations,
    ...it.sessionReminderTranslations,
    ...ja.sessionReminderTranslations,
    ...pl.sessionReminderTranslations,
    ...pt.sessionReminderTranslations,
    ...ru.sessionReminderTranslations,
    ...zh_Hans.sessionReminderTranslations,
    ...zh_Hant.sessionReminderTranslations,
};
