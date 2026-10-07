// Tooling aggregate. Product locale roots import only their locale payload.
import { pluginUpdateReviewTranslations as en } from './features/en';
import { pluginUpdateReviewTranslations as ca } from './features/ca';
import { pluginUpdateReviewTranslations as de } from './features/de';
import { pluginUpdateReviewTranslations as es } from './features/es';
import { pluginUpdateReviewTranslations as fr } from './features/fr';
import { pluginUpdateReviewTranslations as it } from './features/it';
import { pluginUpdateReviewTranslations as ja } from './features/ja';
import { pluginUpdateReviewTranslations as pl } from './features/pl';
import { pluginUpdateReviewTranslations as pt } from './features/pt';
import { pluginUpdateReviewTranslations as ru } from './features/ru';
import { pluginUpdateReviewTranslations as zh_Hans } from './features/zh-Hans';
import { pluginUpdateReviewTranslations as zh_Hant } from './features/zh-Hant';

export const pluginUpdateReviewTranslations = {
    ...en.pluginUpdateReviewTranslations,
    ...ca.pluginUpdateReviewTranslations,
    ...de.pluginUpdateReviewTranslations,
    ...es.pluginUpdateReviewTranslations,
    ...fr.pluginUpdateReviewTranslations,
    ...it.pluginUpdateReviewTranslations,
    ...ja.pluginUpdateReviewTranslations,
    ...pl.pluginUpdateReviewTranslations,
    ...pt.pluginUpdateReviewTranslations,
    ...ru.pluginUpdateReviewTranslations,
    ...zh_Hans.pluginUpdateReviewTranslations,
    ...zh_Hant.pluginUpdateReviewTranslations,
};
