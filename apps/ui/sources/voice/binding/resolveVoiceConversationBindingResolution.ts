import {
    ensureVoiceConversationSessionForSessionRoot,
    ensureVoiceConversationSessionForVoiceHome,
} from '@/voice/persistence/voiceConversationSession';
import { applyRecoveredGlobalVoiceMachineDecision } from '@/voice/agent/applyRecoveredGlobalVoiceMachineDecision';
import { recoverUnavailableGlobalVoiceAutoMachine } from '@/voice/agent/recoverUnavailableGlobalVoiceAutoMachine';
import { shouldRecoverUnavailableGlobalVoiceAutoMachine } from '@/voice/agent/shouldRecoverUnavailableGlobalVoiceAutoMachine';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { getVoiceAdapterRegistry } from '@/voice/session/voiceAdapterRegistry';
import type { VoiceAdapterTranscriptMode } from '@/voice/session/types';

import type { VoiceConversationBindingResolution, VoiceConversationSelection } from './voiceConversationBindingTypes';
import { readLocalConversationVoiceSettings, voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areSessionAddressesEqual, normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { storage } from '@/sync/domains/state/storage';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';
import { isVoiceConversationSystemSessionMetadata, shouldRetireLegacyVoiceConversationSession } from '@/voice/persistence/voiceConversationSystemSessionLookup';
import { readVoiceConversationScopeMetadata } from '@/voice/persistence/voiceConversationScopeMetadata';
import { readPreferredVoiceConversationBindingMetadata } from './voiceConversationBindingMetadata';
import { sync } from '@/sync/sync';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveVoiceConversationSelection } from './resolveVoiceConversationSelection';

/**
 * Read the provider-owned transcript-mode decision for a voice adapter from the
 * registry. Generic binding code does not branch on provider ids: each adapter
 * exposes `resolveBindingTranscriptMode` (a capability) that returns the mode or
 * `null` when it has no hidden voice conversation session for these settings.
 */
function resolveBindingTranscriptMode(
    providerId: string,
    settings: unknown,
): VoiceAdapterTranscriptMode | null {
    const adapter = getVoiceAdapterRegistry().get(providerId);
    return adapter?.resolveBindingTranscriptMode?.(settings) ?? null;
}

function shouldForceVoiceHomeForLocalConversation(settings: any): boolean {
    const config = readLocalConversationVoiceSettings(voiceSettingsParse(settings?.voice));
    return config?.agent?.stayInVoiceHome === true;
}

async function ensureVoiceHomeConversationSessionIdWithRecovery(params: Readonly<{
    transcriptMode: VoiceAdapterTranscriptMode;
    controlSessionId: string;
    settings: any;
    signal?: AbortSignal;
    conversationSelection?: VoiceConversationSelection;
}>): Promise<string> {
    try {
        return await ensureVoiceConversationSessionForVoiceHome(null, params.signal, params.conversationSelection);
    } catch (error) {
        if (params.conversationSelection?.kind === 'continue') throw error;
        const isGlobalNativeSessionVoiceAgent =
            params.controlSessionId === VOICE_AGENT_GLOBAL_SESSION_ID
            && params.transcriptMode === 'native_session';
        if (!isGlobalNativeSessionVoiceAgent) throw error;
        if (!shouldRecoverUnavailableGlobalVoiceAutoMachine(error)) throw error;
        const recoveryDecision = await recoverUnavailableGlobalVoiceAutoMachine();
        if (recoveryDecision.kind !== 'retry' && recoveryDecision.kind !== 'switch') throw error;
        applyRecoveredGlobalVoiceMachineDecision(recoveryDecision);
        return await ensureVoiceConversationSessionForVoiceHome(null, params.signal, params.conversationSelection);
    }
}

