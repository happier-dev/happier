// Tooling aggregate. Product locale roots import only their locale payload.
import { connectedServicesCollectionTranslations as en } from './features/en';
import { connectedServicesCollectionTranslations as ca } from './features/ca';
import { connectedServicesCollectionTranslations as de } from './features/de';
import { connectedServicesCollectionTranslations as es } from './features/es';
import { connectedServicesCollectionTranslations as fr } from './features/fr';
import { connectedServicesCollectionTranslations as it } from './features/it';
import { connectedServicesCollectionTranslations as ja } from './features/ja';
import { connectedServicesCollectionTranslations as pl } from './features/pl';
import { connectedServicesCollectionTranslations as pt } from './features/pt';
import { connectedServicesCollectionTranslations as ru } from './features/ru';
import { connectedServicesCollectionTranslations as zh_Hans } from './features/zh-Hans';
import { connectedServicesCollectionTranslations as zh_Hant } from './features/zh-Hant';

export const connectedServicesCollectionTranslations = {
    ...en.connectedServicesCollectionTranslations,
    ...ca.connectedServicesCollectionTranslations,
    ...de.connectedServicesCollectionTranslations,
    ...es.connectedServicesCollectionTranslations,
    ...fr.connectedServicesCollectionTranslations,
    ...it.connectedServicesCollectionTranslations,
    ...ja.connectedServicesCollectionTranslations,
    ...pl.connectedServicesCollectionTranslations,
    ...pt.connectedServicesCollectionTranslations,
    ...ru.connectedServicesCollectionTranslations,
    ...zh_Hans.connectedServicesCollectionTranslations,
    ...zh_Hant.connectedServicesCollectionTranslations,
};
