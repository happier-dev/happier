import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import {
    SessionSpawnNewResultV1Schema,
    type SessionSpawnNewInitialInputDispositionV1,
} from '@happier-dev/protocol';

import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import type { ActionOperationObservation } from '@/sync/domains/actionOperations/actionOperationStore';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';

type ActionOperationSnapshot = ActionOperationProjection['snapshot'];

export type ActionOperationSection = 'inProgress' | 'needsAttention' | 'recent';
export type ActionOperationStatusTone = 'active' | 'success' | 'danger' | 'muted';
export type ActionOperationStatusLabel =
    | Readonly<{ kind: 'producer'; value: string }>
    | Readonly<{ kind: 'host'; value: 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'reconnecting' | 'unavailable' }>;

export function classifyActionOperationSection(
    snapshot: ActionOperationSnapshot,
    observation: ActionOperationObservation = 'available',
): ActionOperationSection {
    if (!isActionOperationTerminalState(snapshot.state) && observation === 'unavailable') return 'needsAttention';
    if (snapshot.actionId.startsWith('sessions.external.') && snapshot.progress?.kind === 'phase'
        && ['awaiting_user_resume', 'failed', 'reconciliation_required'].includes(snapshot.progress.phase)) return 'needsAttention';
    if (snapshot.state === 'accepted' || snapshot.state === 'running') return 'inProgress';
    if (snapshot.state === 'failed' || snapshot.state === 'cancelled') return 'needsAttention';
    return 'recent';
}

function isActionOperationTerminalState(state: ActionOperationSnapshot['state']): boolean {
    return state === 'succeeded' || state === 'failed' || state === 'cancelled';
}

export function resolveActionOperationStatus(
    snapshot: ActionOperationSnapshot,
    observation: ActionOperationObservation,
): Readonly<{ tone: ActionOperationStatusTone; label: ActionOperationStatusLabel }> {
    if (snapshot.state === 'failed') return { tone: 'danger', label: { kind: 'host', value: 'failed' } };
    if (snapshot.state === 'cancelled') return { tone: 'muted', label: { kind: 'host', value: 'cancelled' } };
    if (snapshot.state === 'succeeded') return { tone: 'success', label: { kind: 'host', value: 'succeeded' } };
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
