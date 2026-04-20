import type { StoreApi } from 'zustand/vanilla';

import { voiceSessionBindingStore } from './voiceConversationBindingStore';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
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
        && normalizeTargetSessionId(existing.runId) === normalizeTargetSessionId(resolution.runId)
        && normalizeTargetSessionId(existing.streamId) === normalizeTargetSessionId(resolution.streamId)
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
        const runId = normalizeTargetSessionId(resolution.runId);
        const streamId = normalizeTargetSessionId(resolution.streamId);
        const nextBinding: VoiceSessionBinding = {
            adapterId,
            controlSessionId: resolution.controlSessionId,
            conversationSessionId: resolution.conversationSessionId,
            ...(runId ? { runId } : {}),
            ...(streamId ? { streamId } : {}),
            transcriptMode: resolution.transcriptMode,
            targetSessionId: resolution.targetSessionId,
            updatedAt: nowMs(),
        };

        store.getState().bind(nextBinding);
        await Promise.resolve(persistBinding(nextBinding)).catch(() => {});

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

    const syncTargetSession = (params: Readonly<{
        controlSessionId: string;
        targetSessionId: string | null;
    }>): VoiceSessionBinding | null => {
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
        store.getState().bind(nextBinding);
        Promise.resolve(persistBinding(nextBinding)).catch(() => {});
        appendTargetSwitchNote({
            conversationSessionId: nextBinding.conversationSessionId,
            previousTargetSessionId: previous.targetSessionId,
            targetSessionId,
        });
        return nextBinding;
    };

    return {
        ensureBound,
        syncTargetSession,
        getByConversationSessionId: (conversationSessionId: string) => store.getState().getByConversationSessionId(conversationSessionId),
        getByControlSessionId: (controlSessionId: string) => store.getState().getByControlSessionId(controlSessionId),
        list: () => store.getState().list(),
    };
}
