// Tooling aggregate. Product locale roots import only their locale payload.
import { cliTrustPromptTranslations as en } from './features/en';
import { cliTrustPromptTranslations as ca } from './features/ca';
import { cliTrustPromptTranslations as de } from './features/de';
import { cliTrustPromptTranslations as es } from './features/es';
import { cliTrustPromptTranslations as fr } from './features/fr';
import { cliTrustPromptTranslations as it } from './features/it';
import { cliTrustPromptTranslations as ja } from './features/ja';
import { cliTrustPromptTranslations as pl } from './features/pl';
import { cliTrustPromptTranslations as pt } from './features/pt';
import { cliTrustPromptTranslations as ru } from './features/ru';
import { cliTrustPromptTranslations as zh_Hans } from './features/zh-Hans';
import { cliTrustPromptTranslations as zh_Hant } from './features/zh-Hant';

export const cliTrustPromptTranslations = {
    ...en.cliTrustPromptTranslations,
    ...ca.cliTrustPromptTranslations,
    ...de.cliTrustPromptTranslations,
    ...es.cliTrustPromptTranslations,
    ...fr.cliTrustPromptTranslations,
    ...it.cliTrustPromptTranslations,
    ...ja.cliTrustPromptTranslations,
    ...pl.cliTrustPromptTranslations,
    ...pt.cliTrustPromptTranslations,
    ...ru.cliTrustPromptTranslations,
    ...zh_Hans.cliTrustPromptTranslations,
    ...zh_Hant.cliTrustPromptTranslations,
};
