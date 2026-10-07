// Tooling aggregate. Product locale roots import only their locale payload.
import { agentStartTranslations as en } from './features/en';
import { agentStartTranslations as ca } from './features/ca';
import { agentStartTranslations as de } from './features/de';
import { agentStartTranslations as es } from './features/es';
import { agentStartTranslations as fr } from './features/fr';
import { agentStartTranslations as it } from './features/it';
import { agentStartTranslations as ja } from './features/ja';
import { agentStartTranslations as pl } from './features/pl';
import { agentStartTranslations as pt } from './features/pt';
import { agentStartTranslations as ru } from './features/ru';
import { agentStartTranslations as zh_Hans } from './features/zh-Hans';
import { agentStartTranslations as zh_Hant } from './features/zh-Hant';

export const agentStartTranslations = {
    ...en.agentStartTranslations,
    ...ca.agentStartTranslations,
    ...de.agentStartTranslations,
    ...es.agentStartTranslations,
    ...fr.agentStartTranslations,
    ...it.agentStartTranslations,
    ...ja.agentStartTranslations,
    ...pl.agentStartTranslations,
    ...pt.agentStartTranslations,
    ...ru.agentStartTranslations,
    ...zh_Hans.agentStartTranslations,
    ...zh_Hant.agentStartTranslations,
};
