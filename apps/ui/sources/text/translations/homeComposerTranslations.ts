// Tooling aggregate. Product locale roots import only their locale payload.
import { homeComposerTranslations as en } from './features/en';
import { homeComposerTranslations as ca } from './features/ca';
import { homeComposerTranslations as de } from './features/de';
import { homeComposerTranslations as es } from './features/es';
import { homeComposerTranslations as fr } from './features/fr';
import { homeComposerTranslations as it } from './features/it';
import { homeComposerTranslations as ja } from './features/ja';
import { homeComposerTranslations as pl } from './features/pl';
import { homeComposerTranslations as pt } from './features/pt';
import { homeComposerTranslations as ru } from './features/ru';
import { homeComposerTranslations as zh_Hans } from './features/zh-Hans';
import { homeComposerTranslations as zh_Hant } from './features/zh-Hant';

export const homeComposerTranslations = {
    ...en.homeComposerTranslations,
    ...ca.homeComposerTranslations,
    ...de.homeComposerTranslations,
    ...es.homeComposerTranslations,
    ...fr.homeComposerTranslations,
    ...it.homeComposerTranslations,
    ...ja.homeComposerTranslations,
    ...pl.homeComposerTranslations,
    ...pt.homeComposerTranslations,
    ...ru.homeComposerTranslations,
    ...zh_Hans.homeComposerTranslations,
    ...zh_Hant.homeComposerTranslations,
};
