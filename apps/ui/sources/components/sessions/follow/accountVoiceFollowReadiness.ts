import { supportsMachineSessionFollowContextV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import type { VoiceHostAuthoredContextScope } from '@/voice/session/types';

export type AccountVoiceFollowReadiness = 'waiting_for_runtime' | 'runtime_unsupported' | 'provider_withheld' | 'waiting_encrypted' | 'pending' | 'eligible';

export function resolveAccountVoiceFollowReadiness(input: Readonly<{
    scopeCurrent: boolean;
    contextScope: VoiceHostAuthoredContextScope | null;
    adapterPresent: boolean;
    machine: Readonly<{ operationProtocolCapabilities?: unknown }> | null;
    sourceEncrypted: boolean;
    sourceKeyReady: boolean;
    initialSnapshotPending: boolean;
}>): AccountVoiceFollowReadiness {
    if (!input.scopeCurrent || !input.adapterPresent) return 'waiting_for_runtime';
    if (input.contextScope === 'current_ui_only') return 'provider_withheld';
    if (input.contextScope !== 'session_context') return 'runtime_unsupported';
    if (!input.machine) return 'waiting_for_runtime';
    if (!supportsMachineSessionFollowContextV1(input.machine.operationProtocolCapabilities)) {
        return 'runtime_unsupported';
    }
    if (input.sourceEncrypted && !input.sourceKeyReady) return 'waiting_encrypted';
    return input.initialSnapshotPending ? 'pending' : 'eligible';
}
