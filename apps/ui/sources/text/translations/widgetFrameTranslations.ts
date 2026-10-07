// Tooling aggregate. Product locale roots import only their locale payload.
import { widgetFrameTranslations as en } from './features/en';
import { widgetFrameTranslations as ca } from './features/ca';
import { widgetFrameTranslations as de } from './features/de';
import { widgetFrameTranslations as es } from './features/es';
import { widgetFrameTranslations as fr } from './features/fr';
import { widgetFrameTranslations as it } from './features/it';
import { widgetFrameTranslations as ja } from './features/ja';
import { widgetFrameTranslations as pl } from './features/pl';
import { widgetFrameTranslations as pt } from './features/pt';
import { widgetFrameTranslations as ru } from './features/ru';
import { widgetFrameTranslations as zh_Hans } from './features/zh-Hans';
import { widgetFrameTranslations as zh_Hant } from './features/zh-Hant';

export const widgetFrameTranslations = {
    ...en.widgetFrameTranslations,
    ...ca.widgetFrameTranslations,
    ...de.widgetFrameTranslations,
    ...es.widgetFrameTranslations,
    ...fr.widgetFrameTranslations,
    ...it.widgetFrameTranslations,
    ...ja.widgetFrameTranslations,
    ...pl.widgetFrameTranslations,
    ...pt.widgetFrameTranslations,
    ...ru.widgetFrameTranslations,
    ...zh_Hans.widgetFrameTranslations,
    ...zh_Hant.widgetFrameTranslations,
};
