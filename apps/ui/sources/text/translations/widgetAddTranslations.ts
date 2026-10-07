// Tooling aggregate. Product locale roots import only their locale payload.
import { widgetAddTranslations as en } from './features/en';
import { widgetAddTranslations as ca } from './features/ca';
import { widgetAddTranslations as de } from './features/de';
import { widgetAddTranslations as es } from './features/es';
import { widgetAddTranslations as fr } from './features/fr';
import { widgetAddTranslations as it } from './features/it';
import { widgetAddTranslations as ja } from './features/ja';
import { widgetAddTranslations as pl } from './features/pl';
import { widgetAddTranslations as pt } from './features/pt';
import { widgetAddTranslations as ru } from './features/ru';
import { widgetAddTranslations as zh_Hans } from './features/zh-Hans';
import { widgetAddTranslations as zh_Hant } from './features/zh-Hant';

export const widgetAddTranslations = {
    ...en.widgetAddTranslations,
    ...ca.widgetAddTranslations,
    ...de.widgetAddTranslations,
    ...es.widgetAddTranslations,
    ...fr.widgetAddTranslations,
    ...it.widgetAddTranslations,
    ...ja.widgetAddTranslations,
    ...pl.widgetAddTranslations,
    ...pt.widgetAddTranslations,
    ...ru.widgetAddTranslations,
    ...zh_Hans.widgetAddTranslations,
    ...zh_Hant.widgetAddTranslations,
};
