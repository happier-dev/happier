// Tooling aggregate. Product locale roots import only their locale payload.
import { settingsMachinesTranslations as en } from './features/en';
import { settingsMachinesTranslations as ca } from './features/ca';
import { settingsMachinesTranslations as de } from './features/de';
import { settingsMachinesTranslations as es } from './features/es';
import { settingsMachinesTranslations as fr } from './features/fr';
import { settingsMachinesTranslations as it } from './features/it';
import { settingsMachinesTranslations as ja } from './features/ja';
import { settingsMachinesTranslations as pl } from './features/pl';
import { settingsMachinesTranslations as pt } from './features/pt';
import { settingsMachinesTranslations as ru } from './features/ru';
import { settingsMachinesTranslations as zh_Hans } from './features/zh-Hans';
import { settingsMachinesTranslations as zh_Hant } from './features/zh-Hant';

export const settingsMachinesTranslations = {
    ...en.settingsMachinesTranslations,
    ...ca.settingsMachinesTranslations,
    ...de.settingsMachinesTranslations,
    ...es.settingsMachinesTranslations,
    ...fr.settingsMachinesTranslations,
    ...it.settingsMachinesTranslations,
    ...ja.settingsMachinesTranslations,
    ...pl.settingsMachinesTranslations,
    ...pt.settingsMachinesTranslations,
    ...ru.settingsMachinesTranslations,
    ...zh_Hans.settingsMachinesTranslations,
    ...zh_Hant.settingsMachinesTranslations,
};