function resolveHiddenCarrierLogicalTarget(conversationSessionAddress: SessionAddress, metadata: unknown): SessionAddress | null {
    const existing = readPreferredVoiceConversationBindingMetadata({
        conversationSessionId: conversationSessionAddress.sessionId,
        preferredMetadata: metadata,
        sourceServerId: conversationSessionAddress.serverId,
    });
    if (existing && !areSessionAddressesEqual(existing.targetSessionAddress, conversationSessionAddress)) {
        return existing.targetSessionAddress;
    }
    const scope = readVoiceConversationScopeMetadata(metadata);
    if (scope?.kind === 'voice_home') return null;
    const rootAddress = scope?.kind === 'session_root'
        ? normalizeSessionAddress(conversationSessionAddress.serverId, scope.sessionRootId) : null;
    if (rootAddress && !areSessionAddressesEqual(rootAddress, conversationSessionAddress)) return rootAddress;
    // Existing self targets came from treating the carrier as a coding Session.
    // Only its recorded scope can recover that lost target; never chase carriers.
    if (existing || scope?.kind === 'session_root') {
        throw Object.assign(new Error('session_unavailable'), { code: 'session_unavailable' });
    }
    return null;
}

export async function ensureVoiceConversationBindingResolution(params: Readonly<{
    providerId: string;
    controlSessionId: string;
    requestedTargetSessionId?: string | null;
    requestedTargetServerId?: string | null;
    settings: any;
    signal?: AbortSignal;
    conversationSelection?: VoiceConversationSelection;
    onConversationSelection?: (selection: VoiceConversationSelection) => void;
}>): Promise<VoiceConversationBindingResolution | null> {
    const providerId = normalizeNonEmptyString(params.providerId);
    if (!providerId) return null;
    const controlSessionId = normalizeNonEmptyString(params.controlSessionId);
    if (!controlSessionId) return null;
    const targetSessionId = normalizeNonEmptyString(params.requestedTargetSessionId);
    const targetServerId = normalizeNonEmptyString(params.requestedTargetServerId)
        ?? normalizeNonEmptyString(getActiveServerSnapshot().serverId);
    const targetSessionAddress = normalizeSessionAddress(targetServerId, targetSessionId);
    // Direct-native binding owns its exact Session/thread. It must run before
    // ordinary idle policy could select a new executable conversation.
    const providerOwnedResolution = await getVoiceAdapterRegistry().get(providerId)?.resolveConversationBinding?.({
        controlSessionId,
        requestedTargetSessionAddress: targetSessionAddress,
        settings: params.settings,
        signal: params.signal,
        conversationSelection: params.conversationSelection,
        onConversationSelection: params.onConversationSelection,
    });
    const providerConversationSessionAddress = providerOwnedResolution
        ? normalizeSessionAddress(
            providerOwnedResolution.conversationSessionAddress.serverId,
            providerOwnedResolution.conversationSessionAddress.sessionId,
        ) : null;
    if (providerOwnedResolution && !providerConversationSessionAddress) return null;

    const transcriptMode = providerOwnedResolution?.transcriptMode ?? resolveBindingTranscriptMode(providerId, params.settings);
    if (!transcriptMode) return null;

    const needsRequestedMetadata = !providerOwnedResolution
        || areSessionAddressesEqual(targetSessionAddress, providerConversationSessionAddress);
    let requestedMetadata = needsRequestedMetadata && targetSessionAddress
        ? readVoiceSessionOwnerMetadataFromState(storage.getState(), targetSessionAddress) : null;
    if (needsRequestedMetadata && targetSessionAddress && !requestedMetadata
        && areServerProfileIdentifiersEquivalent(targetSessionAddress.serverId, getActiveServerSnapshot().serverId)) {
        await sync.ensureSessionVisibleForMessageRoute(targetSessionAddress.sessionId, { serverId: targetSessionAddress.serverId });
        requestedMetadata = readVoiceSessionOwnerMetadataFromState(storage.getState(), targetSessionAddress);
    }
    const requestedCarrierAddress = targetSessionAddress && isVoiceConversationSystemSessionMetadata(requestedMetadata)
        && !shouldRetireLegacyVoiceConversationSession({ metadata: requestedMetadata }) ? targetSessionAddress : null;
    if (providerOwnedResolution && providerConversationSessionAddress) {
        const providerMetadata = readVoiceSessionOwnerMetadataFromState(storage.getState(), providerConversationSessionAddress);
        const isProviderCarrier = isVoiceConversationSystemSessionMetadata(providerMetadata)
            && !shouldRetireLegacyVoiceConversationSession({ metadata: providerMetadata });
        return {
            controlSessionId,
            conversationSessionId: providerConversationSessionAddress.sessionId,
            conversationSessionAddress: providerConversationSessionAddress,
            transcriptMode,
            targetSessionAddress: isProviderCarrier && (!targetSessionAddress
                || areSessionAddressesEqual(targetSessionAddress, providerConversationSessionAddress))
                ? resolveHiddenCarrierLogicalTarget(providerConversationSessionAddress, providerMetadata)
                : providerOwnedResolution.targetSessionAddress,
        };
    }
    const conversationSelection = resolveVoiceConversationSelection({
        settings: params.settings ?? {},
        conversationSelection: params.conversationSelection,
        requestedConversationSessionAddress: requestedCarrierAddress,
    });
    params.onConversationSelection?.(conversationSelection);
    if (conversationSelection.kind === 'continue') {
        const address = conversationSelection.conversationSessionAddress;
        let metadata = readVoiceSessionOwnerMetadataFromState(storage.getState(), address);
        if (!metadata && areServerProfileIdentifiersEquivalent(address.serverId, getActiveServerSnapshot().serverId)) {
            await sync.ensureSessionVisibleForMessageRoute(address.sessionId, { serverId: address.serverId, hydrateMessages: false });
            params.signal?.throwIfAborted();
            metadata = readVoiceSessionOwnerMetadataFromState(storage.getState(), address);
        }
        const logicalTargetSessionAddress = targetSessionAddress && !requestedCarrierAddress
            ? targetSessionAddress : resolveHiddenCarrierLogicalTarget(address, metadata);
        const conversationSessionId = await ensureVoiceConversationSessionForSessionRoot({
            sessionRootAddress: address, signal: params.signal, conversationSelection,
        });
        return { controlSessionId, conversationSessionId,
            conversationSessionAddress: { serverId: address.serverId, sessionId: conversationSessionId }, transcriptMode,
            targetSessionAddress: logicalTargetSessionAddress };
    }

    // The hidden conversation Session belongs to the same Home as its root Session: for the
    // global voice agent that is the resolved target address, and for a Session-attached
    // control session it is that Session in the Home the request was scoped to.
    const rootSessionAddress = requestedCarrierAddress
        ? resolveHiddenCarrierLogicalTarget(requestedCarrierAddress, requestedMetadata)
        : controlSessionId === VOICE_AGENT_GLOBAL_SESSION_ID
            ? targetSessionAddress
            : normalizeSessionAddress(targetServerId, controlSessionId);

    const conversationSessionId =
        rootSessionAddress && !shouldForceVoiceHomeForLocalConversation(params.settings)
            ? await ensureVoiceConversationSessionForSessionRoot({ sessionRootAddress: rootSessionAddress, signal: params.signal,
                conversationSelection })
            : await ensureVoiceHomeConversationSessionIdWithRecovery({
                  transcriptMode,
                  controlSessionId,
                  settings: params.settings,
                  signal: params.signal,
                  conversationSelection,
              });
    const conversationSessionAddress = normalizeSessionAddress(
        rootSessionAddress?.serverId ?? targetServerId,
        conversationSessionId,
    );
    if (!conversationSessionAddress) return null;

    return {
        controlSessionId,
        conversationSessionId,
        conversationSessionAddress,
        transcriptMode,
        targetSessionAddress: requestedCarrierAddress ? resolveHiddenCarrierLogicalTarget(requestedCarrierAddress, requestedMetadata) : targetSessionAddress,
    };
}
