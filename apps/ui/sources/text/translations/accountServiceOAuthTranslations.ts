// Tooling aggregate. Product locale roots import only their locale payload.
import { accountServiceOAuthTranslations as en } from './features/en';
import { accountServiceOAuthTranslations as ca } from './features/ca';
import { accountServiceOAuthTranslations as de } from './features/de';
import { accountServiceOAuthTranslations as es } from './features/es';
import { accountServiceOAuthTranslations as fr } from './features/fr';
import { accountServiceOAuthTranslations as it } from './features/it';
import { accountServiceOAuthTranslations as ja } from './features/ja';
import { accountServiceOAuthTranslations as pl } from './features/pl';
import { accountServiceOAuthTranslations as pt } from './features/pt';
import { accountServiceOAuthTranslations as ru } from './features/ru';
import { accountServiceOAuthTranslations as zh_Hans } from './features/zh-Hans';
import { accountServiceOAuthTranslations as zh_Hant } from './features/zh-Hant';

export const accountServiceOAuthTranslations = {
    ...en.accountServiceOAuthTranslations,
    ...ca.accountServiceOAuthTranslations,
    ...de.accountServiceOAuthTranslations,
    ...es.accountServiceOAuthTranslations,
    ...fr.accountServiceOAuthTranslations,
    ...it.accountServiceOAuthTranslations,
    ...ja.accountServiceOAuthTranslations,
    ...pl.accountServiceOAuthTranslations,
    ...pt.accountServiceOAuthTranslations,
    ...ru.accountServiceOAuthTranslations,
    ...zh_Hans.accountServiceOAuthTranslations,
    ...zh_Hant.accountServiceOAuthTranslations,
};
