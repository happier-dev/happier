import * as React from 'react';

import { useSetting } from '@/sync/domains/state/storage';
import type { VoiceRoleReadiness } from '@/voice/registry/readiness';
import { useVoiceSettingsReadinessInputs } from '@/voice/settings/useVoiceSettingsReadinessInputs';
import { useVoiceConversationsReadinessModel } from '@/voice/settings/panels/VoiceProviderSection';

const retainVoiceSettings = () => {};
export type ReadAloudReadiness = Pick<VoiceRoleReadiness, 'status' | 'reasonKey'>;

/** A revealed assistant action observes the same selected Speak role as Voice setup, without probing. */
export function ReadAloudReadinessSubscription(props: Readonly<{
    onChange: (readiness: ReadAloudReadiness | null) => void;
}>) {
    const voice = useSetting('voice');
    const inputs = useVoiceSettingsReadinessInputs(voice, { purpose: 'conversation', probeMachine: false });
    const model = useVoiceConversationsReadinessModel({
        voice, setVoice: retainVoiceSettings, rowScope: 'selected',
        happierVoiceSupported: inputs.happierVoiceSupported,
        localAvailability: inputs.localAvailability,
        executionMachineId: inputs.executionMachine.machineId,
        executionMachineSelectedId: inputs.executionMachine.selectedMachineId,
        executionMachineSelectionKind: inputs.executionMachine.kind,
    });
    const status = model.selectedLocalSpeechReadiness?.speak?.status ?? null;
    const reasonKey = model.selectedLocalSpeechReadiness?.speak?.reasonKey ?? null;
    React.useLayoutEffect(() => {
        props.onChange(status && reasonKey ? { status, reasonKey } : null);
        return () => props.onChange(null);
    }, [props.onChange, status, reasonKey]);
    return null;
}
