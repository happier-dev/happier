import * as React from 'react';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import { isParticipantRecipientAvailable } from '@/sync/domains/input/participants/resolveParticipantRoutedSend';
import { recipientsEqual } from './recipientOptions';
import { existingSessionDraftSemanticValues } from '@/sync/domains/input/drafts/existingSessionDraftSemanticValues';
import {
    areServerAccountScopesEqual,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { fireAndForget } from '@/utils/system/fireAndForget';

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
    const subscribeToDraft = React.useCallback((listener: () => void) => {
        if (!scope || !persistenceEnabled || !persistedSessionId) return () => undefined;
        return existingSessionDraftSemanticValues.subscribe(scope, persistedSessionId, listener);
    }, [persistedSessionId, persistenceEnabled, scope]);
    const readRoutingSignature = React.useCallback(() => {
        if (!scope || !persistenceEnabled || !persistedSessionId) return 'disabled';
        const recipient = existingSessionDraftSemanticValues.read(scope, persistedSessionId, 'routing.recipient');
        const delivery = existingSessionDraftSemanticValues.read(scope, persistedSessionId, 'routing.executionRunDelivery');
        return JSON.stringify([
            typeof recipient === 'undefined' ? 'unset' : 'set',
            recipient ?? null,
            typeof delivery === 'undefined' ? 'unset' : 'set',
            delivery ?? null,
        ]);
    }, [persistedSessionId, persistenceEnabled, scope]);
    const routingSignature = React.useSyncExternalStore(subscribeToDraft, readRoutingSignature, readRoutingSignature);
    const [manualRecipient, setManualRecipientState] = React.useState<ParticipantRecipientV1 | null>(null);
    const [didManualOverride, setDidManualOverride] = React.useState(false);
    const [executionRunDelivery, setExecutionRunDelivery] = React.useState<ExecutionRunDeliveryMode>('steer_if_supported');
    const pendingFlushTargetRef = React.useRef<Readonly<{
        scope: ServerAccountScope;
        sessionId: string;
    }> | null>(null);
    const pendingFlushTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const previousPersistenceRef = React.useRef<Readonly<{
        sessionId: string | null;
        scope: ServerAccountScope | null;
    }> | null>(null);
    const applyHydratedRecipient = React.useCallback((
        next: ParticipantRecipientV1 | null,
        nextDidManualOverride: boolean,
    ) => {
        setManualRecipientState((current) => {
            if (current === null || next === null) return current === next ? current : next;
            return recipientsEqual(current, next) ? current : next;
        });
        setDidManualOverride((current) => (
            current === nextDidManualOverride ? current : nextDidManualOverride
        ));
    }, []);

    const flushPendingDraftValues = React.useCallback((target?: Readonly<{
        scope: ServerAccountScope;
        sessionId: string;
    }> | null) => {
        if (pendingFlushTimeoutRef.current) {
            clearTimeout(pendingFlushTimeoutRef.current);
            pendingFlushTimeoutRef.current = null;
        }
        const targetToFlush = typeof target === 'undefined' ? pendingFlushTargetRef.current : target;
        if (!targetToFlush) return;
        fireAndForget(
            existingSessionDraftSemanticValues.flush(targetToFlush.scope, targetToFlush.sessionId),
            { tag: 'useSessionRecipientState.flushSemanticDraft' },
        );
        if (pendingFlushTargetRef.current === targetToFlush) {
            pendingFlushTargetRef.current = null;
        }
    }, []);

    const scheduleDraftValueFlush = React.useCallback((target: Readonly<{
        scope: ServerAccountScope;
        sessionId: string;
    }>) => {
        pendingFlushTargetRef.current = target;
        if (pendingFlushTimeoutRef.current) {
            clearTimeout(pendingFlushTimeoutRef.current);
        }
        pendingFlushTimeoutRef.current = setTimeout(() => {
            flushPendingDraftValues(target);
        }, SESSION_RECIPIENT_DRAFT_VALUE_DEBOUNCE_MS);
    }, [flushPendingDraftValues]);

    React.useEffect(() => {
        const previous = previousPersistenceRef.current;
        if (
            previous
            && (previous.sessionId !== persistedSessionId || !areNullableScopesEqual(previous.scope, scope))
        ) {
            flushPendingDraftValues(
                previous.scope && previous.sessionId
                    ? { scope: previous.scope, sessionId: previous.sessionId }
                    : null,
            );
        }
        previousPersistenceRef.current = { sessionId: persistedSessionId, scope };

        if (!scope || !persistenceEnabled || !persistedSessionId) return;

        const persistedRecipient = existingSessionDraftSemanticValues.read(scope, persistedSessionId, 'routing.recipient');
        const persistedDelivery = existingSessionDraftSemanticValues.read(scope, persistedSessionId, 'routing.executionRunDelivery');
        const nextDelivery = persistedDelivery ?? 'steer_if_supported';
        setExecutionRunDelivery((current) => current === nextDelivery ? current : nextDelivery);

        if (typeof persistedRecipient === 'undefined') {
            applyHydratedRecipient(null, false);
            return;
        }

        if (
            persistedRecipient !== null
            && !isParticipantRecipientAvailable({ targets: params.targets, recipient: persistedRecipient })
        ) {
            applyHydratedRecipient(null, false);
            return;
        }

        applyHydratedRecipient(persistedRecipient, true);
    }, [applyHydratedRecipient, flushPendingDraftValues, params.targets, persistedSessionId, persistenceEnabled, routingSignature, scope]);

    React.useEffect(() => {
        return () => {
            const previous = previousPersistenceRef.current;
            if (previous) {
                flushPendingDraftValues(
                    previous.scope && previous.sessionId
                        ? { scope: previous.scope, sessionId: previous.sessionId }
                        : null,
                );
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
        if (scope && persistenceEnabled && persistedSessionId) {
            existingSessionDraftSemanticValues.write(scope, persistedSessionId, 'routing.recipient', next);
            scheduleDraftValueFlush({ scope, sessionId: persistedSessionId });
        }
    }, [persistedSessionId, persistenceEnabled, scheduleDraftValueFlush, scope]);

    const clearPersistedManualRecipient = React.useCallback(() => {
        setDidManualOverride(false);
        setManualRecipientState(null);
        if (scope && persistenceEnabled && persistedSessionId) {
            existingSessionDraftSemanticValues.clear(scope, persistedSessionId, 'routing.recipient');
            scheduleDraftValueFlush({ scope, sessionId: persistedSessionId });
        }
    }, [persistedSessionId, persistenceEnabled, scheduleDraftValueFlush, scope]);

    const setPersistedExecutionRunDelivery = React.useCallback((next: ExecutionRunDeliveryMode) => {
        setExecutionRunDelivery(next);
        if (scope && persistenceEnabled && persistedSessionId) {
            existingSessionDraftSemanticValues.write(scope, persistedSessionId, 'routing.executionRunDelivery', next);
            scheduleDraftValueFlush({ scope, sessionId: persistedSessionId });
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
