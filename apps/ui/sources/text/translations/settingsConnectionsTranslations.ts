// Tooling aggregate. Product locale roots import only their locale payload.
import { settingsConnectionsTranslations as en } from './features/en';
import { settingsConnectionsTranslations as ca } from './features/ca';
import { settingsConnectionsTranslations as de } from './features/de';
import { settingsConnectionsTranslations as es } from './features/es';
import { settingsConnectionsTranslations as fr } from './features/fr';
import { settingsConnectionsTranslations as it } from './features/it';
import { settingsConnectionsTranslations as ja } from './features/ja';
import { settingsConnectionsTranslations as pl } from './features/pl';
import { settingsConnectionsTranslations as pt } from './features/pt';
import { settingsConnectionsTranslations as ru } from './features/ru';
import { settingsConnectionsTranslations as zh_Hans } from './features/zh-Hans';
import { settingsConnectionsTranslations as zh_Hant } from './features/zh-Hant';

export const settingsConnectionsTranslations = {
    ...en.settingsConnectionsTranslations,
    ...ca.settingsConnectionsTranslations,
    ...de.settingsConnectionsTranslations,
    ...es.settingsConnectionsTranslations,
    ...fr.settingsConnectionsTranslations,
    ...it.settingsConnectionsTranslations,
    ...ja.settingsConnectionsTranslations,
    ...pl.settingsConnectionsTranslations,
    ...pt.settingsConnectionsTranslations,
    ...ru.settingsConnectionsTranslations,
    ...zh_Hans.settingsConnectionsTranslations,
    ...zh_Hant.settingsConnectionsTranslations,
};
