import { describe, expect, it } from 'vitest';

import { ca } from './translations/ca';
import { en } from './translations/en';
import { es } from './translations/es';
import { it as itLocale } from './translations/it';
import { ja } from './translations/ja';
import { pl } from './translations/pl';
import { pt } from './translations/pt';
import { ru } from './translations/ru';
import { zhHans } from './translations/zh-Hans';
import { zhHant } from './translations/zh-Hant';

type VoiceDaemonInferenceStateKey =
    | 'machineUnreachable'
    | 'unavailable'
    | 'runtimeUnavailable'
    | 'warming'
    | 'ready'
    | 'degraded'
    | 'idle'
    | 'installing'
    | 'installed'
    | 'installError'
    | 'notInstalled'
    | 'latencyDemoted'
    | 'fallbackToDevice';

type VoiceTranslationLocale = Readonly<{
    settingsVoice: Readonly<{
        local: Readonly<{
            daemonInference: Readonly<{
                states: Readonly<Record<VoiceDaemonInferenceStateKey, string>>;
            }>;
        }>;
    }>;
}>;

const supportedLocales = [
    { code: 'ru', root: ru },
    { code: 'pl', root: pl },
    { code: 'es', root: es },
    { code: 'it', root: itLocale },
    { code: 'pt', root: pt },
    { code: 'ca', root: ca },
    { code: 'zh-Hans', root: zhHans },
    { code: 'zh-Hant', root: zhHant },
    { code: 'ja', root: ja },
] satisfies ReadonlyArray<Readonly<{ code: string; root: VoiceTranslationLocale }>>;

const voiceDaemonInferenceStateKeys: ReadonlyArray<VoiceDaemonInferenceStateKey> = [
    'machineUnreachable',
    'unavailable',
    'runtimeUnavailable',
    'warming',
    'ready',
    'degraded',
    'idle',
    'installing',
    'installed',
    'installError',
    'notInstalled',
    'latencyDemoted',
    'fallbackToDevice',
];

describe('voice daemon inference translations', () => {
    it('keeps daemon inference state labels present in every supported locale', () => {
        for (const { code, root } of supportedLocales) {
            const daemonInference = root.settingsVoice?.local?.daemonInference;
            if (!daemonInference) {
                throw new Error(`${code}: settingsVoice.local.daemonInference is missing`);
            }
            const states = daemonInference.states;
            for (const key of voiceDaemonInferenceStateKeys) {
                expect(states[key], `${code}.${key}`).toEqual(expect.any(String));
                expect(states[key].trim(), `${code}.${key}`).not.toHaveLength(0);
            }
        }
    });
});
