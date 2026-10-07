// Tooling aggregate. Product locale roots import only their locale payload.
import { voiceLocalCredentialTranslations as ca } from './features/ca';
import { voiceLocalCredentialTranslations as es } from './features/es';
import { voiceLocalCredentialTranslations as fr } from './features/fr';
import { voiceLocalCredentialTranslations as it } from './features/it';
import { voiceLocalCredentialTranslations as ja } from './features/ja';
import { voiceLocalCredentialTranslations as pl } from './features/pl';
import { voiceLocalCredentialTranslations as pt } from './features/pt';
import { voiceLocalCredentialTranslations as ru } from './features/ru';
import { voiceLocalCredentialTranslations as zh_Hans } from './features/zh-Hans';
import { voiceLocalCredentialTranslations as zh_Hant } from './features/zh-Hant';

export const voiceLocalCredentialTranslations = {
    ...ca.voiceLocalCredentialTranslations,
    ...es.voiceLocalCredentialTranslations,
    ...fr.voiceLocalCredentialTranslations,
    ...it.voiceLocalCredentialTranslations,
    ...ja.voiceLocalCredentialTranslations,
    ...pl.voiceLocalCredentialTranslations,
    ...pt.voiceLocalCredentialTranslations,
    ...ru.voiceLocalCredentialTranslations,
    ...zh_Hans.voiceLocalCredentialTranslations,
    ...zh_Hant.voiceLocalCredentialTranslations,
};
