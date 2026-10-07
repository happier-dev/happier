// Tooling aggregate. Product locale roots import only their locale payload.
import { workflowRunVisibilityTranslations as en } from './features/en';
import { workflowRunVisibilityTranslations as ca } from './features/ca';
import { workflowRunVisibilityTranslations as de } from './features/de';
import { workflowRunVisibilityTranslations as es } from './features/es';
import { workflowRunVisibilityTranslations as fr } from './features/fr';
import { workflowRunVisibilityTranslations as it } from './features/it';
import { workflowRunVisibilityTranslations as ja } from './features/ja';
import { workflowRunVisibilityTranslations as pl } from './features/pl';
import { workflowRunVisibilityTranslations as pt } from './features/pt';
import { workflowRunVisibilityTranslations as ru } from './features/ru';
import { workflowRunVisibilityTranslations as zh_Hans } from './features/zh-Hans';
import { workflowRunVisibilityTranslations as zh_Hant } from './features/zh-Hant';

export const workflowRunVisibilityTranslations = {
    ...en.workflowRunVisibilityTranslations,
    ...ca.workflowRunVisibilityTranslations,
    ...de.workflowRunVisibilityTranslations,
    ...es.workflowRunVisibilityTranslations,
    ...fr.workflowRunVisibilityTranslations,
    ...it.workflowRunVisibilityTranslations,
    ...ja.workflowRunVisibilityTranslations,
    ...pl.workflowRunVisibilityTranslations,
    ...pt.workflowRunVisibilityTranslations,
    ...ru.workflowRunVisibilityTranslations,
    ...zh_Hans.workflowRunVisibilityTranslations,
    ...zh_Hant.workflowRunVisibilityTranslations,
};
