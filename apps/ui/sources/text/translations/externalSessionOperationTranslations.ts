// Tooling aggregate. Product locale roots import only their locale payload.
import { externalSessionOperationTranslations as en } from './features/en';
import { externalSessionOperationTranslations as ca } from './features/ca';
import { externalSessionOperationTranslations as de } from './features/de';
import { externalSessionOperationTranslations as es } from './features/es';
import { externalSessionOperationTranslations as fr } from './features/fr';
import { externalSessionOperationTranslations as it } from './features/it';
import { externalSessionOperationTranslations as ja } from './features/ja';
import { externalSessionOperationTranslations as pl } from './features/pl';
import { externalSessionOperationTranslations as pt } from './features/pt';
import { externalSessionOperationTranslations as ru } from './features/ru';
import { externalSessionOperationTranslations as zh_Hans } from './features/zh-Hans';
import { externalSessionOperationTranslations as zh_Hant } from './features/zh-Hant';

export const externalSessionOperationTranslations = {
    ...en.externalSessionOperationTranslations,
    ...ca.externalSessionOperationTranslations,
    ...de.externalSessionOperationTranslations,
    ...es.externalSessionOperationTranslations,
    ...fr.externalSessionOperationTranslations,
    ...it.externalSessionOperationTranslations,
    ...ja.externalSessionOperationTranslations,
    ...pl.externalSessionOperationTranslations,
    ...pt.externalSessionOperationTranslations,
    ...ru.externalSessionOperationTranslations,
    ...zh_Hans.externalSessionOperationTranslations,
    ...zh_Hant.externalSessionOperationTranslations,
};
