import { decodeMachineStoredContent, encodeMachineStoredContent, withMachineContentSelect } from '@/storage/sessionMachineStoredContent';
import { registerMachineDaemonStateHandler } from './machineDaemonStateHandler';
import {
    acquireMachinePublicationLocksInTx, readMarkedMachineSocketUpgradeRequired,
    readSocketMachineIdentity, readAuthenticatedMachineId, hasCurrentMachineSocketInstallation,
    encodedMachineEnvelope, isSafePlainMachinePublication, resolveMachineScopedPayloadMachineId,
    resolveMachineMetadataTarget, publishMachineAliveObservation,
} from './machinePublication';
import { registerMachineOperationCapabilitiesHandler } from './machineOperationCapabilities';
import { machineAliveEventsCounter, websocketEventsCounter } from "@/app/monitoring/metrics/index";
import { buildUpdateMachineUpdate, eventRouter } from "@/app/events/eventRouter";
import { log } from "@/utils/logging/log";
import { db } from "@/storage/db";
import { Socket } from "socket.io";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { afterTx, inTx, type Tx } from "@/storage/inTx";
import { markAccountsChanged } from "@/app/changes/markAccountChanged";
import { recordMachineAlive } from "@/app/presence/presenceRecorder";
import { replayWorkflowRunMachineWakes } from '@/app/workflows/workflowRunMachineRouting';
import { submitMachineRemoteAlerts } from '@/app/activity/remoteAlerts/submitMachineRemoteAlerts';
import { EXTERNAL_SESSION_OPERATION_SOCKET_EVENT_V1, type ExternalSessionOperationSocketBatchLimitResolutionV1 } from '@happier-dev/protocol/sessions/external/operationActionsV1';
import { ACTION_OPERATION_REVISION_EPHEMERAL_EVENT_V1, ACTION_OPERATION_SNAPSHOT_PUSH_EVENT_V1 } from '@happier-dev/protocol/actions/operations/v1';
import { EXTERNAL_SESSION_TRANSCRIPT_INVALIDATION_EVENT_V1, EXTERNAL_SESSION_SOURCE_UNAVAILABLE_OCCURRENCE_EVENT_V1, ExternalSessionTranscriptInvalidationV1Schema, ExternalSessionSourceUnavailableOccurrenceV1Schema } from '@happier-dev/protocol/sessions/external/secureRefreshV1';
import { MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1, MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1, MachineSessionTerminalCaptureRequestV1Schema, MachineSessionTerminalFinalizeRequestV1Schema, type MachineSessionTerminalCaptureResponseV1, type MachineSessionTerminalFinalizeResponseV1 } from '@happier-dev/protocol/sessions/control/machineSessionTerminalV1';
import { SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, SessionPendingEnqueueByMachineRequestV1Schema,
    SESSION_PENDING_REQUESTER_BOOTSTRAP_EVENT_V1, SessionPendingRequesterBootstrapRequestV1Schema,
    type SessionPendingRequesterBootstrapResponseV1 } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2, SessionPendingExecutionRunEnqueueByMachineRequestV2Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingExecutionRunMachineAdmissionV2';
