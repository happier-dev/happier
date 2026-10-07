// Tooling aggregate. Product locale roots import only their locale payload.
import { homesHubTranslations as en } from './features/en';
import { homesHubTranslations as ca } from './features/ca';
import { homesHubTranslations as de } from './features/de';
import { homesHubTranslations as es } from './features/es';
import { homesHubTranslations as fr } from './features/fr';
import { homesHubTranslations as it } from './features/it';
import { homesHubTranslations as ja } from './features/ja';
import { homesHubTranslations as pl } from './features/pl';
import { homesHubTranslations as pt } from './features/pt';
import { homesHubTranslations as ru } from './features/ru';
import { homesHubTranslations as zh_Hans } from './features/zh-Hans';
import { homesHubTranslations as zh_Hant } from './features/zh-Hant';

export const homesHubTranslations = {
    ...en.homesHubTranslations,
    ...ca.homesHubTranslations,
    ...de.homesHubTranslations,
    ...es.homesHubTranslations,
    ...fr.homesHubTranslations,
    ...it.homesHubTranslations,
    ...ja.homesHubTranslations,
    ...pl.homesHubTranslations,
    ...pt.homesHubTranslations,
    ...ru.homesHubTranslations,
    ...zh_Hans.homesHubTranslations,
    ...zh_Hant.homesHubTranslations,
};
