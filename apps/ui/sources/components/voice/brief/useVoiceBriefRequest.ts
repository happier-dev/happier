import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useVoiceAttemptControl, VOICE_ATTEMPT_IDLE_TARGET_GLOBAL, type VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';
import { useVoiceSurfaceModel } from '@/components/voice/surface/useVoiceSurfaceModel';
import { useInboxModel } from '@/hooks/inbox/useInboxModel';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { captureActiveServerAccountScopeCurrentness, getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { buildVoiceBrief } from '@/voice/context/buildVoiceBrief';
import { voiceHooks } from '@/voice/context/voiceHooks';
import { useVoiceSessionSnapshot } from '@/voice/session/voiceSession';
import { getVoiceSessionAttemptId, getVoiceSessionPresentedAttemptId, getVoiceSessionSnapshot, subscribeToVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import type { VoiceSessionStatus } from '@/voice/session/types';

import { registerVoiceBriefHomeRequest, registerVoiceBriefOperations, resumeVoiceBriefHomeRequest, voiceBriefOperationResult, type VoiceBriefOperation, type VoiceBriefOperationOutcome } from './voiceBriefActionRuntime';

const SURFACE_PROPS = Object.freeze({ variant: 'sidebar' as const });
type Delivery = 'waiting' | 'sent' | 'refused' | 'stopped';
type PendingBrief = { attemptId: string | null; accountLifetime: ReturnType<typeof captureActiveServerAccountScopeCurrentness> };

function observeBriefControlResult(result: void | Promise<boolean>, settle: (accepted: boolean) => void): 'waiting' | 'settled' {
    if (result) {
        void result.then(settle, () => settle(false));
        return 'waiting';
    }
    settle(true);
    return 'settled';
}

function briefNeedsRecovery(delivery: Delivery, voice: Pick<VoiceAttemptControlProjection, 'availability' | 'live'>,
    status: VoiceSessionStatus, retryRequired: boolean, started: boolean): boolean {
    return (delivery !== 'stopped' && (status === 'error' || retryRequired))
        || (delivery === 'waiting' && (voice.availability !== 'ready' || (!voice.live && (retryRequired || started))));
}

/** Closed Home registers only its existing opener; Inbox details remain demand-mounted. */
export function useVoiceBriefHomeRequest(input: Readonly<{ available: boolean; onOpen: () => void }>): void {
    const enabled = useFeatureEnabled('voice');
    const current = React.useRef({ ...input, enabled, accountLifetime: captureActiveServerAccountScopeCurrentness() });
    current.current = { ...input, enabled, accountLifetime: captureActiveServerAccountScopeCurrentness() };
    React.useLayoutEffect(() => {
        if (!input.available || enabled !== true) return;
        return registerVoiceBriefHomeRequest(() => {
            const owner = current.current;
            if (!owner.available || owner.enabled !== true || !owner.accountLifetime.isCurrent()) {
                return { ok: false, errorCode: 'voice_brief_unavailable' };
            }
            owner.onOpen();
            return voiceBriefOperationResult('waiting');
        });
    }, [input.available, enabled]);
}

/** One request owner for the visible Brief and agent Actions; lifecycle and output remain incumbent. */
export function useVoiceBriefRequest(onClose?: () => void): {
    brief: ReturnType<typeof buildVoiceBrief>;
    voice: VoiceAttemptControlProjection;
    delivery: Delivery;
    waitingUnavailable: boolean;
    actionReady: boolean;
    canStopReply: boolean;
    retry: () => Promise<ActionExecuteResult>;
    stopReply: () => Promise<ActionExecuteResult>;
    closeBrief: () => Promise<ActionExecuteResult>;
} {
    const inbox = useInboxModel();
    const settings = storage((state) => state.settings);
    const brief = React.useMemo(() => buildVoiceBrief({ inbox, settings }), [inbox, settings]);
    const voice = useVoiceAttemptControl(VOICE_ATTEMPT_IDLE_TARGET_GLOBAL);
    const surface = useVoiceSurfaceModel(SURFACE_PROPS);
    const snapshot = useVoiceSessionSnapshot();
    const { execute: executeAction, isCurrent: isActionCurrent, ready: actionReady } = useMountedActionExecution(getActiveServerAccountScope());
    const [delivery, setDelivery] = React.useState<Delivery>('waiting');
    const [retryRequired, setRetryRequired] = React.useState(false);
    const pending = React.useRef<PendingBrief | null>(null);
    const started = React.useRef(false);
    const initialized = React.useRef(false);
    const current = React.useRef({ inbox, voice, surface, delivery, retryRequired, onClose, attemptId: getVoiceSessionAttemptId(), accountLifetime: captureActiveServerAccountScopeCurrentness() });
    current.current = { inbox, voice, surface, delivery, retryRequired, onClose, attemptId: getVoiceSessionAttemptId(), accountLifetime: captureActiveServerAccountScopeCurrentness() };

    const deliverWhenConnected = React.useCallback((): Delivery | null => {
        const request = pending.current;
        if (!request) return null;
        const attemptId = getVoiceSessionAttemptId();
        const snapshot = getVoiceSessionSnapshot();
        if (!request.accountLifetime.isCurrent()
            || (request.attemptId !== null && request.attemptId !== attemptId)) {
            pending.current = null;
            setRetryRequired(true);
            setDelivery('refused');
            return 'refused';
        }
        if (attemptId !== null && request.attemptId === null) request.attemptId = attemptId;
        if (snapshot.status !== 'connected' || !snapshot.sessionId) return null;
        // Retire before transport delivery: synchronous provider publication cannot send twice.
        pending.current = null;
        started.current = true;
        const next = voiceHooks.onBriefRequested(snapshot.sessionId, current.current.inbox) ? 'sent' : 'refused';
        setDelivery(next);
        return next;
    }, []);

    // Observe every canonical transition, including replacement before React can commit another render.
    React.useLayoutEffect(() => {
        const dispose = subscribeToVoiceSessionSnapshot(deliverWhenConnected);
        deliverWhenConnected();
        return dispose;
    }, [deliverWhenConnected]);

    const execute = React.useCallback((operation: VoiceBriefOperation): VoiceBriefOperationOutcome => {
        const owner = current.current;
        if (!owner.accountLifetime.isCurrent()) {
            return { ok: false, errorCode: 'voice_brief_unavailable' };
        }
        if (owner.attemptId !== getVoiceSessionAttemptId()) return { ok: false, errorCode: 'stale_voice_attempt' };
        if (operation === 'request') initialized.current = true;
        if (operation === 'close') {
            if (!owner.onClose) return { ok: false, errorCode: 'voice_brief_unavailable' };
            pending.current = null;
            owner.onClose();
            return voiceBriefOperationResult('closed');
        }
        if (operation === 'stop') {
            const stop = owner.surface?.canBargeIn ? owner.surface.onBargeIn
                : owner.surface?.canCancelTurn ? owner.surface.onCancelTurn : null;
            if (!stop) return { ok: false, errorCode: 'voice_brief_stop_unavailable' };
            const status = observeBriefControlResult(stop(), (accepted) => {
                if (!accepted || !isActionCurrent() || !owner.accountLifetime.isCurrent()
                    || owner.attemptId !== getVoiceSessionAttemptId()) return;
                pending.current = null;
                setDelivery('stopped');
            });
            return voiceBriefOperationResult(status === 'waiting' ? 'waiting' : 'stopped');
        }
        const unavailable = briefNeedsRecovery(owner.delivery, owner.voice, getVoiceSessionSnapshot().status, owner.retryRequired, started.current);
        const retryAvailable = owner.voice.primaryAction === 'start' || owner.voice.primaryAction === 'setup' || owner.voice.recoveryAvailable;
        if (operation === 'retry' && ((!unavailable && owner.delivery !== 'refused')
            || (!retryAvailable && !(owner.delivery === 'refused' && owner.voice.canStop)))) {
            return { ok: false, errorCode: 'voice_brief_not_retryable' };
        }
        if (operation === 'request' && pending.current) return voiceBriefOperationResult(deliverWhenConnected() ?? 'waiting');
        const request = { attemptId: getVoiceSessionAttemptId(), accountLifetime: captureActiveServerAccountScopeCurrentness() };
        pending.current = request;
        const settleControl = (accepted: boolean) => {
            if (accepted || pending.current !== request || !isActionCurrent() || !request.accountLifetime.isCurrent()) return;
            pending.current = null;
            setRetryRequired(true);
            setDelivery('refused');
        };
        setDelivery('waiting');
        setRetryRequired(false);
        if (owner.voice.primaryAction === 'start') {
            started.current = true;
            observeBriefControlResult(owner.voice.onPrimaryAction(), settleControl);
        } else if (operation === 'retry' && owner.voice.recoveryAvailable) {
            const recovery = getVoiceSessionSnapshot().errorRecoveryAction;
            observeBriefControlResult(owner.voice.onRecover(), settleControl);
            // Settings/OS repairs do not admit audio; returning still requires an explicit Retry.
            if (recovery !== 'retry' && recovery !== 'reconnect' && !getVoiceSessionAttemptId()) {
                pending.current = null;
                setRetryRequired(true);
            }
        } else if (operation === 'retry' && owner.voice.primaryAction === 'setup') {
            pending.current = null;
            setRetryRequired(true);
            observeBriefControlResult(owner.voice.onPrimaryAction(), settleControl);
        } else if (!owner.voice.canStop) {
            pending.current = null;
            setRetryRequired(true);
        }
        return voiceBriefOperationResult(deliverWhenConnected() ?? 'waiting');
    }, [deliverWhenConnected, isActionCurrent]);

    React.useLayoutEffect(() => registerVoiceBriefOperations(execute), [execute]);
    const dispatch = React.useCallback(async (operation: VoiceBriefOperation) => {
        const expectedAttemptId = getVoiceSessionPresentedAttemptId();
        const result = await executeAction(`ui.voice_global.brief.${operation}`, expectedAttemptId ? { expectedAttemptId } : {});
        if (!result.ok && (operation === 'request' || operation === 'retry') && isActionCurrent() && !pending.current) {
            setRetryRequired(true);
            setDelivery('refused');
        }
        return result;
    }, [executeAction, isActionCurrent]);
    React.useEffect(() => {
        if (!actionReady || initialized.current) return;
        let active = true;
        // Effect replay retires mounted Action interest. Admit only from the surviving mount.
        void Promise.resolve().then(() => {
            if (!active || initialized.current) return;
            initialized.current = true;
            const resumed = resumeVoiceBriefHomeRequest();
            if (!resumed) return dispatch('request');
            if (!resumed.ok) {
                setRetryRequired(true);
                setDelivery('refused');
            }
        });
        return () => { active = false; };
    }, [actionReady, dispatch]);

    const waitingUnavailable = briefNeedsRecovery(delivery, voice, snapshot.status, retryRequired, started.current);
    return {
        brief, voice, delivery, waitingUnavailable, actionReady,
        canStopReply: surface?.canCancelTurn === true || surface?.canBargeIn === true,
        retry: () => dispatch('retry'),
        stopReply: () => dispatch('stop'),
        closeBrief: () => dispatch('close'),
    };
}
