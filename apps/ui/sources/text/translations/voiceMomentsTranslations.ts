// Tooling aggregate. Product locale roots import only their locale payload.
import { voiceMomentsTranslations as en } from './features/en';
import { voiceMomentsTranslations as ca } from './features/ca';
import { voiceMomentsTranslations as de } from './features/de';
import { voiceMomentsTranslations as es } from './features/es';
import { voiceMomentsTranslations as fr } from './features/fr';
import { voiceMomentsTranslations as it } from './features/it';
import { voiceMomentsTranslations as ja } from './features/ja';
import { voiceMomentsTranslations as pl } from './features/pl';
import { voiceMomentsTranslations as pt } from './features/pt';
import { voiceMomentsTranslations as ru } from './features/ru';
import { voiceMomentsTranslations as zh_Hans } from './features/zh-Hans';
import { voiceMomentsTranslations as zh_Hant } from './features/zh-Hant';

export const voiceMomentsTranslations = {
    ...en.voiceMomentsTranslations,
    ...ca.voiceMomentsTranslations,
    ...de.voiceMomentsTranslations,
    ...es.voiceMomentsTranslations,
    ...fr.voiceMomentsTranslations,
    ...it.voiceMomentsTranslations,
    ...ja.voiceMomentsTranslations,
    ...pl.voiceMomentsTranslations,
    ...pt.voiceMomentsTranslations,
    ...ru.voiceMomentsTranslations,
    ...zh_Hans.voiceMomentsTranslations,
    ...zh_Hant.voiceMomentsTranslations,
};
