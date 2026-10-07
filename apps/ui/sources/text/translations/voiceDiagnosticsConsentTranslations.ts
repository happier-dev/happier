// Tooling aggregate. Product locale roots import only their locale payload.
import { voiceDiagnosticsConsentTranslations as ca } from './features/ca';
import { voiceDiagnosticsConsentTranslations as es } from './features/es';
import { voiceDiagnosticsConsentTranslations as fr } from './features/fr';
import { voiceDiagnosticsConsentTranslations as it } from './features/it';
import { voiceDiagnosticsConsentTranslations as ja } from './features/ja';
import { voiceDiagnosticsConsentTranslations as pl } from './features/pl';
import { voiceDiagnosticsConsentTranslations as pt } from './features/pt';
import { voiceDiagnosticsConsentTranslations as ru } from './features/ru';
import { voiceDiagnosticsConsentTranslations as zh_Hans } from './features/zh-Hans';
import { voiceDiagnosticsConsentTranslations as zh_Hant } from './features/zh-Hant';

export const voiceDiagnosticsConsentTranslations = {
    ...ca.voiceDiagnosticsConsentTranslations,
    ...es.voiceDiagnosticsConsentTranslations,
    ...fr.voiceDiagnosticsConsentTranslations,
    ...it.voiceDiagnosticsConsentTranslations,
    ...ja.voiceDiagnosticsConsentTranslations,
    ...pl.voiceDiagnosticsConsentTranslations,
    ...pt.voiceDiagnosticsConsentTranslations,
    ...ru.voiceDiagnosticsConsentTranslations,
    ...zh_Hans.voiceDiagnosticsConsentTranslations,
    ...zh_Hant.voiceDiagnosticsConsentTranslations,
};
