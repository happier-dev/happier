// Tooling aggregate. Product locale roots import only their locale payload.
import { sidebarFooterTranslations as en } from './features/en';
import { sidebarFooterTranslations as ca } from './features/ca';
import { sidebarFooterTranslations as de } from './features/de';
import { sidebarFooterTranslations as es } from './features/es';
import { sidebarFooterTranslations as fr } from './features/fr';
import { sidebarFooterTranslations as it } from './features/it';
import { sidebarFooterTranslations as ja } from './features/ja';
import { sidebarFooterTranslations as pl } from './features/pl';
import { sidebarFooterTranslations as pt } from './features/pt';
import { sidebarFooterTranslations as ru } from './features/ru';
import { sidebarFooterTranslations as zh_Hans } from './features/zh-Hans';
import { sidebarFooterTranslations as zh_Hant } from './features/zh-Hant';

export const sidebarFooterTranslations = {
    ...en.sidebarFooterTranslations,
    ...ca.sidebarFooterTranslations,
    ...de.sidebarFooterTranslations,
    ...es.sidebarFooterTranslations,
    ...fr.sidebarFooterTranslations,
    ...it.sidebarFooterTranslations,
    ...ja.sidebarFooterTranslations,
    ...pl.sidebarFooterTranslations,
    ...pt.sidebarFooterTranslations,
    ...ru.sidebarFooterTranslations,
    ...zh_Hans.sidebarFooterTranslations,
    ...zh_Hant.sidebarFooterTranslations,
};
