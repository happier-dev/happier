// Tooling aggregate. Product locale roots import only their locale payload.
import { accountDisplayTranslations as en } from './features/en';
import { accountDisplayTranslations as ca } from './features/ca';
import { accountDisplayTranslations as de } from './features/de';
import { accountDisplayTranslations as es } from './features/es';
import { accountDisplayTranslations as fr } from './features/fr';
import { accountDisplayTranslations as it } from './features/it';
import { accountDisplayTranslations as ja } from './features/ja';
import { accountDisplayTranslations as pl } from './features/pl';
import { accountDisplayTranslations as pt } from './features/pt';
import { accountDisplayTranslations as ru } from './features/ru';
import { accountDisplayTranslations as zh_Hans } from './features/zh-Hans';
import { accountDisplayTranslations as zh_Hant } from './features/zh-Hant';

export const accountDisplayTranslations = {
    ...en.accountDisplayTranslations,
    ...ca.accountDisplayTranslations,
    ...de.accountDisplayTranslations,
    ...es.accountDisplayTranslations,
    ...fr.accountDisplayTranslations,
    ...it.accountDisplayTranslations,
    ...ja.accountDisplayTranslations,
    ...pl.accountDisplayTranslations,
    ...pt.accountDisplayTranslations,
    ...ru.accountDisplayTranslations,
    ...zh_Hans.accountDisplayTranslations,
    ...zh_Hant.accountDisplayTranslations,
};
