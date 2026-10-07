// Tooling aggregate. Product locale roots import only their locale payload.
import { machineAgentsTranslations as en } from './features/en';
import { machineAgentsTranslations as ca } from './features/ca';
import { machineAgentsTranslations as de } from './features/de';
import { machineAgentsTranslations as es } from './features/es';
import { machineAgentsTranslations as fr } from './features/fr';
import { machineAgentsTranslations as it } from './features/it';
import { machineAgentsTranslations as ja } from './features/ja';
import { machineAgentsTranslations as pl } from './features/pl';
import { machineAgentsTranslations as pt } from './features/pt';
import { machineAgentsTranslations as ru } from './features/ru';
import { machineAgentsTranslations as zh_Hans } from './features/zh-Hans';
import { machineAgentsTranslations as zh_Hant } from './features/zh-Hant';

export const machineAgentsTranslations = {
    ...en.machineAgentsTranslations,
    ...ca.machineAgentsTranslations,
    ...de.machineAgentsTranslations,
    ...es.machineAgentsTranslations,
    ...fr.machineAgentsTranslations,
    ...it.machineAgentsTranslations,
    ...ja.machineAgentsTranslations,
    ...pl.machineAgentsTranslations,
    ...pt.machineAgentsTranslations,
    ...ru.machineAgentsTranslations,
    ...zh_Hans.machineAgentsTranslations,
    ...zh_Hant.machineAgentsTranslations,
};
