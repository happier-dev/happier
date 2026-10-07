// Tooling aggregate. Product locale roots import only their locale payload.
import { inputPickerTranslations as en } from './features/en';
import { inputPickerTranslations as ca } from './features/ca';
import { inputPickerTranslations as de } from './features/de';
import { inputPickerTranslations as es } from './features/es';
import { inputPickerTranslations as fr } from './features/fr';
import { inputPickerTranslations as it } from './features/it';
import { inputPickerTranslations as ja } from './features/ja';
import { inputPickerTranslations as pl } from './features/pl';
import { inputPickerTranslations as pt } from './features/pt';
import { inputPickerTranslations as ru } from './features/ru';
import { inputPickerTranslations as zh_Hans } from './features/zh-Hans';
import { inputPickerTranslations as zh_Hant } from './features/zh-Hant';

export const inputPickerTranslations = {
    ...en.inputPickerTranslations,
    ...ca.inputPickerTranslations,
    ...de.inputPickerTranslations,
    ...es.inputPickerTranslations,
    ...fr.inputPickerTranslations,
    ...it.inputPickerTranslations,
    ...ja.inputPickerTranslations,
    ...pl.inputPickerTranslations,
    ...pt.inputPickerTranslations,
    ...ru.inputPickerTranslations,
    ...zh_Hans.inputPickerTranslations,
    ...zh_Hant.inputPickerTranslations,
};
