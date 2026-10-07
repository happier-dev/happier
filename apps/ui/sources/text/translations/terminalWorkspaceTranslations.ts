// Tooling aggregate. Product locale roots import only their locale payload.
import { terminalWorkspaceTranslations as en } from './features/en';
import { terminalWorkspaceTranslations as ca } from './features/ca';
import { terminalWorkspaceTranslations as de } from './features/de';
import { terminalWorkspaceTranslations as es } from './features/es';
import { terminalWorkspaceTranslations as fr } from './features/fr';
import { terminalWorkspaceTranslations as it } from './features/it';
import { terminalWorkspaceTranslations as ja } from './features/ja';
import { terminalWorkspaceTranslations as pl } from './features/pl';
import { terminalWorkspaceTranslations as pt } from './features/pt';
import { terminalWorkspaceTranslations as ru } from './features/ru';
import { terminalWorkspaceTranslations as zh_Hans } from './features/zh-Hans';
import { terminalWorkspaceTranslations as zh_Hant } from './features/zh-Hant';
export { terminalWorkspaceKeyboardTranslations } from './terminalWorkspaceTranslations.shared';

export const terminalWorkspaceTranslations = {
    ...en.terminalWorkspaceTranslations,
    ...ca.terminalWorkspaceTranslations,
    ...de.terminalWorkspaceTranslations,
    ...es.terminalWorkspaceTranslations,
    ...fr.terminalWorkspaceTranslations,
    ...it.terminalWorkspaceTranslations,
    ...ja.terminalWorkspaceTranslations,
    ...pl.terminalWorkspaceTranslations,
    ...pt.terminalWorkspaceTranslations,
    ...ru.terminalWorkspaceTranslations,
    ...zh_Hans.terminalWorkspaceTranslations,
    ...zh_Hant.terminalWorkspaceTranslations,
};
