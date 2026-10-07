// Tooling aggregate. Product locale roots import only their locale payload.
import { widgetGlanceTranslations as en } from './features/en';
import { widgetGlanceTranslations as ca } from './features/ca';
import { widgetGlanceTranslations as de } from './features/de';
import { widgetGlanceTranslations as es } from './features/es';
import { widgetGlanceTranslations as fr } from './features/fr';
import { widgetGlanceTranslations as it } from './features/it';
import { widgetGlanceTranslations as ja } from './features/ja';
import { widgetGlanceTranslations as pl } from './features/pl';
import { widgetGlanceTranslations as pt } from './features/pt';
import { widgetGlanceTranslations as ru } from './features/ru';
import { widgetGlanceTranslations as zh_Hans } from './features/zh-Hans';
import { widgetGlanceTranslations as zh_Hant } from './features/zh-Hant';

export const widgetGlanceTranslations = {
    ...en.widgetGlanceTranslations,
    ...ca.widgetGlanceTranslations,
    ...de.widgetGlanceTranslations,
    ...es.widgetGlanceTranslations,
    ...fr.widgetGlanceTranslations,
    ...it.widgetGlanceTranslations,
    ...ja.widgetGlanceTranslations,
    ...pl.widgetGlanceTranslations,
    ...pt.widgetGlanceTranslations,
    ...ru.widgetGlanceTranslations,
    ...zh_Hans.widgetGlanceTranslations,
    ...zh_Hant.widgetGlanceTranslations,
};
