// Tooling aggregate. Product locale roots import only their locale payload.
import { workflowRunRoleTranslations as en } from './features/en';
import { workflowRunRoleTranslations as ca } from './features/ca';
import { workflowRunRoleTranslations as de } from './features/de';
import { workflowRunRoleTranslations as es } from './features/es';
import { workflowRunRoleTranslations as fr } from './features/fr';
import { workflowRunRoleTranslations as it } from './features/it';
import { workflowRunRoleTranslations as ja } from './features/ja';
import { workflowRunRoleTranslations as pl } from './features/pl';
import { workflowRunRoleTranslations as pt } from './features/pt';
import { workflowRunRoleTranslations as ru } from './features/ru';
import { workflowRunRoleTranslations as zh_Hans } from './features/zh-Hans';
import { workflowRunRoleTranslations as zh_Hant } from './features/zh-Hant';

export const workflowRunRoleTranslations = {
    ...en.workflowRunRoleTranslations,
    ...ca.workflowRunRoleTranslations,
    ...de.workflowRunRoleTranslations,
    ...es.workflowRunRoleTranslations,
    ...fr.workflowRunRoleTranslations,
    ...it.workflowRunRoleTranslations,
    ...ja.workflowRunRoleTranslations,
    ...pl.workflowRunRoleTranslations,
    ...pt.workflowRunRoleTranslations,
    ...ru.workflowRunRoleTranslations,
    ...zh_Hans.workflowRunRoleTranslations,
    ...zh_Hant.workflowRunRoleTranslations,
};
