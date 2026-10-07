// Tooling aggregate. Product locale roots import only their locale payload.
import { sessionGitDisplayTranslations as en } from './features/en';
import { sessionGitDisplayTranslations as ca } from './features/ca';
import { sessionGitDisplayTranslations as de } from './features/de';
import { sessionGitDisplayTranslations as es } from './features/es';
import { sessionGitDisplayTranslations as fr } from './features/fr';
import { sessionGitDisplayTranslations as it } from './features/it';
import { sessionGitDisplayTranslations as ja } from './features/ja';
import { sessionGitDisplayTranslations as pl } from './features/pl';
import { sessionGitDisplayTranslations as pt } from './features/pt';
import { sessionGitDisplayTranslations as ru } from './features/ru';
import { sessionGitDisplayTranslations as zh_Hans } from './features/zh-Hans';
import { sessionGitDisplayTranslations as zh_Hant } from './features/zh-Hant';

export const sessionGitDisplayTranslations = {
    ...en.sessionGitDisplayTranslations,
    ...ca.sessionGitDisplayTranslations,
    ...de.sessionGitDisplayTranslations,
    ...es.sessionGitDisplayTranslations,
    ...fr.sessionGitDisplayTranslations,
    ...it.sessionGitDisplayTranslations,
    ...ja.sessionGitDisplayTranslations,
    ...pl.sessionGitDisplayTranslations,
    ...pt.sessionGitDisplayTranslations,
    ...ru.sessionGitDisplayTranslations,
    ...zh_Hans.sessionGitDisplayTranslations,
    ...zh_Hant.sessionGitDisplayTranslations,
};
