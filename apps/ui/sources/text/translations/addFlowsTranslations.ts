// Tooling aggregate. Product locale roots import only their locale payload.
import { addFlowsTranslations as en } from './features/en';
import { addFlowsTranslations as ca } from './features/ca';
import { addFlowsTranslations as de } from './features/de';
import { addFlowsTranslations as es } from './features/es';
import { addFlowsTranslations as fr } from './features/fr';
import { addFlowsTranslations as it } from './features/it';
import { addFlowsTranslations as ja } from './features/ja';
import { addFlowsTranslations as pl } from './features/pl';
import { addFlowsTranslations as pt } from './features/pt';
import { addFlowsTranslations as ru } from './features/ru';
import { addFlowsTranslations as zh_Hans } from './features/zh-Hans';
import { addFlowsTranslations as zh_Hant } from './features/zh-Hant';

export const addFlowsTranslations = {
    ...en.addFlowsTranslations,
    ...ca.addFlowsTranslations,
    ...de.addFlowsTranslations,
    ...es.addFlowsTranslations,
    ...fr.addFlowsTranslations,
    ...it.addFlowsTranslations,
    ...ja.addFlowsTranslations,
    ...pl.addFlowsTranslations,
    ...pt.addFlowsTranslations,
    ...ru.addFlowsTranslations,
    ...zh_Hans.addFlowsTranslations,
    ...zh_Hant.addFlowsTranslations,
};
