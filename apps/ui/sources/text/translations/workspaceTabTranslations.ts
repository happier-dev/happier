// Tooling aggregate. Product locale roots import only their locale payload.
import { workspaceTabTranslations as en } from './features/en';
import { workspaceTabTranslations as ca } from './features/ca';
import { workspaceTabTranslations as de } from './features/de';
import { workspaceTabTranslations as es } from './features/es';
import { workspaceTabTranslations as fr } from './features/fr';
import { workspaceTabTranslations as it } from './features/it';
import { workspaceTabTranslations as ja } from './features/ja';
import { workspaceTabTranslations as pl } from './features/pl';
import { workspaceTabTranslations as pt } from './features/pt';
import { workspaceTabTranslations as ru } from './features/ru';
import { workspaceTabTranslations as zh_Hans } from './features/zh-Hans';
import { workspaceTabTranslations as zh_Hant } from './features/zh-Hant';
export { workspaceTabKeyboardTranslations } from './workspaceTabTranslations.shared';

export const workspaceTabTranslations = {
    ...en.workspaceTabTranslations,
    ...ca.workspaceTabTranslations,
    ...de.workspaceTabTranslations,
    ...es.workspaceTabTranslations,
    ...fr.workspaceTabTranslations,
    ...it.workspaceTabTranslations,
    ...ja.workspaceTabTranslations,
    ...pl.workspaceTabTranslations,
    ...pt.workspaceTabTranslations,
    ...ru.workspaceTabTranslations,
    ...zh_Hans.workspaceTabTranslations,
    ...zh_Hant.workspaceTabTranslations,
};
