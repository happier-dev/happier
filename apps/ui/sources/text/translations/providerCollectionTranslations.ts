// Tooling aggregate. Product locale roots import only their locale payload.
import { providerCollectionTranslations as en } from './features/en';
import { providerCollectionTranslations as ca } from './features/ca';
import { providerCollectionTranslations as de } from './features/de';
import { providerCollectionTranslations as es } from './features/es';
import { providerCollectionTranslations as fr } from './features/fr';
import { providerCollectionTranslations as it } from './features/it';
import { providerCollectionTranslations as ja } from './features/ja';
import { providerCollectionTranslations as pl } from './features/pl';
import { providerCollectionTranslations as pt } from './features/pt';
import { providerCollectionTranslations as ru } from './features/ru';
import { providerCollectionTranslations as zh_Hans } from './features/zh-Hans';
import { providerCollectionTranslations as zh_Hant } from './features/zh-Hant';

export const providerCollectionTranslations = {
    ...en.providerCollectionTranslations,
    ...ca.providerCollectionTranslations,
    ...de.providerCollectionTranslations,
    ...es.providerCollectionTranslations,
    ...fr.providerCollectionTranslations,
    ...it.providerCollectionTranslations,
    ...ja.providerCollectionTranslations,
    ...pl.providerCollectionTranslations,
    ...pt.providerCollectionTranslations,
    ...ru.providerCollectionTranslations,
    ...zh_Hans.providerCollectionTranslations,
    ...zh_Hant.providerCollectionTranslations,
};
