// Tooling aggregate. Product locale roots import only their locale payload.
import { workflowValueReferenceTranslations as en } from './features/en';
import { workflowValueReferenceTranslations as ca } from './features/ca';
import { workflowValueReferenceTranslations as de } from './features/de';
import { workflowValueReferenceTranslations as es } from './features/es';
import { workflowValueReferenceTranslations as fr } from './features/fr';
import { workflowValueReferenceTranslations as it } from './features/it';
import { workflowValueReferenceTranslations as ja } from './features/ja';
import { workflowValueReferenceTranslations as pl } from './features/pl';
import { workflowValueReferenceTranslations as pt } from './features/pt';
import { workflowValueReferenceTranslations as ru } from './features/ru';
import { workflowValueReferenceTranslations as zh_Hans } from './features/zh-Hans';
import { workflowValueReferenceTranslations as zh_Hant } from './features/zh-Hant';

export const workflowValueReferenceTranslations = {
    ...en.workflowValueReferenceTranslations,
    ...ca.workflowValueReferenceTranslations,
    ...de.workflowValueReferenceTranslations,
    ...es.workflowValueReferenceTranslations,
    ...fr.workflowValueReferenceTranslations,
    ...it.workflowValueReferenceTranslations,
    ...ja.workflowValueReferenceTranslations,
    ...pl.workflowValueReferenceTranslations,
    ...pt.workflowValueReferenceTranslations,
    ...ru.workflowValueReferenceTranslations,
    ...zh_Hans.workflowValueReferenceTranslations,
    ...zh_Hant.workflowValueReferenceTranslations,
};
