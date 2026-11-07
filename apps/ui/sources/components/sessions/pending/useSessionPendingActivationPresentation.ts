import * as React from 'react';
import { resolveSessionAutoResumeAdmissionV1 } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';

import { deriveManagedWakeProjection, readManagedWakeAuthorization,
    type ManagedWakeProjectionInput } from '@/sync/domains/pending/managedWakeProjection';
import { storage } from '@/sync/domains/state/storage';
import type { PendingMessage, Session } from '@/sync/domains/state/storageTypes';
import { resolvePendingActivationBanner } from './resolvePendingActivationBanner';

/**
 * One owner of a Session's pending-activation presentation for every consumer (Session composer,
 * Inbox row): the managed wake projection, the person's explicit-stop hold and the in-flight resume
 * are read here, so a Retry is offered on the same facts everywhere. Subscribes only to this Session's
 * `resumingAt`; every other input is a fact its caller already holds.
 */
export function useSessionPendingActivationPresentation(input: Readonly<{
    sessionId: string;
    session: Pick<Session, 'active' | 'activeAt' | 'archivedAt' | 'pendingActivationAuthorization'>;
    /** The Session's owner metadata view (explicit stop lives there); null when unreadable. */
    ownerMetadata: unknown;
    /** Canonical Machine reachability; `null` while unknown. */
    machineReachable: boolean | null;
    canWrite: boolean;
    pendingMessages: readonly PendingMessage[];
    pendingLoaded: boolean;
    pendingReadState?: 'loading' | 'error';
    managed: ManagedWakeProjectionInput['managed'];
    managedReadState: 'loading' | 'read';
    machineInventoryState: 'loading' | 'read';
    /** The composer's own live submission owns the moment; no recovery competes with it. */
    suppressed?: boolean;
}>) {
    const resumingAt = storage(state => state.sessions[input.sessionId]?.resumingAt ?? null);
    const { session, ownerMetadata, machineReachable, canWrite, pendingMessages, pendingLoaded, pendingReadState,
        managed, managedReadState, machineInventoryState, suppressed } = input;
    const authorization = readManagedWakeAuthorization(session);
    const managedWakeProjection = React.useMemo(() => authorization ? deriveManagedWakeProjection({
        managed, activation: authorization, machineReachable,
        pending: pendingMessages.find(message => message.localId === authorization.requestId) ?? null,
        runtimeResuming: resumingAt != null, pendingLoaded, pendingReadState, managedReadState, machineInventoryState,
    }) : null, [authorization, machineInventoryState, machineReachable, managed, managedReadState, pendingLoaded,
        pendingMessages, pendingReadState, resumingAt]);
    const autoResumeAdmission = resolveSessionAutoResumeAdmissionV1({ metadata: ownerMetadata, archivedAt: session.archivedAt,
        machineAvailable: machineReachable === true, authorityAvailable: ownerMetadata !== null });
    const presentation = React.useMemo(() => suppressed ? null : resolvePendingActivationBanner({
        authorization: session.pendingActivationAuthorization, activeAt: session.activeAt, active: session.active,
        machineReachable, canWrite, resumingAt, pendingMessages, managedWakeProjection, autoResumeAdmission,
    }), [autoResumeAdmission, canWrite, machineReachable, managedWakeProjection, pendingMessages, resumingAt,
        session.active, session.activeAt, session.pendingActivationAuthorization, suppressed]);
    return { presentation, managedWakeProjection, managedWakeAuthorization: authorization, autoResumeAdmission, resumingAt };
}
