import type { StoreApi } from 'zustand/vanilla';

import { voiceSessionBindingStore } from './voiceConversationBindingStore';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import type { VoiceConversationTargeting } from '@/voice/session/types';
import type { VoiceConversationBindingResolution, VoiceSessionBinding } from './voiceConversationBindingTypes';
import { resolveVoiceConversationNavigationAddress } from './resolveVoiceConversationNavigationAddress';
import {
    areSessionAddressesEqual,
    normalizeSessionAddress,
    type SessionAddress,
} from '@/sync/domains/session/sessionAddress';

type VoiceSessionBindingStoreLike = StoreApi<Readonly<{
    bindingsByConversationSessionId: Record<string, VoiceSessionBinding>;
    bind: (binding: VoiceSessionBinding) => void;
    unbind: (conversationSessionId: string) => void;
    getByConversationSessionId: (conversationSessionId: string) => VoiceSessionBinding | null;
    getByControlSessionId: (controlSessionId: string) => VoiceSessionBinding | null;
    list: () => ReadonlyArray<VoiceSessionBinding>;
}>>;

function normalizeTargetSessionId(targetSessionId: string | null | undefined): string | null {
    return typeof targetSessionId === 'string' && targetSessionId.trim().length > 0 ? targetSessionId.trim() : null;
}

function haveSameTargetAddress(left: SessionAddress | null, right: SessionAddress | null): boolean {
    return left === null && right === null ? true : areSessionAddressesEqual(left, right);
}

function hasSameBindingSemantics(
    existing: VoiceSessionBinding,
    adapterId: string,
    resolution: VoiceConversationBindingResolution,
): boolean {
    return (
        existing.adapterId === adapterId
        && existing.controlSessionId === resolution.controlSessionId
        && existing.conversationSessionId === resolution.conversationSessionId
        && areSessionAddressesEqual(
            existing.conversationSessionAddress,
            resolution.conversationSessionAddress,
        )
        && existing.transcriptMode === resolution.transcriptMode
        && haveSameTargetAddress(existing.targetSessionAddress, resolution.targetSessionAddress)
    );
}

