// Tooling aggregate. Product locale roots import only their locale payload.
import { commitProposalTranslations as en } from './features/en';
import { commitProposalTranslations as ca } from './features/ca';
import { commitProposalTranslations as de } from './features/de';
import { commitProposalTranslations as es } from './features/es';
import { commitProposalTranslations as fr } from './features/fr';
import { commitProposalTranslations as it } from './features/it';
import { commitProposalTranslations as ja } from './features/ja';
import { commitProposalTranslations as pl } from './features/pl';
import { commitProposalTranslations as pt } from './features/pt';
import { commitProposalTranslations as ru } from './features/ru';
import { commitProposalTranslations as zh_Hans } from './features/zh-Hans';
import { commitProposalTranslations as zh_Hant } from './features/zh-Hant';

export const commitProposalTranslations = {
    ...en.commitProposalTranslations,
    ...ca.commitProposalTranslations,
    ...de.commitProposalTranslations,
    ...es.commitProposalTranslations,
    ...fr.commitProposalTranslations,
    ...it.commitProposalTranslations,
    ...ja.commitProposalTranslations,
    ...pl.commitProposalTranslations,
    ...pt.commitProposalTranslations,
    ...ru.commitProposalTranslations,
    ...zh_Hans.commitProposalTranslations,
    ...zh_Hant.commitProposalTranslations,
};
