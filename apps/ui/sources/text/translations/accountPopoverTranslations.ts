// Tooling aggregate. Product locale roots import only their locale payload.
import { accountPopoverTranslations as en } from './features/en';
import { accountPopoverTranslations as ca } from './features/ca';
import { accountPopoverTranslations as de } from './features/de';
import { accountPopoverTranslations as es } from './features/es';
import { accountPopoverTranslations as fr } from './features/fr';
import { accountPopoverTranslations as it } from './features/it';
import { accountPopoverTranslations as ja } from './features/ja';
import { accountPopoverTranslations as pl } from './features/pl';
import { accountPopoverTranslations as pt } from './features/pt';
import { accountPopoverTranslations as ru } from './features/ru';
import { accountPopoverTranslations as zh_Hans } from './features/zh-Hans';
import { accountPopoverTranslations as zh_Hant } from './features/zh-Hant';

export const accountPopoverTranslations = {
    ...en.accountPopoverTranslations,
    ...ca.accountPopoverTranslations,
    ...de.accountPopoverTranslations,
    ...es.accountPopoverTranslations,
    ...fr.accountPopoverTranslations,
    ...it.accountPopoverTranslations,
    ...ja.accountPopoverTranslations,
    ...pl.accountPopoverTranslations,
    ...pt.accountPopoverTranslations,
    ...ru.accountPopoverTranslations,
    ...zh_Hans.accountPopoverTranslations,
    ...zh_Hant.accountPopoverTranslations,
};
