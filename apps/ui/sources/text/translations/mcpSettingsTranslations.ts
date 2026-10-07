// Tooling aggregate. Product locale roots import only their locale payload.
import { mcpSettingsTranslations as en } from './features/en';
import { mcpSettingsTranslations as ca } from './features/ca';
import { mcpSettingsTranslations as de } from './features/de';
import { mcpSettingsTranslations as es } from './features/es';
import { mcpSettingsTranslations as fr } from './features/fr';
import { mcpSettingsTranslations as it } from './features/it';
import { mcpSettingsTranslations as ja } from './features/ja';
import { mcpSettingsTranslations as pl } from './features/pl';
import { mcpSettingsTranslations as pt } from './features/pt';
import { mcpSettingsTranslations as ru } from './features/ru';
import { mcpSettingsTranslations as zh_Hans } from './features/zh-Hans';
import { mcpSettingsTranslations as zh_Hant } from './features/zh-Hant';

export const mcpSettingsTranslations = {
    ...en.mcpSettingsTranslations,
    ...ca.mcpSettingsTranslations,
    ...de.mcpSettingsTranslations,
    ...es.mcpSettingsTranslations,
    ...fr.mcpSettingsTranslations,
    ...it.mcpSettingsTranslations,
    ...ja.mcpSettingsTranslations,
    ...pl.mcpSettingsTranslations,
    ...pt.mcpSettingsTranslations,
    ...ru.mcpSettingsTranslations,
    ...zh_Hans.mcpSettingsTranslations,
    ...zh_Hant.mcpSettingsTranslations,
};
