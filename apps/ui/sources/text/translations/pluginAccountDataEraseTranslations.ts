// Tooling aggregate. Product locale roots import only their locale payload.
import { pluginAccountDataEraseTranslations as en } from './features/en';
import { pluginAccountDataEraseTranslations as ca } from './features/ca';
import { pluginAccountDataEraseTranslations as de } from './features/de';
import { pluginAccountDataEraseTranslations as es } from './features/es';
import { pluginAccountDataEraseTranslations as fr } from './features/fr';
import { pluginAccountDataEraseTranslations as it } from './features/it';
import { pluginAccountDataEraseTranslations as ja } from './features/ja';
import { pluginAccountDataEraseTranslations as pl } from './features/pl';
import { pluginAccountDataEraseTranslations as pt } from './features/pt';
import { pluginAccountDataEraseTranslations as ru } from './features/ru';
import { pluginAccountDataEraseTranslations as zh_Hans } from './features/zh-Hans';
import { pluginAccountDataEraseTranslations as zh_Hant } from './features/zh-Hant';

export const pluginAccountDataEraseTranslations = {
    ...en.pluginAccountDataEraseTranslations,
    ...ca.pluginAccountDataEraseTranslations,
    ...de.pluginAccountDataEraseTranslations,
    ...es.pluginAccountDataEraseTranslations,
    ...fr.pluginAccountDataEraseTranslations,
    ...it.pluginAccountDataEraseTranslations,
    ...ja.pluginAccountDataEraseTranslations,
    ...pl.pluginAccountDataEraseTranslations,
    ...pt.pluginAccountDataEraseTranslations,
    ...ru.pluginAccountDataEraseTranslations,
    ...zh_Hans.pluginAccountDataEraseTranslations,
    ...zh_Hant.pluginAccountDataEraseTranslations,
};
