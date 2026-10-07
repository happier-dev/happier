// Tooling aggregate. Product locale roots import only their locale payload.
import { sessionGitBranchesTranslations as en } from './features/en';
import { sessionGitBranchesTranslations as ca } from './features/ca';
import { sessionGitBranchesTranslations as de } from './features/de';
import { sessionGitBranchesTranslations as es } from './features/es';
import { sessionGitBranchesTranslations as fr } from './features/fr';
import { sessionGitBranchesTranslations as it } from './features/it';
import { sessionGitBranchesTranslations as ja } from './features/ja';
import { sessionGitBranchesTranslations as pl } from './features/pl';
import { sessionGitBranchesTranslations as pt } from './features/pt';
import { sessionGitBranchesTranslations as ru } from './features/ru';
import { sessionGitBranchesTranslations as zh_Hans } from './features/zh-Hans';
import { sessionGitBranchesTranslations as zh_Hant } from './features/zh-Hant';

export const sessionGitBranchesTranslations = {
    ...en.sessionGitBranchesTranslations,
    ...ca.sessionGitBranchesTranslations,
    ...de.sessionGitBranchesTranslations,
    ...es.sessionGitBranchesTranslations,
    ...fr.sessionGitBranchesTranslations,
    ...it.sessionGitBranchesTranslations,
    ...ja.sessionGitBranchesTranslations,
    ...pl.sessionGitBranchesTranslations,
    ...pt.sessionGitBranchesTranslations,
    ...ru.sessionGitBranchesTranslations,
    ...zh_Hans.sessionGitBranchesTranslations,
    ...zh_Hant.sessionGitBranchesTranslations,
};
