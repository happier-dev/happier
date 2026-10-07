// Tooling aggregate. Product locale roots import only their locale payload.
import { homeGovernanceTranslations as en } from './features/en';
import { homeGovernanceTranslations as ca } from './features/ca';
import { homeGovernanceTranslations as de } from './features/de';
import { homeGovernanceTranslations as es } from './features/es';
import { homeGovernanceTranslations as fr } from './features/fr';
import { homeGovernanceTranslations as it } from './features/it';
import { homeGovernanceTranslations as ja } from './features/ja';
import { homeGovernanceTranslations as pl } from './features/pl';
import { homeGovernanceTranslations as pt } from './features/pt';
import { homeGovernanceTranslations as ru } from './features/ru';
import { homeGovernanceTranslations as zh_Hans } from './features/zh-Hans';
import { homeGovernanceTranslations as zh_Hant } from './features/zh-Hant';

export const homeGovernanceTranslations = {
    ...en.homeGovernanceTranslations,
    ...ca.homeGovernanceTranslations,
    ...de.homeGovernanceTranslations,
    ...es.homeGovernanceTranslations,
    ...fr.homeGovernanceTranslations,
    ...it.homeGovernanceTranslations,
    ...ja.homeGovernanceTranslations,
    ...pl.homeGovernanceTranslations,
    ...pt.homeGovernanceTranslations,
    ...ru.homeGovernanceTranslations,
    ...zh_Hans.homeGovernanceTranslations,
    ...zh_Hant.homeGovernanceTranslations,
};
