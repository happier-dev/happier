// Tooling aggregate. Product locale roots import only their locale payload.
import { voiceRealtimeProviderSetupTranslations as ca } from './features/ca';
import { voiceRealtimeProviderSetupTranslations as es } from './features/es';
import { voiceRealtimeProviderSetupTranslations as fr } from './features/fr';
import { voiceRealtimeProviderSetupTranslations as it } from './features/it';
import { voiceRealtimeProviderSetupTranslations as ja } from './features/ja';
import { voiceRealtimeProviderSetupTranslations as pl } from './features/pl';
import { voiceRealtimeProviderSetupTranslations as pt } from './features/pt';
import { voiceRealtimeProviderSetupTranslations as ru } from './features/ru';
import { voiceRealtimeProviderSetupTranslations as zh_Hans } from './features/zh-Hans';
import { voiceRealtimeProviderSetupTranslations as zh_Hant } from './features/zh-Hant';

export const voiceRealtimeProviderSetupTranslations = {
    ...ca.voiceRealtimeProviderSetupTranslations,
    ...es.voiceRealtimeProviderSetupTranslations,
    ...fr.voiceRealtimeProviderSetupTranslations,
    ...it.voiceRealtimeProviderSetupTranslations,
    ...ja.voiceRealtimeProviderSetupTranslations,
    ...pl.voiceRealtimeProviderSetupTranslations,
    ...pt.voiceRealtimeProviderSetupTranslations,
    ...ru.voiceRealtimeProviderSetupTranslations,
    ...zh_Hans.voiceRealtimeProviderSetupTranslations,
    ...zh_Hant.voiceRealtimeProviderSetupTranslations,
};
