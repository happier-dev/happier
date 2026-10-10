// Tooling aggregate. Product locale roots import only their locale payload.
import { thisComputerConnectionTranslations as en } from './features/en';
import { thisComputerConnectionTranslations as ca } from './features/ca';
import { thisComputerConnectionTranslations as de } from './features/de';
import { thisComputerConnectionTranslations as es } from './features/es';
import { thisComputerConnectionTranslations as fr } from './features/fr';
import { thisComputerConnectionTranslations as it } from './features/it';
import { thisComputerConnectionTranslations as ja } from './features/ja';
import { thisComputerConnectionTranslations as pl } from './features/pl';
import { thisComputerConnectionTranslations as pt } from './features/pt';
import { thisComputerConnectionTranslations as ru } from './features/ru';
import { thisComputerConnectionTranslations as zh_Hans } from './features/zh-Hans';
import { thisComputerConnectionTranslations as zh_Hant } from './features/zh-Hant';
export type { ThisComputerConnectionTranslation } from './thisComputerConnectionTranslations.shared';

export const thisComputerConnectionTranslations = {
    ...en.thisComputerConnectionTranslations,
    ...ca.thisComputerConnectionTranslations,
    ...de.thisComputerConnectionTranslations,
    ...es.thisComputerConnectionTranslations,
    ...fr.thisComputerConnectionTranslations,
    ...it.thisComputerConnectionTranslations,
    ...ja.thisComputerConnectionTranslations,
    ...pl.thisComputerConnectionTranslations,
    ...pt.thisComputerConnectionTranslations,
    ...ru.thisComputerConnectionTranslations,
    ...zh_Hans.thisComputerConnectionTranslations,
    ...zh_Hant.thisComputerConnectionTranslations,
};
