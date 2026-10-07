// Tooling aggregate. Product locale roots import only their locale payload.
import { connectedServicesSetupTranslations as en } from './features/en';
import { connectedServicesSetupTranslations as ca } from './features/ca';
import { connectedServicesSetupTranslations as de } from './features/de';
import { connectedServicesSetupTranslations as es } from './features/es';
import { connectedServicesSetupTranslations as fr } from './features/fr';
import { connectedServicesSetupTranslations as it } from './features/it';
import { connectedServicesSetupTranslations as ja } from './features/ja';
import { connectedServicesSetupTranslations as pl } from './features/pl';
import { connectedServicesSetupTranslations as pt } from './features/pt';
import { connectedServicesSetupTranslations as ru } from './features/ru';
import { connectedServicesSetupTranslations as zh_Hans } from './features/zh-Hans';
import { connectedServicesSetupTranslations as zh_Hant } from './features/zh-Hant';

export const connectedServicesSetupTranslations = {
    ...en.connectedServicesSetupTranslations,
    ...ca.connectedServicesSetupTranslations,
    ...de.connectedServicesSetupTranslations,
    ...es.connectedServicesSetupTranslations,
    ...fr.connectedServicesSetupTranslations,
    ...it.connectedServicesSetupTranslations,
    ...ja.connectedServicesSetupTranslations,
    ...pl.connectedServicesSetupTranslations,
    ...pt.connectedServicesSetupTranslations,
    ...ru.connectedServicesSetupTranslations,
    ...zh_Hans.connectedServicesSetupTranslations,
    ...zh_Hant.connectedServicesSetupTranslations,
};
