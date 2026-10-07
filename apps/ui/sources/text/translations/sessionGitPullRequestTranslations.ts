// Tooling aggregate. Product locale roots import only their locale payload.
import { sessionGitPullRequestTranslations as en } from './features/en';
import { sessionGitPullRequestTranslations as ca } from './features/ca';
import { sessionGitPullRequestTranslations as de } from './features/de';
import { sessionGitPullRequestTranslations as es } from './features/es';
import { sessionGitPullRequestTranslations as fr } from './features/fr';
import { sessionGitPullRequestTranslations as it } from './features/it';
import { sessionGitPullRequestTranslations as ja } from './features/ja';
import { sessionGitPullRequestTranslations as pl } from './features/pl';
import { sessionGitPullRequestTranslations as pt } from './features/pt';
import { sessionGitPullRequestTranslations as ru } from './features/ru';
import { sessionGitPullRequestTranslations as zh_Hans } from './features/zh-Hans';
import { sessionGitPullRequestTranslations as zh_Hant } from './features/zh-Hant';

export const sessionGitPullRequestTranslations = {
    ...en.sessionGitPullRequestTranslations,
    ...ca.sessionGitPullRequestTranslations,
    ...de.sessionGitPullRequestTranslations,
    ...es.sessionGitPullRequestTranslations,
    ...fr.sessionGitPullRequestTranslations,
    ...it.sessionGitPullRequestTranslations,
    ...ja.sessionGitPullRequestTranslations,
    ...pl.sessionGitPullRequestTranslations,
    ...pt.sessionGitPullRequestTranslations,
    ...ru.sessionGitPullRequestTranslations,
    ...zh_Hans.sessionGitPullRequestTranslations,
    ...zh_Hant.sessionGitPullRequestTranslations,
};
