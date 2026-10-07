// Tooling aggregate. Product locale roots import only their locale payload.
import { providerSessionTranslations as ca } from './features/ca';
import { providerSessionTranslations as es } from './features/es';
import { providerSessionTranslations as fr } from './features/fr';
import { providerSessionTranslations as it } from './features/it';
import { providerSessionTranslations as ja } from './features/ja';
import { providerSessionTranslations as pl } from './features/pl';
import { providerSessionTranslations as pt } from './features/pt';
import { providerSessionTranslations as ru } from './features/ru';
import { providerSessionTranslations as zh_Hans } from './features/zh-Hans';
import { providerSessionTranslations as zh_Hant } from './features/zh-Hant';

export const providerSessionTranslations = {
    ...ca.providerSessionTranslations,
    ...es.providerSessionTranslations,
    ...fr.providerSessionTranslations,
    ...it.providerSessionTranslations,
    ...ja.providerSessionTranslations,
    ...pl.providerSessionTranslations,
    ...pt.providerSessionTranslations,
    ...ru.providerSessionTranslations,
    ...zh_Hans.providerSessionTranslations,
    ...zh_Hant.providerSessionTranslations,
};
