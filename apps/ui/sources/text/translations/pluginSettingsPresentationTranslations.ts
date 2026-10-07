// Tooling aggregate. Product locale roots import only their locale payload.
import { pluginSettingsPresentationTranslations as en } from './features/en';
import { pluginSettingsPresentationTranslations as ca } from './features/ca';
import { pluginSettingsPresentationTranslations as de } from './features/de';
import { pluginSettingsPresentationTranslations as es } from './features/es';
import { pluginSettingsPresentationTranslations as fr } from './features/fr';
import { pluginSettingsPresentationTranslations as it } from './features/it';
import { pluginSettingsPresentationTranslations as ja } from './features/ja';
import { pluginSettingsPresentationTranslations as pl } from './features/pl';
import { pluginSettingsPresentationTranslations as pt } from './features/pt';
import { pluginSettingsPresentationTranslations as ru } from './features/ru';
import { pluginSettingsPresentationTranslations as zh_Hans } from './features/zh-Hans';
import { pluginSettingsPresentationTranslations as zh_Hant } from './features/zh-Hant';

export const pluginSettingsPresentationTranslations = {
    ...en.pluginSettingsPresentationTranslations,
    ...ca.pluginSettingsPresentationTranslations,
    ...de.pluginSettingsPresentationTranslations,
    ...es.pluginSettingsPresentationTranslations,
    ...fr.pluginSettingsPresentationTranslations,
    ...it.pluginSettingsPresentationTranslations,
    ...ja.pluginSettingsPresentationTranslations,
    ...pl.pluginSettingsPresentationTranslations,
    ...pt.pluginSettingsPresentationTranslations,
    ...ru.pluginSettingsPresentationTranslations,
    ...zh_Hans.pluginSettingsPresentationTranslations,
    ...zh_Hant.pluginSettingsPresentationTranslations,
};
