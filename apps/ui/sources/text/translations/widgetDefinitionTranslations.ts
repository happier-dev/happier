// Tooling aggregate. Product locale roots import only their locale payload.
import { widgetDefinitionTranslations as en } from './features/en';
import { widgetDefinitionTranslations as ca } from './features/ca';
import { widgetDefinitionTranslations as de } from './features/de';
import { widgetDefinitionTranslations as es } from './features/es';
import { widgetDefinitionTranslations as fr } from './features/fr';
import { widgetDefinitionTranslations as it } from './features/it';
import { widgetDefinitionTranslations as ja } from './features/ja';
import { widgetDefinitionTranslations as pl } from './features/pl';
import { widgetDefinitionTranslations as pt } from './features/pt';
import { widgetDefinitionTranslations as ru } from './features/ru';
import { widgetDefinitionTranslations as zh_Hans } from './features/zh-Hans';
import { widgetDefinitionTranslations as zh_Hant } from './features/zh-Hant';

export const widgetDefinitionTranslations = {
    ...en.widgetDefinitionTranslations,
    ...ca.widgetDefinitionTranslations,
    ...de.widgetDefinitionTranslations,
    ...es.widgetDefinitionTranslations,
    ...fr.widgetDefinitionTranslations,
    ...it.widgetDefinitionTranslations,
    ...ja.widgetDefinitionTranslations,
    ...pl.widgetDefinitionTranslations,
    ...pt.widgetDefinitionTranslations,
    ...ru.widgetDefinitionTranslations,
    ...zh_Hans.widgetDefinitionTranslations,
    ...zh_Hant.widgetDefinitionTranslations,
};
