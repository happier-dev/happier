// Tooling aggregate. Product locale roots import only their locale payload.
import { settingsSessionPagesTranslations as en } from './features/en';
import { settingsSessionPagesTranslations as ca } from './features/ca';
import { settingsSessionPagesTranslations as de } from './features/de';
import { settingsSessionPagesTranslations as es } from './features/es';
import { settingsSessionPagesTranslations as fr } from './features/fr';
import { settingsSessionPagesTranslations as it } from './features/it';
import { settingsSessionPagesTranslations as ja } from './features/ja';
import { settingsSessionPagesTranslations as pl } from './features/pl';
import { settingsSessionPagesTranslations as pt } from './features/pt';
import { settingsSessionPagesTranslations as ru } from './features/ru';
import { settingsSessionPagesTranslations as zh_Hans } from './features/zh-Hans';
import { settingsSessionPagesTranslations as zh_Hant } from './features/zh-Hant';

export const settingsSessionPagesTranslations = {
    ...en.settingsSessionPagesTranslations,
    ...ca.settingsSessionPagesTranslations,
    ...de.settingsSessionPagesTranslations,
    ...es.settingsSessionPagesTranslations,
    ...fr.settingsSessionPagesTranslations,
    ...it.settingsSessionPagesTranslations,
    ...ja.settingsSessionPagesTranslations,
    ...pl.settingsSessionPagesTranslations,
    ...pt.settingsSessionPagesTranslations,
    ...ru.settingsSessionPagesTranslations,
    ...zh_Hans.settingsSessionPagesTranslations,
    ...zh_Hant.settingsSessionPagesTranslations,
};
