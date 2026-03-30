import { tLoose, type TranslationKey } from '@/text';
import type { SystemTaskRunState } from '@/components/systemTasks/types';

const LOCAL_CONTROL_STEP_LABELS = {
    'relay.status.inspect': 'settings.localRelayRuntime.progressStepInspect',
    'relay.status.health': 'settings.localRelayRuntime.progressStepHealth',
    'relay.install': 'settings.localRelayRuntime.progressStepInstall',
    'relay.start': 'settings.localRelayRuntime.progressStepStart',
    'relay.stop': 'settings.localRelayRuntime.progressStepStop',
    'detect': 'settings.localTailscale.progressStepDetect',
    'install': 'settings.localTailscale.progressStepInstall',
    'login': 'settings.localTailscale.progressStepLogin',
    'serve enable': 'settings.localTailscale.progressStepServeEnable',
    'verify url': 'settings.localTailscale.progressStepVerifyUrl',
} as const satisfies Readonly<Record<string, TranslationKey>>;

export function decorateLocalControlSnapshot(snapshot: SystemTaskRunState): SystemTaskRunState {
    const translationKey = snapshot.currentStepId
        ? (LOCAL_CONTROL_STEP_LABELS as Readonly<Record<string, TranslationKey>>)[snapshot.currentStepId] ?? null
        : null;
    if (!translationKey) {
        return snapshot;
    }
    return {
        ...snapshot,
        currentStepId: tLoose(translationKey),
    };
}
