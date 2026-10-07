// Tooling aggregate. Product locale roots import only their locale payload.
import { voiceDiagnosticsTranslations as ca } from './features/ca';
import { voiceDiagnosticsTranslations as es } from './features/es';
import { voiceDiagnosticsTranslations as fr } from './features/fr';
import { voiceDiagnosticsTranslations as it } from './features/it';
import { voiceDiagnosticsTranslations as ja } from './features/ja';
import { voiceDiagnosticsTranslations as pl } from './features/pl';
import { voiceDiagnosticsTranslations as pt } from './features/pt';
import { voiceDiagnosticsTranslations as ru } from './features/ru';
import { voiceDiagnosticsTranslations as zh_Hans } from './features/zh-Hans';
import { voiceDiagnosticsTranslations as zh_Hant } from './features/zh-Hant';

export const voiceDiagnosticsTranslations = {
    ...ca.voiceDiagnosticsTranslations,
    ...es.voiceDiagnosticsTranslations,
    ...fr.voiceDiagnosticsTranslations,
    ...it.voiceDiagnosticsTranslations,
    ...ja.voiceDiagnosticsTranslations,
    ...pl.voiceDiagnosticsTranslations,
    ...pt.voiceDiagnosticsTranslations,
    ...ru.voiceDiagnosticsTranslations,
    ...zh_Hans.voiceDiagnosticsTranslations,
    ...zh_Hant.voiceDiagnosticsTranslations,
};
