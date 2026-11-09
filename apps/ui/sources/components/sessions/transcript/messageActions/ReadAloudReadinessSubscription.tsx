import * as React from 'react';

import { useSetting } from '@/sync/domains/state/storage';
import type { VoiceRoleReadiness } from '@/voice/registry/readiness';
import { useVoiceSettingsReadinessInputs } from '@/voice/settings/useVoiceSettingsReadinessInputs';
import { useVoiceConversationsReadinessModel } from '@/voice/settings/panels/VoiceProviderSection';

const retainVoiceSettings = () => {};
export type ReadAloudReadiness = Pick<VoiceRoleReadiness, 'status' | 'code' | 'reasonKey' | 'recoveryAction'>;

/** A revealed assistant action acquires the same selected Speak role as Voice setup. */
export function ReadAloudReadinessSubscription(props: Readonly<{
    onChange: (readiness: ReadAloudReadiness | null) => void;
}>) {
    const voice = useSetting('voice');
    const inputs = useVoiceSettingsReadinessInputs(voice, { purpose: 'conversation', probeMachine: true });
    const model = useVoiceConversationsReadinessModel({
        voice, setVoice: retainVoiceSettings, rowScope: 'selected',
        happierVoiceSupported: inputs.happierVoiceSupported,
        localAvailability: inputs.localAvailability,
        executionMachineId: inputs.executionMachine.machineId,
        executionMachineSelectedId: inputs.executionMachine.selectedMachineId,
        executionMachineSelectionKind: inputs.executionMachine.selectionKind,
    });
    const status = model.selectedLocalSpeechReadiness?.speak?.status ?? null;
    const reasonKey = model.selectedLocalSpeechReadiness?.speak?.reasonKey ?? null;
    const code = model.selectedLocalSpeechReadiness?.speak?.code ?? null;
    const recoveryAction = model.selectedLocalSpeechReadiness?.speak?.recoveryAction ?? null;
    React.useLayoutEffect(() => {
        props.onChange(status && reasonKey && code && recoveryAction ? { status, reasonKey, code, recoveryAction } : null);
        return () => props.onChange(null);
    }, [props.onChange, status, reasonKey, code, recoveryAction]);
    return null;
}
