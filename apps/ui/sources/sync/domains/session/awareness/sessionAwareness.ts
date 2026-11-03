import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import { projectSessionAwarenessV1 } from '@happier-dev/protocol/sessions/awareness/projectV1';
import { readSessionRuntimeWorkStatusV1 } from '@happier-dev/protocol/sessions/awareness/projectionV1';
import { readSessionTerminalControlServiceabilityStateV1 } from '@happier-dev/protocol/sessions/metadata/terminalMetadata';
import { readSessionWorkStateV1FromMetadata } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateV1';
import { resolveAwarenessCurrentnessV1 } from '@happier-dev/protocol/sessions/awareness/runtime';
import { SessionWorkflowActivityHeadlineV1Schema } from '@happier-dev/protocol/sessions/work/workflow/sessionWorkflowActivityHeadlineV1';
import type { ProjectSessionAwarenessV1Input, SessionContentAvailabilityInputV1 } from '@happier-dev/protocol/sessions/awareness/inputV1';
import type { SessionAwarenessProjectionV1 } from '@happier-dev/protocol/sessions/awareness/projectionV1';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionDisplayTitleField } from '@/sync/state/selectors';
import { readSessionListRenderableSourceMetadata, type SessionListRenderableSession } from '../listing/sessionListRenderable';
import { deriveLatestPendingRequestObservedAtFromSession, derivePendingRequestFlagsFromSession } from '../pending/listPendingSessionRequests';
import { readSessionOwnerMetadataView } from '../readSessionOwnerMetadataView';
import { toAwarenessRuntimeInput } from '../attention/runtimePresentation';
import { readSessionContentAvailability } from '../encryptedContentAvailability';
import { readSessionUsageLimitRecoveryFromMetadata } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import { readSessionListPresentationRuntime, readSessionListPresentationOwnerMetadata, readSessionListPresentationOwnerMetadataField, readSessionListPresentationDisplay, readSessionListPresentationPendingFlags,
    readSessionListPresentationPendingObservedAt, type SessionListPresentationSource } from '../listing/sessionListRenderableSessionProjection';

export type UiSessionAwarenessOptions = Readonly<{
    presentationSource?: SessionListPresentationSource;
    /** Status/count consumers need the same classification without constructing the display title. */
    includeTitle?: boolean;
    /** Summary consumers do not display or reuse the private folder. */
    includeWorkspace?: boolean;
    hasPendingUserMessages?: boolean;
    optimisticPendingUserMessageAt?: number | null;
    hasPendingPermissionRequests?: boolean;
    hasPendingUserActionRequests?: boolean;
    pendingRequestObservedAt?: number | null;
}>;

function readUiSessionContentAvailability(
    session: Session | SessionListRenderableSession | ReturnType<typeof readSessionListPresentationDisplay>,
): SessionContentAvailabilityInputV1 {
    const availability = readSessionContentAvailability(session);
    if (session.encryptionMode === 'plain' && availability === 'ready') return { mode: 'plain' };
    switch (availability) {
        case 'ready':
            return { mode: 'e2ee', keyState: 'opened' };
        case 'encrypted_access_pending':
            return { mode: 'e2ee', keyState: 'access_pending' };
        case 'encrypted_access_needs_repair':
            return { mode: 'e2ee', keyState: 'inconsistent' };
        case 'encrypted_content_unavailable':
            return { mode: 'e2ee', keyState: 'content_unavailable' };
        case 'recipient_encryption_setup_required':
            return { mode: 'e2ee', keyState: 'setup_required' };
        case null:
            // Unsettled: no decryption owner has decided yet, so nothing content-derived shows.
            return { mode: 'e2ee', keyState: 'unknown' };
    }
}

