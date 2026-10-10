import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import {
    SessionSpawnNewResultV1Schema,
    type SessionSpawnNewInitialInputDispositionV1,
} from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';

import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { isActionOperationTerminal, resolveActionOperationObservation, type ActionOperationObservation } from '@/sync/domains/actionOperations/actionOperationStore';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import { t } from '@/text';

type ActionOperationSnapshot = ActionOperationProjection['snapshot'];

export type ActionOperationSection = 'inProgress' | 'needsAttention' | 'recent';
export type ActionOperationStatusTone = 'active' | 'success' | 'danger' | 'muted';
export type ActionOperationStatusLabel =
    | Readonly<{ kind: 'producer'; value: string }>
    | Readonly<{ kind: 'host'; value: 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'reconnecting' | 'unavailable' | 'needs_review' }>;

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

export function classifyActionOperationSection(
    snapshot: ActionOperationSnapshot,
    observation: ActionOperationObservation = 'available',
): ActionOperationSection {
    if (!isActionOperationTerminal(snapshot.state) && snapshot.setupReview) return 'needsAttention';
    if (!isActionOperationTerminal(snapshot.state) && resolveActionOperationObservation(snapshot, observation) === 'unavailable') return 'needsAttention';
    if (snapshot.actionId.startsWith('sessions.external.') && snapshot.progress?.kind === 'phase'
        && ['awaiting_user_resume', 'failed', 'reconciliation_required'].includes(snapshot.progress.phase)) return 'needsAttention';
    if (snapshot.state === 'accepted' || snapshot.state === 'running') return 'inProgress';
    if (snapshot.state === 'failed' || snapshot.state === 'cancelled') return 'needsAttention';
    return 'recent';
}

export function resolveActionOperationStatus(
    snapshot: ActionOperationSnapshot,
    observation: ActionOperationObservation,
): Readonly<{ tone: ActionOperationStatusTone; label: ActionOperationStatusLabel }> {
    if (snapshot.state === 'failed') return { tone: 'danger', label: { kind: 'host', value: 'failed' } };
    if (snapshot.state === 'cancelled') return { tone: 'muted', label: { kind: 'host', value: 'cancelled' } };
    if (snapshot.state === 'succeeded') return { tone: 'success', label: { kind: 'host', value: 'succeeded' } };
    if (snapshot.setupReview) return { tone: 'muted', label: { kind: 'host', value: 'needs_review' } };
    observation = resolveActionOperationObservation(snapshot, observation);
    if (observation === 'reconnecting') return { tone: 'muted', label: { kind: 'host', value: 'reconnecting' } };
    if (observation === 'unavailable') return { tone: 'muted', label: { kind: 'host', value: 'unavailable' } };
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
    const result = SessionSpawnNewResultV1Schema.safeParse(snapshot.result);
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
