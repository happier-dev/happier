// Tooling aggregate. Product locale roots import only their locale payload.
import { workflowAgentAuthoringTranslations as en } from './features/en';
import { workflowAgentAuthoringTranslations as ca } from './features/ca';
import { workflowAgentAuthoringTranslations as de } from './features/de';
import { workflowAgentAuthoringTranslations as es } from './features/es';
import { workflowAgentAuthoringTranslations as fr } from './features/fr';
import { workflowAgentAuthoringTranslations as it } from './features/it';
import { workflowAgentAuthoringTranslations as ja } from './features/ja';
import { workflowAgentAuthoringTranslations as pl } from './features/pl';
import { workflowAgentAuthoringTranslations as pt } from './features/pt';
import { workflowAgentAuthoringTranslations as ru } from './features/ru';
import { workflowAgentAuthoringTranslations as zh_Hans } from './features/zh-Hans';
import { workflowAgentAuthoringTranslations as zh_Hant } from './features/zh-Hant';

export const repeatable = {
    ...en.repeatable,
    ...ca.repeatable,
    ...de.repeatable,
    ...es.repeatable,
    ...fr.repeatable,
    ...it.repeatable,
    ...ja.repeatable,
    ...pl.repeatable,
    ...pt.repeatable,
    ...ru.repeatable,
    ...zh_Hans.repeatable,
    ...zh_Hant.repeatable,
};

export const workflowAgentAuthoringTranslations = {
    ...en.workflowAgentAuthoringTranslations,
    ...ca.workflowAgentAuthoringTranslations,
    ...de.workflowAgentAuthoringTranslations,
    ...es.workflowAgentAuthoringTranslations,
    ...fr.workflowAgentAuthoringTranslations,
    ...it.workflowAgentAuthoringTranslations,
    ...ja.workflowAgentAuthoringTranslations,
    ...pl.workflowAgentAuthoringTranslations,
    ...pt.workflowAgentAuthoringTranslations,
    ...ru.workflowAgentAuthoringTranslations,
    ...zh_Hans.workflowAgentAuthoringTranslations,
    ...zh_Hant.workflowAgentAuthoringTranslations,
};
