import {
    mergeSessionRuntimeActivityProjection,
    parseSessionRuntimeActivityProjectionFields,
    type SessionRuntimeActivityProjection,
    type SessionRuntimeActivityState,
} from '@happier-dev/protocol/sessions/runtime/activity/sessionRuntimeActivity';

export type SessionRuntimeActivityProjectionBase = Readonly<{
    runtimeActivityState?: SessionRuntimeActivityState | null;
    runtimeActivityActiveCount?: number | null;
    runtimeActivityObservedAt?: number | null;
    runtimeActivityRevision?: number | null;
}>;

export type SessionRuntimeActivityProjectionFields = Readonly<{
    runtimeActivityState: SessionRuntimeActivityState;
    runtimeActivityActiveCount: number;
    runtimeActivityObservedAt: number | null;
    runtimeActivityRevision: number;
}>;

export type SessionRuntimeActivityProjectionPatch = Partial<SessionRuntimeActivityProjectionFields>;

export type SessionRuntimeActivityResyncTrigger = Readonly<{
    reason: 'equal_revision_conflict';
    current: SessionRuntimeActivityProjection;
    incoming: SessionRuntimeActivityProjection;
}>;

export type SessionRuntimeActivityResyncHandler = (
    trigger: SessionRuntimeActivityResyncTrigger,
) => void;

export function hasSessionRuntimeActivityProjectionFields(updateBody: unknown): boolean {
    return parseSessionRuntimeActivityProjectionFields(updateBody).kind !== 'absent';
}

export function resolveSessionRuntimeActivityProjectionFields(
    base: SessionRuntimeActivityProjectionBase,
    updateBody: unknown,
    onResyncRequired?: SessionRuntimeActivityResyncHandler,
): SessionRuntimeActivityProjectionPatch {
    return buildSessionRuntimeActivityProjectionPatch(base, updateBody, onResyncRequired);
}

export function buildSessionRuntimeActivityProjectionPatch(
    base: SessionRuntimeActivityProjectionBase,
    updateBody: unknown,
    onResyncRequired?: SessionRuntimeActivityResyncHandler,
): SessionRuntimeActivityProjectionPatch {
    const incoming = parseSessionRuntimeActivityProjectionFields(updateBody);
    if (incoming.kind !== 'valid') return {};

    const current = parseSessionRuntimeActivityProjectionFields(base);
    if (current.kind !== 'valid') return toStoredFields(incoming.projection);

    const result = mergeSessionRuntimeActivityProjection(current.projection, incoming.projection);
    if (result.decision === 'replace') return toStoredFields(result.projection);
    if (result.decision === 'resync_conflict') {
        onResyncRequired?.({
            reason: 'equal_revision_conflict',
            current: current.projection,
            incoming: incoming.projection,
        });
    }
    return {};
}

/**
 * Merge two complete stored projections at their publication boundary.
 * Socket decrypt work can finish out of order after it captured an older
 * session object; applying that whole object must not regress a projection
 * that was published while the decrypt was in flight.
 */
export function resolveMergedSessionRuntimeActivityProjectionFields(
    base: SessionRuntimeActivityProjectionBase,
    incomingValue: unknown,
    onResyncRequired?: SessionRuntimeActivityResyncHandler,
): SessionRuntimeActivityProjectionFields | null {
    const current = parseSessionRuntimeActivityProjectionFields(base);
    const incoming = parseSessionRuntimeActivityProjectionFields(incomingValue);
    if (current.kind !== 'valid') {
        return incoming.kind === 'valid' ? toStoredFields(incoming.projection) : null;
    }
    if (incoming.kind !== 'valid') {
        return toStoredFields(current.projection);
    }

    const result = mergeSessionRuntimeActivityProjection(current.projection, incoming.projection);
    if (result.decision === 'resync_conflict') {
        onResyncRequired?.({
            reason: 'equal_revision_conflict',
            current: current.projection,
            incoming: incoming.projection,
        });
    }
    return toStoredFields(result.projection);
}

function toStoredFields(
    projection: SessionRuntimeActivityProjection,
): SessionRuntimeActivityProjectionFields {
    return {
        runtimeActivityState: projection.state,
        runtimeActivityActiveCount: projection.activeCount,
        runtimeActivityObservedAt: projection.observedAt,
        runtimeActivityRevision: projection.revision,
    };
}
