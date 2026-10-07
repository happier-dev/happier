// Tooling aggregate. Product locale roots import only their locale payload.
import { navigationPlacementTranslations as en } from './features/en';
import { navigationPlacementTranslations as ca } from './features/ca';
import { navigationPlacementTranslations as de } from './features/de';
import { navigationPlacementTranslations as es } from './features/es';
import { navigationPlacementTranslations as fr } from './features/fr';
import { navigationPlacementTranslations as it } from './features/it';
import { navigationPlacementTranslations as ja } from './features/ja';
import { navigationPlacementTranslations as pl } from './features/pl';
import { navigationPlacementTranslations as pt } from './features/pt';
import { navigationPlacementTranslations as ru } from './features/ru';
import { navigationPlacementTranslations as zh_Hans } from './features/zh-Hans';
import { navigationPlacementTranslations as zh_Hant } from './features/zh-Hant';

export const navigationPlacementTranslations = {
    ...en.navigationPlacementTranslations,
    ...ca.navigationPlacementTranslations,
    ...de.navigationPlacementTranslations,
    ...es.navigationPlacementTranslations,
    ...fr.navigationPlacementTranslations,
    ...it.navigationPlacementTranslations,
    ...ja.navigationPlacementTranslations,
    ...pl.navigationPlacementTranslations,
    ...pt.navigationPlacementTranslations,
    ...ru.navigationPlacementTranslations,
    ...zh_Hans.navigationPlacementTranslations,
    ...zh_Hant.navigationPlacementTranslations,
};
