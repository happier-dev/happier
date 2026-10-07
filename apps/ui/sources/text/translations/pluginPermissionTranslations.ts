// Tooling aggregate. Product locale roots import only their locale payload.
import { pluginPermissionTranslations as en } from './features/en';
import { pluginPermissionTranslations as ca } from './features/ca';
import { pluginPermissionTranslations as de } from './features/de';
import { pluginPermissionTranslations as es } from './features/es';
import { pluginPermissionTranslations as fr } from './features/fr';
import { pluginPermissionTranslations as it } from './features/it';
import { pluginPermissionTranslations as ja } from './features/ja';
import { pluginPermissionTranslations as pl } from './features/pl';
import { pluginPermissionTranslations as pt } from './features/pt';
import { pluginPermissionTranslations as ru } from './features/ru';
import { pluginPermissionTranslations as zh_Hans } from './features/zh-Hans';
import { pluginPermissionTranslations as zh_Hant } from './features/zh-Hant';

export const pluginPermissionTranslations = {
    ...en.pluginPermissionTranslations,
    ...ca.pluginPermissionTranslations,
    ...de.pluginPermissionTranslations,
    ...es.pluginPermissionTranslations,
    ...fr.pluginPermissionTranslations,
    ...it.pluginPermissionTranslations,
    ...ja.pluginPermissionTranslations,
    ...pl.pluginPermissionTranslations,
    ...pt.pluginPermissionTranslations,
    ...ru.pluginPermissionTranslations,
    ...zh_Hans.pluginPermissionTranslations,
    ...zh_Hant.pluginPermissionTranslations,
};
