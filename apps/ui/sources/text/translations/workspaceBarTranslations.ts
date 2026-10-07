// Tooling aggregate. Product locale roots import only their locale payload.
import { workspaceBarTranslations as en } from './features/en';
import { workspaceBarTranslations as ca } from './features/ca';
import { workspaceBarTranslations as de } from './features/de';
import { workspaceBarTranslations as es } from './features/es';
import { workspaceBarTranslations as fr } from './features/fr';
import { workspaceBarTranslations as it } from './features/it';
import { workspaceBarTranslations as ja } from './features/ja';
import { workspaceBarTranslations as pl } from './features/pl';
import { workspaceBarTranslations as pt } from './features/pt';
import { workspaceBarTranslations as ru } from './features/ru';
import { workspaceBarTranslations as zh_Hans } from './features/zh-Hans';
import { workspaceBarTranslations as zh_Hant } from './features/zh-Hant';

export const workspaceBarTranslations = {
    ...en.workspaceBarTranslations,
    ...ca.workspaceBarTranslations,
    ...de.workspaceBarTranslations,
    ...es.workspaceBarTranslations,
    ...fr.workspaceBarTranslations,
    ...it.workspaceBarTranslations,
    ...ja.workspaceBarTranslations,
    ...pl.workspaceBarTranslations,
    ...pt.workspaceBarTranslations,
    ...ru.workspaceBarTranslations,
    ...zh_Hans.workspaceBarTranslations,
    ...zh_Hant.workspaceBarTranslations,
};
