// Tooling aggregate. Product locale roots import only their locale payload.
import { shareSheetTranslations as en } from './features/en';
import { shareSheetTranslations as ca } from './features/ca';
import { shareSheetTranslations as de } from './features/de';
import { shareSheetTranslations as es } from './features/es';
import { shareSheetTranslations as fr } from './features/fr';
import { shareSheetTranslations as it } from './features/it';
import { shareSheetTranslations as ja } from './features/ja';
import { shareSheetTranslations as pl } from './features/pl';
import { shareSheetTranslations as pt } from './features/pt';
import { shareSheetTranslations as ru } from './features/ru';
import { shareSheetTranslations as zh_Hans } from './features/zh-Hans';
import { shareSheetTranslations as zh_Hant } from './features/zh-Hant';

export const shareSheetTranslations = {
    ...en.shareSheetTranslations,
    ...ca.shareSheetTranslations,
    ...de.shareSheetTranslations,
    ...es.shareSheetTranslations,
    ...fr.shareSheetTranslations,
    ...it.shareSheetTranslations,
    ...ja.shareSheetTranslations,
    ...pl.shareSheetTranslations,
    ...pt.shareSheetTranslations,
    ...ru.shareSheetTranslations,
    ...zh_Hans.shareSheetTranslations,
    ...zh_Hant.shareSheetTranslations,
};
