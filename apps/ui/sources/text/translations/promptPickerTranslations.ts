// Tooling aggregate. Product locale roots import only their locale payload.
import { promptPickerTranslations as en } from './features/en';
import { promptPickerTranslations as ca } from './features/ca';
import { promptPickerTranslations as de } from './features/de';
import { promptPickerTranslations as es } from './features/es';
import { promptPickerTranslations as fr } from './features/fr';
import { promptPickerTranslations as it } from './features/it';
import { promptPickerTranslations as ja } from './features/ja';
import { promptPickerTranslations as pl } from './features/pl';
import { promptPickerTranslations as pt } from './features/pt';
import { promptPickerTranslations as ru } from './features/ru';
import { promptPickerTranslations as zh_Hans } from './features/zh-Hans';
import { promptPickerTranslations as zh_Hant } from './features/zh-Hant';

export const promptPickerTranslations = {
    ...en.promptPickerTranslations,
    ...ca.promptPickerTranslations,
    ...de.promptPickerTranslations,
    ...es.promptPickerTranslations,
    ...fr.promptPickerTranslations,
    ...it.promptPickerTranslations,
    ...ja.promptPickerTranslations,
    ...pl.promptPickerTranslations,
    ...pt.promptPickerTranslations,
    ...ru.promptPickerTranslations,
    ...zh_Hans.promptPickerTranslations,
    ...zh_Hant.promptPickerTranslations,
};
