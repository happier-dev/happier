// Tooling aggregate. Product locale roots import only their locale payload.
import { actionConfirmationTranslations as en } from './features/en';
import { actionConfirmationTranslations as ca } from './features/ca';
import { actionConfirmationTranslations as de } from './features/de';
import { actionConfirmationTranslations as es } from './features/es';
import { actionConfirmationTranslations as fr } from './features/fr';
import { actionConfirmationTranslations as it } from './features/it';
import { actionConfirmationTranslations as ja } from './features/ja';
import { actionConfirmationTranslations as pl } from './features/pl';
import { actionConfirmationTranslations as pt } from './features/pt';
import { actionConfirmationTranslations as ru } from './features/ru';
import { actionConfirmationTranslations as zh_Hans } from './features/zh-Hans';
import { actionConfirmationTranslations as zh_Hant } from './features/zh-Hant';

export const actionConfirmationTranslations = {
    ...en.actionConfirmationTranslations,
    ...ca.actionConfirmationTranslations,
    ...de.actionConfirmationTranslations,
    ...es.actionConfirmationTranslations,
    ...fr.actionConfirmationTranslations,
    ...it.actionConfirmationTranslations,
    ...ja.actionConfirmationTranslations,
    ...pl.actionConfirmationTranslations,
    ...pt.actionConfirmationTranslations,
    ...ru.actionConfirmationTranslations,
    ...zh_Hans.actionConfirmationTranslations,
    ...zh_Hant.actionConfirmationTranslations,
};
