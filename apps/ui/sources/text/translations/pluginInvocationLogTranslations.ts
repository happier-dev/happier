// Tooling aggregate. Product locale roots import only their locale payload.
import { pluginInvocationLogTranslations as en } from './features/en';
import { pluginInvocationLogTranslations as ca } from './features/ca';
import { pluginInvocationLogTranslations as de } from './features/de';
import { pluginInvocationLogTranslations as es } from './features/es';
import { pluginInvocationLogTranslations as fr } from './features/fr';
import { pluginInvocationLogTranslations as it } from './features/it';
import { pluginInvocationLogTranslations as ja } from './features/ja';
import { pluginInvocationLogTranslations as pl } from './features/pl';
import { pluginInvocationLogTranslations as pt } from './features/pt';
import { pluginInvocationLogTranslations as ru } from './features/ru';
import { pluginInvocationLogTranslations as zh_Hans } from './features/zh-Hans';
import { pluginInvocationLogTranslations as zh_Hant } from './features/zh-Hant';

export const pluginInvocationLogTranslations = {
    ...en.pluginInvocationLogTranslations,
    ...ca.pluginInvocationLogTranslations,
    ...de.pluginInvocationLogTranslations,
    ...es.pluginInvocationLogTranslations,
    ...fr.pluginInvocationLogTranslations,
    ...it.pluginInvocationLogTranslations,
    ...ja.pluginInvocationLogTranslations,
    ...pl.pluginInvocationLogTranslations,
    ...pt.pluginInvocationLogTranslations,
    ...ru.pluginInvocationLogTranslations,
    ...zh_Hans.pluginInvocationLogTranslations,
    ...zh_Hant.pluginInvocationLogTranslations,
};
