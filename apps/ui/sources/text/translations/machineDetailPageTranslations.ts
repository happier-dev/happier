// Tooling aggregate. Product locale roots import only their locale payload.
import { machineDetailPageTranslations as en } from './features/en';
import { machineDetailPageTranslations as ca } from './features/ca';
import { machineDetailPageTranslations as de } from './features/de';
import { machineDetailPageTranslations as es } from './features/es';
import { machineDetailPageTranslations as fr } from './features/fr';
import { machineDetailPageTranslations as it } from './features/it';
import { machineDetailPageTranslations as ja } from './features/ja';
import { machineDetailPageTranslations as pl } from './features/pl';
import { machineDetailPageTranslations as pt } from './features/pt';
import { machineDetailPageTranslations as ru } from './features/ru';
import { machineDetailPageTranslations as zh_Hans } from './features/zh-Hans';
import { machineDetailPageTranslations as zh_Hant } from './features/zh-Hant';

export const machineDetailPageTranslations = {
    ...en.machineDetailPageTranslations,
    ...ca.machineDetailPageTranslations,
    ...de.machineDetailPageTranslations,
    ...es.machineDetailPageTranslations,
    ...fr.machineDetailPageTranslations,
    ...it.machineDetailPageTranslations,
    ...ja.machineDetailPageTranslations,
    ...pl.machineDetailPageTranslations,
    ...pt.machineDetailPageTranslations,
    ...ru.machineDetailPageTranslations,
    ...zh_Hans.machineDetailPageTranslations,
    ...zh_Hant.machineDetailPageTranslations,
};
