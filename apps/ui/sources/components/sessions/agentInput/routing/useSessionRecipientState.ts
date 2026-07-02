import * as React from 'react';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import { isParticipantRecipientAvailable } from '@/sync/domains/input/participants/resolveParticipantRoutedSend';
import {
    clearSessionDraftValue,
    flushSessionDraftValues,
    readSessionDraftValue,
    writeSessionDraftValue,
} from '@/sync/domains/input/draftValues/sessionDraftValueStore';
import {
    areServerAccountScopesEqual,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';

export type ExecutionRunDeliveryMode = 'prompt' | 'steer_if_supported' | 'interrupt';

export type SessionRecipientDraftPersistence = Readonly<{
    sessionId: string | null | undefined;
    surface: 'mainComposer';
}>;

export function useSessionRecipientState(params: Readonly<{
    targets: readonly SessionParticipantTarget[];
    autoRecipient: ParticipantRecipientV1 | null;
    draftPersistence?: SessionRecipientDraftPersistence;
}>): Readonly<{
    recipient: ParticipantRecipientV1 | null;
    didManualOverride: boolean;
    setManualRecipient: (next: ParticipantRecipientV1 | null) => void;
    clearPersistedManualRecipient: () => void;
    executionRunDelivery: ExecutionRunDeliveryMode;
    setExecutionRunDelivery: (next: ExecutionRunDeliveryMode) => void;
}> {
    const scope = useStableServerAccountScope(useActiveServerAccountScope());
    const persistedSessionId = normalizeSessionId(params.draftPersistence?.sessionId);
    const persistenceEnabled = params.draftPersistence?.surface === 'mainComposer' && persistedSessionId !== null;
    const [manualRecipient, setManualRecipientState] = React.useState<ParticipantRecipientV1 | null>(null);
    const [didManualOverride, setDidManualOverride] = React.useState(false);
    const [executionRunDelivery, setExecutionRunDelivery] = React.useState<ExecutionRunDeliveryMode>('steer_if_supported');
    const pendingFlushScopeRef = React.useRef<ServerAccountScope | null | undefined>(undefined);
    const pendingFlushTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const previousPersistenceRef = React.useRef<Readonly<{
        sessionId: string | null;
        scope: ServerAccountScope | null;
    }> | null>(null);

    const flushPendingDraftValues = React.useCallback((targetScope?: ServerAccountScope | null) => {
        if (pendingFlushTimeoutRef.current) {
            clearTimeout(pendingFlushTimeoutRef.current);
            pendingFlushTimeoutRef.current = null;
        }
        const scopeToFlush = typeof targetScope === 'undefined'
            ? pendingFlushScopeRef.current
            : targetScope;
        if (typeof scopeToFlush === 'undefined') return;
        flushSessionDraftValues(scopeToFlush);
        if (pendingFlushScopeRef.current === scopeToFlush) {
            pendingFlushScopeRef.current = undefined;
        }
    }, []);

    const scheduleDraftValueFlush = React.useCallback((targetScope: ServerAccountScope | null) => {
        pendingFlushScopeRef.current = targetScope;
        if (pendingFlushTimeoutRef.current) {
            clearTimeout(pendingFlushTimeoutRef.current);
        }
        pendingFlushTimeoutRef.current = setTimeout(() => {
            flushPendingDraftValues(targetScope);
        }, SESSION_RECIPIENT_DRAFT_VALUE_DEBOUNCE_MS);
    }, [flushPendingDraftValues]);

    React.useEffect(() => {
        const previous = previousPersistenceRef.current;
        if (
            previous
            && (previous.sessionId !== persistedSessionId || !areNullableScopesEqual(previous.scope, scope))
        ) {
            flushPendingDraftValues(previous.scope);
        }
        previousPersistenceRef.current = { sessionId: persistedSessionId, scope };

        if (!persistenceEnabled || !persistedSessionId) return;

        const persistedRecipient = readSessionDraftValue(scope, persistedSessionId, 'routing.recipient');
        const persistedDelivery = readSessionDraftValue(scope, persistedSessionId, 'routing.executionRunDelivery');
        setExecutionRunDelivery(persistedDelivery ?? 'steer_if_supported');

        if (typeof persistedRecipient === 'undefined') {
            setManualRecipientState(null);
            setDidManualOverride(false);
            return;
        }

        if (
            persistedRecipient !== null
            && !isParticipantRecipientAvailable({ targets: params.targets, recipient: persistedRecipient })
        ) {
            setManualRecipientState(null);
            setDidManualOverride(false);
            return;
        }

        setManualRecipientState(persistedRecipient);
        setDidManualOverride(true);
    }, [flushPendingDraftValues, params.targets, persistedSessionId, persistenceEnabled, scope]);

    React.useEffect(() => {
        return () => {
            const previous = previousPersistenceRef.current;
            if (previous) {
                flushPendingDraftValues(previous.scope);
            }
        };
    }, [flushPendingDraftValues]);

    // If the manually selected recipient disappears (run completes/team removed), clear it and
    // allow auto-recipient to apply again.
    React.useEffect(() => {
        if (!manualRecipient) return;
        if (isParticipantRecipientAvailable({ targets: params.targets, recipient: manualRecipient })) return;
        setManualRecipientState(null);
        setDidManualOverride(false);
    }, [manualRecipient, params.targets]);

    const effectiveRecipient = React.useMemo(() => {
        if (manualRecipient) return manualRecipient;
        if (didManualOverride) return null;
        const auto = params.autoRecipient;
        if (!auto) return null;
        if (!isParticipantRecipientAvailable({ targets: params.targets, recipient: auto })) return null;
        return auto;
    }, [didManualOverride, manualRecipient, params.autoRecipient, params.targets]);

    const setManualRecipient = React.useCallback((next: ParticipantRecipientV1 | null) => {
        setDidManualOverride(true);
        setManualRecipientState(next);
        if (persistenceEnabled && persistedSessionId) {
            writeSessionDraftValue(scope, persistedSessionId, 'routing.recipient', next);
            scheduleDraftValueFlush(scope);
        }
    }, [persistedSessionId, persistenceEnabled, scheduleDraftValueFlush, scope]);

    const clearPersistedManualRecipient = React.useCallback(() => {
        setDidManualOverride(false);
        setManualRecipientState(null);
        if (persistenceEnabled && persistedSessionId) {
            clearSessionDraftValue(scope, persistedSessionId, 'routing.recipient');
            scheduleDraftValueFlush(scope);
        }
    }, [persistedSessionId, persistenceEnabled, scheduleDraftValueFlush, scope]);

    const setPersistedExecutionRunDelivery = React.useCallback((next: ExecutionRunDeliveryMode) => {
        setExecutionRunDelivery(next);
        if (persistenceEnabled && persistedSessionId) {
            writeSessionDraftValue(scope, persistedSessionId, 'routing.executionRunDelivery', next);
            scheduleDraftValueFlush(scope);
        }
    }, [persistedSessionId, persistenceEnabled, scheduleDraftValueFlush, scope]);

    return {
        recipient: effectiveRecipient,
        didManualOverride,
        setManualRecipient,
        clearPersistedManualRecipient,
        executionRunDelivery,
        setExecutionRunDelivery: setPersistedExecutionRunDelivery,
    };
}

const SESSION_RECIPIENT_DRAFT_VALUE_DEBOUNCE_MS = 250;

function normalizeSessionId(sessionId: string | null | undefined): string | null {
    if (typeof sessionId !== 'string') return null;
    const trimmed = sessionId.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function areNullableScopesEqual(
    left: ServerAccountScope | null,
    right: ServerAccountScope | null,
): boolean {
    if (!left || !right) return left === right;
    return areServerAccountScopesEqual(left, right);
}

function useStableServerAccountScope(scope: ServerAccountScope | null): ServerAccountScope | null {
    const stableScopeRef = React.useRef<ServerAccountScope | null>(scope);
    if (!areNullableScopesEqual(stableScopeRef.current, scope)) {
        stableScopeRef.current = scope;
    }
    return stableScopeRef.current;
}