import { SESSION_SERVER_START_INGRESS_EVENT_V1, type SessionServerStartIngressResponseV1 } from '@happier-dev/protocol/sessions/creation/sessionServerStartV1';
import { MachineUpdateMetadataRequestSchema, type MachineUpdateMetadataResponse } from '@happier-dev/protocol/machines/metadataUpdate';
import { machineStoredContentMatchesAccountMode } from '@happier-dev/protocol/machines/machineStoredContent';
import { projectActionOperationSnapshotPush } from './actionOperationSnapshotPush';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { enqueuePendingMessageByAuthenticatedMachine, updatePendingRequestedAction } from "@/app/session/pending/pendingMessageService";
import { accessPendingRequesterBootstrap } from '@/app/session/pending/pendingRequesterBootstrap';
import { SESSION_PENDING_RESET_START_RELEASE_EVENT_V1, PendingResetStartReleaseRequestV1Schema, type PendingResetStartReleaseResponseV1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { readSessionAccessAuthenticationFromSocket } from '@/app/session/access/sessionAccessAuthentication';
import { emitPendingChanged } from '@/app/session/pending/publishPendingMutation';
import { executeExternalSessionHistoricalImportCommand } from "@/app/session/externalSessionHistoricalImportCommand";
import type { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { publishSessionPublisherClose } from "@/app/presence/publishSessionPublisherClose";
import { hasCurrentSessionScopedMachineAccessInTx } from "@/app/api/socket/sessionScopedBinding";
import { scheduleSessionActivityRemoteAlerts } from "@/app/activity/remoteAlerts/submitSessionActivityRemoteAlerts";
import { resolveCurrentSessionRecipientAccountIdsInTx } from "@/app/session/access/sessionRecipients";
import { scheduleSessionPersonalEvent } from "@/app/session/personal/publishPersonalEvent";
import {
    classifyMachineAvailabilityState,
    readMachineAvailabilityState,
} from "@/app/machines/machineStateGuards";
import { readVerifiedMachineSocketInstallationIdFromSocketData } from "./machineSocketInstallationProof";
import { TEAM_CREDENTIAL_EXTERNAL_PROVIDER_OPERATION_RETIRE_EVENT_V1, TeamCredentialExternalProviderOperationRetireV1Schema } from '@happier-dev/protocol/teams/credentials/externalProviderApiV1';
import { retireExternalBrokerOperationInTx } from "@/app/teams/credentials/externalBrokerOperation";
import { verifyExternalActionMachineRpcExecution, verifyExternalActionMachinePublicationRequester } from "@/app/auth/externalActionExecutionAuthorization";
import { serializeMachineKeyBasis } from "@/app/machines/machineSerialization";
import { readMachineDevcontainerChildInTx } from '@/app/machines/managed/managedRows';
import { publishManagedGuestActivityAvailable } from '@/app/machines/managed/managedGuestActivity';
import { USAGE_SOURCES_INVALIDATION_EVENT_V1, UsageSourcesInvalidationV1Schema } from '@happier-dev/protocol/usage/usageSources';
import {
    resolveMachineAccessInTx,
    resolveMachineAccessForActorsInTx,
    resolveCurrentMachineRecipientAccountIdsInTx,
} from "@/app/machines/machineAccess";
import { SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1, SessionMessageReplyMachineMutationV1Schema, type SessionMessageReplyMutationResultV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { mutateSessionMessageReplyForMachineInTx } from '@/app/session/messages/sessionMessageReply';
import { createServerRpcForwarder } from './serverRpcForwarder';
import { DISCUSSION_AGENT_POST_EVENT_V1, DiscussionMachinePublicationV2Schema, DiscussionAgentApprovedReplayResponseV1Schema, isDiscussionRequestWithinTransportBudgetV1 } from '@happier-dev/protocol/discussions/api';
import { postPreparedDiscussionMessageInTx, prepareDiscussionPostMutationAccounts } from '@/app/discussions/mutations';
import { admitInstalledDiscussionPublisherInTx } from '@/app/discussions/installedPublisherAdmission';
import { isServerFeatureEnabledForHome } from '@/app/features/catalog/serverFeatureGate';
import { ExecutionRunMachineActivityV1Schema } from '@happier-dev/protocol/execution/runs/activityV1';
import { SCM_DIFF_SUMMARY_RESULT_UPDATED_EVENT, ScmDiffSummaryMachineResultUpdateSchema } from '@happier-dev/protocol/scm/diffSummaryResult';

/** Connect and heartbeat share final publisher admission and one transition path. */
export async function observeMachineAliveFromSocket(input: Readonly<{
    userId: string;
    socket: Socket;
    timestamp: number;
    machineId?: string;
    continuingBeat: boolean;
    workSummaryChanged?: true;
    /** Non-persisted wake hint, never evidence of idle or effect admission. */
    managedActivityChanged?: true;
    isCurrent?: () => Promise<boolean>;
}>): Promise<void> {
    const { userId, socket } = input;
    if (!Number.isFinite(input.timestamp) || !socket.connected) return;
    const machineId = resolveMachineScopedPayloadMachineId(socket, input.machineId);
    if (!machineId) return;
    // A current authenticated socket proves receipt now, not clock agreement
    // with the daemon. Queued observations retain their original timestamp at
    // the recorder boundary; only live socket ingress normalizes the clock.
    const timestamp = Date.now();
    // Ownership may require Redis. Admit before opening a transaction so an
    // unavailable ownership service cannot hold a Machine row lock.
    if (input.isCurrent && !await input.isCurrent()) return;
    if (!socket.connected) return;
    const presence = await recordMachineAlive({ accountId: userId, machineId, timestamp }, async (tx, machine) => {
        // A disconnect cancels locally while waiting for the recovery lock.
        if (!socket.connected) return null;
        if (machine.installationId === null) {
            // Released uninstalled custodian publishers have no installation proof.
            if (machine.accountId !== userId || classifyMachineAvailabilityState(machine) !== 'available') return null;
        } else {
            if (machine.accountId !== userId || classifyMachineAvailabilityState(machine) !== 'available'
                || !hasCurrentMachineSocketInstallation(socket, machine.installationId)) return null;
        }
        return { recipientAccountIds: machine.active && input.continuingBeat ? [] : await resolveCurrentMachineRecipientAccountIdsInTx(tx, machineId),
            wasOffline: !machine.active, lastActiveAt: machine.lastActiveAt };
    }, input.continuingBeat ? {
        installationId: readVerifiedMachineSocketInstallationIdFromSocketData(socket.data),
    } : undefined);
    if (!presence) return;
    // Ordinary beats only renew reachability. Transitions and changed work facts
    // publish their separate content-free notifications.
    await publishMachineAliveObservation(userId, machineId, timestamp, presence, !input.continuingBeat,
        input.workSummaryChanged === true);
    if (input.managedActivityChanged === true) {
        // The hint wakes Home managed policy only; signed exact activity still decides idle.
        const installationId = readVerifiedMachineSocketInstallationIdFromSocketData(socket.data);
        if (installationId) await publishManagedGuestActivityAvailable({ accountId: userId, machineId, installationId });
    }
    if (!input.continuingBeat) {
        const installationId = readVerifiedMachineSocketInstallationIdFromSocketData(socket.data);
        if (installationId) await replayWorkflowRunMachineWakes({
            custodianAccountId: userId, machineId, installationId, socket,
        });
    }
}

async function isMachineAvailableForSocket(accountId: string, machineId: string): Promise<boolean> {
    return await readMachineAvailabilityState({ accountId, machineId }) === "available";
}

export function machineUpdateHandler(
    userId: string,
    socket: Socket,
    options: Readonly<{
        operationSocketBatchLimits: ExternalSessionOperationSocketBatchLimitResolutionV1;
        isMachineSocketCurrent?: () => Promise<boolean>;
        sessionPublisherPresence?: Pick<
            ReturnType<typeof createSessionPublisherPresence>,
            "captureMachineSessionTerminal" | "finalizeMachineSessionTerminal"
        >;
        resolveCurrentSessionMachine?: (input: Readonly<{ accountId: string; sessionId: string }>) => Promise<string | null>;
        sessionServerStartIngress?: (params: Readonly<{
            accountId: string;
            sourceMachineId: string;
            request: unknown;
            signal?: AbortSignal;
        }>) => Promise<SessionServerStartIngressResponseV1>;
    }>,
) {
    socket.on(SESSION_PENDING_REQUESTER_BOOTSTRAP_EVENT_V1, async (
        request: unknown, callback?: (response: SessionPendingRequesterBootstrapResponseV1) => void,
    ) => {
        const parsed = SessionPendingRequesterBootstrapRequestV1Schema.safeParse(request);
        const machineId = readAuthenticatedMachineId(socket);
        const installationId = readVerifiedMachineSocketInstallationIdFromSocketData(socket.data);
        if (!parsed.success || !machineId || !installationId || !socket.connected) {
            callback?.({ v: 1, ok: false });
            return;
        }
        try {
            callback?.(await accessPendingRequesterBootstrap({ custodianAccountId: userId, machineId,
                installationId, request: parsed.data }));
        } catch {
            // Custody remains on Pending until the installation can acknowledge its local write.
            log({ module: 'websocket', level: 'warn', event: SESSION_PENDING_REQUESTER_BOOTSTRAP_EVENT_V1 },
                'Machine Pending requester bootstrap storage unavailable');
        }
    });
    // Startup installs both registrar families. Exactly one socket-profile
    // owner may acknowledge this shared publication event.
    if (readAuthenticatedMachineId(socket)) socket.on(DISCUSSION_AGENT_POST_EVENT_V1, async (data: unknown, callback?: (response: unknown) => void) => {
        const respond = (response: unknown) => callback?.(DiscussionAgentApprovedReplayResponseV1Schema.parse(response));
        const parsed = DiscussionMachinePublicationV2Schema.safeParse(data);
        try {
            if (!await isServerFeatureEnabledForHome('sessions.conversations')) {
                respond({ v: 1, ok: false, error: 'discussions_unavailable' });
                return;
            }
            if (!parsed.success) {
                respond({ v: 1, ok: false, error: 'discussion_machine_publication_invalid' });
                return;
            }
            if (!isDiscussionRequestWithinTransportBudgetV1(parsed.data.publication.request)) {
                respond({ v: 1, ok: false, error: 'discussion_invalid_content' });
                return;
            }
            const machineId = readAuthenticatedMachineId(socket);
            const installationId = readVerifiedMachineSocketInstallationIdFromSocketData(socket.data);
            if (!machineId || machineId !== parsed.data.machineId || !installationId) {
                respond({ v: 1, ok: false, error: !machineId ? 'discussion_machine_identity_missing'
                    : machineId !== parsed.data.machineId ? 'discussion_machine_identity_mismatch' : 'discussion_machine_installation_missing' });
                return;
            }
            if (!socket.connected) {
                respond({ v: 1, ok: false, error: 'discussion_machine_credential_not_current' });
                return;
            }
            if (parsed.data.operation === 'workflow_result') {
                const workflowPublication = parsed.data.publication;
                const append = { actorAccountId: userId, authentication: readSessionAccessAuthenticationFromSocket(socket),
                    discussionId: workflowPublication.discussionId, request: workflowPublication.request,
                    producer: workflowPublication.producer, workflowReturn: { machineId, origin: workflowPublication.origin,
                        ...(workflowPublication.expectedParentRevision !== undefined ? { expectedParentRevision: workflowPublication.expectedParentRevision } : {}) } };
                const result = await inTx(async tx => {
                    const admission = await admitInstalledDiscussionPublisherInTx(tx, { accountId: userId, machineId, installationId });
                    if (!admission.ok) return admission;
                    return postPreparedDiscussionMessageInTx(tx, append);
                }, { prepare: () => prepareDiscussionPostMutationAccounts(append) });
                respond({ v: 1, ...result });
                return;
            }
            const reviewedPublication = parsed.data.publication;
            const append = { actorAccountId: userId, authentication: readSessionAccessAuthenticationFromSocket(socket),
                discussionId: reviewedPublication.discussionId, request: reviewedPublication.request, draftReview: reviewedPublication.draftReview,
                ...(reviewedPublication.terminalReturn ? { terminalReturn: reviewedPublication.terminalReturn } : {}),
                ...(reviewedPublication.replyReturn ? { replyReturn: reviewedPublication.replyReturn } : {}),
                producer: { v: 1 as const, kind: 'agent' as const, sessionId: reviewedPublication.sessionId,
                    ...(reviewedPublication.sourceSession ? { sourceSession: reviewedPublication.sourceSession } : {}),
                    ...(reviewedPublication.runId ? { runId: reviewedPublication.runId } : {}),
                    ...(reviewedPublication.toolCallId ? { toolCallId: reviewedPublication.toolCallId } : {}) } };
            const result = await inTx(async tx => {
                // The installed owner replays a reviewed body or an accepted
                // Workflow original; neither impersonates a live Session publisher.
                const admission = await admitInstalledDiscussionPublisherInTx(tx, { accountId: userId, machineId, installationId,
                    source: { sessionId: reviewedPublication.sessionId, sourceSession: reviewedPublication.sourceSession },
                    lockAuthority: true });
                if (!admission.ok) return null;
                return postPreparedDiscussionMessageInTx(tx, append);
            }, { prepare: () => prepareDiscussionPostMutationAccounts(append) });
            respond(result ? { v: 1, ...result } : { v: 1, ok: false, error: 'discussion_post_denied' });
        } catch {
            log({ module: 'websocket', level: 'warn' }, 'Machine reviewed Discussion publication outcome is unknown');
            // Storage/commit uncertainty is not a definitive no-effect refusal.
            // The existing Action owner retains this visible unknown outcome.
            respond({ v: 1, ok: false, error: 'outcome_unknown' });
        }
    });
    socket.on(TEAM_CREDENTIAL_EXTERNAL_PROVIDER_OPERATION_RETIRE_EVENT_V1, async (
        request: unknown,
        callback?: (response: unknown) => void,
    ) => {
        const parsed = TeamCredentialExternalProviderOperationRetireV1Schema.safeParse(request);
        if (!parsed.success) { callback?.({ ok: false, reasonCode: "invalid_request" }); return; }
        const machineId = readAuthenticatedMachineId(socket);
        const installationId = readVerifiedMachineSocketInstallationIdFromSocketData(socket.data);
        try {
            if (!machineId || !installationId || !socket.connected) {
                callback?.({ ok: false, reasonCode: "resource_forbidden" });
                return;
            }
            const result = await inTx(async tx => {
                const machine = await tx.machine.findFirst({
                    where: { id: machineId, accountId: userId, installationId }, select: { id: true },
                });
                if (!machine) return { ok: false as const, reasonCode: "resource_forbidden" as const };
                return await retireExternalBrokerOperationInTx(tx, {
                    authenticatedAccountId: userId, authenticatedMachineId: machine.id,
                    externalApiKeyId: parsed.data.externalApiKeyId, operationId: parsed.data.operationId,
                });
            });
            callback?.(result);
        } catch {
            // No acknowledgement on an indeterminate storage failure: custody
            // keeps its retirement pending and can retry through its owner.
        }
    });
    socket.on(SESSION_SERVER_START_INGRESS_EVENT_V1, async (
        request: unknown,
        callback?: (response: unknown) => void,
    ) => {
        const sourceMachineId = readAuthenticatedMachineId(socket);
        try {
            if (
                !sourceMachineId
                || !(await isMachineAvailableForSocket(userId, sourceMachineId))
            ) {
                callback?.({
                    v: 1,
                    kind: "result",
                    result: { type: "error", code: "permission_denied", retryable: false },
                });
                return;
            }
            if (!options.sessionServerStartIngress) {
                callback?.({
                    v: 1,
                    kind: "result",
                    result: { type: "error", code: "target_unavailable", retryable: true },
                });
                return;
            }
            callback?.(await options.sessionServerStartIngress({
                accountId: userId,
                sourceMachineId,
                request,
            }));
        } catch {
            // The server may already have dispatched a cross-machine start. A
            // response loss must preserve the one canonical creation-key rejoin.
            callback?.({
                v: 1,
                kind: "result",
                result: { type: "pending", retryWithSameCreationKey: true, outcome: "unknown" },
            });
        }
    });

    // Session publishers use the same event with their own envelope and owner.
    if (readSocketMachineIdentity(socket).clientType === 'machine-scoped') socket.on(SESSION_MESSAGE_REPLY_MUTATE_EVENT_V1, async (request: unknown, callback?: (response: SessionMessageReplyMutationResultV1) => void) => {
        const parsed = SessionMessageReplyMachineMutationV1Schema.safeParse(request);
        const machineId = readAuthenticatedMachineId(socket);
        const installationId = readVerifiedMachineSocketInstallationIdFromSocketData(socket.data);
        if (!parsed.success) { callback?.({ v: 1, ok: false, error: 'invalid_request' }); return; }
        if (!machineId || parsed.data.machineId !== machineId || !installationId) {
            callback?.({ v: 1, ok: false, error: 'forbidden' }); return;
        }
        try {
            if (!socket.connected) { callback?.({ v: 1, ok: false, error: 'forbidden' }); return; }
            callback?.(await inTx(tx => mutateSessionMessageReplyForMachineInTx(tx, { accountId: userId, installationId,
                mutation: parsed.data, authentication: readSessionAccessAuthenticationFromSocket(socket) }), { isolationLevel: 'ReadCommitted' }));
        } catch {
            // Indeterminate storage failure retains original custody; no successful ACK.
            callback?.({ v: 1, ok: false, error: 'unavailable' });
        }
    });

    for (const version of [1, 2] as const) {
        const event = version === 2 ? SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2 : SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1;
        socket.on(event, async (
            request: unknown,
            callback?: (response: unknown) => void,
        ) => {
            const parsed = (version === 2 ? SessionPendingExecutionRunEnqueueByMachineRequestV2Schema : SessionPendingEnqueueByMachineRequestV1Schema).safeParse(request);
            const sourceMachineId = readAuthenticatedMachineId(socket);
            if (!parsed.success) {
                callback?.({
                    v: version,
                    result: { status: "rejected", code: "session_input_invalid" },
                });
                return;
            }
            try {
                if (
                    !sourceMachineId
                    || !(await isMachineAvailableForSocket(userId, sourceMachineId))
                ) {
                    callback?.({
                        v: version,
                        result: { status: "rejected", code: "session_input_unauthorized" },
                    });
                    return;
                }
                const { externalAction, ...unsignedRequest } = parsed.data;
                const verifiedInvocation = externalAction
                    ? await verifyExternalActionMachineRpcExecution(externalAction, {
                        event, method: event, requestId: externalAction.authorization.binding.requestId,
                        params: unsignedRequest,
                        resolveCurrentSessionMachine: options.resolveCurrentSessionMachine,
                    }) : null;
                // The custodian's socket carries its hosted requester's verified Action as
                // it carries the unsigned hosted tuple; Pending admission owns the Session.
                if (externalAction && (!verifiedInvocation
                    || verifiedInvocation.principal.accountId !== userId
                        && (verifiedInvocation.binding.custodianAccountId !== userId
                            || parsed.data.targetMachineId !== sourceMachineId)
                    || verifiedInvocation.binding.machineId !== sourceMachineId
                    || parsed.data.targetMachineId !== sourceMachineId && !verifiedInvocation.deploymentPrepareSessionInput
                    || verifiedInvocation.effectActionId !== "session.message.send"
                    || verifiedInvocation.target.kind !== "session"
                    || verifiedInvocation.target.sessionId !== parsed.data.sessionId
                    || readVerifiedMachineSocketInstallationIdFromSocketData(socket.data) !== externalAction.installationId)) {
                    callback?.({ v: version, result: { status: "rejected", code: "session_input_unauthorized" } });
                    return;
                }
                const result = await enqueuePendingMessageByAuthenticatedMachine({
                    followSourceApp: { forwardRpcForUser: createServerRpcForwarder({ io: socket.nsp.server }) },
                    sourceAuthentication: readSessionAccessAuthenticationFromSocket(socket),
                    ...(parsed.data.reply ? { reply: parsed.data.reply } : {}),
                    ...(parsed.data.followSources ? { followSources: parsed.data.followSources } : {}),
                    ...(parsed.data.followRelations ? { followRelations: parsed.data.followRelations } : {}),
                    ...(parsed.data.followDeliveryV1 ? { followDeliveryV1: parsed.data.followDeliveryV1 } : {}),
                    ...(parsed.data.nextTurnNote ? { nextTurnNote: parsed.data.nextTurnNote } : {}),
                    accountId: userId,
                    sourceMachineId,
                    targetMachineId: parsed.data.targetMachineId,
                    ...(parsed.data.v === 2 ? { targetExecutionRunId: parsed.data.recipient.runId } : {}),
                    sessionId: parsed.data.sessionId,
                    localId: parsed.data.localId,
                    content: parsed.data.content,
                    usageTimingV1: parsed.data.usageTimingV1,
                    requestedAction: parsed.data.requestedAction,
                    ...(verifiedInvocation && 'grant' in verifiedInvocation.binding ? { callerInputConstraints: {
                        models: verifiedInvocation.binding.grant.models,
                        permissionModes: verifiedInvocation.binding.grant.permissionModes,
                    } } : {}),
                    ...(parsed.data.requestEqualityEvidenceV1
                        ? { requestEqualityEvidenceV1: parsed.data.requestEqualityEvidenceV1 }
                        : {}),
                });
                callback?.({ v: version, result });
            } catch {
                log({
                    module: "websocket",
                    level: "error",
                    event,
                    errorCode: "internal_error",
                }, "Machine Session Pending enqueue failed.");
                callback?.({
                    v: version,
                    result: {
                        status: "outcomeUnknown",
                        localId: parsed.data.localId,
                        code: "session_input_admission_acknowledgement_lost",
                    },
                });
            }
        });
    }

    socket.on(MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1, async (
        request: unknown,
        callback?: (response: MachineSessionTerminalCaptureResponseV1) => void,
    ) => {
        const parsed = MachineSessionTerminalCaptureRequestV1Schema.safeParse(request);
        const machineId = readAuthenticatedMachineId(socket);
        const installationId = readVerifiedMachineSocketInstallationIdFromSocketData(socket.data);
        if (!parsed.success) {
            callback?.({ v: 1, status: "rejected", reason: "invalid_request" });
            return;
        }
        try {
            if (installationId && !socket.connected) {
                callback?.({ v: 1, status: "rejected", sessionId: parsed.data.sessionId, reason: "unauthorized" });
                return;
            }
            if (!machineId || !(await isMachineAvailableForSocket(userId, machineId))) {
                callback?.({
                    v: 1,
                    status: "rejected",
                    sessionId: parsed.data.sessionId,
                    reason: "wrong_machine_socket",
                });
                return;
            }
            if (!options.sessionPublisherPresence) {
                callback?.({
                    v: 1,
                    status: "rejected",
                    sessionId: parsed.data.sessionId,
                    reason: "unsupported",
                });
                return;
            }
            const result = await options.sessionPublisherPresence.captureMachineSessionTerminal({
                binding: {
                    accountId: userId,
                    machineId,
                    sessionId: parsed.data.sessionId,
                },
                ...(installationId ? { installedMachineCustody: { installationId } } : {}),
            });
            callback?.(result.status === "captured"
                ? {
                    v: 1,
                    status: "captured",
                    sessionId: parsed.data.sessionId,
                    authority: result.target.authority.kind === "generation"
                        ? {
                            kind: "generation",
                            publisherGeneration: result.target.authority.publisherGeneration.toString(),
                        }
                        : {
                            kind: "legacy-heartbeat",
                            committedFenceMs: result.target.authority.committedFence.getTime(),
                        },
                }
                : result.status === "rejected"
                    ? {
                        v: 1,
                        status: "rejected",
                        sessionId: parsed.data.sessionId,
                        // The domain's missing machine binding is an authorization
                        // denial at this existing wire boundary.
                        reason: result.reason === "machine_control_unavailable"
                            ? "unauthorized"
                            : result.reason,
                    }
                    : {
                        v: 1,
                        status: "already_inactive",
                        sessionId: parsed.data.sessionId,
                    });
        } catch {
            log({
                module: "websocket",
                level: "error",
                event: MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1,
                errorCode: "internal_error",
            }, "Machine Session terminal capture failed.");
            callback?.({
                v: 1,
                status: "rejected",
                sessionId: parsed.data.sessionId,
                reason: "internal_error",
            });
        }
    });

    socket.on(SESSION_PENDING_RESET_START_RELEASE_EVENT_V1, async (
        request: unknown, callback?: (response: PendingResetStartReleaseResponseV1) => void,
    ) => {
        const parsed = PendingResetStartReleaseRequestV1Schema.safeParse(request);
        if (!parsed.success) { callback?.({ v: 1, ok: false, reason: 'invalid_request' }); return; }
        const machineId = readAuthenticatedMachineId(socket);
        const installationId = readVerifiedMachineSocketInstallationIdFromSocketData(socket.data);
        try {
            if (!machineId || !installationId || !socket.connected) {
                callback?.({ v: 1, ok: false, reason: 'authority_unavailable' }); return;
            }
            const result = await updatePendingRequestedAction({ actorUserId: userId,
                authentication: readSessionAccessAuthenticationFromSocket(socket), sessionId: parsed.data.sessionId,
                localId: parsed.data.localId, requestedAction: { v: 1, kind: 'enqueue' },
                expectedRequestedAction: { v: 1, kind: 'reset_start', reset: parsed.data.reset },
                resumeWhenAvailable: true, automaticResetReleaseTarget: { machineId, installationId } });
            if (!result.ok) {
                callback?.({ v: 1, ok: false, reason: result.error === 'action-conflict' ? 'action_conflict'
                    : result.error === 'not-found' ? 'pending_not_found'
                    : result.error === 'internal' ? 'internal_error' : 'authority_unavailable' });
                return;
            }
            if (result.didUpdate) await emitPendingChanged({ sessionId: parsed.data.sessionId,
                changedByAccountId: userId, pendingCount: result.pendingCount,
                pendingBlockedCount: result.pendingBlockedCount, pendingVersion: result.pendingVersion,
                recipientCursors: result.recipientCursors, activationTarget: result.activationTarget });
            callback?.({ v: 1, ok: true, didUpdate: result.didUpdate });
        } catch { callback?.({ v: 1, ok: false, reason: 'internal_error' }); }
    });

    socket.on(MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1, async (
        request: unknown,
        callback?: (response: MachineSessionTerminalFinalizeResponseV1) => void,
    ) => {
        const parsed = MachineSessionTerminalFinalizeRequestV1Schema.safeParse(request);
        const machineId = readAuthenticatedMachineId(socket);
        const installationId = readVerifiedMachineSocketInstallationIdFromSocketData(socket.data);
        if (!parsed.success) {
            callback?.({ v: 1, status: "rejected", reason: "invalid_request" });
            return;
        }
        if (!machineId) {
            callback?.({
                v: 1,
                status: "rejected",
                sessionId: parsed.data.sessionId,
                reason: "wrong_machine_socket",
            });
            return;
        }
        if (!options.sessionPublisherPresence) {
            callback?.({
                v: 1,
                status: "rejected",
                sessionId: parsed.data.sessionId,
                reason: "unsupported",
            });
            return;
        }
        try {
            if (installationId && !socket.connected) {
                callback?.({ v: 1, status: "rejected", sessionId: parsed.data.sessionId, reason: "unauthorized" });
                return;
            }
            const result = await options.sessionPublisherPresence.finalizeMachineSessionTerminal({
                ...(installationId ? { installedMachineCustody: { installationId } } : {}),
                target: {
                    binding: {
                        accountId: userId,
                        machineId,
                        sessionId: parsed.data.sessionId,
                    },
                    authority: parsed.data.authority.kind === "generation"
                        ? {
                            kind: "generation",
                            publisherGeneration: BigInt(parsed.data.authority.publisherGeneration),
                        }
                        : {
                            kind: "legacy-heartbeat",
                            committedFence: new Date(parsed.data.authority.committedFenceMs),
                        },
                },
            });
            if (result.status === "closed") {
                await publishSessionPublisherClose({
                    sessionId: parsed.data.sessionId,
                    publisherAccountId: userId,
                    closed: result,
                });
            }
            callback?.(result.status === "rejected"
                ? {
                    v: 1,
                    status: "rejected",
                    sessionId: parsed.data.sessionId,
                    reason: result.reason,
                }
                : {
                    v: 1,
                    status: result.status === "closed_replay"
                        ? "already_inactive"
                        : result.status,
                    sessionId: parsed.data.sessionId,
                });
        } catch {
            log({
                module: "websocket",
                level: "error",
                event: MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1,
                errorCode: "internal_error",
            }, "Machine Session terminal finalize failed.");
            callback?.({
                v: 1,
                status: "rejected",
                sessionId: parsed.data.sessionId,
                reason: "internal_error",
            });
        }
    });

    const handleActionOperationSnapshotPush = async (raw: unknown, acknowledge?: (admitted: boolean) => void) => {
        let admitted = false;
        try {
            if (!socket.connected) return;
            const account = await db.account.findUnique({ where: { id: userId }, select: { encryptionMode: true } });
            if (!account) return;
            const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(account);
            if (mode.status !== 'ready') return;
            const payload = projectActionOperationSnapshotPush(raw, readAuthenticatedMachineId(socket), {
                accountId: userId, encryptionMode: mode.mode,
            });
            if (!payload || !socket.connected) return;
            eventRouter.emitEphemeral({ userId, payload, recipientFilter: { type: 'user-scoped-only' } });
            admitted = true;
        } catch {
            // Unavailable Account admission cannot disclose an operation observation.
        } finally {
            // This acknowledges Home admission and fanout, not delivery to each
            // observing client. Existing producers need not request an ACK.
            acknowledge?.(admitted);
        }
    };
    socket.on(ACTION_OPERATION_SNAPSHOT_PUSH_EVENT_V1, handleActionOperationSnapshotPush);
    socket.on(ACTION_OPERATION_REVISION_EPHEMERAL_EVENT_V1, handleActionOperationSnapshotPush);

    socket.on(EXTERNAL_SESSION_OPERATION_SOCKET_EVENT_V1, async (
        command: unknown,
        callback?: (response: unknown) => void,
    ) => {
        const machineId = readAuthenticatedMachineId(socket);
        if (!machineId) {
            callback?.({
                v: 1,
                kind: "error",
                errorCode: "wrong_machine_socket",
                message: "Historical import requires an authenticated machine socket.",
            });
            return;
        }
        try {
            if (!(await isMachineAvailableForSocket(userId, machineId))) {
                callback?.({
                    v: 1,
                    kind: "error",
                    errorCode: "wrong_machine_socket",
                    message: "Historical import requires a current machine socket.",
                });
                return;
            }
            if (!options.operationSocketBatchLimits.ok) {
                callback?.({
                    v: 1,
                    kind: "error",
                    errorCode: options.operationSocketBatchLimits.errorCode,
                    message: "Historical import exceeds the live socket capacity.",
                });
                return;
            }
            callback?.(await executeExternalSessionHistoricalImportCommand({
                actorUserId: userId,
                transportMachineId: machineId,
                command,
                limits: options.operationSocketBatchLimits.limits,
            }));
        } catch {
            log(
                {
                    module: "websocket",
                    level: "error",
                    event: EXTERNAL_SESSION_OPERATION_SOCKET_EVENT_V1,
                    errorCode: "internal_error",
                },
                "External Session historical import command failed.",
            );
            callback?.({
                v: 1,
                kind: "error",
                errorCode: "internal_error",
                message: "Historical import command failed.",
            });
        }
    });

    socket.on('machine-alive', async (data: {
        machineId?: string;
        time: number;
        workSummaryChanged?: true;
        managedActivityChanged?: true;
    }) => {
        try {
            // Track metrics
            websocketEventsCounter.inc({ event_type: 'machine-alive' });
            machineAliveEventsCounter.inc();

            if (!data || typeof data.time !== 'number') return;
            await observeMachineAliveFromSocket({ userId, socket, timestamp: data.time,
                machineId: data.machineId, continuingBeat: true,
                ...(data.workSummaryChanged === true ? { workSummaryChanged: true as const } : {}),
                ...(data.managedActivityChanged === true ? { managedActivityChanged: true as const } : {}),
                isCurrent: options.isMachineSocketCurrent });
        } catch {
            log(
                {
                    module: 'websocket',
                    level: 'error',
                    event: 'machine-alive',
                    errorCode: 'internal_error',
                },
                'Machine alive handling failed.',
            );
        }
    });

    // The handshake admitted this socket only for its custodian Account's own, unrevoked Machine and
    // verified installation; revoke, replacement and installation change disconnect it by push. A
    // content-free invalidation to that same Account re-reads no Machine row per event: recipients
    // re-authorize their own reads (OWNER-RULINGS 2026-11-16, remove overbuilt re-checks).
    const isAdmittedCustodianInstallationPublisher = (installationId: string): boolean =>
        socket.connected && hasCurrentMachineSocketInstallation(socket, installationId);

    socket.on(SCM_DIFF_SUMMARY_RESULT_UPDATED_EVENT, async (data: unknown) => {
        try {
            const parsed = ScmDiffSummaryMachineResultUpdateSchema.safeParse(data);
            const machineId = parsed.success ? resolveMachineScopedPayloadMachineId(socket, parsed.data.machineId) : null;
            if (!parsed.success || !machineId || !socket.connected) return;
            if (!isAdmittedCustodianInstallationPublisher(parsed.data.installationId)) return;
            const recipientAccountId = parsed.data.executionAuthorizationToken
                ? await verifyExternalActionMachinePublicationRequester({ authorizationToken: parsed.data.executionAuthorizationToken,
                    custodianAccountId: userId, machineId, installationId: parsed.data.installationId }) : userId;
            if (!recipientAccountId) return;
            eventRouter.emitEphemeral({ userId: recipientAccountId, payload: { type: SCM_DIFF_SUMMARY_RESULT_UPDATED_EVENT, machineId,
                resultId: parsed.data.resultId, revision: parsed.data.revision }, recipientFilter: { type: 'user-scoped-only' } });
        } catch {
            log({ module: 'websocket', level: 'error', event: SCM_DIFF_SUMMARY_RESULT_UPDATED_EVENT, errorCode: 'internal_error' },
                'Saved SCM result activity handling failed.');
        }
    });

    socket.on('execution-run-updated', async (data: unknown) => {
        try {
            websocketEventsCounter.inc({ event_type: 'execution-run-updated' });
            const parsed = ExecutionRunMachineActivityV1Schema.safeParse(data);
            const machineId = parsed.success ? resolveMachineScopedPayloadMachineId(socket, parsed.data.machineId) : null;
            if (!parsed.success || !machineId || !socket.connected) return;
            if (!isAdmittedCustodianInstallationPublisher(parsed.data.installationId)) return;
            const recipientAccountId = parsed.data.executionAuthorizationToken
                ? await verifyExternalActionMachinePublicationRequester({ authorizationToken: parsed.data.executionAuthorizationToken,
                    custodianAccountId: userId, machineId, installationId: parsed.data.installationId }) : userId;
            if (!recipientAccountId) return;
            eventRouter.emitEphemeral({ userId: recipientAccountId, payload: { type: 'execution-run-updated', machineId,
                runId: parsed.data.runId }, recipientFilter: { type: 'user-scoped-only' } });
        } catch {
            log({ module: 'websocket', level: 'error', event: 'execution-run-updated', errorCode: 'internal_error' },
                'Machine Run activity handling failed.');
        }
    });

    socket.on(USAGE_SOURCES_INVALIDATION_EVENT_V1, async (data: unknown) => {
        try {
            websocketEventsCounter.inc({ event_type: USAGE_SOURCES_INVALIDATION_EVENT_V1 });
            const parsed = UsageSourcesInvalidationV1Schema.safeParse(data);
            const machineId = parsed.success ? resolveMachineScopedPayloadMachineId(socket, parsed.data.machineId) : null;
            if (!parsed.success || !machineId || !socket.connected) return;
            if (!isAdmittedCustodianInstallationPublisher(parsed.data.installationId)) return;
            // Only the capture Account is woken. Shared Machine access grants no
            // right to its custodian's private source inventory or accounting.
            eventRouter.emitEphemeral({ userId, payload: parsed.data, recipientFilter: { type: 'user-scoped-only' } });
        } catch {
            log({ module: 'websocket', level: 'error', event: USAGE_SOURCES_INVALIDATION_EVENT_V1, errorCode: 'internal_error' },
                'Usage source invalidation handling failed.');
        }
    });

    socket.on(EXTERNAL_SESSION_TRANSCRIPT_INVALIDATION_EVENT_V1, async (data: unknown) => {
        try {
            websocketEventsCounter.inc({ event_type: EXTERNAL_SESSION_TRANSCRIPT_INVALIDATION_EVENT_V1 });

            const clientType = typeof (socket.data as any)?.clientType === 'string'
                ? (socket.data as any).clientType
                : '';
            const machineId = typeof (socket.data as any)?.machineId === 'string'
                ? (socket.data as any).machineId
                : '';
            if (clientType !== 'machine-scoped' || !machineId) {
                return;
            }

            const parsed = ExternalSessionTranscriptInvalidationV1Schema.safeParse(data);
            if (!parsed.success || parsed.data.binding.machineId !== machineId) {
                return;
            }
            if (!(await isMachineAvailableForSocket(userId, machineId))) {
                return;
            }

            eventRouter.emitEphemeral({
                userId,
                payload: parsed.data,
                recipientFilter: {
                    type: 'all-interested-in-session',
                    sessionId: parsed.data.binding.sessionId,
                },
            });
        } catch {
            log(
                {
                    module: 'websocket',
                    level: 'error',
                    event: EXTERNAL_SESSION_TRANSCRIPT_INVALIDATION_EVENT_V1,
                    errorCode: 'internal_error',
                },
                'External Session transcript invalidation handling failed.',
            );
        }
    });

    socket.on(EXTERNAL_SESSION_SOURCE_UNAVAILABLE_OCCURRENCE_EVENT_V1, async (data: unknown) => {
        try {
            websocketEventsCounter.inc({ event_type: EXTERNAL_SESSION_SOURCE_UNAVAILABLE_OCCURRENCE_EVENT_V1 });
            const clientType = typeof (socket.data as Record<string, unknown> | undefined)?.clientType === "string"
                ? (socket.data as Record<string, unknown>).clientType
                : "";
            const machineId = typeof (socket.data as Record<string, unknown> | undefined)?.machineId === "string"
                ? (socket.data as Record<string, unknown>).machineId as string
                : "";
            const parsed = ExternalSessionSourceUnavailableOccurrenceV1Schema.safeParse(data);
            if (clientType !== "machine-scoped" || !machineId || !parsed.success || parsed.data.machineId !== machineId) return;
            if (!(await isMachineAvailableForSocket(userId, machineId))) {
                return;
            }
            const admitted = await inTx(async (tx) => {
                if (!(await hasCurrentSessionScopedMachineAccessInTx({
                    tx, accountId: userId, machineId, sessionId: parsed.data.sessionId,
                }))) return false;
                // Synchronize the committed content-free fact, not a background
                // notification decision. The router qualifies each live socket's
                // credential; Activity then applies its current Follow and policy.
                const recipients = await resolveCurrentSessionRecipientAccountIdsInTx(tx, { sessionId: parsed.data.sessionId });
                for (const recipientAccountId of recipients) {
                    scheduleSessionPersonalEvent(tx, recipientAccountId, {
                        type: 'session-personal-event',
                        sessionId: parsed.data.sessionId,
                        event: 'source_unavailable',
                        eventId: JSON.stringify([parsed.data.machineId, parsed.data.observedAtMs]),
                    });
                }
                return true;
            });
            if (!admitted) return;
            // The daemon emits only after its canonical status metadata write
            // commits. Recipient access, Follow and policy are rechecked by the
            // Activity owner at submission time.
            scheduleSessionActivityRemoteAlerts({
                sessionId: parsed.data.sessionId,
                event: "source_unavailable",
            });
        } catch {
            log({ module: "websocket", level: "error", event: EXTERNAL_SESSION_SOURCE_UNAVAILABLE_OCCURRENCE_EVENT_V1, errorCode: "internal_error" },
                "External Session source-unavailable occurrence handling failed.");
        }
    });

    registerMachineOperationCapabilitiesHandler(userId, socket, { isCurrent: options.isMachineSocketCurrent });

    // Machine metadata update with optimistic concurrency control
    socket.on('machine-update-metadata', async (
        data: unknown,
        callback: (response: MachineUpdateMetadataResponse) => void,
    ) => {
        try {
            const parsed = MachineUpdateMetadataRequestSchema.safeParse(data);
            const machineId = parsed.success
                ? resolveMachineMetadataTarget(socket, parsed.data.machineId)
                : null;

            // Validate input
            if (!parsed.success || !machineId) {
                if (callback) {
                    callback({ result: 'error', message: 'Invalid parameters' });
                }
                return;
            }
            const { metadata, expectedVersion, expectedDataEncryptionKey } = parsed.data;

            if (!socket.connected) {
                callback?.({ result: 'error', message: 'Forbidden' });
                socket.disconnect(true);
                return;
            }
            await inTx(async (tx) => {
                const recipientAccountIds = await acquireMachinePublicationLocksInTx(tx, machineId);
                // Metadata is an offline content edit, not installation execution admission.
                // The canonical access owner keeps a legacy owner's nullable installation valid.
                const admission = await resolveMachineAccessInTx(tx, { actorAccountId: userId, machineId });
                if (!admission || admission.role !== 'manage' || admission.accessState !== 'ready') {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Forbidden' }));
                    return null;
                }
                const machine = await tx.machine.findFirst({
                    where: { accountId: admission.custodianAccountId, id: machineId, installationId: admission.installationId },
                    select: withMachineContentSelect({
                        metadataVersion: true,
                        daemonStateVersion: true,
                        metadata: true,
                        daemonState: true,
                        dataEncryptionKey: true,
                        installationId: true,
                        revokedAt: true,
                        replacedByMachineId: true,
                    }),
                }).then(decodeMachineStoredContent);
                if (!machine) {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Machine not found' }));
                    return null;
                }
                const machineState = classifyMachineAvailabilityState(machine);
                if (machineState === "revoked") {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Machine revoked' }));
                    return null;
                }
                if (machineState === "replaced") {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Machine replaced' }));
                    return null;
                }
                if (!hasCurrentMachineSocketInstallation(socket, machine.installationId)) {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Machine installation changed' }));
                    return null;
                }
                if (encodedMachineEnvelope(machine.dataEncryptionKey) !== expectedDataEncryptionKey) {
                    afterTx(tx, () => callback?.({ result: 'key-mismatch' }));
                    return null;
                }
                const upgradeRequired =
                    readMarkedMachineSocketUpgradeRequired(
                        socket,
                        machine.dataEncryptionKey,
                    );
                if (upgradeRequired) {
                    afterTx(tx, () => callback?.(upgradeRequired));
                    return null;
                }
                if (!machineStoredContentMatchesAccountMode({
                    mode: admission.encryptionMode,
                    dataEncryptionKey: machine.dataEncryptionKey,
                    metadata,
                }) || (admission.encryptionMode === 'plain' && !isSafePlainMachinePublication(metadata, machine.daemonState))) {
                    afterTx(tx, () => callback?.({ result: 'error', message: 'Invalid parameters' }));
                    return null;
                }

                if (machine.metadataVersion !== expectedVersion) {
                    afterTx(tx, () => callback?.({ result: 'version-mismatch', version: machine.metadataVersion, metadata: machine.metadata }));
                    return null;
                }

                const { count } = await tx.machine.updateMany({
                    where: {
                        accountId: admission.custodianAccountId, id: machineId, metadataVersion: expectedVersion,
                        dataEncryptionKey: machine.dataEncryptionKey, installationId: machine.installationId,
                        revokedAt: null, replacedByMachineId: null,
                    },
                    data: encodeMachineStoredContent({ metadata, metadataVersion: expectedVersion + 1 }),
                });

                if (count === 0) {
                    const fresh = await tx.machine.findFirst({
                        where: { accountId: admission.custodianAccountId, id: machineId },
                        select: withMachineContentSelect({ metadataVersion: true, metadata: true, dataEncryptionKey: true, installationId: true, revokedAt: true, replacedByMachineId: true }),
                    }).then(decodeMachineStoredContent);
                    const freshState = classifyMachineAvailabilityState(fresh);
                    if (freshState === "revoked") {
                        afterTx(tx, () => callback?.({ result: 'error', message: 'Machine revoked' }));
                        return null;
                    }
                    if (freshState === "replaced") {
                        afterTx(tx, () => callback?.({ result: 'error', message: 'Machine replaced' }));
                        return null;
                    }
                    if (!fresh) {
                        afterTx(tx, () => callback?.({ result: 'error', message: 'Machine not found' }));
                        return null;
                    }
                    if (fresh.installationId !== admission.installationId
                        || !hasCurrentMachineSocketInstallation(socket, fresh.installationId)) {
                        afterTx(tx, () => callback?.({ result: 'error', message: 'Machine installation changed' }));
                        return null;
                    }
                    if (encodedMachineEnvelope(fresh.dataEncryptionKey) !== expectedDataEncryptionKey) {
                        afterTx(tx, () => callback?.({ result: 'key-mismatch' }));
                        return null;
                    }
                    afterTx(tx, () => callback?.({ result: 'version-mismatch', version: fresh.metadataVersion, metadata: fresh.metadata }));
                    return null;
                }

                const metadataUpdate = { value: metadata, version: expectedVersion + 1 };
                const child = await readMachineDevcontainerChildInTx(tx, machineId);
                const recipientAccess = await resolveMachineAccessForActorsInTx(tx, { machineId, actorAccountIds: recipientAccountIds });
                const publications = await markAccountsChanged(tx, { accountIds: recipientAccountIds, kind: 'machine', entityId: machineId });
                for (const cursor of publications) {
                    const accountId = cursor.accountId;
                    const access = recipientAccess.get(accountId);
                    const devcontainerChild = access?.accessState === 'ready' ? child : null;
                    afterTx(tx, () => {
                        const updatePayload = buildUpdateMachineUpdate(machineId, cursor.resolveCursor(), randomKeyNaked(12), metadataUpdate, undefined, {
                            keyBasis: serializeMachineKeyBasis({ ...machine, metadataVersion: expectedVersion + 1 }),
                            devcontainerChild,
                        });
                        eventRouter.emitUpdate({
                            userId: accountId,
                            payload: updatePayload,
                            recipientFilter: { type: 'machine-scoped-only', machineId },
                        });
                    });
                }
                afterTx(tx, () => callback?.({ result: 'success', version: expectedVersion + 1, metadata }));
                return null;
            }, {
                isolationLevel: "ReadCommitted",
                transactionClass: "machine-metadata",
            });
        } catch {
            log(
                {
                    module: 'websocket',
                    level: 'error',
                    event: 'machine-update-metadata',
                    errorCode: 'internal_error',
                },
                'Machine metadata update failed.',
            );
            if (callback) {
                callback({ result: 'error', message: 'Internal error' });
            }
        }
    });

    registerMachineDaemonStateHandler(userId, socket);
}
