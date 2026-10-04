import * as React from 'react';

import {
    DEFAULT_PENDING_REQUESTED_ACTION_V1,
    SessionDraftRecipientValueV1Schema,
    StrictJsonValueSchema,
    type PendingRequestedActionV1,
    type ParticipantRecipientV1,
    type SessionDraftRecipientValueV1,
} from '@happier-dev/protocol';

import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import {
    isParticipantRecipientAvailable,
    participantRecipientsMatch,
} from '@/sync/domains/input/participants/resolveParticipantRoutedSend';
import {
    type ServerAccountScopeLifetime,
} from '@/sync/domains/scope/serverAccountScope';
import {
    getSessionDraftSnapshot,
    subscribeSessionDraft,
    writeExistingSessionDraft,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { readExecutionRunRequestedAction } from '@/sync/domains/input/participants/executionRunRequestedAction';

export type SessionRecipientDraftPersistence = Readonly<{
    sessionId: string | null | undefined;
    surface: 'mainComposer';
}>;

export function useSessionRecipientState(params: Readonly<{
    targets: readonly SessionParticipantTarget[];
    autoRecipient: ParticipantRecipientV1 | null;
    accountLifetime?: ServerAccountScopeLifetime | null;
    draftPersistence?: SessionRecipientDraftPersistence;
}>): Readonly<{
    recipient: ParticipantRecipientV1 | null;
    didManualOverride: boolean;
    setManualRecipient: (next: ParticipantRecipientV1 | null) => void;
    clearPersistedManualRecipient: () => void;
    executionRunRequestedAction: PendingRequestedActionV1;
    setExecutionRunRequestedAction: (next: PendingRequestedActionV1) => void;
    scmDiffSummaryDiscussion: Extract<NonNullable<SessionDraftRecipientValueV1>, { mode: 'scm_diff_summary' }>['target'] | null;
}> {
    const scope = params.accountLifetime?.isCurrent() === true
        ? params.accountLifetime.scope
        : null;
    const scopeIsCurrent = React.useCallback(() => (
        params.accountLifetime?.isCurrent() === true
    ), [params.accountLifetime]);
    const persistedSessionId = normalizeSessionId(params.draftPersistence?.sessionId);
    const persistenceEnabled = params.draftPersistence?.surface === 'mainComposer' && persistedSessionId !== null;
    const subscribeToRouting = React.useCallback((listener: () => void) => {
        if (!scope || !scopeIsCurrent() || !persistenceEnabled || !persistedSessionId) return () => undefined;
        return subscribeSessionDraft(scope, { kind: 'session', sessionId: persistedSessionId }, listener);
    }, [persistedSessionId, persistenceEnabled, scope, scopeIsCurrent]);
    const readRoutingSignature = React.useCallback(() => {
        if (!scope || !scopeIsCurrent() || !persistenceEnabled || !persistedSessionId) return 'disabled';
        const snapshot = getSessionDraftSnapshot(scope, { kind: 'session', sessionId: persistedSessionId });
        const routing = snapshot?.document.target.kind === 'session' ? snapshot.document.target.routing : null;
        return JSON.stringify([
            routing?.recipient.value ?? null,
            routing?.executionRunDelivery.value ?? null,
        ]);
    }, [persistedSessionId, persistenceEnabled, scope, scopeIsCurrent]);
    const routingSignature = React.useSyncExternalStore(
        subscribeToRouting,
        readRoutingSignature,
        readRoutingSignature,
    );
    const persistedRouting = React.useMemo(() => {
        if (routingSignature === 'disabled') return null;
        const parsed = SessionDraftRecipientValueV1Schema.safeParse(JSON.parse(routingSignature)[0]);
        return parsed.success ? parsed.data : null;
    }, [routingSignature]);
    const scmDiffSummaryDiscussion = persistedRouting?.mode === 'scm_diff_summary' ? persistedRouting.target : null;
    const [manualRecipient, setManualRecipientState] = React.useState<ParticipantRecipientV1 | null>(null);
    const [didManualOverride, setDidManualOverride] = React.useState(false);
    const [executionRunRequestedAction, setExecutionRunRequestedAction] = React.useState<PendingRequestedActionV1>(
        DEFAULT_PENDING_REQUESTED_ACTION_V1,
    );
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
        if (!persistenceEnabled || !persistedSessionId || !scope || !scopeIsCurrent()) return;

        const snapshot = getSessionDraftSnapshot(scope, { kind: 'session', sessionId: persistedSessionId });
        const routing = snapshot?.document.target.kind === 'session' ? snapshot.document.target.routing : null;
        const parsedRecipient = SessionDraftRecipientValueV1Schema.safeParse(routing?.recipient.value);
        const persistedRecipient = parsedRecipient.success ? parsedRecipient.data : null;
        const nextRequestedAction = readExecutionRunRequestedAction(routing?.executionRunDelivery.value);
        setExecutionRunRequestedAction((current) => (
            current.kind === nextRequestedAction.kind ? current : nextRequestedAction
        ));

        if (persistedRecipient === null) {
            applyHydratedRecipient(null, false);
            return;
        }

        const recipient = persistedRecipient.recipient;

        if (
            recipient !== null
            && recipient.kind !== 'execution_run'
            && !isParticipantRecipientAvailable({ targets: params.targets, recipient })
        ) {
            applyHydratedRecipient(null, false);
            return;
        }

        applyHydratedRecipient(recipient, true);
    }, [applyHydratedRecipient, params.targets, persistedSessionId, persistenceEnabled, routingSignature, scope, scopeIsCurrent]);

    // Team selection follows the roster. A Run's missing local roster entry cannot
    // authorize routing its message to the parent Agent; Pending decides Run availability.
    React.useEffect(() => {
        if (!manualRecipient) return;
        if (manualRecipient.kind === 'execution_run') return;
        if (isParticipantRecipientAvailable({ targets: params.targets, recipient: manualRecipient })) return;
        setManualRecipientState(null);
        setDidManualOverride(false);
    }, [manualRecipient, params.targets]);

    const effectiveRecipient = React.useMemo(() => {
        if (persistedRouting?.mode === 'scm_diff_summary') return persistedRouting.recipient;
        if (persistedRouting?.recipient?.kind === 'execution_run') return persistedRouting.recipient;
        if (manualRecipient) return manualRecipient;
        if (didManualOverride) return null;
        const auto = params.autoRecipient;
        if (!auto) return null;
        if (!isParticipantRecipientAvailable({ targets: params.targets, recipient: auto })) return null;
        return auto;
    }, [didManualOverride, manualRecipient, params.autoRecipient, params.targets, persistedRouting]);

    const setManualRecipient = React.useCallback((next: ParticipantRecipientV1 | null) => {
        setDidManualOverride(true);
        setManualRecipientState(next);
        if (persistenceEnabled && persistedSessionId && scope && scopeIsCurrent()) {
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
    }, [persistedSessionId, persistenceEnabled, scope, scopeIsCurrent]);

    const clearPersistedManualRecipient = React.useCallback(() => {
        setDidManualOverride(false);
        setManualRecipientState(null);
        if (persistenceEnabled && persistedSessionId && scope && scopeIsCurrent()) {
            writeExistingSessionDraft({
                scope,
                sessionId: persistedSessionId,
                patch: { routing: { recipient: null } },
            });
        }
    }, [persistedSessionId, persistenceEnabled, scope, scopeIsCurrent]);

    const setPersistedExecutionRunRequestedAction = React.useCallback((next: PendingRequestedActionV1) => {
        setExecutionRunRequestedAction(next);
        if (persistenceEnabled && persistedSessionId && scope && scopeIsCurrent()) {
            writeExistingSessionDraft({
                scope,
                sessionId: persistedSessionId,
                patch: { routing: { executionRunRequestedAction: StrictJsonValueSchema.parse(next) } },
            });
        }
    }, [persistedSessionId, persistenceEnabled, scope, scopeIsCurrent]);

    return {
        recipient: effectiveRecipient,
        didManualOverride: scmDiffSummaryDiscussion !== null || didManualOverride,
        scmDiffSummaryDiscussion,
        setManualRecipient,
        clearPersistedManualRecipient,
        executionRunRequestedAction,
        setExecutionRunRequestedAction: setPersistedExecutionRunRequestedAction,
    };
}

function normalizeSessionId(sessionId: string | null | undefined): string | null {
    if (typeof sessionId !== 'string') return null;
    const trimmed = sessionId.trim();
    return trimmed.length > 0 ? trimmed : null;
}