export function createVoiceSessionBindingManager(deps: Readonly<{
    store?: VoiceSessionBindingStoreLike;
    nowMs?: () => number;
    resolveBinding: (params: Readonly<{
        adapterId: string;
        controlSessionId: string;
        requestedTargetSessionId?: string | null;
        requestedTargetServerId?: string | null;
    }>) => Promise<VoiceConversationBindingResolution | null>;
    resolveExistingBindingByConversationSessionId?: (
        conversationSessionId: string,
    ) => VoiceSessionBinding | null;
    resolveConversationTargeting?: (
        adapterId: string,
    ) => VoiceConversationTargeting;
    appendTargetSwitchNote?: (params: Readonly<{
        conversationSessionId: string;
        previousTargetSessionAddress: SessionAddress | null;
        targetSessionAddress: SessionAddress | null;
    }>) => void;
    persistBinding?: (binding: VoiceSessionBinding) => Promise<void> | void;
}>) {
    const store = deps.store ?? voiceSessionBindingStore;
    const nowMs = deps.nowMs ?? (() => Date.now());
    const appendTargetSwitchNote = deps.appendTargetSwitchNote ?? (() => {});
    const persistBinding = deps.persistBinding ?? (() => {});
    const resolveExistingBindingByConversationSessionId =
        deps.resolveExistingBindingByConversationSessionId ?? (() => null);
    const resolveConversationTargeting =
        deps.resolveConversationTargeting ?? (() => 'route_target');

    const ensureBound = async (params: Readonly<{
        adapterId: string;
        controlSessionId: string;
        requestedTargetSessionId?: string | null;
        requestedTargetServerId?: string | null;
    }>): Promise<VoiceSessionBinding | null> => {
        const adapterId = normalizeNonEmptyString(params.adapterId);
        const controlSessionId = normalizeNonEmptyString(params.controlSessionId);
        const requestedTargetSessionId = normalizeTargetSessionId(params.requestedTargetSessionId);
        if (!adapterId || !controlSessionId) return null;

        const existing = store.getState().getByControlSessionId(controlSessionId);
        const resolution = await deps.resolveBinding({
            adapterId,
            controlSessionId,
            requestedTargetSessionId,
            requestedTargetServerId: params.requestedTargetServerId,
        });
        if (!resolution) return null;
        if (existing && hasSameBindingSemantics(existing, adapterId, resolution)) {
            return existing;
        }

        const previous = store.getState().getByConversationSessionId(resolution.conversationSessionId);
        const nextBinding: VoiceSessionBinding = {
            adapterId,
            controlSessionId: resolution.controlSessionId,
            conversationSessionId: resolution.conversationSessionId,
            conversationSessionAddress: resolution.conversationSessionAddress,
            transcriptMode: resolution.transcriptMode,
            targetSessionAddress: resolution.targetSessionAddress,
            updatedAt: nowMs(),
        };

        await Promise.resolve(persistBinding(nextBinding));
        store.getState().bind(nextBinding);

        if (
            previous
            && previous.conversationSessionId === nextBinding.conversationSessionId
            && !haveSameTargetAddress(previous.targetSessionAddress, nextBinding.targetSessionAddress)
        ) {
            appendTargetSwitchNote({
                conversationSessionId: nextBinding.conversationSessionId,
                previousTargetSessionAddress: previous.targetSessionAddress,
                targetSessionAddress: nextBinding.targetSessionAddress,
            });
        }

        return nextBinding;
    };

    /**
     * Owns the "should we rebind when opening the conversation?" policy that used
     * to live inline in the voice surface action handler. Given the currently
     * resolved open-conversation session and the requested route target, it
     * decides whether the existing binding still matches; if not (or none exists)
     * it rebinds through `ensureBound` and returns the conversation session id the
     * caller should navigate to. The UI only requests "open conversation X for
     * control session Y targeting Z" — it no longer encodes binding decisions.
     */
    const ensureBoundForOpenConversation = async (params: Readonly<{
        openConversationSessionId: string;
        fallbackControlSessionId: string | null;
        activeAdapterId: string | null;
        providerId: string;
        requestedTargetSessionId: string | null;
        requestedTargetServerId?: string | null;
    }>): Promise<{ conversationSessionId: string | null; conversationServerId: string | null } | null> => {
        const openConversationSessionId = normalizeNonEmptyString(params.openConversationSessionId);
        if (!openConversationSessionId) return null;

        const requestedTargetSessionId = normalizeTargetSessionId(params.requestedTargetSessionId);
        const requestedTargetSessionAddress = normalizeSessionAddress(
            params.requestedTargetServerId,
            requestedTargetSessionId,
        );
        const existing = resolveExistingBindingByConversationSessionId(openConversationSessionId);
        // The binding already holds the Home of both the target and the conversation
        // carrier, so the caller never has to re-derive one from the active Home.
        const existingConversationServerId = existing?.conversationSessionAddress?.serverId ?? null;
        if (existing?.lifetime === 'runtime_attempt') {
            const address = resolveVoiceConversationNavigationAddress(existing);
            return {
                conversationSessionId: address?.sessionId ?? null,
                conversationServerId: address?.serverId ?? null,
            };
        }
        if (
            existing
            && resolveConversationTargeting(existing.adapterId) === 'bound_conversation'
        ) {
            return { conversationSessionId: openConversationSessionId, conversationServerId: existingConversationServerId };
        }
        const shouldRebind =
            !existing
            || !haveSameTargetAddress(existing.targetSessionAddress, requestedTargetSessionAddress);
        if (!shouldRebind) {
            return { conversationSessionId: openConversationSessionId, conversationServerId: existingConversationServerId };
        }

        const rebindAdapterId =
            normalizeNonEmptyString(existing?.adapterId)
            ?? normalizeNonEmptyString(params.activeAdapterId)
            ?? normalizeNonEmptyString(params.providerId);
        const controlSessionId = normalizeNonEmptyString(params.fallbackControlSessionId);
        if (!rebindAdapterId || !controlSessionId) {
            return { conversationSessionId: openConversationSessionId, conversationServerId: existingConversationServerId };
        }

        const rebound = await ensureBound({
            adapterId: rebindAdapterId,
            controlSessionId,
            requestedTargetSessionId,
            requestedTargetServerId: params.requestedTargetServerId,
        });
        return rebound
            ? {
                conversationSessionId: rebound.conversationSessionId,
                conversationServerId: rebound.conversationSessionAddress?.serverId ?? null,
            }
            : { conversationSessionId: openConversationSessionId, conversationServerId: existingConversationServerId };
    };

    const syncTargetSession = async (params: Readonly<{
        controlSessionId: string;
        targetSessionAddress: SessionAddress | null;
    }>): Promise<VoiceSessionBinding | null> => {
        const controlSessionId = normalizeNonEmptyString(params.controlSessionId);
        if (!controlSessionId) return null;
        const previous = store.getState().getByControlSessionId(controlSessionId);
        if (!previous) return null;
        const targetSessionAddress = params.targetSessionAddress
            ? normalizeSessionAddress(
                params.targetSessionAddress.serverId,
                params.targetSessionAddress.sessionId,
            )
            : null;
        if (haveSameTargetAddress(previous.targetSessionAddress, targetSessionAddress)) return previous;

        const nextBinding: VoiceSessionBinding = {
            ...previous,
            targetSessionAddress,
            updatedAt: nowMs(),
        };
        await Promise.resolve(persistBinding(nextBinding));
        store.getState().bind(nextBinding);
        appendTargetSwitchNote({
            conversationSessionId: nextBinding.conversationSessionId,
            previousTargetSessionAddress: previous.targetSessionAddress,
            targetSessionAddress,
        });
        return nextBinding;
    };

    return {
        ensureBound,
        ensureBoundForOpenConversation,
        syncTargetSession,
        getByConversationSessionId: (conversationSessionId: string) => store.getState().getByConversationSessionId(conversationSessionId),
        getByControlSessionId: (controlSessionId: string) => store.getState().getByControlSessionId(controlSessionId),
        list: () => store.getState().list(),
    };
}