/** Adapt already opened UI facts; Protocol owns every operational decision. */
export function createUiSessionAwarenessInput(
    session: Session | SessionListRenderableSession,
    nowMs: number,
    options: UiSessionAwarenessOptions = {},
): ProjectSessionAwarenessV1Input {
    const source = options.presentationSource;
    const hydrated = 'agentState' in session;
    const ownerMetadata = source ? readSessionListPresentationOwnerMetadata(source) : hydrated ? readSessionOwnerMetadataView(session) : null;
    const ownerWork = source ? readSessionListPresentationOwnerMetadataField(source, 'work') : ownerMetadata?.work;
    const statusReason = ownerWork && typeof ownerWork === 'object' && 'statusReason' in ownerWork
        && typeof ownerWork.statusReason === 'string' ? ownerWork.statusReason : undefined;
    const presentationMetadata = hydrated ? readSessionListRenderableSourceMetadata(session) : null;
    const hasReadableMetadata = !('metadataUnavailable' in session && session.metadataUnavailable === true);
    const metadata = hasReadableMetadata
        ? source ? source.metadata : hydrated ? presentationMetadata : session.metadata
        : null;
    const pending = source ? readSessionListPresentationPendingFlags(source) : hydrated ? derivePendingRequestFlagsFromSession(session, []) : session;
    const hasPendingPermissionRequests = options.hasPendingPermissionRequests ?? pending.hasPendingPermissionRequests;
    const hasPendingUserActionRequests = options.hasPendingUserActionRequests ?? pending.hasPendingUserActionRequests;
    const hasPendingOptionsEvidence = options.hasPendingPermissionRequests !== undefined
        && options.hasPendingUserActionRequests !== undefined;
    const hasPendingProjectionEvidence = source ? source.pendingObserved : hydrated
        ? (
            typeof session.pendingPermissionRequestCount === 'number'
            && typeof session.pendingUserActionRequestCount === 'number'
        ) || session.agentState !== null
        : typeof session.hasPendingPermissionRequests === 'boolean'
            && typeof session.hasPendingUserActionRequests === 'boolean';
    const controlState = readSessionTerminalControlServiceabilityStateV1(
        source ? source.metadataFromRow ? source.row.metadata?.terminalControlServiceabilityV1 ?? ownerMetadata?.terminal?.controlServiceabilityV1
            : ownerMetadata?.terminal?.controlServiceabilityV1
            : hydrated ? ownerMetadata?.terminal?.controlServiceabilityV1 : metadata?.terminalControlServiceabilityV1,
    );
    const workflowHeadline = source && !source.metadataFromRow ? ownerMetadata?.sessionWorkflowActivityHeadlineV1
        : hydrated ? ownerMetadata?.sessionWorkflowActivityHeadlineV1 : null;
    const workflow = workflowHeadline == null ? null : SessionWorkflowActivityHeadlineV1Schema.safeParse(workflowHeadline);
    const fork = hasReadableMetadata
        ? source ? source.metadataFromRow ? source.row.forkV1 : readSessionListPresentationOwnerMetadataField(source, 'forkV1')
            : hydrated ? presentationMetadata?.forkV1 : session.forkV1
        : undefined;
    const components = toAwarenessRuntimeInput({
        ...(source ? readSessionListPresentationRuntime(source) : session),
        hasPendingPermissionRequests,
        hasPendingUserActionRequests,
        hasPendingUserMessages: options.hasPendingUserMessages ?? (source?.lifecycle.pendingCount ?? session.pendingCount ?? 0) > 0,
        optimisticThinkingAt: session.optimisticThinkingAt ?? options.optimisticPendingUserMessageAt,
        controlServiceability: controlState === 'unknown' ? null : controlState,
        pendingRequestObservedAt: options.pendingRequestObservedAt ?? (source ? readSessionListPresentationPendingObservedAt(source)
            : hydrated ? deriveLatestPendingRequestObservedAtFromSession(session, []) : session.pendingRequestObservedAt),
    });
    const lifecycle = { ...components.lifecycle,
        processTerminalState: metadata?.lifecycleState === 'stopped' ? 'stopped' as const : null };
    return {
        sessionId: session.id,
        origin: session.origin,
        nowMs,
        title: options.includeTitle === false ? undefined : readSessionDisplayTitleField({ metadata }).value ?? metadata?.name,
        ...components,
        runtime: { ...components.runtime, workStatus: readSessionRuntimeWorkStatusV1(source ? source.pending.agentState : hydrated ? session.agentState : null) },
        lifecycle,
        runtimeIssue: session.lastRuntimeIssue,
        usageLimitRecovery: source?.metadataFromRow ? source.row.metadata?.sessionUsageLimitRecoveryV1 ?? null
            : source ? readSessionUsageLimitRecoveryFromMetadata(metadata)
            : hydrated ? readSessionUsageLimitRecoveryFromMetadata(metadata)
            : hasReadableMetadata ? session.metadata?.sessionUsageLimitRecoveryV1 ?? null : null,
        content: readUiSessionContentAvailability(source ? readSessionListPresentationDisplay(source) : session),
        statusReason,
        work: source ? metadata ? source.metadataFromRow ? source.row.workDisplay
            : readSessionWorkStateV1FromMetadata(metadata) : null
            : hydrated ? metadata ? session.workDisplay !== undefined ? session.workDisplay : readSessionWorkStateV1FromMetadata(metadata) : null : session.workDisplay,
        workflowHeadline: source ? metadata ? source.metadataFromRow ? source.row.workflowHeadline : workflow?.success ? workflow.data : null : null
            : hydrated ? workflow?.success ? workflow.data : null : session.workflowHeadline,
        // A no-folder session's private folder is not a workspace to show or reuse.
        workspace: options.includeWorkspace !== false && metadata && readSessionDirectoryKind(metadata) !== 'managed'
            ? { path: metadata.path, machineId: metadata.machineId ?? undefined }
            : null,
        lineage: fork ? { relation: 'fork', sourceSessionId: fork.parentSessionId } : null,
        currentness: resolveAwarenessCurrentnessV1({
            lifecycle,
            runtime: components.runtime,
            pending: hasPendingOptionsEvidence || hasPendingProjectionEvidence ? 'observed' : 'unavailable',
            work: metadata ? 'observed' : 'unavailable',
        }),
    };
}

export function projectUiSessionAwareness(
    session: Session | SessionListRenderableSession,
    nowMs: number,
    options?: UiSessionAwarenessOptions,
): SessionAwarenessProjectionV1 {
    return projectSessionAwarenessV1(createUiSessionAwarenessInput(session, nowMs, options));
}
