// Tooling aggregate. Product locale roots import only their locale payload.
import { secretsSettingsTranslations as en } from './features/en';
import { secretsSettingsTranslations as ca } from './features/ca';
import { secretsSettingsTranslations as de } from './features/de';
import { secretsSettingsTranslations as es } from './features/es';
import { secretsSettingsTranslations as fr } from './features/fr';
import { secretsSettingsTranslations as it } from './features/it';
import { secretsSettingsTranslations as ja } from './features/ja';
import { secretsSettingsTranslations as pl } from './features/pl';
import { secretsSettingsTranslations as pt } from './features/pt';
import { secretsSettingsTranslations as ru } from './features/ru';
import { secretsSettingsTranslations as zh_Hans } from './features/zh-Hans';
import { secretsSettingsTranslations as zh_Hant } from './features/zh-Hant';

export const secretsSettingsTranslations = {
    ...en.secretsSettingsTranslations,
    ...ca.secretsSettingsTranslations,
    ...de.secretsSettingsTranslations,
    ...es.secretsSettingsTranslations,
    ...fr.secretsSettingsTranslations,
    ...it.secretsSettingsTranslations,
    ...ja.secretsSettingsTranslations,
    ...pl.secretsSettingsTranslations,
    ...pt.secretsSettingsTranslations,
    ...ru.secretsSettingsTranslations,
    ...zh_Hans.secretsSettingsTranslations,
    ...zh_Hant.secretsSettingsTranslations,
};
