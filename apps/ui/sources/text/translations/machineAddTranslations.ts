// Tooling aggregate. Product locale roots import only their locale payload.
import { machineAddTranslations as en } from './features/en';
import { machineAddTranslations as ca } from './features/ca';
import { machineAddTranslations as de } from './features/de';
import { machineAddTranslations as es } from './features/es';
import { machineAddTranslations as fr } from './features/fr';
import { machineAddTranslations as it } from './features/it';
import { machineAddTranslations as ja } from './features/ja';
import { machineAddTranslations as pl } from './features/pl';
import { machineAddTranslations as pt } from './features/pt';
import { machineAddTranslations as ru } from './features/ru';
import { machineAddTranslations as zh_Hans } from './features/zh-Hans';
import { machineAddTranslations as zh_Hant } from './features/zh-Hant';

export const machineAddTranslations = {
    ...en.machineAddTranslations,
    ...ca.machineAddTranslations,
    ...de.machineAddTranslations,
    ...es.machineAddTranslations,
    ...fr.machineAddTranslations,
    ...it.machineAddTranslations,
    ...ja.machineAddTranslations,
    ...pl.machineAddTranslations,
    ...pt.machineAddTranslations,
    ...ru.machineAddTranslations,
    ...zh_Hans.machineAddTranslations,
    ...zh_Hant.machineAddTranslations,
};
