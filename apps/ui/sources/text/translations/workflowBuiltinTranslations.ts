// Tooling aggregate. Product locale roots import only their locale payload.
import { workflowBuiltinTranslations as en } from './features/en';
import { workflowBuiltinTranslations as ca } from './features/ca';
import { workflowBuiltinTranslations as de } from './features/de';
import { workflowBuiltinTranslations as es } from './features/es';
import { workflowBuiltinTranslations as fr } from './features/fr';
import { workflowBuiltinTranslations as it } from './features/it';
import { workflowBuiltinTranslations as ja } from './features/ja';
import { workflowBuiltinTranslations as pl } from './features/pl';
import { workflowBuiltinTranslations as pt } from './features/pt';
import { workflowBuiltinTranslations as ru } from './features/ru';
import { workflowBuiltinTranslations as zh_Hans } from './features/zh-Hans';
import { workflowBuiltinTranslations as zh_Hant } from './features/zh-Hant';

export const workflowBuiltinTranslations = {
    ...en.workflowBuiltinTranslations,
    ...ca.workflowBuiltinTranslations,
    ...de.workflowBuiltinTranslations,
    ...es.workflowBuiltinTranslations,
    ...fr.workflowBuiltinTranslations,
    ...it.workflowBuiltinTranslations,
    ...ja.workflowBuiltinTranslations,
    ...pl.workflowBuiltinTranslations,
    ...pt.workflowBuiltinTranslations,
    ...ru.workflowBuiltinTranslations,
    ...zh_Hans.workflowBuiltinTranslations,
    ...zh_Hant.workflowBuiltinTranslations,
};
