// Tooling aggregate. Product locale roots import only their locale payload.
import { sessionGitPaneTranslations as en } from './features/en';
import { sessionGitPaneTranslations as ca } from './features/ca';
import { sessionGitPaneTranslations as de } from './features/de';
import { sessionGitPaneTranslations as es } from './features/es';
import { sessionGitPaneTranslations as fr } from './features/fr';
import { sessionGitPaneTranslations as it } from './features/it';
import { sessionGitPaneTranslations as ja } from './features/ja';
import { sessionGitPaneTranslations as pl } from './features/pl';
import { sessionGitPaneTranslations as pt } from './features/pt';
import { sessionGitPaneTranslations as ru } from './features/ru';
import { sessionGitPaneTranslations as zh_Hans } from './features/zh-Hans';
import { sessionGitPaneTranslations as zh_Hant } from './features/zh-Hant';

export const sessionGitPaneTranslations = {
    ...en.sessionGitPaneTranslations,
    ...ca.sessionGitPaneTranslations,
    ...de.sessionGitPaneTranslations,
    ...es.sessionGitPaneTranslations,
    ...fr.sessionGitPaneTranslations,
    ...it.sessionGitPaneTranslations,
    ...ja.sessionGitPaneTranslations,
    ...pl.sessionGitPaneTranslations,
    ...pt.sessionGitPaneTranslations,
    ...ru.sessionGitPaneTranslations,
    ...zh_Hans.sessionGitPaneTranslations,
    ...zh_Hant.sessionGitPaneTranslations,
};
