// Tooling aggregate. Product locale roots import only their locale payload.
import { workflowsDestinationTranslations as en } from './features/en';
import { workflowsDestinationTranslations as ca } from './features/ca';
import { workflowsDestinationTranslations as de } from './features/de';
import { workflowsDestinationTranslations as es } from './features/es';
import { workflowsDestinationTranslations as fr } from './features/fr';
import { workflowsDestinationTranslations as it } from './features/it';
import { workflowsDestinationTranslations as ja } from './features/ja';
import { workflowsDestinationTranslations as pl } from './features/pl';
import { workflowsDestinationTranslations as pt } from './features/pt';
import { workflowsDestinationTranslations as ru } from './features/ru';
import { workflowsDestinationTranslations as zh_Hans } from './features/zh-Hans';
import { workflowsDestinationTranslations as zh_Hant } from './features/zh-Hant';

export const workflowsDestinationTranslations = {
    ...en.workflowsDestinationTranslations,
    ...ca.workflowsDestinationTranslations,
    ...de.workflowsDestinationTranslations,
    ...es.workflowsDestinationTranslations,
    ...fr.workflowsDestinationTranslations,
    ...it.workflowsDestinationTranslations,
    ...ja.workflowsDestinationTranslations,
    ...pl.workflowsDestinationTranslations,
    ...pt.workflowsDestinationTranslations,
    ...ru.workflowsDestinationTranslations,
    ...zh_Hans.workflowsDestinationTranslations,
    ...zh_Hant.workflowsDestinationTranslations,
};
