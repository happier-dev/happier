import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import {
    SessionSpawnNewActionResultV1Schema,
    type SessionSpawnNewInitialInputDispositionV1,
} from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';

import { readActionOperationIntervention, type ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { isActionOperationTerminal, resolveActionOperationObservation, type ActionOperationObservation } from '@/sync/domains/actionOperations/actionOperationStore';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import { t } from '@/text';

type ActionOperationSnapshot = ActionOperationProjection['snapshot'];

export type ActionOperationStatusTone = 'active' | 'success' | 'danger' | 'muted';
export type ActionOperationStatusLabel =
    | Readonly<{ kind: 'producer'; value: string }>
    | Readonly<{ kind: 'host'; value: 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'reconnecting' | 'unavailable' | 'needs_review' | 'outcome_uncertain' | 'waiting_idle' }>;

/** One label owner for operation detail, Activity and Session Work. */
export function describeActionOperationStatusLabel(label: ActionOperationStatusLabel): string {
    if (label.kind === 'producer') return label.value;
    switch (label.value) {
        case 'accepted': return t('inbox.actionOperations.status.accepted');
        case 'running': return t('inbox.actionOperations.status.running');
        case 'succeeded': return t('inbox.actionOperations.status.succeeded');
        case 'failed': return t('inbox.actionOperations.status.failed');
        case 'cancelled': return t('inbox.actionOperations.status.cancelled');
        case 'reconnecting': return t('inbox.actionOperations.observation.reconnecting');
        case 'unavailable': return t('inbox.actionOperations.observation.unavailable');
        case 'needs_review': return t('inbox.needsYou');
        case 'outcome_uncertain': return t('inbox.actionOperations.status.outcomeUncertain');
        case 'waiting_idle': return t('managedRetention.waitingForIdle');
    }
}

/** An unconfirmed Stop can be requested again; it never fabricates a terminal outcome. */
export function canRequestActionOperationStop(
    snapshot: ActionOperationSnapshot,
    observation: ActionOperationObservation,
): boolean {
    return !isActionOperationTerminal(snapshot.state) && snapshot.cancellation === 'supported'
        && (resolveActionOperationObservation(snapshot, observation) === 'available'
            || snapshot.observation?.kind === 'stop_unconfirmed');
}

/** A process exit is an outcome only when the command owner reports a failed step. */
export function readProjectCommandStepExitCode(snapshot: ActionOperationSnapshot): number | null {
    return snapshot.domainRef?.kind === 'projectCommand'
        && snapshot.domainRef.exitCode !== undefined
        && (snapshot.error?.errorCode === 'project_command_step_failed' || snapshot.error?.errorCode === 'project_setup_step_failed')
        ? snapshot.domainRef.exitCode : null;
}

export function resolveActionOperationStatus(
    snapshot: ActionOperationSnapshot,
    observation: ActionOperationObservation,
): Readonly<{ tone: ActionOperationStatusTone; label: ActionOperationStatusLabel }> {
    if (snapshot.state === 'failed') return { tone: 'danger', label: { kind: 'host', value: 'failed' } };
    if (snapshot.state === 'cancelled') return { tone: 'muted', label: { kind: 'host', value: 'cancelled' } };
    if (snapshot.state === 'succeeded') return { tone: 'success', label: { kind: 'host', value: 'succeeded' } };
    if (readActionOperationIntervention(snapshot)) return { tone: 'muted', label: { kind: 'host', value: 'needs_review' } };
    // The owner submitted the work and lost its acknowledgement: neither running nor failed, and never a guess.
    if (snapshot.observation?.kind === 'outcome_uncertain') return { tone: 'muted', label: { kind: 'host', value: 'outcome_uncertain' } };
    observation = resolveActionOperationObservation(snapshot, observation);
    if (observation === 'reconnecting') return { tone: 'muted', label: { kind: 'host', value: 'reconnecting' } };
    if (observation === 'unavailable') return { tone: 'muted', label: { kind: 'host', value: 'unavailable' } };
    if (snapshot.actionId === 'machines.managed.power.set' && snapshot.progress?.kind === 'phase'
        && snapshot.progress.phase === 'managed.intent.waiting-idle') {
        return { tone: 'muted', label: { kind: 'host', value: 'waiting_idle' } };
    }
    if (snapshot.progress?.label) return { tone: 'active', label: { kind: 'producer', value: snapshot.progress.label } };
    return { tone: 'active', label: { kind: 'host', value: snapshot.state } };
}

function readStringField(value: unknown, field: string): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = (value as Record<string, unknown>)[field];
    return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

export function readActionOperationDestinationSessionId(snapshot: ActionOperationSnapshot): string | null {
    if (snapshot.state !== 'succeeded') return null;
    if (snapshot.actionId === 'session.fork') {
        return readStringField(snapshot.result, 'childSessionId');
    }
    if (snapshot.actionId === 'session.spawn_new') {
        return readStringField(snapshot.result, 'sessionId');
    }
    if (snapshot.actionId === 'session.handoff') {
        return snapshot.scope.sessionId ?? null;
    }
    return null;
}

export function readActionOperationDestinationServerId(
    snapshot: ActionOperationSnapshot,
    sourceServerId?: string | null,
): string | null {
    if (snapshot.state !== 'succeeded') return null;
    if (
        snapshot.actionId === 'session.spawn_new'
        || snapshot.actionId === 'session.fork'
        || snapshot.actionId === 'session.handoff'
    ) {
        return typeof sourceServerId === 'string' && sourceServerId.trim() ? sourceServerId.trim() : null;
    }
    return null;
}

export function readActionOperationSessionSpawnNewInitialInput(
    snapshot: ActionOperationSnapshot,
): SessionSpawnNewInitialInputDispositionV1 | null {
    if (snapshot.state !== 'succeeded' || snapshot.actionId !== 'session.spawn_new') return null;
    const result = SessionSpawnNewActionResultV1Schema.safeParse(snapshot.result);
    return result.success && result.data.type === 'success'
        ? result.data.initialInput
        : null;
}

export function readActionOperationPluginIdentity(actionId: string): string | null {
    if (ActionIdSchema.safeParse(actionId).success) return null;
    const separator = actionId.indexOf('/');
    return separator > 0 ? actionId.slice(0, separator) : actionId;
}

export function formatActionOperationAge(snapshot: ActionOperationSnapshot, now: number = Date.now()): string {
    const origin = snapshot.settledAt ?? snapshot.startedAt ?? snapshot.createdAt;
    return formatShortRelativeTimeAt(origin, now);
}
