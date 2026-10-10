// Tooling aggregate. Product locale roots import only their locale payload.
import { menuBarModeTranslations as en } from './features/en';
import { menuBarModeTranslations as ca } from './features/ca';
import { menuBarModeTranslations as de } from './features/de';
import { menuBarModeTranslations as es } from './features/es';
import { menuBarModeTranslations as fr } from './features/fr';
import { menuBarModeTranslations as it } from './features/it';
import { menuBarModeTranslations as ja } from './features/ja';
import { menuBarModeTranslations as pl } from './features/pl';
import { menuBarModeTranslations as pt } from './features/pt';
import { menuBarModeTranslations as ru } from './features/ru';
import { menuBarModeTranslations as zh_Hans } from './features/zh-Hans';
import { menuBarModeTranslations as zh_Hant } from './features/zh-Hant';
export type { DesktopTrayTranslation, DesktopLoginStartTranslation } from './menuBarModeTranslations.shared';

export const menuBarModeTranslations = {
    ...en.menuBarModeTranslations,
    ...ca.menuBarModeTranslations,
    ...de.menuBarModeTranslations,
    ...es.menuBarModeTranslations,
    ...fr.menuBarModeTranslations,
    ...it.menuBarModeTranslations,
    ...ja.menuBarModeTranslations,
    ...pl.menuBarModeTranslations,
    ...pt.menuBarModeTranslations,
    ...ru.menuBarModeTranslations,
    ...zh_Hans.menuBarModeTranslations,
    ...zh_Hant.menuBarModeTranslations,
};
