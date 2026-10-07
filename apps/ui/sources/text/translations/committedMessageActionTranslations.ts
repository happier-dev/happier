// Tooling aggregate. Product locale roots import only their locale payload.
import { committedMessageActionTranslations as en } from './features/en';
import { committedMessageActionTranslations as ca } from './features/ca';
import { committedMessageActionTranslations as de } from './features/de';
import { committedMessageActionTranslations as es } from './features/es';
import { committedMessageActionTranslations as fr } from './features/fr';
import { committedMessageActionTranslations as it } from './features/it';
import { committedMessageActionTranslations as ja } from './features/ja';
import { committedMessageActionTranslations as pl } from './features/pl';
import { committedMessageActionTranslations as pt } from './features/pt';
import { committedMessageActionTranslations as ru } from './features/ru';
import { committedMessageActionTranslations as zh_Hans } from './features/zh-Hans';
import { committedMessageActionTranslations as zh_Hant } from './features/zh-Hant';

export const committedMessageActionTranslations = {
    ...en.committedMessageActionTranslations,
    ...ca.committedMessageActionTranslations,
    ...de.committedMessageActionTranslations,
    ...es.committedMessageActionTranslations,
    ...fr.committedMessageActionTranslations,
    ...it.committedMessageActionTranslations,
    ...ja.committedMessageActionTranslations,
    ...pl.committedMessageActionTranslations,
    ...pt.committedMessageActionTranslations,
    ...ru.committedMessageActionTranslations,
    ...zh_Hans.committedMessageActionTranslations,
    ...zh_Hant.committedMessageActionTranslations,
};
