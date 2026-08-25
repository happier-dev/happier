import * as React from 'react';

import {
    SessionDraftRecipientValueV1Schema,
    StrictJsonValueSchema,
    type ParticipantRecipientV1,
} from '@happier-dev/protocol';

import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import {
    isParticipantRecipientAvailable,
    participantRecipientsMatch,
} from '@/sync/domains/input/participants/resolveParticipantRoutedSend';
import {
    areServerAccountScopesEqual,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import {
    getSessionDraftSnapshot,
    subscribeSessionDraft,
    writeExistingSessionDraft,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';

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
    const subscribeToRouting = React.useCallback((listener: () => void) => {
        if (!scope || !persistenceEnabled || !persistedSessionId) return () => undefined;
        return subscribeSessionDraft(scope, { kind: 'session', sessionId: persistedSessionId }, listener);
    }, [persistedSessionId, persistenceEnabled, scope]);
    const readRoutingSignature = React.useCallback(() => {
        if (!scope || !persistenceEnabled || !persistedSessionId) return 'disabled';
        const snapshot = getSessionDraftSnapshot(scope, { kind: 'session', sessionId: persistedSessionId });
        const routing = snapshot?.document.target.kind === 'session' ? snapshot.document.target.routing : null;
        return JSON.stringify([
            routing?.recipient.value ?? null,
            routing?.executionRunDelivery.value ?? null,
        ]);
    }, [persistedSessionId, persistenceEnabled, scope]);
    const routingSignature = React.useSyncExternalStore(
        subscribeToRouting,
        readRoutingSignature,
        readRoutingSignature,
    );
    const [manualRecipient, setManualRecipientState] = React.useState<ParticipantRecipientV1 | null>(null);
    const [didManualOverride, setDidManualOverride] = React.useState(false);
    const [executionRunDelivery, setExecutionRunDelivery] = React.useState<ExecutionRunDeliveryMode>('steer_if_supported');
    const applyHydratedRecipient = React.useCallback((
        next: ParticipantRecipientV1 | null,
        nextDidManualOverride: boolean,
    ) => {
        setManualRecipientState((current) => {
            if (current === null || next === null) return current === next ? current : next;
            return participantRecipientsMatch(current, next) ? current : next;
        });
        setDidManualOverride((current) => (
            current === nextDidManualOverride ? current : nextDidManualOverride
        ));
    }, []);

    React.useEffect(() => {
        if (!persistenceEnabled || !persistedSessionId || !scope) return;

        const snapshot = getSessionDraftSnapshot(scope, { kind: 'session', sessionId: persistedSessionId });
        const routing = snapshot?.document.target.kind === 'session' ? snapshot.document.target.routing : null;
        const parsedRecipient = SessionDraftRecipientValueV1Schema.safeParse(routing?.recipient.value);
        const persistedRecipient = parsedRecipient.success ? parsedRecipient.data : null;
        const persistedDelivery = routing?.executionRunDelivery.value;
        const nextDelivery = persistedDelivery === 'prompt'
            || persistedDelivery === 'interrupt'
            || persistedDelivery === 'steer_if_supported'
                ? persistedDelivery
                : 'steer_if_supported';
        setExecutionRunDelivery((current) => current === nextDelivery ? current : nextDelivery);

        if (persistedRecipient === null) {
            applyHydratedRecipient(null, false);
            return;
        }

        const recipient = persistedRecipient.recipient;

        if (
            recipient !== null
            && !isParticipantRecipientAvailable({ targets: params.targets, recipient })
        ) {
            applyHydratedRecipient(null, false);
            return;
        }

        applyHydratedRecipient(recipient, true);
    }, [applyHydratedRecipient, params.targets, persistedSessionId, persistenceEnabled, routingSignature, scope]);

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
        if (persistenceEnabled && persistedSessionId && scope) {
            writeExistingSessionDraft({
                scope,
                sessionId: persistedSessionId,
                patch: {
                    routing: {
                        recipient: StrictJsonValueSchema.parse({ mode: 'manual', recipient: next }),
                    },
                },
            });
        }
    }, [persistedSessionId, persistenceEnabled, scope]);

    const clearPersistedManualRecipient = React.useCallback(() => {
        setDidManualOverride(false);
        setManualRecipientState(null);
        if (persistenceEnabled && persistedSessionId && scope) {
            writeExistingSessionDraft({
                scope,
                sessionId: persistedSessionId,
                patch: { routing: { recipient: null } },
            });
        }
    }, [persistedSessionId, persistenceEnabled, scope]);

    const setPersistedExecutionRunDelivery = React.useCallback((next: ExecutionRunDeliveryMode) => {
        setExecutionRunDelivery(next);
        if (persistenceEnabled && persistedSessionId && scope) {
            writeExistingSessionDraft({
                scope,
                sessionId: persistedSessionId,
                patch: { routing: { executionRunDelivery: next } },
            });
        }
    }, [persistedSessionId, persistenceEnabled, scope]);

    return {
        recipient: effectiveRecipient,
        didManualOverride,
        setManualRecipient,
        clearPersistedManualRecipient,
        executionRunDelivery,
        setExecutionRunDelivery: setPersistedExecutionRunDelivery,
    };
}

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
