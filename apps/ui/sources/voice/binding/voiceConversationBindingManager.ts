import type { StoreApi } from 'zustand/vanilla';

import { voiceSessionBindingStore } from './voiceConversationBindingStore';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import type { VoiceConversationTargeting } from '@/voice/session/types';
import type { VoiceConversationBindingResolution, VoiceSessionBinding } from './voiceConversationBindingTypes';

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

function hasSameBindingSemantics(
    existing: VoiceSessionBinding,
    adapterId: string,
    resolution: VoiceConversationBindingResolution,
): boolean {
    return (
        existing.adapterId === adapterId
        && existing.controlSessionId === resolution.controlSessionId
        && existing.conversationSessionId === resolution.conversationSessionId
        && existing.transcriptMode === resolution.transcriptMode
        && normalizeTargetSessionId(existing.targetSessionId) === normalizeTargetSessionId(resolution.targetSessionId)
    );
}

export function createVoiceSessionBindingManager(deps: Readonly<{
    store?: VoiceSessionBindingStoreLike;
    nowMs?: () => number;
    resolveBinding: (params: Readonly<{
        adapterId: string;
        controlSessionId: string;
        requestedTargetSessionId?: string | null;
    }>) => Promise<VoiceConversationBindingResolution | null>;
    resolveExistingBindingByConversationSessionId?: (
        conversationSessionId: string,
    ) => VoiceSessionBinding | null;
    resolveConversationTargeting?: (
        adapterId: string,
    ) => VoiceConversationTargeting;
    appendTargetSwitchNote?: (params: Readonly<{
        conversationSessionId: string;
        previousTargetSessionId: string | null;
        targetSessionId: string | null;
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
            transcriptMode: resolution.transcriptMode,
            targetSessionId: resolution.targetSessionId,
            updatedAt: nowMs(),
        };

        await Promise.resolve(persistBinding(nextBinding));
        store.getState().bind(nextBinding);

        if (
            previous
            && previous.conversationSessionId === nextBinding.conversationSessionId
            && previous.targetSessionId !== nextBinding.targetSessionId
        ) {
            appendTargetSwitchNote({
                conversationSessionId: nextBinding.conversationSessionId,
                previousTargetSessionId: previous.targetSessionId,
                targetSessionId: nextBinding.targetSessionId,
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
    }>): Promise<{ conversationSessionId: string | null } | null> => {
        const openConversationSessionId = normalizeNonEmptyString(params.openConversationSessionId);
        if (!openConversationSessionId) return null;

        const requestedTargetSessionId = normalizeTargetSessionId(params.requestedTargetSessionId);
        const existing = resolveExistingBindingByConversationSessionId(openConversationSessionId);
        if (existing?.lifetime === 'runtime_attempt') {
            return { conversationSessionId: normalizeTargetSessionId(existing.targetSessionId) };
        }
        if (
            existing
            && resolveConversationTargeting(existing.adapterId) === 'bound_conversation'
        ) {
            return { conversationSessionId: openConversationSessionId };
        }
        const shouldRebind =
            !existing
            || normalizeTargetSessionId(existing.targetSessionId) !== requestedTargetSessionId;
        if (!shouldRebind) {
            return { conversationSessionId: openConversationSessionId };
        }

        const rebindAdapterId =
            normalizeNonEmptyString(existing?.adapterId)
            ?? normalizeNonEmptyString(params.activeAdapterId)
            ?? normalizeNonEmptyString(params.providerId);
        const controlSessionId = normalizeNonEmptyString(params.fallbackControlSessionId);
        if (!rebindAdapterId || !controlSessionId) {
            return { conversationSessionId: openConversationSessionId };
        }

        const rebound = await ensureBound({
            adapterId: rebindAdapterId,
            controlSessionId,
            requestedTargetSessionId,
        });
        return { conversationSessionId: rebound?.conversationSessionId ?? openConversationSessionId };
    };

    const syncTargetSession = async (params: Readonly<{
        controlSessionId: string;
        targetSessionId: string | null;
    }>): Promise<VoiceSessionBinding | null> => {
        const controlSessionId = normalizeNonEmptyString(params.controlSessionId);
        if (!controlSessionId) return null;
        const previous = store.getState().getByControlSessionId(controlSessionId);
        if (!previous) return null;
        const targetSessionId = normalizeTargetSessionId(params.targetSessionId);
        if (previous.targetSessionId === targetSessionId) return previous;

        const nextBinding: VoiceSessionBinding = {
            ...previous,
            targetSessionId,
            updatedAt: nowMs(),
        };
        await Promise.resolve(persistBinding(nextBinding));
        store.getState().bind(nextBinding);
        appendTargetSwitchNote({
            conversationSessionId: nextBinding.conversationSessionId,
            previousTargetSessionId: previous.targetSessionId,
            targetSessionId,
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
