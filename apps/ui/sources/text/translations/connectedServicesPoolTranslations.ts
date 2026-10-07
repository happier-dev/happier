// Tooling aggregate. Product locale roots import only their locale payload.
import { connectedServicesPoolTranslations as en } from './features/en';
import { connectedServicesPoolTranslations as ca } from './features/ca';
import { connectedServicesPoolTranslations as de } from './features/de';
import { connectedServicesPoolTranslations as es } from './features/es';
import { connectedServicesPoolTranslations as fr } from './features/fr';
import { connectedServicesPoolTranslations as it } from './features/it';
import { connectedServicesPoolTranslations as ja } from './features/ja';
import { connectedServicesPoolTranslations as pl } from './features/pl';
import { connectedServicesPoolTranslations as pt } from './features/pt';
import { connectedServicesPoolTranslations as ru } from './features/ru';
import { connectedServicesPoolTranslations as zh_Hans } from './features/zh-Hans';
import { connectedServicesPoolTranslations as zh_Hant } from './features/zh-Hant';

export const connectedServicesPoolTranslations = {
    ...en.connectedServicesPoolTranslations,
    ...ca.connectedServicesPoolTranslations,
    ...de.connectedServicesPoolTranslations,
    ...es.connectedServicesPoolTranslations,
    ...fr.connectedServicesPoolTranslations,
    ...it.connectedServicesPoolTranslations,
    ...ja.connectedServicesPoolTranslations,
    ...pl.connectedServicesPoolTranslations,
    ...pt.connectedServicesPoolTranslations,
    ...ru.connectedServicesPoolTranslations,
    ...zh_Hans.connectedServicesPoolTranslations,
    ...zh_Hant.connectedServicesPoolTranslations,
};
