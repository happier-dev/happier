// Tooling aggregate. Product locale roots import only their locale payload.
import { workflowFieldTranslations as en } from './features/en';
import { workflowFieldTranslations as ca } from './features/ca';
import { workflowFieldTranslations as de } from './features/de';
import { workflowFieldTranslations as es } from './features/es';
import { workflowFieldTranslations as fr } from './features/fr';
import { workflowFieldTranslations as it } from './features/it';
import { workflowFieldTranslations as ja } from './features/ja';
import { workflowFieldTranslations as pl } from './features/pl';
import { workflowFieldTranslations as pt } from './features/pt';
import { workflowFieldTranslations as ru } from './features/ru';
import { workflowFieldTranslations as zh_Hans } from './features/zh-Hans';
import { workflowFieldTranslations as zh_Hant } from './features/zh-Hant';

export const workflowFieldTranslations = {
    ...en.workflowFieldTranslations,
    ...ca.workflowFieldTranslations,
    ...de.workflowFieldTranslations,
    ...es.workflowFieldTranslations,
    ...fr.workflowFieldTranslations,
    ...it.workflowFieldTranslations,
    ...ja.workflowFieldTranslations,
    ...pl.workflowFieldTranslations,
    ...pt.workflowFieldTranslations,
    ...ru.workflowFieldTranslations,
    ...zh_Hans.workflowFieldTranslations,
    ...zh_Hant.workflowFieldTranslations,
};
