// Tooling aggregate. Product locale roots import only their locale payload.
import { surfaceStateTranslations as en } from './features/en';
import { surfaceStateTranslations as ca } from './features/ca';
import { surfaceStateTranslations as de } from './features/de';
import { surfaceStateTranslations as es } from './features/es';
import { surfaceStateTranslations as fr } from './features/fr';
import { surfaceStateTranslations as it } from './features/it';
import { surfaceStateTranslations as ja } from './features/ja';
import { surfaceStateTranslations as pl } from './features/pl';
import { surfaceStateTranslations as pt } from './features/pt';
import { surfaceStateTranslations as ru } from './features/ru';
import { surfaceStateTranslations as zh_Hans } from './features/zh-Hans';
import { surfaceStateTranslations as zh_Hant } from './features/zh-Hant';

export const surfaceStateTranslations = {
    ...en.surfaceStateTranslations,
    ...ca.surfaceStateTranslations,
    ...de.surfaceStateTranslations,
    ...es.surfaceStateTranslations,
    ...fr.surfaceStateTranslations,
    ...it.surfaceStateTranslations,
    ...ja.surfaceStateTranslations,
    ...pl.surfaceStateTranslations,
    ...pt.surfaceStateTranslations,
    ...ru.surfaceStateTranslations,
    ...zh_Hans.surfaceStateTranslations,
    ...zh_Hant.surfaceStateTranslations,
};
