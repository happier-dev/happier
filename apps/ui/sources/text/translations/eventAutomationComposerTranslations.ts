// Tooling aggregate. Product locale roots import only their locale payload.
import { eventAutomationComposerTranslations as en } from './features/en';
import { eventAutomationComposerTranslations as ca } from './features/ca';
import { eventAutomationComposerTranslations as de } from './features/de';
import { eventAutomationComposerTranslations as es } from './features/es';
import { eventAutomationComposerTranslations as fr } from './features/fr';
import { eventAutomationComposerTranslations as it } from './features/it';
import { eventAutomationComposerTranslations as ja } from './features/ja';
import { eventAutomationComposerTranslations as pl } from './features/pl';
import { eventAutomationComposerTranslations as pt } from './features/pt';
import { eventAutomationComposerTranslations as ru } from './features/ru';
import { eventAutomationComposerTranslations as zh_Hans } from './features/zh-Hans';
import { eventAutomationComposerTranslations as zh_Hant } from './features/zh-Hant';

export const eventAutomationComposerTranslations = {
    ...en.eventAutomationComposerTranslations,
    ...ca.eventAutomationComposerTranslations,
    ...de.eventAutomationComposerTranslations,
    ...es.eventAutomationComposerTranslations,
    ...fr.eventAutomationComposerTranslations,
    ...it.eventAutomationComposerTranslations,
    ...ja.eventAutomationComposerTranslations,
    ...pl.eventAutomationComposerTranslations,
    ...pt.eventAutomationComposerTranslations,
    ...ru.eventAutomationComposerTranslations,
    ...zh_Hans.eventAutomationComposerTranslations,
    ...zh_Hant.eventAutomationComposerTranslations,
};
