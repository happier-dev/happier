// Tooling aggregate. Product locale roots import only their locale payload.
import { machinePoolTranslations as en } from './features/en';
import { machinePoolTranslations as ca } from './features/ca';
import { machinePoolTranslations as de } from './features/de';
import { machinePoolTranslations as es } from './features/es';
import { machinePoolTranslations as fr } from './features/fr';
import { machinePoolTranslations as it } from './features/it';
import { machinePoolTranslations as ja } from './features/ja';
import { machinePoolTranslations as pl } from './features/pl';
import { machinePoolTranslations as pt } from './features/pt';
import { machinePoolTranslations as ru } from './features/ru';
import { machinePoolTranslations as zh_Hans } from './features/zh-Hans';
import { machinePoolTranslations as zh_Hant } from './features/zh-Hant';

export const machinePoolTranslations = {
    ...en.machinePoolTranslations,
    ...ca.machinePoolTranslations,
    ...de.machinePoolTranslations,
    ...es.machinePoolTranslations,
    ...fr.machinePoolTranslations,
    ...it.machinePoolTranslations,
    ...ja.machinePoolTranslations,
    ...pl.machinePoolTranslations,
    ...pt.machinePoolTranslations,
    ...ru.machinePoolTranslations,
    ...zh_Hans.machinePoolTranslations,
    ...zh_Hant.machinePoolTranslations,
};
