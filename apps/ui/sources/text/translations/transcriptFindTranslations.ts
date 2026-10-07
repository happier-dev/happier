// Tooling aggregate. Product locale roots import only their locale payload.
import { transcriptFindTranslations as en } from './features/en';
import { transcriptFindTranslations as ca } from './features/ca';
import { transcriptFindTranslations as de } from './features/de';
import { transcriptFindTranslations as es } from './features/es';
import { transcriptFindTranslations as fr } from './features/fr';
import { transcriptFindTranslations as it } from './features/it';
import { transcriptFindTranslations as ja } from './features/ja';
import { transcriptFindTranslations as pl } from './features/pl';
import { transcriptFindTranslations as pt } from './features/pt';
import { transcriptFindTranslations as ru } from './features/ru';
import { transcriptFindTranslations as zh_Hans } from './features/zh-Hans';
import { transcriptFindTranslations as zh_Hant } from './features/zh-Hant';

export const transcriptFindTranslations = {
    ...en.transcriptFindTranslations,
    ...ca.transcriptFindTranslations,
    ...de.transcriptFindTranslations,
    ...es.transcriptFindTranslations,
    ...fr.transcriptFindTranslations,
    ...it.transcriptFindTranslations,
    ...ja.transcriptFindTranslations,
    ...pl.transcriptFindTranslations,
    ...pt.transcriptFindTranslations,
    ...ru.transcriptFindTranslations,
    ...zh_Hans.transcriptFindTranslations,
    ...zh_Hant.transcriptFindTranslations,
};
