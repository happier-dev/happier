// Tooling aggregate. Product locale roots import only their locale payload.
import { artifactsBrowserTranslations as en } from './features/en';
import { artifactsBrowserTranslations as ca } from './features/ca';
import { artifactsBrowserTranslations as de } from './features/de';
import { artifactsBrowserTranslations as es } from './features/es';
import { artifactsBrowserTranslations as fr } from './features/fr';
import { artifactsBrowserTranslations as it } from './features/it';
import { artifactsBrowserTranslations as ja } from './features/ja';
import { artifactsBrowserTranslations as pl } from './features/pl';
import { artifactsBrowserTranslations as pt } from './features/pt';
import { artifactsBrowserTranslations as ru } from './features/ru';
import { artifactsBrowserTranslations as zh_Hans } from './features/zh-Hans';
import { artifactsBrowserTranslations as zh_Hant } from './features/zh-Hant';

export const artifactsBrowserTranslations = {
    ...en.artifactsBrowserTranslations,
    ...ca.artifactsBrowserTranslations,
    ...de.artifactsBrowserTranslations,
    ...es.artifactsBrowserTranslations,
    ...fr.artifactsBrowserTranslations,
    ...it.artifactsBrowserTranslations,
    ...ja.artifactsBrowserTranslations,
    ...pl.artifactsBrowserTranslations,
    ...pt.artifactsBrowserTranslations,
    ...ru.artifactsBrowserTranslations,
    ...zh_Hans.artifactsBrowserTranslations,
    ...zh_Hant.artifactsBrowserTranslations,
};
