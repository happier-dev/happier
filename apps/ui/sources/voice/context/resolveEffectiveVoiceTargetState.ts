import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
    areSessionAddressesEqual,
    normalizeSessionAddress,
    type SessionAddress,
} from '@/sync/domains/session/sessionAddress';
import { storage } from '@/sync/domains/state/storage';
import { resolveActiveLocalVoiceAgentBinding } from '@/voice/context/resolveActiveLocalVoiceAgentBinding';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { resolveVoiceSessionRef } from '@/voice/tools/actionImpl/sessionReference';

function resolveAddress(target: SessionAddress | string | null | undefined): SessionAddress | null {
    if (target && typeof target === 'object') {
        return normalizeSessionAddress(target.serverId, target.sessionId);
    }
    const sessionId = normalizeNonEmptyString(target);
    if (!sessionId) return null;
    return resolveVoiceSessionRef(sessionId, storage.getState(), {
        activeServerId: getActiveServerSnapshot().serverId,
    })?.address ?? null;
}

export function resolveEffectiveVoiceTargetState(
    target: SessionAddress | string,
    options?: Readonly<{
        targetSessionAddress?: SessionAddress | null;
        /** Persisted/pre-migration binding adapter. It resolves only with an unambiguous local origin. */
        targetSessionId?: string | null;
    }>,
): Readonly<{
    primaryActionSessionAddress: SessionAddress | null;
    voiceLiveContextSessionAddresses: ReadonlyArray<SessionAddress>;
}> {
    const store = useVoiceTargetStore.getState();
    const voiceLiveContextSessionAddresses = Array.isArray(store.voiceLiveContextSessionAddresses)
        ? store.voiceLiveContextSessionAddresses
        : [];
    const currentAddress = resolveAddress(target);
    const explicitTargetAddress = resolveAddress(
        options?.targetSessionAddress ?? normalizeNonEmptyString(options?.targetSessionId),
    );
    const activeLocalBinding = resolveActiveLocalVoiceAgentBinding();
    const boundTargetAddress = activeLocalBinding?.binding
        ? activeLocalBinding.binding.targetSessionAddress
        : explicitTargetAddress;
    const primaryActionSessionAddress = activeLocalBinding?.binding || explicitTargetAddress
        ? boundTargetAddress : store.primaryActionSessionAddress;

    if (!currentAddress || !areSessionAddressesEqual(boundTargetAddress, currentAddress)) {
        return {
            primaryActionSessionAddress,
            voiceLiveContextSessionAddresses,
        };
    }

    return {
        primaryActionSessionAddress: currentAddress,
        voiceLiveContextSessionAddresses: voiceLiveContextSessionAddresses.some((address) =>
            areSessionAddressesEqual(address, currentAddress))
            ? voiceLiveContextSessionAddresses
            : [...voiceLiveContextSessionAddresses, currentAddress],
    };
}
