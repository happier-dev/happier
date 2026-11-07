import type { PendingActivationAuthorizationV1 } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';

import { describeManagedWakeLabel } from '@/components/sessions/pending/ManagedWakePopover';
import { resolvePendingActivationBanner, type PendingActivationBannerPresentation } from '@/components/sessions/pending/resolvePendingActivationBanner';
import { deriveManagedWakeProjection, readManagedWakeAuthorization,
    type ManagedWakeProjectionInput } from '@/sync/domains/pending/managedWakeProjection';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';

/** Which existing recovery the Inbox's one Retry runs; the banner owner decides it, never the row. */
export type InboxManagedWakeRetry = 'rearm' | 'retry' | 'resume';

export type InboxManagedWakeRecovery = Readonly<{
    /** The wake owner's reason sentence ("Starting do-bot-1 was refused. Your message is still queued."). */
    sentence: string;
    retry: InboxManagedWakeRetry | null;
    presentation: PendingActivationBannerPresentation;
}>;

/**
 * The Session composer's wake facts, read for an Inbox row the attention owner already admitted (52s2,
 * lab `b-inbox` I). Projection, banner and sentence are the composer's owners; this only names the retry.
 */
export function buildInboxManagedWakeRecovery(input: Readonly<{
    authorization: PendingActivationAuthorizationV1 | null | undefined;
    sessionActiveAt: number;
    sessionActive: boolean;
    canWrite: boolean;
    managed: ManagedWakeProjectionInput['managed'];
    managedReadState: 'loading' | 'read';
    machineInventoryState: 'loading' | 'read';
    machineReachable: boolean | null;
    runtimeResumingAt: number | null;
    pendingMessages: readonly PendingMessage[];
    pendingLoaded: boolean;
    pendingReadState?: 'loading' | 'error';
    names: Parameters<typeof describeManagedWakeLabel>[1];
}>): InboxManagedWakeRecovery | null {
    const authorization = readManagedWakeAuthorization({ activeAt: input.sessionActiveAt,
        pendingActivationAuthorization: input.authorization ?? null });
    if (!authorization) return null;
    const projection = deriveManagedWakeProjection({
        managed: input.managed, activation: authorization, machineReachable: input.machineReachable,
        pending: input.pendingMessages.find(message => message.localId === authorization.requestId) ?? null,
        runtimeResuming: input.runtimeResumingAt != null, pendingLoaded: input.pendingLoaded, pendingReadState: input.pendingReadState,
        managedReadState: input.managedReadState, machineInventoryState: input.machineInventoryState,
    });
    if (!projection) return null;
    const presentation = resolvePendingActivationBanner({
        authorization, activeAt: input.sessionActiveAt, active: input.sessionActive, machineReachable: input.machineReachable,
        canWrite: input.canWrite, pendingMessages: input.pendingMessages, managedWakeProjection: projection,
        resumingAt: input.runtimeResumingAt,
    });
    if (!presentation) return null;
    const retry = presentation.primaryAction === 'process_when_online' ? 'rearm'
        : presentation.primaryAction === 'retry' || presentation.primaryAction === 'resume' ? presentation.primaryAction : null;
    return { sentence: describeManagedWakeLabel(projection, input.names), retry, presentation };
}
