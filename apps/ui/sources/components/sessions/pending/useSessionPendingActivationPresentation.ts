import * as React from 'react';
import { resolveSessionAutoResumeAdmissionV1 } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';

import type { ManagedWakeProjection } from '@/sync/domains/pending/managedWakeProjection';
import { storage } from '@/sync/domains/state/storage';
import type { PendingMessage, Session } from '@/sync/domains/state/storageTypes';
import { resolvePendingActivationBanner } from './resolvePendingActivationBanner';
import { resolveSessionDeliveryFailure } from './pendingMessageVisualState';

/**
 * One owner of a Session's pending-activation presentation for every consumer (Session composer,
 * Inbox row): the acquired managed wake projection, the person's explicit-stop hold and the in-flight
 * resume share one recovery decision. Subscribes only to this Session's
 * `resumingAt`; every other input is a fact its caller already holds.
 */
export function useSessionPendingActivationPresentation(input: Readonly<{
    sessionId: string;
    session: Pick<Session, 'active' | 'activeAt' | 'archivedAt' | 'pendingActivationAuthorization' | 'pendingActivationFailureDetails' | 'lastRuntimeIssue'>;
    /** The Session's owner metadata view (explicit stop lives there); null when unreadable. */
    ownerMetadata: unknown;
    /** Canonical Machine reachability; `null` while unknown. */
    machineReachable: boolean | null;
    canWrite: boolean;
    pendingMessages: readonly PendingMessage[];
    /** Shared acquisition already decided the observed wake and pending custody. */
    managedWakeProjection: ManagedWakeProjection | null;
    /** The composer's own live submission owns the moment; no recovery competes with it. */
    suppressed?: boolean;
    machineAccessRemoved?: boolean;
}>) {
    const resumingAt = storage(state => state.sessions[input.sessionId]?.resumingAt ?? null);
    const { session, ownerMetadata, machineReachable, canWrite, pendingMessages, suppressed } = input;
    const deliveryFailure = React.useMemo(() => resolveSessionDeliveryFailure(pendingMessages, session, input.machineAccessRemoved === true),
        [input.machineAccessRemoved, pendingMessages, session.active, session.activeAt, session.pendingActivationAuthorization,
            session.pendingActivationFailureDetails, session.lastRuntimeIssue]);
    const managedWakeProjection = deliveryFailure?.recovery === 'new_session' ? null : input.managedWakeProjection;
    const autoResumeAdmission = resolveSessionAutoResumeAdmissionV1({ metadata: ownerMetadata, archivedAt: session.archivedAt,
        machineAvailable: machineReachable === true, authorityAvailable: ownerMetadata !== null });
    const presentation = React.useMemo(() => suppressed || deliveryFailure?.recovery === 'new_session' ? null : resolvePendingActivationBanner({
        authorization: session.pendingActivationAuthorization, activeAt: session.activeAt, active: session.active,
        machineReachable, canWrite, resumingAt, pendingMessages, managedWakeProjection, autoResumeAdmission,
    }), [autoResumeAdmission, canWrite, deliveryFailure?.recovery, machineReachable, managedWakeProjection, pendingMessages, resumingAt,
        session.active, session.activeAt, session.pendingActivationAuthorization, suppressed]);
    return { presentation, deliveryFailure, managedWakeProjection, autoResumeAdmission, resumingAt };
}
