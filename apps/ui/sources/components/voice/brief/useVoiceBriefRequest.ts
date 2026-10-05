import * as React from 'react';

import { useVoiceAttemptControl, VOICE_ATTEMPT_IDLE_TARGET_GLOBAL, type VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';
import { useVoiceSurfaceModel } from '@/components/voice/surface/useVoiceSurfaceModel';
import { useInboxModel } from '@/hooks/inbox/useInboxModel';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { buildVoiceBrief } from '@/voice/context/buildVoiceBrief';
import { voiceHooks } from '@/voice/context/voiceHooks';
import { useVoiceSessionSnapshot } from '@/voice/session/voiceSession';
import { getVoiceSessionAttemptId, getVoiceSessionSnapshot, subscribeToVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import type { VoiceSessionStatus } from '@/voice/session/types';

import { registerVoiceBriefHomeRequest, registerVoiceBriefOperations, voiceBriefOperationResult, type VoiceBriefOperation, type VoiceBriefOperationOutcome } from './voiceBriefActionRuntime';

const SURFACE_PROPS = Object.freeze({ variant: 'sidebar' as const });
type Delivery = 'waiting' | 'sent' | 'refused' | 'stopped';
type PendingBrief = { attemptId: string | null; accountLifetime: ReturnType<typeof captureActiveServerAccountScopeCurrentness> };

function briefNeedsRecovery(delivery: Delivery, voice: Pick<VoiceAttemptControlProjection, 'availability' | 'live'>,
    status: VoiceSessionStatus, retryRequired: boolean, started: boolean): boolean {
    return (delivery !== 'stopped' && status === 'error')
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
export function useVoiceBriefRequest() {
    const inbox = useInboxModel();
    const settings = storage((state) => state.settings);
    const brief = React.useMemo(() => buildVoiceBrief({ inbox, settings }), [inbox, settings]);
    const voice = useVoiceAttemptControl(VOICE_ATTEMPT_IDLE_TARGET_GLOBAL);
    const surface = useVoiceSurfaceModel(SURFACE_PROPS);
    const snapshot = useVoiceSessionSnapshot();
    const [delivery, setDelivery] = React.useState<Delivery>('waiting');
    const [retryRequired, setRetryRequired] = React.useState(false);
    const pending = React.useRef<PendingBrief | null>(null);
    const started = React.useRef(false);
    const initialized = React.useRef(false);
    const current = React.useRef({ inbox, voice, surface, delivery, retryRequired, attemptId: getVoiceSessionAttemptId(), accountLifetime: captureActiveServerAccountScopeCurrentness() });
    current.current = { inbox, voice, surface, delivery, retryRequired, attemptId: getVoiceSessionAttemptId(), accountLifetime: captureActiveServerAccountScopeCurrentness() };

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
        if (operation === 'stop') {
            const stop = owner.surface?.canBargeIn ? owner.surface.onBargeIn
                : owner.surface?.canCancelTurn ? owner.surface.onCancelTurn : null;
            if (!stop) return { ok: false, errorCode: 'voice_brief_stop_unavailable' };
            pending.current = null;
            setDelivery('stopped');
            stop();
            return voiceBriefOperationResult('stopped');
        }
        const unavailable = briefNeedsRecovery(owner.delivery, owner.voice, getVoiceSessionSnapshot().status, owner.retryRequired, started.current);
        const retryAvailable = owner.voice.primaryAction === 'start' || owner.voice.primaryAction === 'setup' || owner.voice.recoveryAvailable;
        if (operation === 'retry' && ((!unavailable && owner.delivery !== 'refused')
            || (!retryAvailable && !(owner.delivery === 'refused' && owner.voice.canStop)))) {
            return { ok: false, errorCode: 'voice_brief_not_retryable' };
        }
        if (operation === 'request' && pending.current) return voiceBriefOperationResult(deliverWhenConnected() ?? 'waiting');
        pending.current = { attemptId: getVoiceSessionAttemptId(), accountLifetime: captureActiveServerAccountScopeCurrentness() };
        setDelivery('waiting');
        setRetryRequired(false);
        if (owner.voice.primaryAction === 'start') {
            started.current = true;
            owner.voice.onPrimaryAction();
        } else if (operation === 'retry' && owner.voice.recoveryAvailable) {
            const recovery = getVoiceSessionSnapshot().errorRecoveryAction;
            owner.voice.onRecover();
            // Settings/OS repairs do not admit audio; returning still requires an explicit Retry.
            if (recovery !== 'retry' && recovery !== 'reconnect' && !getVoiceSessionAttemptId()) {
                pending.current = null;
                setRetryRequired(true);
            }
        } else if (operation === 'retry' && owner.voice.primaryAction === 'setup') {
            pending.current = null;
            setRetryRequired(true);
            owner.voice.onPrimaryAction();
        } else if (!owner.voice.canStop) {
            pending.current = null;
            setRetryRequired(true);
        }
        return voiceBriefOperationResult(deliverWhenConnected() ?? 'waiting');
    }, [deliverWhenConnected]);

    React.useLayoutEffect(() => registerVoiceBriefOperations(execute), [execute]);
    React.useEffect(() => {
        if (initialized.current) return;
        initialized.current = true;
        execute('request');
    }, [execute]);

    const waitingUnavailable = briefNeedsRecovery(delivery, voice, snapshot.status, retryRequired, started.current);
    return {
        brief, voice, delivery, waitingUnavailable,
        canStopReply: surface?.canCancelTurn === true || surface?.canBargeIn === true,
        retry: () => execute('retry'),
        stopReply: () => execute('stop'),
    };
}
