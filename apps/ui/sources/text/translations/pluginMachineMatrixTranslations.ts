// Tooling aggregate. Product locale roots import only their locale payload.
import { pluginMachineMatrixTranslations as en } from './features/en';
import { pluginMachineMatrixTranslations as ca } from './features/ca';
import { pluginMachineMatrixTranslations as de } from './features/de';
import { pluginMachineMatrixTranslations as es } from './features/es';
import { pluginMachineMatrixTranslations as fr } from './features/fr';
import { pluginMachineMatrixTranslations as it } from './features/it';
import { pluginMachineMatrixTranslations as ja } from './features/ja';
import { pluginMachineMatrixTranslations as pl } from './features/pl';
import { pluginMachineMatrixTranslations as pt } from './features/pt';
import { pluginMachineMatrixTranslations as ru } from './features/ru';
import { pluginMachineMatrixTranslations as zh_Hans } from './features/zh-Hans';
import { pluginMachineMatrixTranslations as zh_Hant } from './features/zh-Hant';

export const pluginMachineMatrixTranslations = {
    ...en.pluginMachineMatrixTranslations,
    ...ca.pluginMachineMatrixTranslations,
    ...de.pluginMachineMatrixTranslations,
    ...es.pluginMachineMatrixTranslations,
    ...fr.pluginMachineMatrixTranslations,
    ...it.pluginMachineMatrixTranslations,
    ...ja.pluginMachineMatrixTranslations,
    ...pl.pluginMachineMatrixTranslations,
    ...pt.pluginMachineMatrixTranslations,
    ...ru.pluginMachineMatrixTranslations,
    ...zh_Hans.pluginMachineMatrixTranslations,
    ...zh_Hant.pluginMachineMatrixTranslations,
};
