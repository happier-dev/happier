// Tooling aggregate. Product locale roots import only their locale payload.
import { cliPathExposureTranslations as en } from './features/en';
import { cliPathExposureTranslations as ca } from './features/ca';
import { cliPathExposureTranslations as de } from './features/de';
import { cliPathExposureTranslations as es } from './features/es';
import { cliPathExposureTranslations as fr } from './features/fr';
import { cliPathExposureTranslations as it } from './features/it';
import { cliPathExposureTranslations as ja } from './features/ja';
import { cliPathExposureTranslations as pl } from './features/pl';
import { cliPathExposureTranslations as pt } from './features/pt';
import { cliPathExposureTranslations as ru } from './features/ru';
import { cliPathExposureTranslations as zh_Hans } from './features/zh-Hans';
import { cliPathExposureTranslations as zh_Hant } from './features/zh-Hant';

export const cliPathExposureTranslations = {
    ...en.cliPathExposureTranslations,
    ...ca.cliPathExposureTranslations,
    ...de.cliPathExposureTranslations,
    ...es.cliPathExposureTranslations,
    ...fr.cliPathExposureTranslations,
    ...it.cliPathExposureTranslations,
    ...ja.cliPathExposureTranslations,
    ...pl.cliPathExposureTranslations,
    ...pt.cliPathExposureTranslations,
    ...ru.cliPathExposureTranslations,
    ...zh_Hans.cliPathExposureTranslations,
    ...zh_Hant.cliPathExposureTranslations,
};
