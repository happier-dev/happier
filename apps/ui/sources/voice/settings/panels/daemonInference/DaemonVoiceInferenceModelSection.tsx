import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { formatDownloadProgressDetail } from '@/voice/downloads/downloadProgress';
import { DaemonVoiceInferenceClient } from '@/voice/runtime/daemonInference/DaemonVoiceInferenceClient';
import type { VoiceDaemonRouteDiagnosticReason } from '@/voice/settings/voiceProviderLocalAvailability';

import { useDaemonVoiceInferenceModelState } from './useDaemonVoiceInferenceModelState';

function resolveServiceDetail(
    serviceState: ReturnType<typeof useDaemonVoiceInferenceModelState>['state']['serviceState'],
    errorCode: ReturnType<typeof useDaemonVoiceInferenceModelState>['state']['errorCode'],
    daemonRouteDiagnosticReason: VoiceDaemonRouteDiagnosticReason | null | undefined,
): string {
    if (daemonRouteDiagnosticReason === 'daemon_relay_disabled') {
        return t('settingsVoice.local.daemonInference.states.relayDisabled');
    }
    if (daemonRouteDiagnosticReason === 'daemon_relay_capped') {
        return t('settingsVoice.local.daemonInference.states.relayCapped');
    }
    if (errorCode === 'machine_unreachable') {
        return t('settingsVoice.local.daemonInference.states.machineUnreachable');
    }
    if (errorCode === 'feature_disabled') {
        return t('settingsVoice.local.daemonInference.states.unavailable');
    }
    if (errorCode === 'runtime_unavailable') {
        return t('settingsVoice.local.daemonInference.states.runtimeUnavailable');
    }
    if (serviceState === 'warming') {
        return t('settingsVoice.local.daemonInference.states.warming');
    }
    if (serviceState === 'ready') {
        return t('settingsVoice.local.daemonInference.states.ready');
    }
    if (serviceState === 'degraded') {
        return t('settingsVoice.local.daemonInference.states.degraded');
    }
    if (serviceState === 'idle') {
        return t('settingsVoice.local.daemonInference.states.idle');
    }
    return t('settingsVoice.local.daemonInference.states.unavailable');
}

function resolveModelDetail(
    state: ReturnType<typeof useDaemonVoiceInferenceModelState>['state'],
): string {
    if (state.actionInFlight === 'install') {
        return t('settingsVoice.local.daemonInference.states.installing');
    }
    if (state.model?.installState === 'installing' && state.model.progress) {
        return formatDownloadProgressDetail(state.model.progress, {
            prefix: t('settingsVoice.local.daemonInference.states.installing'),
        });
    }
    if (state.model?.installState === 'installed') {
        return t('settingsVoice.local.daemonInference.states.installed');
    }
    if (state.model?.installState === 'error') {
        return t('settingsVoice.local.daemonInference.states.installError');
    }
    return t('settingsVoice.local.daemonInference.states.notInstalled');
}

export function DaemonVoiceInferenceModelSection(props: Readonly<{
    packId: string | null;
    kind: 'tts' | 'stt';
    client?: Pick<DaemonVoiceInferenceClient, 'getStatus' | 'getModelsStatus' | 'installModel' | 'removeModel'>;
    daemonRouteDiagnosticReason?: VoiceDaemonRouteDiagnosticReason | null;
}>): React.ReactElement {
    const { state, refresh, install, remove } = useDaemonVoiceInferenceModelState({
        packId: props.packId,
        client: props.client,
    });

    return (
        <>
            <Item
                title={t('settingsVoice.local.daemonInference.service.title')}
                subtitle={t('settingsVoice.local.daemonInference.service.subtitle')}
                detail={resolveServiceDetail(state.serviceState, state.errorCode, props.daemonRouteDiagnosticReason)}
                onPress={() => {
                    fireAndForget(refresh(), { tag: 'DaemonVoiceInferenceModelSection.refreshService' });
                }}
                showChevron={false}
                selected={false}
            />

            <Item
                title={t('settingsVoice.local.daemonInference.model.title')}
                subtitle={props.kind === 'tts'
                    ? t('settingsVoice.local.daemonInference.model.subtitleTts')
                    : t('settingsVoice.local.daemonInference.model.subtitleStt')}
                detail={resolveModelDetail(state)}
                onPress={() => {
                    if (!props.packId) {
                        return;
                    }
                    const action = state.model?.installState === 'installed' ? refresh : install;
                    fireAndForget(action(), { tag: 'DaemonVoiceInferenceModelSection.modelAction' });
                }}
                showChevron={false}
                selected={false}
            />

            <Item
                title={t('settingsVoice.local.daemonInference.remove.title')}
                subtitle={t('settingsVoice.local.daemonInference.remove.subtitle')}
                detail={state.model?.installState === 'installed'
                    ? t('settingsVoice.local.daemonInference.remove.detailInstalled')
                    : t('common.none')}
                onPress={state.model?.installState === 'installed'
                    ? () => {
                        fireAndForget(remove(), { tag: 'DaemonVoiceInferenceModelSection.removeModel' });
                    }
                    : undefined}
                showChevron={false}
                selected={false}
            />
        </>
    );
}
