// Tooling aggregate. Product locale roots import only their locale payload.
import { automationTriggerSetTranslations as ca } from './features/ca';
import { automationTriggerSetTranslations as de } from './features/de';
import { automationTriggerSetTranslations as es } from './features/es';
import { automationTriggerSetTranslations as fr } from './features/fr';
import { automationTriggerSetTranslations as it } from './features/it';
import { automationTriggerSetTranslations as ja } from './features/ja';
import { automationTriggerSetTranslations as pl } from './features/pl';
import { automationTriggerSetTranslations as pt } from './features/pt';
import { automationTriggerSetTranslations as ru } from './features/ru';
import { automationTriggerSetTranslations as zh_Hans } from './features/zh-Hans';
import { automationTriggerSetTranslations as zh_Hant } from './features/zh-Hant';

export const automationTriggerSetTranslations = {
    ...ca.automationTriggerSetTranslations,
    ...de.automationTriggerSetTranslations,
    ...es.automationTriggerSetTranslations,
    ...fr.automationTriggerSetTranslations,
    ...it.automationTriggerSetTranslations,
    ...ja.automationTriggerSetTranslations,
    ...pl.automationTriggerSetTranslations,
    ...pt.automationTriggerSetTranslations,
    ...ru.automationTriggerSetTranslations,
    ...zh_Hans.automationTriggerSetTranslations,
    ...zh_Hant.automationTriggerSetTranslations,
};
