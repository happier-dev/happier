// Tooling aggregate. Product locale roots import only their locale payload.
import { homeWidgetTranslations as en } from './features/en';
import { homeWidgetTranslations as ca } from './features/ca';
import { homeWidgetTranslations as de } from './features/de';
import { homeWidgetTranslations as es } from './features/es';
import { homeWidgetTranslations as fr } from './features/fr';
import { homeWidgetTranslations as it } from './features/it';
import { homeWidgetTranslations as ja } from './features/ja';
import { homeWidgetTranslations as pl } from './features/pl';
import { homeWidgetTranslations as pt } from './features/pt';
import { homeWidgetTranslations as ru } from './features/ru';
import { homeWidgetTranslations as zh_Hans } from './features/zh-Hans';
import { homeWidgetTranslations as zh_Hant } from './features/zh-Hant';

export const homeWidgetTranslations = {
    ...en.homeWidgetTranslations,
    ...ca.homeWidgetTranslations,
    ...de.homeWidgetTranslations,
    ...es.homeWidgetTranslations,
    ...fr.homeWidgetTranslations,
    ...it.homeWidgetTranslations,
    ...ja.homeWidgetTranslations,
    ...pl.homeWidgetTranslations,
    ...pt.homeWidgetTranslations,
    ...ru.homeWidgetTranslations,
    ...zh_Hans.homeWidgetTranslations,
    ...zh_Hant.homeWidgetTranslations,
};
