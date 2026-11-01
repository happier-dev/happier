import * as z from 'zod/mini';
import { isProjectWorkspaceSyncPreparationActionV1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { DaemonLocalServiceLauncherStartRequestV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { ExternalActionActionIdV1Schema, bindExternalActionExecutionAuthorizationVerifyHttpPathV1, bindExternalActionExecutionAuthorizationHttpPathV1, EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationVerifyRequestV1Schema, isExternalActionResolvedTargetAllowedV1, isExternalActionWorkflowActionIdV1, type ExternalActionExecutionAuthorizationBindingV1, type ExternalActionExecutionAuthorizationV1, type ExternalActionMachineRpcExecutionV1, type ExternalActionTargetV1, type ExternalActionServerPrincipalV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { decodeExternalActionResolvedTargetV1, encodeExternalActionResolvedTargetV1, verifyExternalActionMachineRpcRequestV1, verifyExternalActionMachineRequestV1, isExternalActionAuthorizationBoundToEnvelope, type ExternalActionMachineRpcEventV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { getActionSpec, isPluginProvenanceOnlyActionId, isSessionTargetPreparationAction, PublicActionIdSchema, SignedRootActionIdSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { ActionIdSchema, type ActionId } from '@happier-dev/protocol/actions/actionIds';
import { MachineAccessActionIdSchema } from '@happier-dev/protocol/actions';
import type { ActionRequiredAuthority } from "@happier-dev/protocol/actions/metadata";
import { SOCKET_RPC_EVENTS, WorkspaceSyncSourceExecutionV1Schema, type WorkspaceSyncSourceRoutingV1, type WorkspaceSyncSourceWriterTargetRoutingV1,
    type WorkspaceSyncSourceExecutionV1, type WorkspaceSyncTargetRoutingV1, type WorkspaceSyncSeedRoutingV1 } from "@happier-dev/protocol/socketRpc";
import { OpenProjectInputV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { evaluateApiTokenGrantV1, isApiTokenGrantWithinV1, isApiTokenGrantTargetMemberV1, isApiTokenGrantRestrictedV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { resolveCredentialActionAdmissionV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { ManagedMachineActionIdV1Schema, managedMachineActionEndpointPathV1, ManagedControllerReportV1Schema, ManagedControllerIntentReportV1Schema, type ManagedControllerReportV1, type ManagedControllerIntentReportV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { type AuthTokenAuthenticationEvidenceV1 } from '@happier-dev/protocol/auth/authToken';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { QualifiedConnectedServiceUsageSourceV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { ProviderAccountUsageRecordIdSchema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { parseQualifiedConnectedAccountV4StructuredQueryValue } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4QueryCodec';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1, SessionPendingEnqueueByMachineRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2, SessionPendingExecutionRunEnqueueByMachineRequestV2Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingExecutionRunMachineAdmissionV2';
import { resolveMachineRpcExternalActionEffectV1 } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { MANAGED_ACTIVITY_READ_RPC_METHOD, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD,
    ManagedActivityReadRequestV1Schema, ManagedAdmissionDrainConfirmRequestV1Schema,
    type ManagedActivityReadRequestV1 } from '@happier-dev/protocol/machines/managed/managedIntentV1';

import { classifyMachineAvailabilityState } from "@/app/machines/machineStateGuards";
import { resolveMachineAdmission, resolveMachineAdmissionInTx } from "@/app/machines/machineAccess";
import { ManagedMachineError, requireCurrentManagedMachineInTx, sameManagedInput, readManagedMachineInTx, readManagedAdmissionState, projectManagedMachine,
    readMachineDevcontainerWorkspaceSyncRouteInTx, readMachineDevcontainerWorkspaceSyncEndpointInTx } from '@/app/machines/managed/managedRows';
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { db } from "@/storage/db";
import { inReadSnapshot, type Tx } from "@/storage/inTx";
import { enforceLoginEligibility } from "./enforceLoginEligibility";
import { narrowCredentialAuthority } from './effectiveCredentialAuthority';
import { hasCurrentSessionActionRpcSourceBinding, hasCurrentSessionActionRpcSourceBindingInTx,
    hasCurrentSessionScopedMachineAccessInTx, hasCurrentMachineAccessForSessionInTx } from '@/app/api/socket/sessionScopedBinding';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowReadRequestV1Schema,
    ProjectAccountRowListRequestV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { ProjectSourcesCreateInputV1Schema, ProjectSourcesUpdateInputV1Schema,
    ProjectSourcesDeleteInputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { PROJECT_TRUST_ROUTE_V1, ProjectTrustMutationRequestV1Schema, ProjectTrustReadRequestV1Schema,
    ProjectTrustListRequestV1Schema } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';
import { WORKSPACE_EXECUTION_CONFIG_ROUTE_V1, WorkspaceExecutionConfigReadRequestV1Schema,
    WorkspaceExecutionConfigMutationRequestV1Schema } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import { isRequesterProjectExecutionActionV1, PROJECT_FINITE_ACTION_RPC_METHODS_V1, PROJECT_ACTION_INPUT_SCHEMAS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { WorkspaceSyncPrepareBetweenRequestV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { MACHINE_TERMINAL_ACTION_IDS } from '@happier-dev/protocol/actions/specs/machineTerminal';
import { ExternalActionRequestEnvelopeSchema, type ExternalActionRequestEnvelope } from '@happier-dev/protocol/actions/externalActionApi';
import { ProjectServiceRelocateInputV1Schema, isProjectServiceMoveChildInputV1, readProjectServiceMoveChildEffectV1, readProjectServiceMoveChildMachineV1 } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { readDiscussionSecondOpinionModelChildV1, isDiscussionSecondOpinionModelRpcMethodV1 } from '@happier-dev/protocol/discussions/secondOpinionActions';
import { TargetedActionRpcRequestV1Schema } from '@happier-dev/protocol/actions/actionRpcTransport';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { SessionInputSourceSessionV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { isSessionInputSourceCurrentInTx, readSessionMessageReplyInTx } from '@/app/session/messages/sessionMessageReply';

import { auth, type VerifiedApiTokenPrincipal } from "./auth";
import { isAutomationOriginRunPublisherTx } from '@/app/automations/automationTriggerCauseChain';
import { QualifiedProviderAccountUsageHistoryRequestV4Schema } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { PendingResetStartsReadInputV1Schema } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { readExternalActionPendingResetStartPurpose, isExternalActionPendingResetStartReadPurpose } from './externalActionPendingResetStartPurpose';
import { SessionBoardMutationV1Schema } from '@happier-dev/protocol/sessions/board/mutations';
import { SessionSystemRecordAddressSchema } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordAddress';
import { projectExternalActionPendingResetStartAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { SCM_REVIEWED_MARKS_KV_PREFIX, buildScmReviewedMarksKey } from '@happier-dev/protocol/scm/reviewedMarks';
import { KvMutationRequestSchema } from '@/app/kv/kvMutate';
import { isHomeDomainActionIdV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { isDiscussionActionIdV1, discussionActionHttpWireInputSchemaV1 } from '@happier-dev/protocol/actions/discussionActionFamily';
import { DISCUSSION_HTTP_PATHS_V1, DiscussionListQueryV1Schema, DiscussionRouteDiscussionParamsV1Schema } from '@happier-dev/protocol/discussions/api';
import { DiscussionListInputV1Schema } from '@happier-dev/protocol/discussions/actions';
import { DiscussionRecipientKeyEnvelopeCommitInputV1Schema } from '@happier-dev/protocol/discussions/access';
import { isSessionFollowActionIdV1 } from '@happier-dev/protocol/sessions/follow/actions';
import { isSessionFollowActionHttpRequestV1, resolveSessionFollowActionRequest } from '@happier-dev/protocol/sessions/follow/actionTransport';
import { SessionOrganizationPinSetInputSchema } from '@happier-dev/protocol/actions/sessionOrganizationMoveAction';
import { isSessionStateFieldActionId } from '@happier-dev/protocol/actions/sessionStateFieldActions';
import { SessionMetadataTuplePatchV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { SessionListQueryV1Schema } from '@happier-dev/protocol/sessions/listing/query';
import { isLedSubtreeSessionLifecycleActionId } from '@happier-dev/protocol/actions/executor/sessionListAccess';
import { readSessionManagedSubtreeSessionIdsInTx } from '@/app/session/follow/sessionManagerSubtree';
import { DOC_EDIT_PROPOSAL_HTTP_PATHS_V1, DocEditAcceptTransportInputV1Schema,
    DocEditDeclineTransportInputV1Schema } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { DISCUSSION_SECOND_OPINION_PREVIEW_HTTP_PATH_V1, DiscussionSecondOpinionPreviewInputV1Schema } from '@happier-dev/protocol/discussions/secondOpinion';
import { ArtifactAccessGrantSetInputV1Schema, ArtifactRecipientKeyEnvelopeCommitInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { bindDiscussionCandidatePeopleReadV1, projectDiscussionCandidateSessionQueryV1 } from '@happier-dev/protocol/actions/discussionActionFamily';
import { UsersSearchQueryV1Schema } from '@happier-dev/protocol/social/friends';
import { SESSION_FOLLOW_RULES_ROUTE_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { isMemoryWriteActionV1 } from '@happier-dev/protocol/prompts/library/memoryActionsV1';
import { log } from '@/utils/logging/log';

export type VerifiedExternalActionPrincipal = VerifiedApiTokenPrincipal
    | (Extract<ExternalActionServerPrincipalV1, { authentication: unknown }>
        & Readonly<{ authority: ActionRequiredAuthority; authenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[] }>);

/** Original Account Project ingress still uses the canonical Action admission policy. */
export function isOriginalAccountProjectAction(actionId: string): boolean {
    return isRequesterProjectExecutionActionV1(actionId)
        || Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, actionId);
}
export function isOriginalAccountHandoffAction(actionId: string): boolean {
    return ActionIdSchema.safeParse(actionId).success
        && (actionId === 'session.handoff' || actionId.startsWith('session.handoff.'));
}

/** Installed Session and Workflow callers propose on the Agent surface; this never grants execution authority.
 * Ingress must verify its installation proof and current source before minting.
 */
export function readExternalActionSessionProposalSurface(
    origin?: Pick<ExternalActionExecutionAuthorizationBindingV1, 'sessionActionOrigin' | 'sessionActionSource' | 'workflowActionOrigin'>,
): 'agent' | undefined {
    return origin?.workflowActionOrigin || origin?.sessionActionOrigin && origin.sessionActionSource ? 'agent' : undefined;
}

/** Client roots need the installed Session proof; a paired credential alone cannot originate them. */
function isInstalledSessionClientAction(
    spec: Pick<ReturnType<typeof getActionSpec>, 'executionPlacement'>,
    origin?: Pick<ExternalActionExecutionAuthorizationBindingV1, 'sessionActionOrigin' | 'sessionActionSource' | 'workflowActionOrigin'>,
): boolean {
    return spec.executionPlacement === 'client' && readExternalActionSessionProposalSurface(origin) !== undefined;
}

/** Interactive Account execution consumes the canonical signed-root catalog and declaration families. */
export function isOriginalAccountExecutionAction(actionId: string,
    origin?: Pick<ExternalActionExecutionAuthorizationBindingV1, 'sessionActionOrigin' | 'sessionActionSource' | 'workflowActionOrigin'>): boolean {
    const parsed = SignedRootActionIdSchema.safeParse(actionId);
    if (!parsed.success) return false;
    const spec = getActionSpec(parsed.data);
    if (spec.originalExecution?.accountRoot === 'separate') return false;
    // Home cannot open encrypted operands. The declaration names the variants
    // that the receiving daemon resolves after schema admission.
    const placements = spec.executionPlacements ?? [spec.executionPlacement];
    return isPluginProvenanceOnlyActionId(parsed.data)
        || placements.includes('account') || placements.includes('machine') || isInstalledSessionClientAction(spec, origin)
        || spec.executionPlacement === 'session'
            && spec.surfaces[readExternalActionSessionProposalSurface(origin) ?? 'api'] === true
            && resolveCredentialActionAdmissionV1({ spec, authority: 'account_automation', grant: null,
                surface: readExternalActionSessionProposalSurface(origin) }).ok
        || spec.executionPlacement === 'account' && readExternalActionSessionProposalSurface(origin) !== undefined
        || spec.originalExecution?.accountRoot === 'allowed';
}

/** Paired terminal roots consume catalog placement/policy without inventing a Session source. */
export function isOriginalTerminalExecutionAction(actionId: string,
    origin?: Pick<ExternalActionExecutionAuthorizationBindingV1, 'sessionActionOrigin' | 'sessionActionSource' | 'workflowActionOrigin'>): boolean {
    if (isPluginProvenanceOnlyActionId(actionId)) return false;
    const parsed = ActionIdSchema.safeParse(actionId);
    if (!parsed.success) return false;
    const spec = getActionSpec(parsed.data);
    const surface = readExternalActionSessionProposalSurface(origin);
    const placements = spec.executionPlacements ?? [spec.executionPlacement];
    return spec.originalExecution?.accountRoot !== 'separate' && SignedRootActionIdSchema.safeParse(actionId).success
            && (placements.some(placement => placement === 'machine' || placement === 'account' || placement === 'session')
                || isInstalledSessionClientAction(spec, origin))
            && (spec.executionPlacement !== 'session' || spec.surfaces[surface ?? 'api'] === true)
            && resolveCredentialActionAdmissionV1({ spec, authority: 'account_automation', grant: null, surface }).ok
        || spec.originalExecution?.terminalRoot === 'allowed'
            && resolveCredentialActionAdmissionV1({ spec, authority: 'account_automation', grant: null, surface }).ok
        || spec.originalExecution?.terminalRoot === 'host'
            && !origin?.sessionActionOrigin && !origin?.sessionActionSource
            && !origin?.workflowActionOrigin
            && resolveCredentialActionAdmissionV1({ spec, authority: 'account_automation', grant: null, surface }).ok;
}

/** Native effects use C41 policy; Account effects retain their domain route's authority. */
export function resolveExternalActionExecutionMachineAdmissionInTx(reader: Tx,
    input: Readonly<{ actorAccountId: string; machineId: string; actionId: string }>): ReturnType<typeof resolveMachineAdmissionInTx> {
    const action = SignedRootActionIdSchema.safeParse(input.actionId);
    const spec = action.success ? getActionSpec(action.data) : null;
    const accountPlaced = spec?.executionPlacement === 'account'
        && !(spec.executionPlacements ?? []).includes('machine');
    // This Machine carries an Account Action; it does not execute its domain
    // effect. Use admits the carrier, while the Account route owns the actual
    // Session/resource permission (including managed wake's separate Manage).
    // Input-dependent Machine variants retain their native admission policy.
    return resolveMachineAdmissionInTx(reader, { actorAccountId: input.actorAccountId, machineId: input.machineId,
        ...(input.actionId === 'approval.request.decide'
            ? { rpcMethod: RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED }
            : accountPlaced ? {} : { actionId: input.actionId }) });
}

/** Existing host-private phases are effects of an accepted root, never public originators. */
function parseExternalActionEffectAction(binding: ExternalActionExecutionAuthorizationBindingV1, actionId: string) {
    return (isDocDiscussionEffect(binding.actionId, actionId) || isDocReadEffect(binding.actionId, actionId)
        || isSecondOpinionEffect(binding.actionId, actionId))
        ? SignedRootActionIdSchema.safeParse(actionId)
        : binding.handoffContinuation && binding.handoffAdmission && binding.actionId === actionId
        && isOriginalAccountHandoffAction(actionId)
        ? ActionIdSchema.safeParse(actionId)
        : 'authentication' in binding && (binding.authentication.kind === 'account'
            || binding.authentication.kind === 'terminal' && isOriginalTerminalExecutionAction(actionId, binding)
            || readExternalActionSessionProposalSurface(binding) !== undefined)
            ? SignedRootActionIdSchema.safeParse(actionId) : PublicActionIdSchema.safeParse(actionId);
}

/** Private phases spend only the original accepted handoff grant, never a fresh spawn grant. */
export function readExternalActionCredentialActionId(binding: ExternalActionExecutionAuthorizationBindingV1): string {
    return binding.handoffContinuation && binding.handoffAdmission
        && (isOriginalAccountHandoffAction(binding.actionId) || binding.actionId === 'session.spawn_new')
        ? 'session.handoff' : binding.actionId;
}

export { isExternalActionAuthorizationBoundToEnvelope };

/** Project the signed root's authority, narrowed only by the authenticated invocation ceiling. */
export function projectExternalActionBoundPrincipal(binding: ExternalActionExecutionAuthorizationBindingV1,
    current: VerifiedExternalActionPrincipal,
    authorityCeiling?: ExternalActionServerPrincipalV1['authority']): (ExternalActionServerPrincipalV1
        & Readonly<{ authority: ActionRequiredAuthority }>) | null {
    if (current.accountId !== binding.accountId) return null;
    if ('authentication' in binding) {
        if (!('authentication' in current)) return null;
        if (binding.workflowActionOrigin) return { accountId: binding.accountId, authentication: binding.authentication,
            authority: 'account_automation', workflowActionOrigin: binding.workflowActionOrigin };
        if (binding.authentication.kind === 'terminal') return { accountId: binding.accountId,
            authentication: binding.authentication, authority: 'account_automation',
            ...(binding.sessionActionOrigin ? { sessionActionOrigin: binding.sessionActionOrigin } : {}) };
        return binding.sessionActionOrigin
            ? { accountId: binding.accountId, authentication: binding.authentication,
                authority: 'account_automation', sessionActionOrigin: binding.sessionActionOrigin }
            : { accountId: binding.accountId, authentication: binding.authentication,
                authority: narrowCredentialAuthority(current.authority, authorityCeiling) };
    }
    if ('authentication' in current) return null;
    return { accountId: binding.accountId, authority: 'account_automation', principalId: binding.principalId,
        credentialId: binding.credentialId, grant: binding.grant };
}

/** Keep verified private facts while the signed root owns immutable public provenance. */
function projectVerifiedExternalActionBoundPrincipal(binding: ExternalActionExecutionAuthorizationBindingV1,
    current: VerifiedExternalActionPrincipal): VerifiedExternalActionPrincipal | null {
    const bound = projectExternalActionBoundPrincipal(binding, current);
    if (!bound) return null;
    // Signed facts were read from this exact binding by the credential owner.
    if ('authentication' in current) return current;
    return 'authentication' in bound ? null : { ...current, ...bound };
}

function readHandoffContinuationIssuanceAction(path: string): string | null {
    if (!path.startsWith(EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1) || !path.endsWith('/execution-authorization')) return null;
    try {
        const actionId = decodeURIComponent(path.slice(EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1.length).split('/')[0]);
        return (isOriginalAccountHandoffAction(actionId) && actionId !== 'session.handoff' || actionId === 'session.spawn_new')
            && path === bindExternalActionExecutionAuthorizationHttpPathV1(actionId) ? actionId : null;
    } catch { return null; }
}

/** The existing Session key and C41 admissions own both sides of one handoff. */
export async function readCurrentExternalActionHandoffBindingInTx(reader: Tx, input: Readonly<{
    accountId: string;
    requireSourceOnline?: true;
    handoffAdmission: NonNullable<ExternalActionExecutionAuthorizationBindingV1['handoffAdmission']>
        | Pick<NonNullable<ExternalActionExecutionAuthorizationBindingV1['handoffAdmission']>, 'sessionId' | 'sourceMachineId' | 'targetMachineId'>;
}>): Promise<NonNullable<ExternalActionExecutionAuthorizationBindingV1['handoffAdmission']> | null> {
    const { handoffAdmission: handoff } = input;
    const source = await resolveMachineAdmissionInTx(reader, { actorAccountId: input.accountId,
        machineId: handoff.sourceMachineId, ...(input.requireSourceOnline ? { requireOnline: true } : {}) });
    const target = await resolveMachineAdmissionInTx(reader, { actorAccountId: input.accountId,
        machineId: handoff.targetMachineId });
    if (source.kind !== 'admitted' || target.kind !== 'admitted'
        || ('sourceInstallationId' in handoff && handoff.sourceInstallationId !== source.installationId)
        || ('targetInstallationId' in handoff && handoff.targetInstallationId !== target.installationId)
        || !await hasCurrentSessionActionRpcSourceBindingInTx(reader, { accountId: input.accountId,
            machineId: handoff.sourceMachineId, installationId: source.installationId,
            sourceSessionId: handoff.sessionId })) return null;
    return { sessionId: handoff.sessionId, sourceMachineId: handoff.sourceMachineId,
        targetMachineId: handoff.targetMachineId, sourceInstallationId: source.installationId,
        targetInstallationId: target.installationId };
}

type IssuedAcquireNativeFactPurpose = Readonly<{ kind: 'issued-managed-acquire-native-fact'; report: ManagedControllerReportV1 }>;
type IssuedHandoffContinuationPurpose = Readonly<{ kind: 'issued-handoff-continuation' }>;
type IssuedIntentNativeFactPurpose = Readonly<{ kind: 'issued-managed-intent-native-fact'; report: ManagedControllerIntentReportV1 }>;
type RetainedDiscussionPublicationPurpose = Readonly<{ kind: 'retained-discussion-publication'; source: SessionInputSourceSessionV1 }>;
type ExternalActionVerificationPurpose = IssuedAcquireNativeFactPurpose | IssuedHandoffContinuationPurpose | IssuedIntentNativeFactPurpose
    | RetainedDiscussionPublicationPurpose;

/** Root verification only: final publication still opens the approved Artifact at its trusted host. */
async function isRetainedDiscussionPublicationSourceCurrentInTx(reader: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1, source: SessionInputSourceSessionV1): Promise<boolean> {
    const original = binding.sessionActionOrigin;
    const installation = binding.sessionActionSource;
    if (!('authentication' in binding) || !['discussion.post', 'discussion.reply'].includes(binding.actionId)
        || binding.target.kind !== 'machine' || binding.target.machineId !== binding.machineId
        || !original || !installation || installation.machineId !== binding.machineId
        || installation.installationId !== binding.installationId
        || !source.sourceInputId || !source.discussionAddressing
        || source.sourceSessionId !== original.caller.sessionId
        || source.sourceInputId !== original.sourceInputId || source.sourceTurnId !== original.sourceTurnId
        || source.discussionAddressing.participantSessionId !== source.sourceSessionId
        || !await isSessionInputSourceCurrentInTx(reader, binding.accountId, source)) return false;
    const retained = await readSessionMessageReplyInTx(reader, { accountId: binding.accountId,
        sessionId: source.sourceSessionId, localId: source.sourceInputId,
        authentication: { env: process.env, authority: 'account_automation', tokenEpoch: binding.authentication.tokenEpoch,
            authenticationEvidence: binding.authentication.evidence } });
    return retained.status === 'available' && retained.progress.mode === 'return' && !retained.progress.workflow
        && retained.progress.acceptedTurnId === source.sourceTurnId
        && sameStrictJsonValue(retained.progress.discussion, source.discussionAddressing);
}

/** Retirement closes effects, not reports of the one already-submitted native tuple. */
async function isIssuedIntentNativeFactReportInTx(reader: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    report: ManagedControllerIntentReportV1): Promise<boolean> {
    if (!binding.workflowActionOrigin || !['machines.managed.power.set', 'machines.managed.delete'].includes(binding.actionId)
        || binding.serverIdentityId !== report.homeId || binding.requestId !== report.requestId
        || binding.machineId !== report.controller.machineId || binding.installationId !== report.controller.installationId) return false;
    try {
        const row = await readManagedMachineInTx(reader, report);
        const pending = readManagedAdmissionState(row.admittedInput).submittedEffect;
        return row.custodianAccountId === binding.custodianAccountId && Boolean(pending)
            && pending!.expectedIntentRevision === report.expectedIntentRevision && pending!.requestId === report.requestId
            && sameManagedInput(pending!.controller, report.controller)
            && (binding.actionId === 'machines.managed.delete' ? pending!.intent === 'delete' : pending!.intent === 'stop' || pending!.intent === 'suspend' || pending!.intent === 'start' || pending!.intent === 'resume');
    } catch (error) {
        if (!(error instanceof ManagedMachineError)) throw error;
        return false;
    }
}

/** A submitted purchase may still return its identity after its source stops admitting effects. */
async function isIssuedAcquireNativeFactReportInTx(reader: Tx, binding: ExternalActionExecutionAuthorizationBindingV1,
    report: ManagedControllerReportV1): Promise<boolean> {
    if ((report.result.kind !== 'bound' && report.result.kind !== 'pending')
        || (binding.actionId !== 'machines.managed.acquire' && binding.actionId !== 'machines.managed.bootstrap.retry')
        || binding.serverIdentityId !== report.homeId || binding.machineId !== report.controller.machineId
        || binding.installationId !== report.controller.installationId
        // Retry keeps its own signed Action correlation; its body addresses
        // the original purchase returned by the existing controller context.
        || (binding.actionId === 'machines.managed.acquire' && binding.requestId !== report.requestId)) return false;
    try {
        const row = await requireCurrentManagedMachineInTx(reader, report,
            { requestAuthority: 'creation', allowCanceledResourceReport: true });
        return row.custodianAccountId === binding.custodianAccountId
            && (row.allocation === 'may-exist' || (report.result.kind === 'bound' && row.allocation === 'bound'));
    } catch (error) {
        if (!(error instanceof ManagedMachineError)) throw error;
        return false;
    }
}

/**
 * A Machine target is placement for opaque Session input, not Session access.
 * The daemon resolves the decrypted selector and signs that Session target;
 * issuance, principal currentness and resolved-effect verification share this
 * owner and the existing exact Session/Machine access proof.
 */
export async function hasCurrentOriginalSessionActionTargetInTx(
    reader: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1,
    target: ExternalActionTargetV1 = binding.target,
): Promise<boolean> {
    const action = SignedRootActionIdSchema.safeParse(binding.actionId);
    if (!('authentication' in binding) || binding.handoffAdmission
        || !action.success || getActionSpec(action.data).executionPlacement !== 'session') return true;
    // The installed transition coordinator reads ancestry before routing the
    // incumbent. Its exact HTTP/RPC purpose owners retain ordinary Session
    // access; a pre-existing Session/Machine access key is not its root contract.
    if (binding.actionId === 'session.agent.transition' || binding.actionId === 'session.continuation.inspect') return true;
    // A Run's assigned executor signs the call, while another admitted Machine
    // may host the exact target Session. Its existing key owner proves custody.
    if (binding.workflowActionOrigin) return binding.workflowActionOrigin.sessionAuthority !== undefined
        && binding.target.kind === 'session' && target.kind === 'session' && target.sessionId === binding.target.sessionId
        && hasCurrentMachineAccessForSessionInTx({ tx: reader, accountId: binding.accountId, sessionId: target.sessionId });
    return target.kind === 'machine'
        ? target.machineId === binding.machineId
        : hasCurrentSessionScopedMachineAccessInTx({ tx: reader, accountId: binding.accountId,
            machineId: binding.machineId, sessionId: target.sessionId });
}

/** Issuance and currentness share FIN's assigned publisher and retained origin proof. */
export async function hasCurrentExternalActionWorkflowOriginInTx(reader: Tx, input: Readonly<{
    accountId: string; machineId: string; actionId: string; requestId: string;
    target: ExternalActionTargetV1;
    publisherMachineId?: string;
    workflowActionOrigin?: ExternalActionExecutionAuthorizationBindingV1['workflowActionOrigin'];
}>): Promise<boolean> {
    const origin = input.workflowActionOrigin;
    if (!origin || origin.requestId !== input.requestId || !isExternalActionWorkflowActionIdV1(input.actionId)) return false;
    if (origin.sessionLeaf) {
        // The installed FIN producer already admitted the exact leaf/Session.
        // Home cannot open that E2EE binding; later effects only read Run liveness.
        return await reader.automationRun.findFirst({ where: { id: origin.runId, accountId: input.accountId,
            claimedByMachineId: input.publisherMachineId ?? input.machineId,
            workflowAcceptedSnapshotEnvelope: { not: null }, workflowCustodyState: 'pending',
            state: { in: ['claimed', 'running'] } }, select: { id: true } }) !== null;
    }
    if (!await isAutomationOriginRunPublisherTx(reader, { accountId: input.accountId, machineId: input.machineId,
            runId: origin.runId, requireCurrentScopeEnd: true })) return false;
    if (ManagedMachineActionIdV1Schema.safeParse(input.actionId).success) return input.target.kind === 'machine'
        && input.target.machineId === input.machineId;
    if (!origin.sessionAuthority || input.target.kind !== 'session') return false;
    const run = await reader.automationRun.findUnique({ where: { id: origin.runId }, select: { originSessionId: true } });
    return run !== null && run.originSessionId === (origin.sessionAuthority.runOriginSessionId ?? null);
}

async function readCurrentExternalActionPrincipal(
    binding: ExternalActionExecutionAuthorizationBindingV1,
    reader: Tx,
    purpose?: ExternalActionVerificationPurpose,
): Promise<VerifiedExternalActionPrincipal | null> {
    if (binding.workflowActionOrigin?.sessionLeaf) {
        if (!('authentication' in binding) || !await hasCurrentExternalActionWorkflowOriginInTx(reader, binding)) return null;
        return { accountId: binding.accountId, authentication: binding.authentication,
            authority: 'account_automation', workflowActionOrigin: binding.workflowActionOrigin };
    }
    if (purpose?.kind === 'issued-managed-acquire-native-fact'
        && !await isIssuedAcquireNativeFactReportInTx(reader, binding, purpose.report)) return null;
    if (purpose?.kind === 'issued-managed-intent-native-fact'
        && !await isIssuedIntentNativeFactReportInTx(reader, binding, purpose.report)) return null;
    if (purpose?.kind === 'retained-discussion-publication'
        && !await isRetainedDiscussionPublicationSourceCurrentInTx(reader, binding, purpose.source)) return null;
    if (binding.handoffAdmission) {
        if (!(isOriginalAccountHandoffAction(binding.actionId) || binding.actionId === 'session.spawn_new' && binding.handoffContinuation)
            || !PublicActionIdSchema.safeParse(binding.actionId).success && !binding.handoffContinuation
            || binding.actionId === 'session.spawn_new' && binding.machineId !== binding.handoffAdmission.targetMachineId
            || binding.target.kind !== 'machine'
            || binding.target.machineId !== binding.machineId
            || ![binding.handoffAdmission.sourceMachineId, binding.handoffAdmission.targetMachineId].includes(binding.machineId)
            || !await readCurrentExternalActionHandoffBindingInTx(reader, { accountId: binding.accountId,
                handoffAdmission: binding.handoffAdmission })) return null;
    }
    if (purpose?.kind === 'issued-handoff-continuation'
        && (binding.actionId !== 'session.handoff' || !binding.handoffAdmission || binding.handoffContinuation)) return null;
    if (binding.accountEncryptionMode !== undefined) {
        const account = await reader.account.findUnique({ where: { id: binding.accountId }, select: { encryptionMode: true } });
        if (account?.encryptionMode !== binding.accountEncryptionMode) return null;
    }
    if (binding.sessionActionOrigin) {
        if (!('authentication' in binding) || !binding.sessionActionSource
            || binding.sessionActionOrigin.requestId !== binding.requestId
            || (purpose?.kind !== 'issued-managed-acquire-native-fact' && !await hasCurrentSessionActionRpcSourceBindingInTx(reader, { accountId: binding.accountId,
                ...binding.sessionActionSource, sourceSessionId: binding.sessionActionOrigin.caller.sessionId }))) return null;
        const action = ActionIdSchema.safeParse(binding.actionId);
        if (action.success && getActionSpec(action.data).originalExecution?.nativePurpose === 'session_board_write' && (binding.target.kind !== 'session'
            || binding.target.sessionId !== binding.sessionActionOrigin.caller.sessionId
            || binding.machineId !== binding.sessionActionSource.machineId)) return null;
        if (binding.handoffAdmission && (binding.sessionActionSource.machineId !== binding.handoffAdmission.sourceMachineId
            || binding.sessionActionSource.installationId !== binding.handoffAdmission.sourceInstallationId)) return null;
    }
    if (binding.workflowActionOrigin && (!('authentication' in binding)
        || !isExternalActionWorkflowActionIdV1(binding.actionId)
        || purpose?.kind !== 'issued-managed-intent-native-fact'
            && !await hasCurrentExternalActionWorkflowOriginInTx(reader, binding))) return null;
    if (binding.managedContinuation) {
        const continuation = binding.managedContinuation;
        if (!['session.spawn_new', 'machines.environment.apply'].includes(binding.actionId) || binding.target.kind !== 'machine'
            || binding.target.machineId !== binding.machineId) return null;
        try {
            const row = await requireCurrentManagedMachineInTx(reader, { homeId: binding.serverIdentityId,
                managedId: continuation.managedId, requestId: continuation.creationRequestId,
                expectedIntentRevision: continuation.expectedIntentRevision, controller: continuation.controller },
                { requestAuthority: 'creation' });
            const admissionState = readManagedAdmissionState(row.admittedInput);
            const setup = projectManagedMachine(row).environmentSetup;
            const acquisitionDigest = binding.actionId === 'machines.environment.apply'
                ? admissionState.environmentSetup?.requestEnvelopeDigest : admissionState.continuation?.requestEnvelopeDigest;
            if (row.custodianAccountId !== binding.custodianAccountId || row.enrolledMachineId !== binding.machineId
                || row.allocation !== 'bound' || !row.resource
                || row.desired === 'delete' || acquisitionDigest !== continuation.acquireRequestEnvelopeDigest
                || binding.actionId === 'machines.environment.apply' && (!setup || setup.state === 'skipped')
                || binding.actionId === 'session.spawn_new' && setup && !['succeeded', 'skipped'].includes(setup.state)) return null;
            const guest = await reader.machine.findUnique({ where: { id: binding.machineId }, select: {
                accountId: true, installationId: true, revokedAt: true, replacedByMachineId: true,
            } });
            if (!guest || guest.accountId !== binding.custodianAccountId || guest.installationId !== binding.installationId
                || classifyMachineAvailabilityState(guest) !== 'available') return null;
            const guestAdmission = await resolveMachineAdmissionInTx(reader, { actorAccountId: binding.accountId,
                machineId: binding.machineId, actionId: binding.actionId });
            if (guestAdmission.kind !== 'admitted' || guestAdmission.custodianAccountId !== binding.custodianAccountId
                || guestAdmission.installationId !== binding.installationId) return null;
            const controller = await resolveMachineAdmissionInTx(reader, { actorAccountId: binding.accountId,
                machineId: continuation.controller.machineId, actionId: 'machines.managed.acquire', requiredRole: 'manage' });
            if (controller.kind !== 'admitted' || controller.custodianAccountId !== binding.custodianAccountId
                || controller.installationId !== continuation.controller.installationId) return null;
        } catch (error) {
            if (!(error instanceof ManagedMachineError)) throw error;
            return null;
        }
    }
    if ('authentication' in binding) {
        if (!isOriginalAccountExecutionAction(binding.actionId, binding)
            && !(binding.authentication.kind === 'terminal' && isOriginalTerminalExecutionAction(binding.actionId, binding))
            && !(['session.spawn_new', 'machines.environment.apply'].includes(binding.actionId) && binding.managedContinuation)
            && !(binding.actionId === 'session.spawn_new' && binding.handoffContinuation)
            && !(binding.handoffContinuation && isOriginalAccountHandoffAction(binding.actionId))) return null;
        if (!await hasCurrentOriginalSessionActionTargetInTx(reader, binding)) return null;
        if (!await auth.isSignedCredentialCurrent(reader, binding.accountId, binding.authentication.tokenEpoch)) return null;
        const authority = narrowCredentialAuthority('present_user', binding.sessionActionOrigin || binding.workflowActionOrigin
            || binding.authentication.kind === 'terminal' ? 'account_automation' : undefined);
        const base = { accountId: binding.accountId, authentication: binding.authentication,
            ...(binding.authentication.evidence ? { authenticationEvidence: binding.authentication.evidence } : {}) };
        if (binding.workflowActionOrigin) return { ...base, authority: 'account_automation', workflowActionOrigin: binding.workflowActionOrigin };
        if (binding.authentication.kind === 'terminal') {
            if (!isOriginalTerminalExecutionAction(binding.actionId, binding)) return null;
            return { accountId: binding.accountId, authentication: binding.authentication, authority: 'account_automation',
                ...(binding.authentication.evidence ? { authenticationEvidence: binding.authentication.evidence } : {}),
                ...(binding.sessionActionOrigin ? { sessionActionOrigin: binding.sessionActionOrigin } : {}) };
        }
        return authority === 'account_automation' && binding.sessionActionOrigin
            ? { ...base, authority, sessionActionOrigin: binding.sessionActionOrigin }
            : { ...base, authentication: binding.authentication, authority: 'present_user' };
    }
    const principal = await auth.verifyCurrentApiTokenPrincipal(binding, undefined, reader);
    if (!principal || !isApiTokenGrantWithinV1(binding.grant, principal.grant)) return null;
    const qualifiedAction = parseQualifiedPluginActionId(binding.actionId);
    if (!evaluateApiTokenGrantV1({
        grant: principal.grant,
        actionId: qualifiedAction ? "action.invoke" : readExternalActionCredentialActionId(binding),
        contributedActionAdmission: 'pre_open',
        automationAdmission: 'pre_open',
        ...(qualifiedAction ? { contributedQualifiedId: binding.actionId } : {}),
        target: binding.target,
        targetMachineId: binding.machineId,
        automationId: binding.automationId,
    }).ok) return null;
    return principal;
}

async function verifyCurrentExternalActionPrincipalForPurpose(
    binding: ExternalActionExecutionAuthorizationBindingV1,
    purpose?: ExternalActionVerificationPurpose,
): Promise<VerifiedExternalActionPrincipal | null> {
    if (binding.workflowActionOrigin?.sessionLeaf) return readCurrentExternalActionPrincipal(binding, db, purpose);
    const principal = await readCurrentExternalActionPrincipal(binding, db, purpose);
    if (!principal) return null;
    const eligibility = await enforceLoginEligibility({ accountId: principal.accountId, env: process.env });
    if (!eligibility.ok && eligibility.statusCode === 503) {
        // Unavailable eligibility evidence is not a revoked signed credential.
        throw Object.assign(new Error(eligibility.error), { statusCode: 503, code: eligibility.error });
    }
    return eligibility.ok ? await readCurrentExternalActionPrincipal(binding, db, purpose) : null;
}

export async function verifyCurrentExternalActionPrincipal(
    binding: ExternalActionExecutionAuthorizationBindingV1,
): Promise<VerifiedExternalActionPrincipal | null> {
    return verifyCurrentExternalActionPrincipalForPurpose(binding);
}

/**
 * Transaction-only current-row recheck for a host invocation already admitted
 * by verifyCurrentExternalActionPrincipal before entering the transaction.
 * Never accepts a raw header as proof and never repeats provider/network I/O.
 */
export async function verifyCurrentExternalActionPrincipalInTx(
    tx: Tx,
    alreadyVerifiedInvocation: ExternalActionExecutionAuthorizationBindingV1,
): Promise<VerifiedExternalActionPrincipal | null> {
    return readCurrentExternalActionPrincipal(alreadyVerifiedInvocation, tx);
}

export type VerifiedExternalActionExecutionRequest = Readonly<{
    binding: ExternalActionExecutionAuthorizationBindingV1;
    effectActionId: string;
    target: ExternalActionTargetV1;
    principal: VerifiedExternalActionPrincipal;
    /** Request-local ceiling; never rewrites verified credential provenance. */
    effectiveAuthority: VerifiedExternalActionPrincipal['authority'];
    /** Home-derived private phase, never a caller-authored guest grant. */
    managedGuestActivity?: Readonly<{ machineId: string; installationId: string; encryptionMode: 'plain' | 'e2ee' }>;
}>;

type ExternalActionExecutionRequestProof = Readonly<{
    authorizationToken: string;
    machineSignature: string;
    effectActionId: string;
    encodedTarget: string;
    method: string;
    path: string;
    body: unknown;
    idempotencyKey?: string;
    /** Validated HTTP route operands, used only to compare with the canonical Action binding. */
    routeInput?: unknown;
    /** Session selected by the HTTP route's incumbent operation/target policy, never by a header. */
    sessionRouteTarget?: Extract<ExternalActionTargetV1, { kind: 'session' }>
        & Readonly<{ actionId?: ActionId; additionalSessionIds?: readonly string[] }>;
    resolveCurrentSessionMachine?: (input: Readonly<{ accountId: string; sessionId: string }>) => Promise<string | null>;
}>;

export async function hasCurrentExternalActionSessionSource(binding: ExternalActionExecutionAuthorizationBindingV1,
    resolveCurrentSessionMachine: ExternalActionExecutionRequestProof['resolveCurrentSessionMachine']): Promise<boolean> {
    if (binding.handoffContinuation) return Boolean(binding.handoffAdmission
        && await readCurrentExternalActionHandoffBindingInTx(db, { accountId: binding.accountId, handoffAdmission: binding.handoffAdmission })
        && (!binding.sessionActionOrigin || binding.sessionActionSource
            && await hasCurrentSessionActionRpcSourceBindingInTx(db, { accountId: binding.accountId,
                ...binding.sessionActionSource, sourceSessionId: binding.sessionActionOrigin.caller.sessionId })));
    return !binding.sessionActionOrigin || Boolean(binding.sessionActionSource
        && await hasCurrentSessionActionRpcSourceBinding({ accountId: binding.accountId,
            ...binding.sessionActionSource, sourceSessionId: binding.sessionActionOrigin.caller.sessionId,
            resolveCurrentSessionMachine }));
}

async function hasCurrentExecutionMachineAdmission(
    binding: ExternalActionExecutionAuthorizationBindingV1,
    admittedMachine?: Readonly<{ accountId: string; kind: string; installationId: string | null;
        revokedAt: Date | null; replacedByMachineId: string | null }>,
): Promise<boolean> {
    const machine = admittedMachine ?? await db.machine.findFirst({
        where: { id: binding.machineId, accountId: binding.custodianAccountId, installationId: binding.installationId },
        select: { accountId: true, kind: true, installationId: true, revokedAt: true, replacedByMachineId: true },
    });
    if (!machine || classifyMachineAvailabilityState(machine) !== 'available'
        || machine.accountId !== binding.custodianAccountId || machine.installationId !== binding.installationId) return false;
    // This signed leaf already owns admission. The principal check reads its
    // active Run; the installation check above authenticates this later call.
    if (binding.workflowActionOrigin?.sessionLeaf) return true;
    // Only the authenticated handoff tuple proves requester attribution for
    // these otherwise custodian-only methods. Unsigned method admission stays closed.
    if (binding.handoffAdmission) {
        const handoff = await readCurrentExternalActionHandoffBindingInTx(db, { accountId: binding.accountId,
            handoffAdmission: binding.handoffAdmission });
        return handoff !== null && (binding.machineId === handoff.sourceMachineId
            ? binding.installationId === handoff.sourceInstallationId
            : binding.machineId === handoff.targetMachineId && binding.installationId === handoff.targetInstallationId);
    }
    // Restricted Runner admission is Session/credential-owned, not a persistent Machine grant.
    if (machine.kind === 'ephemeral_session_runner') return binding.accountId === machine.accountId;
    const current = await resolveExternalActionExecutionMachineAdmissionInTx(db, { actorAccountId: binding.accountId,
        machineId: binding.machineId, actionId: binding.actionId });
    return current.kind === 'admitted'
        && current.custodianAccountId === binding.custodianAccountId
        && current.installationId === binding.installationId;
}

function hasMatchingExecutionEffectFamily(rootActionId: string, effectActionId: string): boolean {
    const managedRoot = ManagedMachineActionIdV1Schema.safeParse(rootActionId);
    const managedEffect = ManagedMachineActionIdV1Schema.safeParse(effectActionId);
    if (managedRoot.success || managedEffect.success) return managedRoot.success && managedEffect.success
        && managedRoot.data === managedEffect.data;
    const root = MachineAccessActionIdSchema.safeParse(rootActionId);
    const effect = MachineAccessActionIdSchema.safeParse(effectActionId);
    return !root.success && !effect.success
        || root.success && effect.success && root.data === effect.data;
}

/** The retained control admission is the only producer of a guest observation scope. */
export async function readCurrentManagedGuestActivityInTx(reader: Tx,
    binding: ExternalActionExecutionAuthorizationBindingV1, machineId: string,
    target?: ManagedActivityReadRequestV1): Promise<VerifiedExternalActionExecutionRequest['managedGuestActivity'] | null> {
    if (binding.actionId !== 'machines.managed.power.set' && binding.actionId !== 'machines.managed.delete'
        || binding.target.kind !== 'machine' || binding.target.machineId !== binding.machineId) return null;
    try {
        if (!await verifyCurrentExternalActionPrincipalInTx(reader, binding)) return null;
        if (!binding.managedAccountExecutor) {
            const controller = await resolveExternalActionExecutionMachineAdmissionInTx(reader, {
                actorAccountId: binding.accountId, machineId: binding.machineId, actionId: binding.actionId,
            });
            if (controller.kind !== 'admitted' || controller.custodianAccountId !== binding.custodianAccountId
                || controller.installationId !== binding.installationId) return null;
        }
        const enrolled = await reader.managedMachine.findUnique({ where: { enrolledMachineId: machineId } });
        if (!enrolled || enrolled.homeId !== binding.serverIdentityId || enrolled.custodianAccountId !== binding.custodianAccountId) return null;
        const currentTarget = target ?? { homeId: enrolled.homeId, managedId: enrolled.id, expectedRevision: enrolled.intentRevision,
            ...(enrolled.controllerMachineId === null ? {} : {
                controller: { machineId: binding.machineId, installationId: binding.installationId } }) };
        const row = await requireCurrentManagedMachineInTx(reader, { ...currentTarget,
            expectedIntentRevision: currentTarget.expectedRevision, requestId: binding.requestId });
        const admission = readManagedAdmissionState(row.admittedInput).currentAdmission;
        const accountExecutor = row.controllerMachineId === null && row.custodianAccountId === binding.accountId
            && binding.managedAccountExecutor?.enrolledMachineId === row.enrolledMachineId
            && binding.managedAdmission?.actionId === binding.actionId && admission?.kind === 'control'
            && sameManagedInput(binding.managedAdmission.input, admission.request.input);
        if (row.id !== enrolled.id || row.enrolledMachineId !== machineId || row.allocation !== 'bound'
            || !row.resource || row.desiredWhen !== 'after-idle'
            || !(accountExecutor || row.controllerMachineId === binding.machineId && row.controllerInstallationId === binding.installationId)
            || admission?.kind !== 'control' || admission.request.action !== binding.actionId
            || admission.request.action !== 'machines.managed.power.set' && admission.request.action !== 'machines.managed.delete'
            || admission.request.requestId !== binding.requestId
            || admission.request.input.homeId !== row.homeId || admission.request.input.managedId !== row.id
            || admission.request.input.when !== 'after-idle'
            || row.desired !== (binding.actionId === 'machines.managed.delete' ? 'delete' : 'stop')
            || admission.request.input.intent !== row.desired) return null;
        // The proved controller uses its custodian's transport for this exact
        // retained guest. Requester Manage is rechecked on the controller above;
        // no independent guest grant or requester key disclosure is needed.
        const guest = await resolveMachineAdmissionInTx(reader, { actorAccountId: binding.custodianAccountId,
            machineId, rpcMethod: MANAGED_ACTIVITY_READ_RPC_METHOD });
        return guest.kind === 'admitted' && guest.custodianAccountId === binding.custodianAccountId && guest.installationId
            ? { machineId, installationId: guest.installationId, encryptionMode: guest.encryptionMode } : null;
    } catch (error) {
        if (error instanceof ManagedMachineError) return null;
        throw error;
    }
}

/** An admitted continuation retains its captured source signer, never its private key. */
async function readCurrentExternalActionSourceSigningPublicKey(
    binding: ExternalActionExecutionAuthorizationBindingV1,
): Promise<Uint8Array | null> {
    let source: Readonly<{ machineId: string; installationId: string }> | undefined;
    if (binding.handoffContinuation || binding.handoffPreflight) {
        if (!binding.handoffAdmission) return null;
        const handoff = await readCurrentExternalActionHandoffBindingInTx(db, {
            accountId: binding.accountId, handoffAdmission: binding.handoffAdmission,
        });
        if (!handoff) return null;
        source = { machineId: handoff.sourceMachineId, installationId: handoff.sourceInstallationId };
    } else if ('authentication' in binding && binding.sessionActionOrigin && binding.sessionActionSource) {
        source = binding.sessionActionSource;
        if (!await hasCurrentSessionActionRpcSourceBindingInTx(db, { accountId: binding.accountId,
            ...source, sourceSessionId: binding.sessionActionOrigin.caller.sessionId })) return null;
    }
    if (!source) return null;
    const machine = await db.machine.findUnique({ where: { id: source.machineId }, select: {
        installationId: true, installationPublicKey: true, revokedAt: true, replacedByMachineId: true,
    } });
    return machine?.installationId === source.installationId
        && classifyMachineAvailabilityState(machine) === 'available' ? machine.installationPublicKey : null;
}

function isTeamCredentialUsageExportReadEffect(rootActionId: string, effectActionId: string): boolean {
    return rootActionId === 'teams.credentials.usage.export' && effectActionId === 'teams.credentials.usage.query';
}

/** Doc posting composes C3; proposal decisions and Artifact writes are never children. */
function isDocDiscussionEffect(rootActionId: string, effectActionId: string): boolean {
    return (rootActionId === 'doc.comment.reply' || rootActionId === 'doc.edit.propose')
        && (effectActionId === 'discussion.read' || effectActionId === 'discussion.post' || effectActionId === 'discussion.reply'
            || rootActionId === 'doc.comment.reply' && effectActionId === 'discussion.create');
}

/** Doc reads consume their Artifact codec and one source-scoped, batched count list. */
function isDocReadEffect(rootActionId: string, effectActionId: string): boolean {
    return rootActionId === 'doc.read' && (effectActionId === 'artifact.get' || effectActionId === 'discussion.list');
}

/** The installed composition signs these consumed owners; this is no sibling management grant. */
function isSecondOpinionEffect(rootActionId: string, effectActionId: string): boolean {
    return rootActionId === 'discussion.second_opinion.start' && [
        'discussion.create', 'discussion.post', 'discussion.invite', 'discussion.participants.list',
        'artifact.get', 'artifact.access.grants.set', 'session.access.grant.set',
    ].includes(effectActionId);
}

/** Only acceptance opens a stored proposal and its exact source before person-authorized submission. */
function isDocDecisionPreparationEffect(rootActionId: string, effectActionId: string): boolean {
    return rootActionId === 'doc.edit.accept' && (effectActionId === 'discussion.read' || effectActionId === 'artifact.get');
}

/** Run admission opens its committed C3 question through the installed requester codec. */
function isWorkflowDiscussionPreparationEffect(rootActionId: string, effectActionId: string): boolean {
    return rootActionId === 'workflow.run.start' && effectActionId === 'discussion.read';
}

/** Memory admission inspects existing exposure before proposing or performing a write. */
function isMemoryExposureReadEffect(rootActionId: string, effectActionId: string): boolean {
    return (rootActionId === 'approval.request.create' || isMemoryWriteActionV1(rootActionId))
        && effectActionId === 'artifact.access.grants.list';
}

/** Archive's existing report cascade may stop an active report under its unchanged root. */
function isSessionArchiveStopEffect(rootActionId: string, effectActionId: string): boolean {
    return rootActionId === 'session.archive' && effectActionId === 'session.stop';
}

/** Fixed labels only: signed proofs and caller-controlled content never enter logs. */
function refuseExternalActionExecutionRequest(phase:
    | 'proof_shape' | 'authorization_token' | 'resolved_target' | 'original_target' | 'pending_reset_admission'
    | 'effect_family' | 'server_identity' | 'custody_purpose' | 'custody_before_principal'
    | 'source_before_principal' | 'machine_identity' | 'machine_admission_before_principal' | 'machine_signature'
    | 'principal' | 'machine_admission_after_principal' | 'source_after_principal' | 'final_credential'
    | 'final_machine_admission' | 'final_original_target' | 'final_custody'
    | 'outer_action' | 'verification_purpose' | 'credential_action_admission',
): null {
    log({ module: 'external-action-authorization-refusal', phase });
    return null;
}

async function verifyCommon(
    proof: ExternalActionExecutionRequestProof,
): Promise<VerifiedExternalActionExecutionRequest | null> {
    const effectActionId = ExternalActionActionIdV1Schema.safeParse(proof.effectActionId);
    const target = decodeExternalActionResolvedTargetV1(proof.encodedTarget);
    if (!effectActionId.success || !target) return refuseExternalActionExecutionRequest('proof_shape');

    const binding = await auth.verifyExternalActionExecutionAuthorization(proof.authorizationToken);
    if (!binding) return refuseExternalActionExecutionRequest('authorization_token');
    if (!isExternalActionResolvedTargetAllowedV1({
        authorizedTarget: binding.target,
        resolvedTarget: target,
        selectedMachineId: binding.machineId,
    })) return refuseExternalActionExecutionRequest('resolved_target');
    if (!await hasCurrentOriginalSessionActionTargetInTx(db, binding, target)) return refuseExternalActionExecutionRequest('original_target');
    if (binding.actionId === 'session.pending.resetStart.set' && !binding.pendingResetStartAdmission) return refuseExternalActionExecutionRequest('pending_reset_admission');
    const resolvesPatEffect = !('authentication' in binding)
        && (binding.actionId === 'approval.request.create' || binding.actionId === 'action.invoke'
            || parseQualifiedPluginActionId(binding.actionId) !== null);
    if (!hasMatchingExecutionEffectFamily(binding.actionId, effectActionId.data)
        || binding.actionId !== effectActionId.data && (binding.handoffContinuation || binding.handoffPreflight
            || !resolvesPatEffect && !isTeamCredentialUsageExportReadEffect(binding.actionId, effectActionId.data)
                && !isDocDiscussionEffect(binding.actionId, effectActionId.data)
                && !isDocReadEffect(binding.actionId, effectActionId.data)
                && !isSecondOpinionEffect(binding.actionId, effectActionId.data)
                && !isWorkflowDiscussionPreparationEffect(binding.actionId, effectActionId.data)
                && !isMemoryExposureReadEffect(binding.actionId, effectActionId.data)
                && !isSessionArchiveStopEffect(binding.actionId, effectActionId.data)
                && !isDocDecisionPreparationEffect(binding.actionId, effectActionId.data))) return refuseExternalActionExecutionRequest('effect_family');
    if (binding.serverIdentityId !== await getOrCreateServerIdentityId()) return refuseExternalActionExecutionRequest('server_identity');
    const currentnessBody = ExternalActionExecutionAuthorizationVerifyRequestV1Schema.safeParse(proof.body);
    const retainedDiscussionSource = currentnessBody.success ? currentnessBody.data.retainedDiscussionSource : undefined;
    if (retainedDiscussionSource && (proof.method.toUpperCase() !== 'POST'
        || proof.path !== bindExternalActionExecutionAuthorizationVerifyHttpPathV1(binding.actionId)
        || effectActionId.data !== binding.actionId
        || !await isRetainedDiscussionPublicationSourceCurrentInTx(db, binding, retainedDiscussionSource))) {
        return refuseExternalActionExecutionRequest('verification_purpose');
    }
    const custodyTarget = currentnessBody.success ? currentnessBody.data.managedFiniteWakeTarget : undefined;
    const readCustody = custodyTarget ? async () => {
        const { readCurrentManagedFiniteWakeCustodyInTx } = await import('@/app/machines/managed/managedWake');
        return readCurrentManagedFiniteWakeCustodyInTx(db, {
            actionOrigin: { v: 1, token: proof.authorizationToken, binding }, target: custodyTarget,
        });
    } : undefined;
    if (custodyTarget && (proof.method.toUpperCase() !== 'POST'
        || proof.path !== bindExternalActionExecutionAuthorizationVerifyHttpPathV1(binding.actionId))) return refuseExternalActionExecutionRequest('custody_purpose');
    const custody = await readCustody?.();
    if (custodyTarget && !custody) return refuseExternalActionExecutionRequest('custody_before_principal');
    const report = proof.method.toUpperCase() === 'POST' && proof.path.split('?')[0] === '/v1/machines/managed/controller/report'
        ? ManagedControllerReportV1Schema.safeParse(proof.body) : null;
    const intentReport = proof.method.toUpperCase() === 'POST' && proof.path.split('?')[0] === '/v1/machines/managed/controller/report-intent'
        ? ManagedControllerIntentReportV1Schema.safeParse(proof.body) : null;
    const handoffChild = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(proof.body);
    const isHandoffChildIssue = proof.method.toUpperCase() === 'POST' && binding.actionId === 'session.handoff'
        && binding.handoffAdmission && !binding.handoffContinuation && !binding.handoffPreflight && handoffChild.success
        && handoffChild.data.handoffContinuation?.authorization.token === proof.authorizationToken
        && readHandoffContinuationIssuanceAction(proof.path) !== null;
    const purpose: ExternalActionVerificationPurpose | undefined = report?.success
        && await isIssuedAcquireNativeFactReportInTx(db, binding, report.data)
        ? { kind: 'issued-managed-acquire-native-fact', report: report.data }
        : intentReport?.success && await isIssuedIntentNativeFactReportInTx(db, binding, intentReport.data)
            ? { kind: 'issued-managed-intent-native-fact', report: intentReport.data }
            : isHandoffChildIssue ? { kind: 'issued-handoff-continuation' }
                : retainedDiscussionSource ? { kind: 'retained-discussion-publication', source: retainedDiscussionSource } : undefined;
    if (!purpose && !await hasCurrentExternalActionSessionSource(binding, proof.resolveCurrentSessionMachine)) return refuseExternalActionExecutionRequest('source_before_principal');

    const machine = await db.machine.findFirst({
        where: { id: binding.machineId, accountId: binding.custodianAccountId, installationId: binding.installationId },
        select: {
            accountId: true,
            kind: true,
            revokedAt: true,
            replacedByMachineId: true,
            installationId: true,
            installationPublicKey: true,
        },
    });
    const verifySignature = (publicKey: Uint8Array) => verifyExternalActionMachineRequestV1({
        authorizationToken: proof.authorizationToken,
        effectActionId: effectActionId.data,
        target,
        installationId: binding.installationId,
        requestId: binding.requestId,
        method: proof.method,
        path: proof.path,
        body: proof.body,
        ...(proof.idempotencyKey === undefined ? {} : { idempotencyKey: proof.idempotencyKey }),
        publicKey,
        signature: proof.machineSignature,
    });
    let signatureCurrent = custody
        ? verifySignature(decodeBase64(custody.installationPublicKey, 'base64url'))
        : Boolean(machine?.installationPublicKey && verifySignature(machine.installationPublicKey));
    // Target currentness and the captured source both sign the exact destination
    // tuple. Only the accepted continuation survives its publisher stopping.
    const managedGuestMetadata = proof.method.toUpperCase() === 'GET'
        && (binding.actionId === 'machines.managed.power.set' || binding.actionId === 'machines.managed.delete')
        && /^\/v1\/machines\/[^/]+$/u.test(proof.path.split('?')[0]);
    // Guest key publication is controller custody, not requester/source custody.
    if ((!signatureCurrent || binding.handoffPreflight) && !custodyTarget && !managedGuestMetadata) {
        const sourceKey = await readCurrentExternalActionSourceSigningPublicKey(binding);
        signatureCurrent = sourceKey !== null && verifySignature(sourceKey);
    }
    if (
        !machine
        || classifyMachineAvailabilityState(machine) !== "available"
        || !machine.installationId
        || !machine.installationPublicKey
    ) {
        return refuseExternalActionExecutionRequest('machine_identity');
    }
    if (!await hasCurrentExecutionMachineAdmission(binding, machine)) return refuseExternalActionExecutionRequest('machine_admission_before_principal');
    if (!signatureCurrent) return refuseExternalActionExecutionRequest('machine_signature');

    // Login eligibility may await a provider; publisher currentness is checked
    // afterwards, followed by the current persisted credential and admissions.
    const currentPrincipal = await verifyCurrentExternalActionPrincipalForPurpose(binding, purpose);
    const principal = currentPrincipal && projectVerifiedExternalActionBoundPrincipal(binding, currentPrincipal);
    if (!principal) return refuseExternalActionExecutionRequest('principal');
    if (!await hasCurrentExecutionMachineAdmission(binding)) return refuseExternalActionExecutionRequest('machine_admission_after_principal');
    if (!purpose && !await hasCurrentExternalActionSessionSource(binding, proof.resolveCurrentSessionMachine)) return refuseExternalActionExecutionRequest('source_after_principal');
    if (!await readCurrentExternalActionPrincipal(binding, db, purpose)) return refuseExternalActionExecutionRequest('final_credential');
    if (!await hasCurrentExecutionMachineAdmission(binding)) return refuseExternalActionExecutionRequest('final_machine_admission');
    if (!await hasCurrentOriginalSessionActionTargetInTx(db, binding, target)) return refuseExternalActionExecutionRequest('final_original_target');
    if (readCustody) {
        const current = await readCustody();
        if (!current || current.installationPublicKey !== custody?.installationPublicKey) return refuseExternalActionExecutionRequest('final_custody');
    }
    return { binding, effectActionId: effectActionId.data, target, principal, effectiveAuthority: principal.authority };
}

function isAccountEncryptionCurrentnessHttpRead(proof: ExternalActionExecutionRequestProof): boolean {
    return proof.method.toUpperCase() === 'GET' && proof.body === undefined
        && proof.path === '/v1/account/encryption/currentness';
}

/** The incumbent read-only Artifact codec needs no audience census or recipient-key writes. */
function isReadOnlyArtifactHttpPurpose(proof: ExternalActionExecutionRequestProof): boolean {
    if (isAccountEncryptionCurrentnessHttpRead(proof)) return proof.routeInput === undefined || sameManagedInput(proof.routeInput, {});
    const match = /^\/v1\/artifacts\/([^/?#]+)$/u.exec(proof.path);
    if (!match || proof.method.toUpperCase() !== 'GET' || proof.body !== undefined) return false;
    try {
        const artifactId = decodeURIComponent(match[1]);
        return getActionSpec('artifact.get').inputSchema.safeParse({ artifactId }).success
            && match[1] === encodeURIComponent(artifactId)
            && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, { id: artifactId }));
    } catch { return false; }
}

/** One readable recursive membership owner serves lifecycle operands and selected-lead observation. */
async function isInstalledSessionLifecycleSubtreeMember(verified: VerifiedExternalActionExecutionRequest,
    sessionId: string): Promise<boolean> {
    const origin = verified.binding.sessionActionOrigin;
    if (!origin || !isLedSubtreeSessionLifecycleActionId(verified.binding.actionId)) return false;
    const members = await inReadSnapshot(tx => readSessionManagedSubtreeSessionIdsInTx(tx, {
        accountId: verified.binding.accountId, rootSessionId: origin.caller.sessionId,
        authentication: { env: process.env, authority: verified.effectiveAuthority,
            authenticationEvidence: verified.principal.authenticationEvidence,
            ...('authentication' in verified.binding ? { tokenEpoch: verified.binding.authentication.tokenEpoch }
                : { apiTokenGrant: verified.binding.grant }) },
    }));
    return members.includes(sessionId);
}

/** Original roots retain policy reads; lifecycle cascade may select a still-led nested root. */
async function isInstalledSessionSubtreeObservationHttpPurpose(verified: VerifiedExternalActionExecutionRequest,
    proof: ExternalActionExecutionRequestProof): Promise<boolean> {
    const origin = verified.binding.sessionActionOrigin;
    if (!origin || verified.effectActionId !== verified.binding.actionId
            && !isSessionArchiveStopEffect(verified.binding.actionId, verified.effectActionId)
        || proof.method.toUpperCase() !== 'POST' || proof.path !== '/v2/sessions/query') return false;
    const query = SessionListQueryV1Schema.safeParse(proof.body);
    if (!query.success || !query.data.underSessionId) return false;
    return query.data.underSessionId === origin.caller.sessionId
        || isInstalledSessionLifecycleSubtreeMember(verified, query.data.underSessionId);
}

/** Original lifecycle roots consume the same readable recursive subtree as Session listing. */
async function isInstalledSessionLifecycleHttpPurpose(verified: VerifiedExternalActionExecutionRequest,
    proof: ExternalActionExecutionRequestProof): Promise<boolean> {
    const actionId = verified.effectActionId;
    if (!isLedSubtreeSessionLifecycleActionId(actionId) && actionId !== 'session.open'
        || actionId !== verified.binding.actionId && !isSessionArchiveStopEffect(verified.binding.actionId, actionId)
        || !proof.sessionRouteTarget
        || verified.binding.target.kind !== 'machine' || verified.target.kind !== 'machine') return false;
    const sessionId = proof.sessionRouteTarget.sessionId;
    const path = `/v2/sessions/${encodeURIComponent(sessionId)}`;
    const reads = proof.method.toUpperCase() === 'GET' && proof.body === undefined
        && (proof.path === path || proof.path === `${path}?accessProjectionVersion=1`);
    const origin = verified.binding.sessionActionOrigin;
    if (actionId === 'session.open' || actionId === 'session.stop') {
        const patch = proof.method.toUpperCase() === 'PATCH' && proof.path === path
            ? SessionMetadataTuplePatchV1Schema.safeParse(proof.body) : null;
        if (!reads && !(patch?.success && patch.data.mode === 'owner')) return false;
        const session = await db.session.findUnique({ where: { id: sessionId }, select: { accountId: true } });
        if (session?.accountId !== verified.binding.accountId) return false;
        if (!origin) return verified.effectiveAuthority === 'present_user';
        if (actionId === 'session.open') return sessionId === origin.caller.sessionId;
    } else {
        const op = actionId === 'session.archive' ? 'archive' : 'unarchive';
        const mutation = proof.method.toUpperCase() === 'POST' && proof.path === `${path}/${op}`
            && proof.body !== null && typeof proof.body === 'object' && !Array.isArray(proof.body)
            && Object.keys(proof.body).length === 0;
        if (!reads && !mutation) return false;
    }
    return isInstalledSessionLifecycleSubtreeMember(verified, sessionId);
}

/** Post-commit preparation signs its operand read; the Session route retains access admission. */
function isSessionSourceKeyTransportHttpPurpose(verified: VerifiedExternalActionExecutionRequest,
    proof: ExternalActionExecutionRequestProof): boolean {
    if (!['session.spawn_new', 'session.manager.set'].includes(verified.binding.actionId)
        || verified.effectActionId !== verified.binding.actionId
        || proof.method.toUpperCase() !== 'GET' || proof.body !== undefined) return false;
    if (isAccountEncryptionCurrentnessHttpRead(proof)) return true;
    // Operands may be encrypted and may name two Sessions on different Machines.
    // As with transition ancestry reads, the installed owner signs the exact
    // selected path under the original root; it cannot mint a new Session root.
    if (!proof.sessionRouteTarget) return false;
    if (verified.target.kind === 'session' && proof.sessionRouteTarget.sessionId !== verified.target.sessionId) return false;
    const path = `/v2/sessions/${encodeURIComponent(proof.sessionRouteTarget.sessionId)}`;
    return proof.path === path || proof.path === `${path}?accessProjectionVersion=1`;
}

/** Quota reads consume B's canonical request schemas, not a generic Account read privilege. */
function isQuotaReadHttpPurpose(proof: ExternalActionExecutionRequestProof): boolean {
    const url = new URL(proof.path, 'http://home.invalid');
    const method = proof.method.toUpperCase();
    if (method === 'POST') {
        return url.pathname === '/v2/pending/reset-starts/read' && url.search === ''
            && PendingResetStartsReadInputV1Schema.safeParse(proof.body).success;
    }
    if (method !== 'GET' || proof.body !== undefined) return false;
    if (isAccountEncryptionCurrentnessHttpRead(proof)) return true;
    if (['/v1/account/encryption', '/v2/account/settings'].includes(url.pathname)) {
        return url.search === '';
    }
    const field = url.pathname === '/v4/connect/qualified/provider-account-usage/sources/resolve' ? 'source'
        : url.pathname === '/v4/connect/qualified/provider-account-usage/record' ? 'recordId'
        : url.pathname === '/v4/connect/qualified/provider-account-usage/history' ? 'query' : null;
    if (!field || Array.from(url.searchParams.keys()).length !== 1 || !url.searchParams.has(field)) return false;
    try {
        const value = url.searchParams.get(field);
        if (field === 'recordId') return ProviderAccountUsageRecordIdSchema.safeParse(value).success;
        if (field === 'source') parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedServiceUsageSourceV4Schema, value);
        else parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedProviderAccountUsageHistoryRequestV4Schema, value);
        return true;
    } catch {
        return false;
    }
}

/** Personal review Actions use the existing Account currentness and KV owners. */
function isScmReviewedMarksHttpPurpose(proof: ExternalActionExecutionRequestProof): boolean {
    const url = new URL(proof.path, 'http://home.invalid');
    if (url.search !== '' || url.hash !== '') return false;
    const isReviewedKey = (key: string): boolean => {
        if (!key.startsWith(SCM_REVIEWED_MARKS_KV_PREFIX)) return false;
        try {
            return buildScmReviewedMarksKey(decodeURIComponent(key.slice(SCM_REVIEWED_MARKS_KV_PREFIX.length))) === key;
        } catch { return false; }
    };
    const method = proof.method.toUpperCase();
    if (method === 'POST' && url.pathname === '/v1/kv') {
        const request = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(KvMutationRequestSchema).safeParse(proof.body);
        return request.success && request.data.mutations.every(mutation => isReviewedKey(mutation.key));
    }
    if (method !== 'GET' || proof.body !== undefined) return false;
    if (isAccountEncryptionCurrentnessHttpRead(proof)) return true;
    const prefix = '/v1/kv/';
    if (!url.pathname.startsWith(prefix)) return false;
    try {
        const key = decodeURIComponent(url.pathname.slice(prefix.length));
        return url.pathname === prefix + encodeURIComponent(key) && isReviewedKey(key);
    } catch { return false; }
}

/** Metadata purposes of an original Project root; domain routes retain row/CAS/audience admission. */
function isProjectAccountMetadataHttpPurpose(verified: VerifiedExternalActionExecutionRequest,
    proof: ExternalActionExecutionRequestProof): boolean {
    if (verified.effectActionId !== verified.binding.actionId) return false;
    const actionId = verified.binding.actionId;
    const url = new URL(proof.path, 'http://home.invalid');
    const method = proof.method.toUpperCase();
    if (MACHINE_TERMINAL_ACTION_IDS.some(id => id === actionId)) {
        if (url.search !== '' || url.hash !== '' || method !== 'POST') return false;
        // Census/control revalidate the requester's accepted checkouts. They
        // confer neither row mutation nor another Account's catalog authority.
        if (url.pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return ProjectAccountRowListRequestV1Schema.safeParse(proof.body).success;
        return (actionId === 'machines.terminal.open' || actionId === 'machines.terminal.restart')
            && url.pathname === `${PROJECT_TRUST_ROUTE_V1}/read` && ProjectTrustReadRequestV1Schema.safeParse(proof.body).success;
    }
    // Preparation, including an unsigned proposal replayed inside its admitted
    // decision, spends the unchanged signed root. Reads confer no mutation authority.
    const readsExecutionConfig = actionId === 'projects.script.run' || actionId === 'projects.compute.exec'
        || actionId === 'localServices.launcher.start' || actionId === 'localServices.actions.restartManaged'
        || actionId === 'approval.request.decide';
    if (Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, actionId) || actionId === 'projects.inspect' || readsExecutionConfig) {
        if (url.search !== '' || url.hash !== '') return false;
        if (method === 'GET' && proof.body === undefined) return readsExecutionConfig && url.pathname === '/v1/account/encryption';
        if (method !== 'POST') return false;
        // Finite work and inspection use admitted private requester custody for
        // Account topology. A signed Project root is not a catalog credential.
        const readsAccountRows = !Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, actionId) && actionId !== 'projects.inspect';
        if (url.pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`) return readsAccountRows && ProjectAccountRowReadRequestV1Schema.safeParse(proof.body).success;
        if (url.pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return readsAccountRows && ProjectAccountRowListRequestV1Schema.safeParse(proof.body).success;
        if (url.pathname === `${PROJECT_TRUST_ROUTE_V1}/read`) return ProjectTrustReadRequestV1Schema.safeParse(proof.body).success;
        if (url.pathname === `${PROJECT_TRUST_ROUTE_V1}/list`) return ProjectTrustListRequestV1Schema.safeParse(proof.body).success;
        return readsExecutionConfig && url.pathname === `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`
            && WorkspaceExecutionConfigReadRequestV1Schema.safeParse(proof.body).success;
    }
    const sourcePath = '/v1/projects/sources';
    if (actionId.startsWith('projects.sources.')) {
        if (method === 'GET' && proof.body === undefined
            && url.searchParams.getAll('serverId').length === 1
            && url.searchParams.get('serverId') === verified.binding.serverIdentityId) {
            return actionId === 'projects.sources.list' && url.pathname === sourcePath
                || actionId === 'projects.sources.read' && /^\/v1\/projects\/sources\/[^/]+$/u.test(url.pathname);
        }
        if (url.search !== '') return false;
        const create = actionId === 'projects.sources.create' && method === 'POST' && url.pathname === sourcePath
            ? ProjectSourcesCreateInputV1Schema.safeParse(proof.body) : null;
        const mutation = actionId === 'projects.sources.update' && method === 'PATCH'
            ? ProjectSourcesUpdateInputV1Schema.safeParse(proof.body)
            : actionId === 'projects.sources.delete' && method === 'DELETE'
                ? ProjectSourcesDeleteInputV1Schema.safeParse(proof.body) : null;
        return Boolean(create?.success && create.data.serverId === verified.binding.serverIdentityId
            || mutation?.success && mutation.data.serverId === verified.binding.serverIdentityId
                && url.pathname === `${sourcePath}/${encodeURIComponent(mutation.data.sourceId)}`);
    }
    if (['projects.worker.preferences.get', 'projects.worker.preferences.set', 'projects.worker.preferences.reset',
        'projects.service.placement.get', 'projects.service.placement.set', 'projects.service.relocate'].includes(actionId)) {
        if (url.search !== '') return false;
        if (method === 'GET' && proof.body === undefined) return url.pathname === '/v1/account/encryption';
        if (method !== 'POST') return false;
        if (url.pathname === `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/read`) {
            return WorkspaceExecutionConfigReadRequestV1Schema.safeParse(proof.body).success;
        }
        return !actionId.endsWith('.get') && url.pathname === `${WORKSPACE_EXECUTION_CONFIG_ROUTE_V1}/mutate`
            && WorkspaceExecutionConfigMutationRequestV1Schema.safeParse(proof.body).success;
    }
    if (!['projects.list', 'projects.workspace.update', 'projects.workspace.forget',
        'projects.context.update', 'projects.visibility.set'].includes(actionId) || url.search !== '') return false;
    if (method === 'GET' && proof.body === undefined) return actionId === 'projects.list'
        && (url.pathname === '/v1/account/authoring-memory' || url.pathname === '/v1/machines');
    if (method !== 'POST') return false;
    return url.pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read` || url.pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`
        || actionId !== 'projects.list' && url.pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/mutate`;
}

/** Match the canonical schema and transport rather than a parallel route permission. */
function isAccountActionHttpOperation(actionId: string,
    proof: ExternalActionExecutionRequestProof): boolean {
    if (isSessionFollowActionIdV1(actionId) && actionId.startsWith('follow.')) {
        return isSessionFollowActionHttpRequestV1(actionId, { method: proof.method, path: proof.path,
            body: proof.body, routeInput: proof.routeInput, sessionRouteSessionId: proof.sessionRouteTarget?.sessionId });
    }
    if (!isHomeDomainActionIdV1(actionId) && !isDiscussionActionIdV1(actionId) && actionId !== 'session.organization.pin.set'
        && actionId !== 'session.attention.set' && actionId !== 'account.apiTokens.list'
        && !actionId.startsWith('session.delivery.mute.')
        && !proof.sessionRouteTarget) return false;
    const action = ActionIdSchema.safeParse(actionId);
    if (!action.success) return false;
    const spec = getActionSpec(action.data);
    const transport = spec.serverTransport;
    if (spec.executionPlacement !== 'account' || !transport
        || proof.method.toUpperCase() !== transport.method.toUpperCase()) return false;
    if (actionId.startsWith('session.delivery.mute.')) {
        if (!isSessionFollowActionIdV1(actionId)) return false;
        const receiver = proof.sessionRouteTarget
            ? { kind: 'session' as const, sessionId: proof.sessionRouteTarget.sessionId }
            : { kind: 'account' as const };
        const body = proof.body && typeof proof.body === 'object' && !Array.isArray(proof.body) ? proof.body : {};
        const parsedMute = spec.inputSchema.safeParse({ ...body, receiver });
        if (!parsedMute.success) return false;
        const expectedMute = resolveSessionFollowActionRequest(actionId, parsedMute.data);
        return expectedMute.path === proof.path && sameManagedInput(expectedMute.body, proof.body);
    }
    const input = proof.routeInput ?? proof.body;
    // GET binding omits the existing domain version marker from its query.
    // Restore only that marker; all values/defaults still pass the Action schema.
    // Discussion content has already been sealed by the installed host. The
    // semantic Action schema is not its strict stored-content HTTP schema.
    const inputSchema = isDiscussionActionIdV1(actionId)
        ? discussionActionHttpWireInputSchemaV1(actionId) : spec.inputSchema;
    const parsed = inputSchema.safeParse(input);
    const versioned = !parsed.success && transport.method.toUpperCase() === 'GET'
        && input && typeof input === 'object' && !Array.isArray(input)
        ? inputSchema.safeParse({ v: 1, ...input }) : parsed;
    if (!versioned.success) return false;
    const expected = bindHomeDomainHttpRequestV1({ transport, inputSchema, input: versioned.data });
    return expected.path === proof.path && sameManagedInput(expected.body, proof.body);
}

/** A Discussion operation admits only its resource-codec preparation phases. */
function isDiscussionActionHttpPreparation(verified: VerifiedExternalActionExecutionRequest,
    proof: ExternalActionExecutionRequestProof): boolean {
    const actionId = verified.effectActionId;
    const docChild = isDocDiscussionEffect(verified.binding.actionId, actionId)
        || isDocDecisionPreparationEffect(verified.binding.actionId, actionId);
    if (!isDiscussionActionIdV1(actionId) || verified.binding.actionId !== actionId && !docChild
        && !isSecondOpinionEffect(verified.binding.actionId, actionId)
        && !isWorkflowDiscussionPreparationEffect(verified.binding.actionId, actionId)) return false;
    if (actionId === 'discussion.create' && isAccountEncryptionCurrentnessHttpRead(proof)) {
        return proof.routeInput === undefined || sameManagedInput(proof.routeInput, {});
    }
    const url = new URL(proof.path, 'http://home.invalid');
    if (url.hash !== '') return false;
    const method = proof.method.toUpperCase();
    if (actionId === 'discussion.create' && method === 'GET' && proof.body === undefined
        && url.pathname === DISCUSSION_HTTP_PATHS_V1.collection) {
        // Recovery is creator-qualified, never an unfiltered collection read.
        const query: Record<string, string> = {};
        for (const [key, value] of url.searchParams) {
            if (Object.hasOwn(query, key)) return false;
            query[key] = value;
        }
        const schema = z.strictObject({
            creationLocalId: DiscussionListQueryV1Schema.shape.creationLocalId,
            state: DiscussionListQueryV1Schema.shape.state,
            cursor: DiscussionListQueryV1Schema.shape.cursor,
        });
        const parsed = schema.safeParse(query);
        const route = proof.routeInput === undefined ? parsed : schema.safeParse(proof.routeInput);
        return parsed.success && route.success && parsed.data.creationLocalId !== undefined
            && parsed.data.state !== undefined && sameManagedInput(parsed.data, route.data);
    }
    if (url.search !== '') return false;
    const prefix = DISCUSSION_HTTP_PATHS_V1.discussion.split(':discussionId')[0];
    if (!url.pathname.startsWith(prefix)) return false;
    let discussionId: string;
    try { discussionId = decodeURIComponent(url.pathname.slice(prefix.length).split('/')[0]); }
    catch { return false; }
    const params = DiscussionRouteDiscussionParamsV1Schema.safeParse({ discussionId });
    if (!params.success) return false;
    const atDiscussion = (path: string) => path.replace(':discussionId', encodeURIComponent(params.data.discussionId));
    const matchesInput = (body?: unknown) => proof.routeInput === undefined
        || sameManagedInput(proof.routeInput, { ...params.data,
            ...(body && typeof body === 'object' && !Array.isArray(body) ? body : {}) });
    // Reply policy is an original-root companion read, not a separately
    // authorized participants Action or permission to change the roster.
    if (verified.binding.actionId === actionId && (actionId === 'discussion.post' || actionId === 'discussion.reply')
        && method === 'GET' && proof.body === undefined
        && url.pathname === atDiscussion(DISCUSSION_HTTP_PATHS_V1.participants)) return matchesInput();
    const preparesContent = actionId === 'discussion.read' || actionId === 'discussion.post'
        || actionId === 'discussion.reply' || actionId === 'discussion.rename'
        || actionId === 'discussion.invite' || actionId === 'discussion.access.grants.set';
    if (preparesContent && method === 'GET' && proof.body === undefined
        && url.pathname === atDiscussion(DISCUSSION_HTTP_PATHS_V1.discussion)) return matchesInput();
    // Doc comments create no participants; their root cannot spend C3's
    // separate recipient-key publication authority.
    const preparesRecipients = !docChild && (actionId === 'discussion.create' || actionId === 'discussion.invite'
        || actionId === 'discussion.access.grants.set');
    if (!preparesRecipients) return false;
    if (method === 'GET' && proof.body === undefined
        && url.pathname === atDiscussion(DISCUSSION_HTTP_PATHS_V1.recipientCensus)) return matchesInput();
    return method === 'PUT' && url.pathname === atDiscussion(DISCUSSION_HTTP_PATHS_V1.recipientEnvelopes)
        && DiscussionRecipientKeyEnvelopeCommitInputV1Schema.safeParse(proof.body).success && matchesInput(proof.body);
}

/** A signed Account root spends its declared operation and required preparation reads. */
function isAccountActionHttpPurpose(verified: VerifiedExternalActionExecutionRequest,
    proof: ExternalActionExecutionRequestProof): boolean {
    const root = verified.binding.actionId;
    if (root === 'usage.recap.compose' || root === 'usage.recap.export' || root === 'usage.recap.deliver') {
        // The installed executor signs this consumed safe-view read under its
        // unchanged recap root. No owner record or private Usage grant follows.
        return verified.effectActionId === root && proof.method.toUpperCase() === 'GET'
            && proof.body === undefined && proof.path === '/v1/account/public-profile/view'
            && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, {}));
    }
    if (isMemoryExposureReadEffect(root, verified.effectActionId)) {
        if (proof.method.toUpperCase() !== 'GET' || proof.body !== undefined) return false;
        const url = new URL(proof.path, 'http://home.invalid');
        if (url.pathname === '/v1/public-shares') {
            const artifactId = url.searchParams.get('subjectId');
            return url.hash === '' && url.searchParams.size === 2
                && url.searchParams.get('subjectKind') === 'artifact'
                && url.searchParams.getAll('subjectId').length === 1
                && getActionSpec('artifact.access.grants.list').inputSchema.safeParse({ artifactId }).success
                && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, { subjectKind: 'artifact', subjectId: artifactId }));
        }
        const match = /^\/v1\/artifacts\/([^/?#]+)\/access\/grants$/u.exec(proof.path);
        if (!match) return false;
        try {
            const artifactId = decodeURIComponent(match[1]);
            return getActionSpec('artifact.access.grants.list').inputSchema.safeParse({ artifactId }).success
                && match[1] === encodeURIComponent(artifactId)
                && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, { id: artifactId }));
        } catch { return false; }
    }
    if (root === 'doc.read') {
        if (!isDocReadEffect(root, verified.effectActionId)) return false;
        if (proof.method.toUpperCase() === 'GET' && proof.body === undefined && proof.path === '/v1/features/authenticated') return true;
        if (verified.effectActionId === 'artifact.get') return isReadOnlyArtifactHttpPurpose(proof);
        const list = DiscussionListInputV1Schema.safeParse(proof.routeInput ?? proof.body);
        // Home retains the original envelope digest, not its opened Doc ref.
        // The installed host signs that derived filter; C3 owns exact active
        // Doc/source admission and its batched first-root projection.
        return list.success && list.data.state === 'active' && list.data.anchorDocArtifactId !== undefined
            && list.data.anchorSessionId === undefined && list.data.creationLocalId === undefined && list.data.limit === undefined
            && isAccountActionHttpOperation('discussion.list', proof);
    }
    if (root === 'discussion.second_opinion.start') {
        if (verified.effectActionId === root) {
            if (proof.method.toUpperCase() === 'POST' && proof.path === DISCUSSION_SECOND_OPINION_PREVIEW_HTTP_PATH_V1) {
                const parsed = DiscussionSecondOpinionPreviewInputV1Schema.safeParse(proof.body);
                return parsed.success && (proof.routeInput === undefined || sameManagedInput(parsed.data, proof.routeInput));
            }
            // The canonical transcript reader uses the original root while the
            // authenticated route retains its actual Session read admission.
            if (isAccountEncryptionCurrentnessHttpRead(proof)) return true;
            if (proof.method.toUpperCase() !== 'GET' || proof.body !== undefined) return false;
            if (proof.path === '/v1/features/authenticated') return true;
            if (proof.sessionRouteTarget?.actionId !== 'session.transcript.get') return false;
            const sourcePath = encodeURIComponent(proof.sessionRouteTarget.sessionId);
            const url = new URL(proof.path, 'http://home.invalid');
            if (url.hash !== '') return false;
            // Query filters still pass the transcript route's canonical parser;
            // a source read grants no sibling Session metadata/reply purpose.
            return url.pathname === `/v1/sessions/${sourcePath}/messages`
                || url.pathname === `/v2/sessions/${sourcePath}`
                    && (url.search === '' || url.search === '?accessProjectionVersion=1');
        }
        if (!isSecondOpinionEffect(root, verified.effectActionId)) return false;
        if (verified.effectActionId === 'artifact.get' || verified.effectActionId === 'artifact.access.grants.set') {
            if (proof.method.toUpperCase() === 'GET' && proof.body === undefined && proof.path === '/v1/features/authenticated') return true;
            if (isAccountEncryptionCurrentnessHttpRead(proof)) return proof.routeInput === undefined || sameManagedInput(proof.routeInput, {});
            const match = /^\/v1\/artifacts\/([^/?#]+)(?:\/access\/(grants|recipients|key-envelopes))?$/u.exec(proof.path);
            if (!match) return false;
            let artifactId: string;
            try { artifactId = decodeURIComponent(match[1]); } catch { return false; }
            if (!artifactId || match[1] !== encodeURIComponent(artifactId)) return false;
            const method = proof.method.toUpperCase();
            const matchesInput = (body?: unknown) => proof.routeInput === undefined || sameManagedInput(proof.routeInput,
                { id: artifactId, ...(body && typeof body === 'object' && !Array.isArray(body) ? body : {}) });
            if (method === 'GET' && proof.body === undefined && (match[2] === undefined || match[2] === 'recipients')) return matchesInput();
            if (method === 'PUT' && match[2] === 'grants' && verified.effectActionId === 'artifact.access.grants.set') {
                const parsed = ArtifactAccessGrantSetInputV1Schema.safeParse(proof.body);
                return parsed.success && parsed.data.artifactId === artifactId && matchesInput(parsed.data);
            }
            if (method === 'POST' && match[2] === 'key-envelopes') {
                const parsed = ArtifactRecipientKeyEnvelopeCommitInputV1Schema.safeParse(proof.body);
                return parsed.success && parsed.data.artifactId === artifactId && matchesInput(parsed.data);
            }
            return false;
        }
        return isAccountActionHttpOperation(verified.effectActionId, proof)
            || isDiscussionActionHttpPreparation(verified, proof)
            || proof.method.toUpperCase() === 'GET' && proof.body === undefined && proof.path === '/v1/features/authenticated';
    }
    if (root === 'doc.edit.accept' || root === 'doc.edit.decline') {
        if (verified.effectActionId === root) {
            const path = root === 'doc.edit.accept' ? DOC_EDIT_PROPOSAL_HTTP_PATHS_V1.accept : DOC_EDIT_PROPOSAL_HTTP_PATHS_V1.decline;
            const schema = root === 'doc.edit.accept' ? DocEditAcceptTransportInputV1Schema : DocEditDeclineTransportInputV1Schema;
            return proof.method.toUpperCase() === 'POST' && proof.path === path && schema.safeParse(proof.body).success
                && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, proof.body));
        }
        if (!isDocDecisionPreparationEffect(root, verified.effectActionId)) return false;
        if (verified.effectActionId === 'discussion.read') {
            return isAccountActionHttpOperation(verified.effectActionId, proof) || isDiscussionActionHttpPreparation(verified, proof)
                || proof.method.toUpperCase() === 'GET' && proof.body === undefined && proof.path === '/v1/features/authenticated';
        }
        return isReadOnlyArtifactHttpPurpose(proof);
    }
    if (isDocDiscussionEffect(verified.binding.actionId, verified.effectActionId)) {
        // As with usage export, Home retains the root envelope digest while
        // the installed host derives and signs the exact child operands.
        // C3 still owns access, source disclosure and encrypted content admission.
        return isAccountActionHttpOperation(verified.effectActionId, proof)
            || isDiscussionActionHttpPreparation(verified, proof)
            || proof.method.toUpperCase() === 'GET' && proof.body === undefined
                && proof.path === '/v1/features/authenticated';
    }
    if (verified.effectActionId !== verified.binding.actionId && 'authentication' in verified.binding) return false;
    if (isDiscussionActionIdV1(verified.binding.actionId)) {
        return verified.effectActionId === verified.binding.actionId
            && (isAccountActionHttpOperation(verified.effectActionId, proof)
                || isDiscussionActionHttpPreparation(verified, proof));
    }
    if (verified.binding.actionId === 'session.organization.pin.set'
        && proof.method.toUpperCase() === 'GET' && proof.body === undefined) {
        if (isAccountEncryptionCurrentnessHttpRead(proof)) return true;
        // Rail admission opens only a named authorized Session. The existing
        // detail route retains access/projection policy; no list or Account
        // content read is granted by the pin's installed-Machine signature.
        const detail = /^\/v2\/sessions\/([^/?#]+)(\?accessProjectionVersion=1)?$/u.exec(proof.path);
        if (detail) {
            try {
                const parsed = SessionOrganizationPinSetInputSchema.safeParse({ sessionId: decodeURIComponent(detail[1]), pinned: true });
                return parsed.success && proof.path === `/v2/sessions/${encodeURIComponent(parsed.data.sessionId)}${detail[2] ?? ''}`;
            } catch { return false; }
        }
    }
    return isAccountActionHttpOperation(verified.effectActionId, proof);
}

/** Candidate reads compose existing directories; the root grants no content or execution effect. */
function isDiscussionCandidateReadHttpPurpose(verified: VerifiedExternalActionExecutionRequest,
    proof: ExternalActionExecutionRequestProof): boolean {
    if (verified.binding.actionId !== 'discussion.candidates.list'
        || verified.effectActionId !== verified.binding.actionId || verified.target.kind !== 'machine'
        || !('authentication' in verified.binding) && verified.binding.grant.targets !== null) return false;
    const url = new URL(proof.path, 'http://home.invalid');
    if (url.hash !== '') return false;
    const method = proof.method.toUpperCase();
    if (method === 'POST' && proof.path === '/v2/sessions/query') {
        const query = SessionListQueryV1Schema.safeParse(proof.body);
        return query.success && sameManagedInput(query.data, projectDiscussionCandidateSessionQueryV1({
            source: 'sessions', ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
        })) && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, query.data));
    }
    if (method !== 'GET' || proof.body !== undefined) return false;
    if (proof.path === '/v1/features/authenticated') return true;
    if (url.pathname === '/v1/user/search') {
        if ([...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)) return false;
        const query = UsersSearchQueryV1Schema.safeParse(Object.fromEntries(url.searchParams));
        return query.success && query.data.purpose === 'collaboration'
            && proof.path === bindDiscussionCandidatePeopleReadV1({ source: 'people', query: query.data.query,
                ...(query.data.cursor ? { cursor: query.data.cursor } : {}) });
    }
    const match = /^\/v1\/discussions\/([^/?#]+)\/participants$/u.exec(proof.path);
    if (!match) return false;
    try {
        const params = DiscussionRouteDiscussionParamsV1Schema.safeParse({ discussionId: decodeURIComponent(match[1]) });
        return params.success && match[1] === encodeURIComponent(params.data.discussionId)
            && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, params.data));
    } catch { return false; }
}

/** Selector preparation spends its declared root, never a Follow or Discussion child Action. */
function isSessionTargetPreparationHttpPurpose(verified: VerifiedExternalActionExecutionRequest,
    proof: ExternalActionExecutionRequestProof): boolean {
    const root = SignedRootActionIdSchema.safeParse(verified.binding.actionId);
    if (!root.success || !isSessionTargetPreparationAction(root.data)
        || verified.effectActionId !== verified.binding.actionId) return false;
    const method = proof.method.toUpperCase();
    if (method === 'GET' && proof.body === undefined && proof.sessionRouteTarget?.actionId === 'session.transcript.get') {
        // Exact reference/manager facts precede selection and final Action scope.
        // Per-Session grants above and ordinary route access still apply.
        const path = `/v2/sessions/${encodeURIComponent(proof.sessionRouteTarget.sessionId)}`;
        if (proof.path === path || proof.path === `${path}?accessProjectionVersion=1`) return true;
    }
    if (method === 'GET' && proof.body === undefined && proof.sessionRouteTarget?.actionId === 'follow.list'
        && isSessionFollowActionHttpRequestV1('follow.list', { method, path: proof.path, routeInput: proof.routeInput,
            sessionRouteSessionId: proof.sessionRouteTarget.sessionId })) return true;
    // Native routes retain current actor/resource admission. Collection and
    // private Account facts additionally require the root's Account-wide scope.
    if (!('authentication' in verified.binding) && verified.binding.grant.targets !== null) return false;
    if (method === 'POST' && proof.path === '/v2/sessions/query') {
        const query = SessionListQueryV1Schema.safeParse(proof.body);
        return query.success && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, query.data));
    }
    if (method === 'GET' && proof.body === undefined) {
        if (proof.path === '/v1/account/encryption/currentness' || proof.path === '/v1/features/authenticated') {
            return proof.routeInput === undefined || sameManagedInput(proof.routeInput, {});
        }
        if (isAccountActionHttpOperation('discussion.participants.list', proof)) return true;
        if (proof.path === SESSION_FOLLOW_RULES_ROUTE_V1 && isSessionFollowActionHttpRequestV1('follow.list', {
            method, path: proof.path, routeInput: proof.routeInput,
        })) return true;
    }
    // Accepted-workspace status reads use an exact row when metadata has its
    // accepted id, or a Home/kind-filtered census for path-associated Sessions.
    // Both spend the same Account-wide read authority checked above.
    if (root.data === 'session.status.get' && method === 'POST' && !proof.sessionRouteTarget) {
        const rows = proof.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`
            ? ProjectAccountRowReadRequestV1Schema.safeParse(proof.body)
            : proof.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`
                ? ProjectAccountRowListRequestV1Schema.safeParse(proof.body) : null;
        if (rows?.success) return ('authentication' in verified.binding || !isApiTokenGrantRestrictedV1(verified.binding.grant))
            && (proof.routeInput === undefined || sameManagedInput(proof.routeInput, rows.data));
    }
    // Follow's existing transport owns the closed Project/assignment fact reads.
    return isSessionFollowActionHttpRequestV1('follow.preview', { method, path: proof.path, body: proof.body,
        routeInput: proof.routeInput, sessionRouteSessionId: proof.sessionRouteTarget?.sessionId });
}

/** Collection phases have no single Session operand and require captured Account-wide resource access. */
function isSessionListHttpPurpose(verified: VerifiedExternalActionExecutionRequest,
    proof: ExternalActionExecutionRequestProof): boolean {
    const preview = verified.binding.actionId === 'follow.preview';
    if ((verified.binding.actionId !== 'session.list' && !preview) || verified.effectActionId !== verified.binding.actionId
        || verified.target.kind !== 'machine'
        || !('authentication' in verified.binding) && verified.binding.grant.targets !== null) return false;
    const url = new URL(proof.path, 'http://home.invalid');
    if (proof.method.toUpperCase() === 'POST') return url.pathname === '/v2/sessions/query' && url.search === ''
        && SessionListQueryV1Schema.safeParse(proof.body).success;
    if (proof.method.toUpperCase() !== 'GET' || proof.body !== undefined) return false;
    // Preview consumes the authorized corpus, not Session listing's broader
    // metadata/settings preparation. Its local predicates stay host-owned.
    if (preview) return proof.path === '/v1/account/encryption/currentness';
    return ['/v1/sessions', '/v2/sessions', '/v2/sessions/active', '/v2/sessions/archived'].includes(url.pathname)
        || url.search === '' && ['/v1/account/encryption/currentness', '/v1/account/encryption', '/v2/account/settings'].includes(url.pathname);
}

/** Every admitted Session operand retains the captured grant and current Machine relationship. */
async function isExternalActionSessionTargetWithinGrant(binding: ExternalActionExecutionAuthorizationBindingV1,
    sessionId: string): Promise<boolean> {
    if ('authentication' in binding) return true;
    if (isApiTokenGrantTargetMemberV1(binding.grant, { kind: 'session', sessionId })) return true;
    for (const machineId of binding.grant.targets?.machines ?? []) {
        if (await hasCurrentSessionScopedMachineAccessInTx({ tx: db, accountId: binding.accountId, machineId, sessionId })) return true;
    }
    return false;
}

/** The installed coordinator owns decrypted selection; Home admits only its named, signed phases. */
async function isSessionAgentTransitionHttpPurpose(verified: VerifiedExternalActionExecutionRequest,
    proof: ExternalActionExecutionRequestProof): Promise<boolean> {
    if (verified.effectActionId !== verified.binding.actionId) return false;
    const url = new URL(proof.path, 'http://home.invalid');
    const method = proof.method.toUpperCase();
    if (method === 'GET' && proof.body === undefined) {
        if (['/v1/account/encryption/currentness', '/v1/account/encryption', '/v2/account/settings'].includes(url.pathname)) {
            return url.search === '';
        }
        if (url.pathname === `/v1/machines/${encodeURIComponent(verified.binding.machineId)}`) return url.search === '';
        if (verified.target.kind !== 'session') return false;
        const read = /^\/v(?:1\/sessions\/([^/]+)(?:\/messages)?|2\/sessions\/([^/]+)(?:\/messages\/by-local-id\/[^/]+)?)$/u.exec(url.pathname);
        if (!read) return false;
        let sessionId: string;
        try { sessionId = decodeURIComponent(read[1] ?? read[2]); } catch { return false; }
        // Replay follows existing fork ancestry. Ordinary Account Session access
        // remains handler-owned; a PAT must retain its captured scope for each
        // actual requested ancestor, not borrow the child's resolved Machine.
        return isExternalActionSessionTargetWithinGrant(verified.binding, sessionId);
    }
    return verified.binding.actionId === 'session.agent.transition' && verified.target.kind === 'session'
        && method === 'POST' && url.search === ''
        && url.pathname === `/v2/sessions/${encodeURIComponent(verified.target.sessionId)}/agent-transition/cutover`;
}

/** No generic descendant grant: first-input custody, the transition fence, stop and same-Session resume only. */
function isSessionAgentTransitionRpcPurpose(binding: ExternalActionExecutionAuthorizationBindingV1,
    execution: ExternalActionMachineRpcExecutionV1,
    request: Readonly<{ method: string; params?: unknown; event?: ExternalActionMachineRpcEventV1 }>): boolean {
    if (binding.actionId !== 'session.agent.transition' || execution.target.kind !== 'session') return false;
    const sessionId = execution.target.sessionId;
    if (execution.effectActionId === 'session.message.send') {
        const v1 = request.event === SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1 && request.method === request.event;
        const v2 = request.event === SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2 && request.method === request.event;
        const pending = v1 ? SessionPendingEnqueueByMachineRequestV1Schema.safeParse(request.params)
            : v2 ? SessionPendingExecutionRunEnqueueByMachineRequestV2Schema.safeParse(request.params) : null;
        return Boolean(pending?.success && pending.data.sessionId === sessionId
            && pending.data.targetMachineId === binding.machineId && pending.data.requestedAction.kind === 'send_now');
    }
    if (execution.effectActionId !== binding.actionId || request.event !== undefined && request.event !== SOCKET_RPC_EVENTS.CALL) return false;
    const fence = request.method === `${sessionId}:${SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION}`;
    const stop = request.method === `${binding.machineId}:${RPC_METHODS.STOP_SESSION}`;
    const resume = [RPC_METHODS.SPAWN_HAPPY_SESSION, RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE]
        .some(method => request.method === `${binding.machineId}:${method}`);
    if (!fence && !stop && !resume) return false;
    // Home cannot open E2EE RPC params. The installed signature binds the exact
    // Session/method/ciphertext; the incumbent receiver validates the opened request.
    if (typeof request.params === 'string') return true;
    if (!request.params || typeof request.params !== 'object' || Array.isArray(request.params)) return false;
    const params = request.params as Readonly<Record<string, unknown>>;
    if (fence) return params.serviceId === 'session.agentTransition' && (params.action === 'enforce' || params.action === 'clear');
    return params.sessionId === sessionId && (stop || params.type === 'resume-session');
}

/** Account metadata writes resolve one Session before signing its codec reads and tuple patch. */
function isSessionStateFieldActionHttpPurpose(verified: VerifiedExternalActionExecutionRequest,
    proof: ExternalActionExecutionRequestProof): boolean {
    if (!isSessionStateFieldActionId(verified.binding.actionId)
        || verified.effectActionId !== verified.binding.actionId || verified.target.kind !== 'session') return false;
    const sessionPath = `/v2/sessions/${encodeURIComponent(verified.target.sessionId)}`;
    if (proof.method.toUpperCase() === 'GET' && proof.body === undefined) {
        return isAccountEncryptionCurrentnessHttpRead(proof)
            || proof.path === sessionPath || proof.path === `${sessionPath}?accessProjectionVersion=1`;
    }
    return proof.method.toUpperCase() === 'PATCH' && proof.path === sessionPath
        && SessionMetadataTuplePatchV1Schema.safeParse(proof.body).success;
}

/** The Run Action owner spends its storage phases without acquiring a worker claim. */
function isWorkflowRunActionHttpPurpose(verified: VerifiedExternalActionExecutionRequest,
    proof: ExternalActionExecutionRequestProof): boolean {
    if (isWorkflowDiscussionPreparationEffect(verified.binding.actionId, verified.effectActionId)) {
        // Home retains the root envelope digest. Its installed host signs the
        // exact derived read; C3 still owns grants, current keys and disclosure.
        return proof.method.toUpperCase() === 'GET' && proof.body === undefined
            && (isAccountActionHttpOperation('discussion.read', proof)
                || isDiscussionActionHttpPreparation(verified, proof)
                || proof.path === '/v1/features/authenticated');
    }
    const reads = ['get', 'run-key.census', 'run-key.commit'];
    const invocationReads = [...reads, 'invocations.list', 'invocations.get', 'invocations.current'];
    const purposes: Readonly<Record<string, readonly string[]>> = {
        // Accepted replay / Another round reads the prior Run's exact outcomes
        // before admission. These are Account reads, not worker mutations.
        'workflow.run.start': [...invocationReads, 'admit'],
        'workflow.run.get': invocationReads,
        'workflow.run.list': ['list', 'run-key.commit'],
        'workflow.run.summaries': ['summaries'],
        // Wait reads the same invocation history as Get to reject a wait
        // that would occupy its own target conversation.
        'workflow.run.wait': [...invocationReads, 'wait'],
        'workflow.run.pause': [...reads, 'pause'],
        'workflow.run.cancel': [...reads, 'cancel'],
        'workflow.run.delete': [...reads, 'delete'],
        'workflow.run.resume': [...invocationReads, 'resume', 'invocations.recover'],
        'workflow.run.invocations.list': [...reads, 'invocations.list'],
        'workflow.run.invocations.get': invocationReads,
        'workflow.run.invocations.retry': [...invocationReads, 'invocations.recover'],
        'workflow.run.invocations.publish_draft': [...invocationReads, 'invocations.publish_draft'],
        'workflow.run.invocations.complete_review': [...invocationReads, 'invocations.complete_review'],
    };
    const allowed = Object.hasOwn(purposes, verified.binding.actionId) ? purposes[verified.binding.actionId] : undefined;
    if (!allowed || verified.effectActionId !== verified.binding.actionId || verified.target.kind !== 'machine') return false;
    if (isAccountEncryptionCurrentnessHttpRead(proof)) return true;
    if (proof.method.toUpperCase() !== 'POST' || proof.path !== '/v3/automations/runs/workflow-storage'
        || !proof.body || typeof proof.body !== 'object' || Array.isArray(proof.body)) return false;
    const body = proof.body as Readonly<Record<string, unknown>>;
    const reattachFact = verified.binding.actionId === 'workflow.run.resume' && body.operation === 'invocations.fact'
        && (body.resolution === 'observed_terminal_execution' || body.resolution === 'root_list_progress')
        && Number.isSafeInteger(body.expectedRevision) && Number(body.expectedRevision) >= 0 && body.parentAttempt === undefined;
    // The strict route schema and storage owner retain resource, mode, CAS,
    // and publisher-signature admission after this original-root purpose check.
    return typeof body.operation === 'string' && (allowed.includes(body.operation) || reattachFact)
        && body.publisherMachineId === verified.binding.machineId;
}

export async function verifyExternalActionDomainExecutionRequest(
    proof: ExternalActionExecutionRequestProof,
): Promise<VerifiedExternalActionExecutionRequest | null> {
    const verified = await verifyCommon(proof);
    if (!verified) return null;
    // All reachable roots spend the same resolved private phase, including
    // approval/invoke wrappers. Finite preview corpus permission is separate.
    if (verified.effectActionId === 'follow.preview' && isSessionFollowActionHttpRequestV1('follow.preview', {
        method: proof.method, path: proof.path, body: proof.body, routeInput: proof.routeInput,
        sessionRouteSessionId: proof.sessionRouteTarget?.sessionId,
    })
        && !('authentication' in verified.binding) && isApiTokenGrantRestrictedV1(verified.binding.grant)) return null;
    if (proof.sessionRouteTarget) {
        for (const sessionId of [proof.sessionRouteTarget.sessionId, ...(proof.sessionRouteTarget.additionalSessionIds ?? [])]) {
            if (!await isExternalActionSessionTargetWithinGrant(verified.binding, sessionId)) return null;
        }
    }
    if (verified.binding.handoffPreflight && (proof.method.toUpperCase() !== 'GET' || proof.body !== undefined
        || proof.path !== `/v1/machines/${encodeURIComponent(verified.binding.machineId)}`)) return null;
    const relay = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(proof.body);
    const isAdmittedRootRelay = proof.method.toUpperCase() === 'POST'
        && proof.path === `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${encodeURIComponent(verified.binding.actionId)}`
        && relay.success && relay.data.executionAuthorization?.token === proof.authorizationToken
        && sameManagedInput(relay.data.executionAuthorization.binding, verified.binding)
        && isExternalActionAuthorizationBoundToEnvelope(verified.binding, { actionId: verified.effectActionId,
            machineId: relay.data.machineId, envelope: relay.data.envelope });
    const root = SignedRootActionIdSchema.safeParse(verified.binding.actionId);
    const rootSpec = root.success ? getActionSpec(root.data) : null;
    const nativePurpose = rootSpec?.originalExecution?.nativePurpose;
    const rootMachineAction = MachineAccessActionIdSchema.safeParse(verified.binding.actionId);
    const effectMachineAction = MachineAccessActionIdSchema.safeParse(verified.effectActionId);
    const readsExecutionMachine = root.success
        && (((rootSpec?.executionPlacements ?? [rootSpec?.executionPlacement]).includes('machine')
                || verified.binding.sessionActionOrigin && isLedSubtreeSessionLifecycleActionId(root.data))
            && verified.binding.target.kind === 'machine' && verified.binding.target.machineId === verified.binding.machineId
            || getActionSpec(root.data).executionPlacement === 'session' && verified.target.kind === 'session')
        && (verified.effectActionId === verified.binding.actionId
            || isSessionArchiveStopEffect(verified.binding.actionId, verified.effectActionId))
        && proof.method.toUpperCase() === 'GET' && proof.body === undefined
        && proof.path === `/v1/machines/${encodeURIComponent(verified.binding.machineId)}`;
    const managedRoot = ManagedMachineActionIdV1Schema.safeParse(verified.binding.actionId);
    let managedGuestActivity: VerifiedExternalActionExecutionRequest['managedGuestActivity'];
    if (readsExecutionMachine) {
        // Native Machine and Session RPC read the exact execution Machine's content codec
        // before delivery. This is not Account read authority or a family grant.
    } else if (verified.binding.actionId === 'workflow.trigger.run_now') {
        const match = /^\/v3\/automations\/([^/]+)\/run-now$/u.exec(proof.path);
        if (proof.method.toUpperCase() !== 'POST' || proof.body !== undefined || !match
            || verified.effectActionId !== verified.binding.actionId
            || proof.idempotencyKey !== verified.binding.idempotencyKey) return null;
        let automationId: string;
        try { automationId = decodeURIComponent(match[1]!); } catch { return null; }
        if (verified.binding.automationId !== undefined && verified.binding.automationId !== automationId) return null;
        if ('grant' in verified.principal && !evaluateApiTokenGrantV1({ grant: verified.principal.grant,
            actionId: verified.binding.actionId, automationId, target: verified.target,
            targetMachineId: verified.binding.machineId }).ok) return null;
    } else if (verified.binding.actionId.startsWith('workflow.run.')) {
        if (!isWorkflowRunActionHttpPurpose(verified, proof)) return null;
        // Direct and Session-origin Runs use the same requester storage port.
        // Automation workers retain their separate installed-publisher path.
    } else if (verified.binding.actionId === 'discussion.candidates.list') {
        // Keep this composed read out of generic read-root Session admission.
        // Native directory/roster routes still own current actor and resource access.
        if (!isDiscussionCandidateReadHttpPurpose(verified, proof)) return null;
    } else if (isSessionStateFieldActionHttpPurpose(verified, proof)) {
        // The existing Session routes retain actor access, tuple CAS and publisher policy.
    } else if (isSessionListHttpPurpose(verified, proof)
        || await isInstalledSessionSubtreeObservationHttpPurpose(verified, proof)
        || isSessionSourceKeyTransportHttpPurpose(verified, proof)
        || await isInstalledSessionLifecycleHttpPurpose(verified, proof)) {
        // Original-root observations and lifecycle operands (including Archive's
        // named Stop phase) retain signature, currentness and ordinary route access.
    } else if (!verified.binding.actionId.startsWith('follow.')
        && (rootSpec?.executionPlacement === 'session' || verified.binding.sessionActionOrigin)
        && (verified.effectActionId === verified.binding.actionId
            || isSessionArchiveStopEffect(verified.binding.actionId, verified.effectActionId))
        && isAccountEncryptionCurrentnessHttpRead(proof)) {
        // The Session transport must admit persisted requester Account mode
        // before opening owner metadata. verifyCommon has already rechecked
        // the signed placement, Machine installation and principal.
    } else if (isAdmittedRootRelay || verified.binding.handoffPreflight) {
        // Exact root re-entry is not a family grant or a new originator.
    } else if (managedRoot.success) {
        const path = proof.path.split('?')[0];
        const method = proof.method.toUpperCase();
        // The managed controller namespace is the incumbent native-effect
        // owner. Its handlers additionally verify their exact named effect.
        const controllerPurpose = method === 'POST' && /^\/v1\/machines\/managed\/controller\/[^/]+$/u.test(path);
        const readPurpose = method === 'POST' && path === managedMachineActionEndpointPathV1('machines.managed.get');
        const directPurpose = method === 'POST'
            && ['machines.managed.list', 'machines.managed.get', 'machines.managed.cancel', 'machines.managed.setup.skip'].includes(managedRoot.data)
            && path === managedMachineActionEndpointPathV1(managedRoot.data);
        const continuation = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(proof.body);
        const childPurpose = managedRoot.data === 'machines.managed.acquire' && method === 'POST'
            && ['session.spawn_new', 'machines.environment.apply'].some(action =>
                path === bindExternalActionExecutionAuthorizationHttpPathV1(action)
                || path === `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${action}`)
            && continuation.success && continuation.data.managedContinuation !== undefined;
        const setupPurpose = managedRoot.data === 'machines.environment.apply' && method === 'POST'
            && ['/v1/machines/environment/resolve', '/v1/machines/environment/report'].includes(path);
        const guestPath = method === 'GET' ? /^\/v1\/machines\/([^/]+)$/u.exec(path) : null;
        const guestPurpose = guestPath && await readCurrentManagedGuestActivityInTx(db, verified.binding, guestPath[1]);
        if (!controllerPurpose && !readPurpose && !directPurpose && !childPurpose && !guestPurpose && !setupPurpose) return null;
        if (guestPurpose) managedGuestActivity = guestPurpose;
    } else if (rootMachineAction.success || effectMachineAction.success) {
        if (!rootMachineAction.success || !effectMachineAction.success
            || rootMachineAction.data !== effectMachineAction.data) return null;
        const path = proof.path.split('?')[0];
        const method = proof.method.toUpperCase();
        const preparesKeys = rootMachineAction.data === 'machines.access.grant.set'
            || rootMachineAction.data === 'machines.access.prepareKeys';
        const keyPreparationPath = /^\/v1\/machines\/[^/]+\/data-key-envelopes$/u.test(path);
        // Existing C40 routes own original-custodian conversion; Machine
        // audience routes independently own current Manage.
        const custodianPreparationPath = preparesKeys && (
            method === 'GET' && (path === '/v1/account/encryption' || /^\/v1\/machines\/[^/]+$/u.test(path))
            || method === 'POST' && /^\/v1\/machines\/[^/]+\/content-key\/transition$/u.test(path)
        );
        if (keyPreparationPath) {
            if (!preparesKeys || (method !== 'GET' && method !== 'PATCH')) return null;
        } else if (!custodianPreparationPath) {
            const transport = getActionSpec(rootMachineAction.data).serverTransport;
            if (!transport || method !== transport.method
                || !/^\/v1\/machines\/[^/]+\/access$/u.test(path)) return null;
        }
    } else if (isProjectAccountMetadataHttpPurpose(verified, proof)) {
        // The installed signature spends the unchanged root as its original
        // requester, not the daemon's ambient bearer or a new Account grant.
    } else if (isOriginalAccountProjectAction(verified.binding.actionId)) {
        const actionId = verified.binding.actionId;
        const path = proof.path.split('?')[0];
        if (verified.effectActionId !== actionId) return null;
        const readsSource = actionId === 'projects.open' && proof.method.toUpperCase() === 'GET'
            && /^\/v1\/projects\/sources\/[^/]+$/u.test(path)
            && new URL(proof.path, 'http://home.invalid').searchParams.get('serverId') === verified.binding.serverIdentityId;
        const readsTrust = path === `${PROJECT_TRUST_ROUTE_V1}/read` || path === `${PROJECT_TRUST_ROUTE_V1}/list`;
        const opensProjectRows = actionId === 'projects.open'
            && [`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`, `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/mutate`].includes(path);
        const revocation = actionId === 'projects.trust.revoke' && path === `${PROJECT_TRUST_ROUTE_V1}/mutate`
            ? ProjectTrustMutationRequestV1Schema.safeParse(proof.body) : null;
        const revokesTrust = revocation?.success && revocation.data.content === null;
        if (!readsSource && (proof.method.toUpperCase() !== 'POST' || !readsTrust && !opensProjectRows && !revokesTrust)) return null;
    } else if (isOriginalAccountHandoffAction(verified.binding.actionId)) {
        const path = proof.path.split('?')[0];
        const child = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(proof.body);
        if (verified.binding.actionId !== 'session.handoff' || !verified.binding.handoffAdmission
            || verified.binding.handoffPreflight
            || proof.method.toUpperCase() !== 'POST' || !child.success
            || !(child.data.handoffContinuation && readHandoffContinuationIssuanceAction(path) !== null
                || child.data.handoffPreflight && path === bindExternalActionExecutionAuthorizationHttpPathV1('session.handoff'))) return null;
    } else if (verified.binding.actionId === 'session.agent.transition' || verified.binding.actionId === 'session.continuation.inspect') {
        if (!await isSessionAgentTransitionHttpPurpose(verified, proof)) return null;
    } else if (nativePurpose === 'quota_read') {
        if (verified.effectActionId !== verified.binding.actionId || !isQuotaReadHttpPurpose(proof)) return null;
    } else if (verified.binding.actionId === 'agents.models.list') {
        // Automatic Summary models consume the requester's current default-auth
        // purposes row. Admit only that row and Account-mode currentness under
        // this same root; retained Settings and source maintenance are private.
        if (verified.effectActionId !== verified.binding.actionId
            || proof.method.toUpperCase() !== 'GET' || proof.body !== undefined
            || !['/v1/account/encryption/currentness',
                `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`].includes(proof.path)) return null;
    } else if (verified.binding.actionId === 'scm.diffSummary.reviewed.mark'
        || verified.binding.actionId === 'scm.diffSummary.reviewed.unmark'
        || verified.binding.actionId === 'scm.diffSummary.result.delete'
        || verified.binding.actionId === 'scm.diffSummary.result.clear') {
        // A collaborator cannot borrow the custodian's Account material. The
        // daemon comparison owner validates exact occurrences before this CAS;
        // the Home keeps mode admission and Account isolation authoritative.
        if (verified.effectActionId !== verified.binding.actionId
            || verified.binding.accountId !== verified.binding.custodianAccountId
            || !isScmReviewedMarksHttpPurpose(proof)) return null;
    } else if (nativePurpose === 'session_board_write') {
        const target = verified.binding.target;
        const origin = verified.binding.sessionActionOrigin;
        if (verified.effectActionId !== verified.binding.actionId || target.kind !== 'session'
            || !origin || origin.caller.sessionId !== target.sessionId) return null;
        const url = new URL(proof.path, 'http://home.invalid');
        const sessionPath = `/v2/sessions/${encodeURIComponent(target.sessionId)}`;
        const method = proof.method.toUpperCase();
        const mutation = method === 'PUT' && url.pathname === `${sessionPath}/board` && url.search === ''
            ? SessionBoardMutationV1Schema.safeParse(proof.body) : null;
        const query = Object.fromEntries(url.searchParams);
        const address = method === 'GET' && proof.body === undefined && url.pathname === `${sessionPath}/system-records/record`
            && Object.keys(query).length === Array.from(url.searchParams).length
            ? SessionSystemRecordAddressSchema.safeParse(query) : null;
        const readsSurface = address?.success && address.data.owner === 'host' && address.data.namespace === 'surface'
            && (address.data.kind === 'item.v1' || address.data.kind === 'layout.v1' && address.data.localId === 'layout');
        const readsSession = method === 'GET' && proof.body === undefined && url.pathname === sessionPath
            && (url.search === '' || url.search === '?accessProjectionVersion=1');
        if (!readsSession && !readsSurface && !(mutation?.success && mutation.data.operation === 'upsert_item')) return null;
    } else if (nativePurpose === 'pending_reset_start') {
        const admission = verified.binding.pendingResetStartAdmission;
        const purpose = readExternalActionPendingResetStartPurpose({ actionId: verified.effectActionId,
            method: proof.method, path: proof.path, body: proof.body });
        const preparesReset = admission && isExternalActionPendingResetStartReadPurpose({ method: proof.method,
            path: proof.path, body: proof.body, admission });
        if (verified.effectActionId !== verified.binding.actionId
            || !preparesReset && (!purpose || (admission ? !purpose.reset || !sameManagedInput(projectExternalActionPendingResetStartAdmissionV1(purpose), admission)
                : verified.binding.target.kind !== 'session' || purpose.sessionId !== verified.binding.target.sessionId))) return null;
    } else if (verified.binding.actionId === 'teams.credentials.usage.export') {
        // The installed executor derives this consumed read from the admitted
        // export input. Home retains only its envelope digest, not the opened
        // query: it cannot independently reconstruct parent/child input equality.
        // The native signature binds the read bytes; the existing route still
        // owns current actor, Team and resource authorization.
        if (!isTeamCredentialUsageExportReadEffect(verified.binding.actionId, verified.effectActionId)
            || !isAccountActionHttpOperation(verified.effectActionId, proof)) return null;
    } else if (isSessionFollowActionIdV1(verified.binding.actionId) && verified.binding.actionId.startsWith('follow.')) {
        // A finite Follow root cannot fall through to generic Session read
        // admission or spend a sibling Follow subaction/private census.
        if (verified.effectActionId !== verified.binding.actionId
            || !isAccountActionHttpOperation(verified.effectActionId, proof)) return null;
    } else if (isSessionTargetPreparationHttpPurpose(verified, proof)) {
        // Specialized roots above retain their narrower native-purpose contract.
        // General Session operands prepare only the signed selector read phases.
    } else if (verified.binding.actionId === 'session.targets.resolve') {
        // Inspection has no final Session effect. A non-preparation read must
        // not borrow the generic read-root admission below (for example messages).
        return null;
    } else if (isAccountActionHttpPurpose(verified, proof)) {
        // The signature binds these exact bytes; route schemas and the domain
        // still own resource admission, while the credential policy below
        // retains human-only execution floors.
    } else if (verified.effectActionId === verified.binding.actionId
        && proof.method.toUpperCase() === 'GET' && proof.body === undefined && proof.path === '/v1/features/authenticated') {
        // Shared transport discovery runs only after each specialized native
        // purpose has enforced its own narrower phase contract.
    } else if (proof.sessionRouteTarget
        && (proof.method.toUpperCase() === 'GET' && proof.body === undefined
            || proof.sessionRouteTarget.actionId !== undefined
                && (proof.sessionRouteTarget.actionId === verified.effectActionId
                    || getActionSpec(proof.sessionRouteTarget.actionId).sideEffectClass === 'read'))
        && (verified.target.kind === 'session'
            && proof.sessionRouteTarget.sessionId === verified.target.sessionId
            && (rootSpec?.executionPlacement === 'session' && verified.effectActionId === verified.binding.actionId
                || !('authentication' in verified.binding))
            || verified.effectActionId === verified.binding.actionId && (rootSpec?.sideEffectClass === 'read'
                    || verified.binding.sessionActionOrigin
                        && proof.sessionRouteTarget.sessionId === verified.binding.sessionActionOrigin.caller.sessionId)
                && verified.binding.target.kind === 'machine' && verified.target.kind === 'machine'
                && proof.method.toUpperCase() === 'GET' && proof.body === undefined)) {
        // The HTTP auth adapter uses the same route operation/selector owner
        // as direct Session admission. Read roots retain domain access checks;
        // a mutation may prepare only the source Session the runner already reads.
        // Mutations still declare this root's actual effect on its exact Session.
    } else {
        const path = proof.path.split('?')[0];
        const childPurpose = verified.binding.actionId === 'session.spawn_new' && verified.binding.managedContinuation
            && proof.method.toUpperCase() === 'POST' && path === '/v1/sessions';
        if (!childPurpose) return null;
    }
    const effect = parseExternalActionEffectAction(verified.binding, verified.effectActionId);
    const credentialAction = isDocDecisionPreparationEffect(verified.binding.actionId, verified.effectActionId)
        || isSecondOpinionEffect(verified.binding.actionId, verified.effectActionId)
        || isMemoryExposureReadEffect(verified.binding.actionId, verified.effectActionId)
        ? parseExternalActionEffectAction(verified.binding, verified.binding.actionId)
        : isTeamCredentialUsageExportReadEffect(verified.binding.actionId, verified.effectActionId)
        || isDocDiscussionEffect(verified.binding.actionId, verified.effectActionId)
        || isDocReadEffect(verified.binding.actionId, verified.effectActionId)
        ? PublicActionIdSchema.safeParse(verified.binding.actionId)
        : verified.binding.handoffContinuation
            ? PublicActionIdSchema.safeParse(readExternalActionCredentialActionId(verified.binding)) : effect;
    if (!effect.success || !credentialAction.success || !resolveCredentialActionAdmissionV1({
        spec: getActionSpec(credentialAction.data),
        authority: verified.effectiveAuthority, grant: 'grant' in verified.binding ? verified.binding.grant : null }).ok) return null;
    return managedGuestActivity ? { ...verified, managedGuestActivity } : verified;
}

function matchesExternalActionAuthorizationBinding(binding: ExternalActionExecutionAuthorizationBindingV1,
    supplied: ExternalActionExecutionAuthorizationBindingV1): boolean {
    return !(
        binding.serverIdentityId !== supplied.serverIdentityId
        || binding.accountId !== supplied.accountId
        || binding.custodianAccountId !== supplied.custodianAccountId
        || binding.installationId !== supplied.installationId
        || ('authentication' in binding
            ? !('authentication' in supplied) || JSON.stringify(binding.authentication) !== JSON.stringify(supplied.authentication)
            : !('credentialId' in supplied) || binding.principalId !== supplied.principalId || binding.credentialId !== supplied.credentialId)
        || binding.machineId !== supplied.machineId
        || binding.actionId !== supplied.actionId
        || binding.requestId !== supplied.requestId
        || binding.requestEnvelopeDigest !== supplied.requestEnvelopeDigest
        || binding.automationId !== supplied.automationId
        || binding.idempotencyKey !== supplied.idempotencyKey
        || binding.accountEncryptionMode !== supplied.accountEncryptionMode
        || !sameManagedInput(binding.managedContinuation, supplied.managedContinuation)
        || !sameManagedInput(binding.managedAdmission, supplied.managedAdmission)
        || !sameManagedInput(binding.managedAccountExecutor, supplied.managedAccountExecutor)
        || !sameManagedInput(binding.handoffAdmission, supplied.handoffAdmission)
        || !sameManagedInput(binding.handoffContinuation, supplied.handoffContinuation)
        || !sameManagedInput(binding.handoffPreflight, supplied.handoffPreflight)
        || !sameManagedInput(binding.sessionActionOrigin, supplied.sessionActionOrigin)
        || !sameManagedInput(binding.sessionActionSource, supplied.sessionActionSource)
        || !sameManagedInput(binding.workflowActionOrigin, supplied.workflowActionOrigin)
        || ('grant' in binding && (!('grant' in supplied) || !sameManagedInput(binding.grant, supplied.grant)))
        || encodeExternalActionResolvedTargetV1(binding.target) !== encodeExternalActionResolvedTargetV1(supplied.target)
    );
}

/** The installed writer proves transport; only this issuer/currentness owner proves the retained handoff root. */
export async function verifyWorkspaceSyncHandoffSourceAuthorization(
    authorization: ExternalActionExecutionAuthorizationV1,
    routing: WorkspaceSyncSourceRoutingV1,
    resolveCurrentSessionMachine?: ExternalActionExecutionRequestProof['resolveCurrentSessionMachine'],
): Promise<VerifiedExternalActionExecutionRequest | null> {
    const binding = await auth.verifyExternalActionExecutionAuthorization(authorization.token);
    const context = routing.sourceContext;
    const claimed = context?.machineAdmission;
    if (!binding || !matchesExternalActionAuthorizationBinding(binding, authorization.binding)
        || binding.actionId !== 'session.handoff' || binding.handoffContinuation || binding.handoffPreflight || !binding.handoffAdmission
        || routing.originalActionEnvelope || !context || !claimed
        || binding.serverIdentityId !== await getOrCreateServerIdentityId()
        || routing.accountServerId !== binding.serverIdentityId
        || routing.operationId !== binding.requestId
        || routing.sourceMachineId !== binding.handoffAdmission.sourceMachineId
        || routing.sourceSessionId !== binding.handoffAdmission.sessionId
        || binding.machineId !== routing.sourceMachineId
        || binding.installationId !== binding.handoffAdmission.sourceInstallationId
        || claimed.machineId !== binding.machineId || claimed.installationId !== binding.installationId
        || claimed.actorAccountId !== binding.accountId || claimed.custodianAccountId !== binding.custodianAccountId
        || !sameManagedInput(context.sessionActionOrigin, binding.sessionActionOrigin)
        || ('grant' in binding && !sameManagedInput(context.callerInputConstraints,
            { models: binding.grant.models, permissionModes: binding.grant.permissionModes }))) return null;
    return readCurrentWorkspaceSyncSourceAuthorization(binding, routing, resolveCurrentSessionMachine);
}

/** Both source purposes retain the issuer's principal and independently recheck logical Source access. */
async function readCurrentWorkspaceSyncSourceAuthorization(binding: ExternalActionExecutionAuthorizationBindingV1,
    routing: WorkspaceSyncSourceRoutingV1,
    resolveCurrentSessionMachine?: ExternalActionExecutionRequestProof['resolveCurrentSessionMachine']): Promise<VerifiedExternalActionExecutionRequest | null> {
    const context = routing.sourceContext;
    const claimed = context?.machineAdmission;
    const action = PublicActionIdSchema.safeParse(binding.actionId);
    if (!action.success || !context || !claimed || claimed.machineId !== routing.sourceMachineId || claimed.actorAccountId !== binding.accountId
        || !sameManagedInput(context.sessionActionOrigin, binding.sessionActionOrigin)
        || ('grant' in binding && !sameManagedInput(context.callerInputConstraints,
            { models: binding.grant.models, permissionModes: binding.grant.permissionModes }))) return null;
    const current = await verifyCurrentExternalActionPrincipal(binding);
    const principal = current && projectVerifiedExternalActionBoundPrincipal(binding, current);
    if (!principal || narrowCredentialAuthority(principal.authority, context.callerAuthority) !== context.callerAuthority
        || !await hasCurrentExecutionMachineAdmission(binding)
        || !resolveCredentialActionAdmissionV1({ spec: getActionSpec(action.data), authority: context.callerAuthority,
            grant: 'grant' in binding ? binding.grant : null }).ok) return null;
    if (binding.sessionActionOrigin && ((context.callerPermissionMode != null
        && context.callerPermissionMode !== binding.sessionActionOrigin.callerPermissionMode)
        || (context.causalPermissionAuthority != null
            && !sameManagedInput(context.causalPermissionAuthority, binding.sessionActionOrigin.causalPermissionAuthority))
        || context.workspaceWrites !== binding.sessionActionOrigin.workspaceWrites)) return null;
    const source = await resolveMachineAdmission({ actorAccountId: binding.accountId, machineId: routing.sourceMachineId, requiredRole: claimed.role });
    if (source.kind !== 'admitted' || source.custodianAccountId !== claimed.custodianAccountId
        || source.installationId !== claimed.installationId || source.encryptionMode !== claimed.encryptionMode) return null;
    if (!await hasCurrentExternalActionSessionSource(binding, resolveCurrentSessionMachine)) return null;
    return { binding, principal, effectiveAuthority: context.callerAuthority, effectActionId: binding.actionId, target: binding.target };
}

/** Only an installed D proof or its retained original packet can attest this exact Project purpose. */
export async function readCurrentWorkspaceSyncProjectSourceAuthorization(
    authorization: ExternalActionExecutionAuthorizationV1,
    routing: WorkspaceSyncSourceRoutingV1,
    writerMachineId: string,
    resolveCurrentSessionMachine?: ExternalActionExecutionRequestProof['resolveCurrentSessionMachine'],
): Promise<Readonly<{ verified: VerifiedExternalActionExecutionRequest;
    route: Pick<NonNullable<Awaited<ReturnType<typeof readMachineDevcontainerWorkspaceSyncRouteInTx>>>,
        'parentMachineId' | 'parentInstallationId' | 'custodianAccountId'> }> | null> {
    const binding = await auth.verifyExternalActionExecutionAuthorization(authorization.token);
    const envelope = routing.originalActionEnvelope;
    if (!binding || !matchesExternalActionAuthorizationBinding(binding, authorization.binding)
        || !readWorkspaceSyncProjectSourceMethod(binding.actionId) || binding.handoffAdmission || binding.handoffContinuation || binding.handoffPreflight
        || routing.phase !== 'prepare' || routing.sourceSessionId !== undefined || !envelope
        || binding.serverIdentityId !== await getOrCreateServerIdentityId() || routing.accountServerId !== binding.serverIdentityId
        || !isExternalActionAuthorizationBoundToEnvelope(binding, { actionId: binding.actionId, machineId: binding.machineId, envelope })) return null;
    const verified = await readCurrentWorkspaceSyncSourceAuthorization(binding, routing, resolveCurrentSessionMachine);
    if (!verified) return null;
    if (envelope.v === 1 && !matchesWorkspaceSyncProjectSourceInput(envelope.input, binding, routing)) return null;
    const route = await readMachineDevcontainerWorkspaceSyncRouteInTx(db, { accountServerId: routing.accountServerId,
        childMachineId: routing.sourceMachineId, childRootPath: routing.sourceRootPath,
        parentMachineId: writerMachineId, releaseOnly: false });
    if (route) return await hasCurrentExternalActionSessionSource(binding, resolveCurrentSessionMachine) ? { verified, route } : null;
    if (binding.actionId === 'projects.open') return null;
    // Finite preparation can run at an independently shared hub. The original
    // worker attests the selected controller; its receiver proves the current
    // topology. Home independently requires requester access to this controller.
    const controller = await resolveMachineAdmission({ actorAccountId: binding.accountId,
        machineId: writerMachineId, requiredRole: 'use' });
    return controller.kind === 'admitted' && await hasCurrentExternalActionSessionSource(binding, resolveCurrentSessionMachine)
        ? { verified, route: { parentMachineId: controller.machineId, parentInstallationId: controller.installationId,
            custodianAccountId: controller.custodianAccountId } } : null;
}

function readWorkspaceSyncProjectSourceMethod(actionId: string): string | null {
    return actionId === 'projects.open' ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN
        : isProjectWorkspaceSyncPreparationActionV1(actionId)
            ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN : null;
}

function matchesWorkspaceSyncProjectSourceInput(value: unknown,
    binding: ExternalActionExecutionAuthorizationBindingV1, routing: WorkspaceSyncSourceRoutingV1): boolean {
    const actionId = binding.actionId;
    if (actionId === 'projects.open') {
        const input = OpenProjectInputV1Schema.safeParse(value);
        return input.success && input.data.serverId === binding.serverIdentityId && input.data.machineId === binding.machineId
            && input.data.materialization.kind === 'sync' && (input.data.source.kind === 'workspace' || input.data.source.kind === 'source')
            && input.data.source.checkout?.machineId === routing.sourceMachineId && input.data.source.checkout.rootPath === routing.sourceRootPath;
    }
    if (!isProjectWorkspaceSyncPreparationActionV1(actionId)) return false;
    if (actionId === 'projects.service.relocate') {
        const input = ProjectServiceRelocateInputV1Schema.safeParse(value);
        return input.success && input.data.workspace.serverId === binding.serverIdentityId;
    }
    const input = actionId === 'localServices.launcher.start'
        ? DaemonLocalServiceLauncherStartRequestV1Schema.safeParse(value)
        : PROJECT_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(value);
    return input.success && !!input.data.workspace && input.data.workspace.serverId === binding.serverIdentityId
        && input.data.workspace.machineId === routing.sourceMachineId && input.data.workspace.rootPath === routing.sourceRootPath;
}

/** The current installed D's original packet attests verified decryption; P1 never signs as D. */
export async function verifyWorkspaceSyncProjectSourceAuthorization(
    authorization: ExternalActionExecutionAuthorizationV1, routing: WorkspaceSyncSourceRoutingV1,
    execution: WorkspaceSyncSourceExecutionV1,
    resolveCurrentSessionMachine?: ExternalActionExecutionRequestProof['resolveCurrentSessionMachine'],
): Promise<Awaited<ReturnType<typeof readCurrentWorkspaceSyncProjectSourceAuthorization>>> {
    const method = readWorkspaceSyncProjectSourceMethod(authorization.binding.actionId);
    if (!method) return null;
    const suffix = `:${method}`;
    if (!execution.method.endsWith(suffix)) return null;
    const admitted = await readCurrentWorkspaceSyncProjectSourceAuthorization(authorization, routing,
        execution.method.slice(0, -suffix.length), resolveCurrentSessionMachine);
    if (!admitted) return null;
    const { binding } = admitted.verified;
    const actionId = binding.actionId;
    const envelope = routing.originalActionEnvelope;
    const packet = execution.externalActionExecution;
    if (!envelope || packet.authorization.token !== authorization.token
        || !matchesExternalActionAuthorizationBinding(binding, packet.authorization.binding)
        || packet.effectActionId !== binding.actionId || packet.installationId !== binding.installationId
        || encodeExternalActionResolvedTargetV1(packet.target) !== encodeExternalActionResolvedTargetV1(binding.target)) return null;
    // Plain decoded packets can also be checked against their canonical input.
    // For opaque transport params, the same installed D signature binds the
    // unchanged envelope and exact Source facts after D's verified decryption.
    if (typeof execution.params !== 'string') {
        if (binding.actionId === 'projects.open') {
            if (!matchesWorkspaceSyncProjectSourceInput(execution.params, binding, routing)
                || envelope.v === 1 && !sameManagedInput(envelope.input, execution.params)) return null;
        } else {
            const request = WorkspaceSyncPrepareBetweenRequestV1Schema.safeParse(execution.params);
            if (!request.success) return null;
            if (envelope.v === 1 && binding.actionId === 'projects.service.relocate') {
                const input = ProjectServiceRelocateInputV1Schema.safeParse(envelope.input);
                if (!input.success || request.data.sourceWorkspaceRefId !== input.data.workspace.refId) return null;
            }
            if (envelope.v === 1 && isProjectWorkspaceSyncPreparationActionV1(actionId)
                && actionId !== 'projects.service.relocate') {
                const input = actionId === 'localServices.launcher.start'
                    ? DaemonLocalServiceLauncherStartRequestV1Schema.safeParse(envelope.input)
                    : PROJECT_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(envelope.input);
                if (!input.success || !input.data.workspace || request.data.sourceWorkspaceRefId !== input.data.workspace.workspaceId) return null;
            }
        }
    }
    const rootMachine = await db.machine.findUnique({ where: { id: binding.machineId } });
    if (!rootMachine?.installationPublicKey || rootMachine.installationId !== binding.installationId
        || classifyMachineAvailabilityState(rootMachine) !== 'available'
        || !verifyExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
            requesterAccountContext: packet.authorization.requesterAccountContext,
            effectActionId: packet.effectActionId, target: packet.target, installationId: packet.installationId,
            event: SOCKET_RPC_EVENTS.CALL, method: execution.method, requestId: execution.requestId,
            ...(execution.params === undefined ? {} : { params: execution.params }), workspaceSyncSourceRouting: routing,
            publicKey: rootMachine.installationPublicKey, signature: packet.machineSignature })) return null;
    return await hasCurrentExternalActionSessionSource(binding, resolveCurrentSessionMachine) ? admitted : null;
}

/** One currentness decision for the original handoff's installed source writer and chosen target. */
export async function readCurrentWorkspaceSyncHandoffWriterTarget(
    authorization: ExternalActionExecutionAuthorizationV1,
    routing: WorkspaceSyncSourceWriterTargetRoutingV1,
    resolveCurrentSessionMachine?: ExternalActionExecutionRequestProof['resolveCurrentSessionMachine'],
    targetReceiver?: Readonly<{ routing: WorkspaceSyncTargetRoutingV1; machineId?: string }>,
    sourceExecution?: WorkspaceSyncSourceExecutionV1,
): Promise<Readonly<{ verified: VerifiedExternalActionExecutionRequest;
    writer: Extract<Awaited<ReturnType<typeof resolveMachineAdmission>>, { kind: 'admitted' }>;
    target: Extract<Awaited<ReturnType<typeof resolveMachineAdmission>>, { kind: 'admitted' }>;
    physicalTarget: NonNullable<Awaited<ReturnType<typeof readMachineDevcontainerWorkspaceSyncEndpointInTx>>>;
    targetRoute?: NonNullable<Awaited<ReturnType<typeof readMachineDevcontainerWorkspaceSyncRouteInTx>>> }> | null> {
    if (routing.target.phase === 'release') return null;
    const project = authorization.binding.actionId === 'projects.open';
    const projectSource = project && sourceExecution
        ? await verifyWorkspaceSyncProjectSourceAuthorization(authorization, routing.source, sourceExecution, resolveCurrentSessionMachine) : null;
    const verified = project ? projectSource?.verified
        : !sourceExecution && await verifyWorkspaceSyncHandoffSourceAuthorization(authorization, routing.source, resolveCurrentSessionMachine);
    if (!verified || (project ? verified.binding.machineId : verified.binding.handoffAdmission?.targetMachineId) !== routing.target.targetMachineId) return null;
    const originalEnvelope = routing.source.originalActionEnvelope;
    if (project && (originalEnvelope?.v === 1 || sourceExecution && typeof sourceExecution.params !== 'string')) {
        // A readable original Root remains authoritative even when the installed
        // SOURCE packet is sealed. V2 decryption belongs to the actual D owner.
        const input = OpenProjectInputV1Schema.safeParse(originalEnvelope?.v === 1 ? originalEnvelope.input : sourceExecution?.params);
        if (!input.success || input.data.materialization.kind !== 'sync'
            || input.data.materialization.targetPath !== routing.target.targetRootPath) return null;
    }
    const writer = await resolveMachineAdmission({ actorAccountId: routing.source.sourceContext.machineAdmission.custodianAccountId,
        machineId: routing.sourceWriter.machineId, requiredRole: 'manage' });
    if (writer.kind !== 'admitted' || writer.installationId !== routing.sourceWriter.installationId) return null;
    if (routing.sourceWriter.machineId !== routing.source.sourceMachineId) {
        const route = await readMachineDevcontainerWorkspaceSyncRouteInTx(db, { accountServerId: routing.source.accountServerId,
            childMachineId: routing.source.sourceMachineId, childRootPath: routing.source.sourceRootPath,
            parentMachineId: writer.machineId, releaseOnly: false });
        if (!route || route.parentInstallationId !== writer.installationId) return null;
    } else if (writer.installationId !== routing.source.sourceContext.machineAdmission.installationId) return null;
    const target = await resolveMachineAdmission({ actorAccountId: verified.binding.accountId,
        machineId: routing.target.targetMachineId, requiredRole: 'use' });
    if (target.kind !== 'admitted' || target.installationId !== (project
        ? verified.binding.installationId : verified.binding.handoffAdmission?.targetInstallationId)) return null;
    const physicalTarget = await readMachineDevcontainerWorkspaceSyncEndpointInTx(db, { accountServerId: routing.target.accountServerId,
        machineId: target.machineId, rootPath: routing.target.targetRootPath });
    if (!physicalTarget) return null;
    let targetRoute: NonNullable<Awaited<ReturnType<typeof readMachineDevcontainerWorkspaceSyncRouteInTx>>> | undefined;
    if (targetReceiver) {
        const { targetContext, ...phase } = targetReceiver.routing;
        const { kind: _kind, ...targetAdmission } = target;
        if (!sameManagedInput(phase, routing.target) || !sameManagedInput(targetContext.machineAdmission, targetAdmission)
            || !sameManagedInput({ ...targetContext, machineAdmission: routing.source.sourceContext.machineAdmission }, routing.source.sourceContext)) return null;
        if (targetReceiver.machineId !== undefined && physicalTarget.machineId !== targetReceiver.machineId) return null;
        if (physicalTarget.machineId !== target.machineId) targetRoute = { custodianAccountId: physicalTarget.custodianAccountId,
            parentMachineId: physicalTarget.machineId, parentInstallationId: physicalTarget.installationId };
    }
    if (!await hasCurrentExternalActionSessionSource(verified.binding, resolveCurrentSessionMachine)) return null;
    return { verified, writer, target, physicalTarget, ...(targetRoute ? { targetRoute } : {}) };
}

/** Seed transport spends only the same admitted Project prepare; the source fence owns export effects. */
export async function readCurrentWorkspaceSyncSeedAuthorization(
    authorization: ExternalActionExecutionAuthorizationV1, routing: WorkspaceSyncSeedRoutingV1,
    execution: WorkspaceSyncSourceExecutionV1,
    resolveCurrentSessionMachine?: ExternalActionExecutionRequestProof['resolveCurrentSessionMachine'],
): Promise<Awaited<ReturnType<typeof readCurrentWorkspaceSyncHandoffWriterTarget>>> {
    if (authorization.binding.actionId !== 'projects.open' || routing.target.phase !== 'prepare') return null;
    return readCurrentWorkspaceSyncHandoffWriterTarget(authorization, routing.sourceWriterTarget, resolveCurrentSessionMachine,
        { routing: routing.target }, execution);
}

export async function verifyExternalActionMachineRpcExecution(
    execution: ExternalActionMachineRpcExecutionV1,
    request: Readonly<{ method: string; requestId?: string; params?: unknown; event?: ExternalActionMachineRpcEventV1;
        workspaceSyncSourceRouting?: WorkspaceSyncSourceRoutingV1;
        workspaceSyncSourceWriterTargetRouting?: WorkspaceSyncSourceWriterTargetRoutingV1;
        workspaceSyncTargetRouting?: WorkspaceSyncTargetRoutingV1;
        workspaceSyncSourceExecution?: WorkspaceSyncSourceExecutionV1;
        workspaceSyncSeedRouting?: WorkspaceSyncSeedRoutingV1;
        originalActionEnvelope?: ExternalActionRequestEnvelope;
        resolveCurrentSessionMachine?: ExternalActionExecutionRequestProof['resolveCurrentSessionMachine'] }>,
): Promise<VerifiedExternalActionExecutionRequest | null> {
    if (!request.requestId) return null;
    const binding = await auth.verifyExternalActionExecutionAuthorization(execution.authorization.token);
    if (!binding || binding.serverIdentityId !== await getOrCreateServerIdentityId()
        || !await hasCurrentExternalActionSessionSource(binding, request.resolveCurrentSessionMachine)
        || !matchesExternalActionAuthorizationBinding(binding, execution.authorization.binding)
        || !isExternalActionResolvedTargetAllowedV1({ authorizedTarget: binding.target,
            resolvedTarget: execution.target, selectedMachineId: binding.machineId })) return null;

    if ((binding.actionId === 'projects.service.relocate' || binding.actionId === 'discussion.second_opinion.start') && request.originalActionEnvelope) {
        const envelope = ExternalActionRequestEnvelopeSchema.safeParse(request.originalActionEnvelope);
        const separator = request.method.indexOf(':');
        const machineId = request.method.slice(0, separator);
        const opinionChild = binding.actionId === 'discussion.second_opinion.start';
        const effect = opinionChild ? isDiscussionSecondOpinionModelRpcMethodV1(request.method.slice(separator + 1)) ? 'session.spawn_new' : null
            : readProjectServiceMoveChildEffectV1(request.method.slice(separator + 1));
        if (!envelope.success || separator < 1 || effect !== execution.effectActionId
            || request.event !== undefined && request.event !== SOCKET_RPC_EVENTS.CALL
            || request.workspaceSyncSourceRouting || request.workspaceSyncTargetRouting || request.workspaceSyncSourceWriterTargetRouting
            || request.workspaceSyncSeedRouting || request.workspaceSyncSourceExecution
            || execution.installationId !== binding.installationId
            || !isExternalActionAuthorizationBoundToEnvelope(binding, { actionId: binding.actionId,
                machineId: binding.machineId, envelope: envelope.data })
            || !opinionChild && envelope.data.v === 1 && readProjectServiceMoveChildMachineV1(envelope.data.input, effect) !== machineId
            || !opinionChild && envelope.data.v === 1 && typeof request.params !== 'string'
                && !isProjectServiceMoveChildInputV1(envelope.data.input, effect, machineId, request.params)) return null;
        if (opinionChild && envelope.data.v === 1 && typeof request.params !== 'string') {
            const wrapper = TargetedActionRpcRequestV1Schema.safeParse(request.params);
            const derived = readDiscussionSecondOpinionModelChildV1(envelope.data.input, machineId,
                wrapper.success ? wrapper.data.input : request.params, request.method.slice(separator + 1));
            if (!derived) return null;
            const discussion = derived.spawn ? null : await db.discussion.findUnique({ where: {
                createdByAccountId_creationLocalId: { createdByAccountId: binding.accountId, creationLocalId: derived.root.retry.creationLocalId } }, select: { id: true } });
            const ref = derived.spawn?.discussionParticipant ?? (discussion ? { discussionId: discussion.id,
                participantSlotId: derived.reviewer.participantSlotId! } : null);
            if (!ref) return null;
            const slot = await db.discussionParticipant.findUnique({ where: { discussionId_participantSlotId: ref },
                include: { discussion: { select: { ownerAccountId: true, creationLocalId: true, archivedAt: true } } } });
            if (!slot || slot.removedAt || slot.answerPolicy !== 'when_addressed'
                || slot.discussion.archivedAt || slot.discussion.ownerAccountId !== binding.accountId
                || slot.discussion.creationLocalId !== derived.root.retry.creationLocalId
                || !sameStrictJsonValue(slot.modelLaunch, derived.launch)) return null;
        }
        const machine = await db.machine.findUnique({ where: { id: binding.machineId } });
        const destination = await resolveMachineAdmission({ actorAccountId: binding.accountId, machineId, requiredRole: 'use' });
        const current = await verifyCurrentExternalActionPrincipal(binding);
        const principal = current && projectVerifiedExternalActionBoundPrincipal(binding, current);
        if (!machine?.installationPublicKey || machine.installationId !== binding.installationId
            || classifyMachineAvailabilityState(machine) !== 'available' || destination.kind !== 'admitted'
            || !principal || !await hasCurrentExecutionMachineAdmission(binding)
            || !resolveCredentialActionAdmissionV1({ spec: getActionSpec(binding.actionId), authority: principal.authority,
                grant: 'grant' in binding ? binding.grant : null }).ok
            || !verifyExternalActionMachineRpcRequestV1({ authorizationToken: execution.authorization.token,
                requesterAccountContext: execution.authorization.requesterAccountContext, effectActionId: execution.effectActionId,
                target: execution.target, installationId: execution.installationId, event: request.event ?? SOCKET_RPC_EVENTS.CALL,
                method: request.method, requestId: request.requestId, ...(request.params === undefined ? {} : { params: request.params }),
                publicKey: machine.installationPublicKey, signature: execution.machineSignature })) return null;
        // Opaque original/child input is opened and compared by the admitted receiver;
        // the SOURCE signature attests derivation, never permission on the destination.
        const finalDestination = await resolveMachineAdmission({ actorAccountId: binding.accountId, machineId, requiredRole: 'use' });
        if (finalDestination.kind !== 'admitted' || finalDestination.installationId !== destination.installationId
            || !await hasCurrentExecutionMachineAdmission(binding) || !await readCurrentExternalActionPrincipal(binding, db)) return null;
        return { binding, effectActionId: effect, target: execution.target, principal, effectiveAuthority: principal.authority };
    }

    if (request.workspaceSyncSeedRouting) {
        if (!request.workspaceSyncSourceExecution || request.workspaceSyncSourceRouting
            || request.workspaceSyncSourceWriterTargetRouting || request.workspaceSyncTargetRouting
            || execution.effectActionId !== 'projects.open' || request.event !== undefined && request.event !== SOCKET_RPC_EVENTS.CALL) return null;
        const admitted = await readCurrentWorkspaceSyncSeedAuthorization(execution.authorization, request.workspaceSyncSeedRouting,
            request.workspaceSyncSourceExecution, request.resolveCurrentSessionMachine);
        const route = admitted?.physicalTarget;
        if (!admitted || !route || request.method !== `${admitted.writer.machineId}:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`
            || execution.installationId !== route.installationId) return null;
        const signer = await db.machine.findUnique({ where: { id: route.machineId }, select: { installationPublicKey: true } });
        if (!signer?.installationPublicKey || !verifyExternalActionMachineRpcRequestV1({ authorizationToken: execution.authorization.token,
            requesterAccountContext: execution.authorization.requesterAccountContext,
            effectActionId: execution.effectActionId, target: execution.target, installationId: execution.installationId,
            event: request.event ?? SOCKET_RPC_EVENTS.CALL, method: request.method, requestId: request.requestId,
            ...(request.params === undefined ? {} : { params: request.params }), workspaceSyncSeedRouting: request.workspaceSyncSeedRouting,
            publicKey: signer.installationPublicKey, signature: execution.machineSignature })) return null;
        return await hasCurrentExternalActionSessionSource(admitted.verified.binding, request.resolveCurrentSessionMachine) ? admitted.verified : null;
    }

    if (request.workspaceSyncSourceRouting?.originalActionEnvelope) {
        if (request.workspaceSyncSourceWriterTargetRouting
            || request.event !== undefined && request.event !== SOCKET_RPC_EVENTS.CALL) return null;
        const parsed = WorkspaceSyncSourceExecutionV1Schema.safeParse({
            method: request.method, requestId: request.requestId,
            ...(request.params === undefined ? {} : { params: request.params }), externalActionExecution: execution });
        return parsed.success ? (await verifyWorkspaceSyncProjectSourceAuthorization(execution.authorization,
            request.workspaceSyncSourceRouting, parsed.data, request.resolveCurrentSessionMachine))?.verified ?? null : null;
    }

    if (request.workspaceSyncSourceWriterTargetRouting) {
        const routing = request.workspaceSyncSourceWriterTargetRouting;
        const admitted = await readCurrentWorkspaceSyncHandoffWriterTarget(execution.authorization, routing, request.resolveCurrentSessionMachine,
            request.workspaceSyncTargetRouting ? { routing: request.workspaceSyncTargetRouting,
                machineId: request.method.slice(0, request.method.indexOf(':')) } : undefined, request.workspaceSyncSourceExecution);
        const phaseMethod = routing.target.phase === 'preflight' ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT
            : routing.target.phase === 'prepare' ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE : null;
        if (!admitted || execution.effectActionId !== admitted.verified.effectActionId || !phaseMethod
            || request.method !== `${admitted.targetRoute?.parentMachineId ?? routing.target.targetMachineId}:${phaseMethod}`) return null;
        const signer = request.workspaceSyncTargetRouting ? admitted.target : admitted.writer;
        if (execution.installationId !== signer.installationId) return null;
        const writer = await db.machine.findUnique({ where: { id: signer.machineId }, select: { installationPublicKey: true } });
        if (!writer?.installationPublicKey || !verifyExternalActionMachineRpcRequestV1({
            authorizationToken: execution.authorization.token, effectActionId: execution.effectActionId, target: execution.target,
            requesterAccountContext: execution.authorization.requesterAccountContext,
            installationId: execution.installationId, event: request.event ?? SOCKET_RPC_EVENTS.CALL,
            method: request.method, requestId: request.requestId, ...(request.params === undefined ? {} : { params: request.params }),
            workspaceSyncSourceWriterTargetRouting: routing, publicKey: writer.installationPublicKey,
            signature: execution.machineSignature })) return null;
        if (!await hasCurrentExternalActionSessionSource(admitted.verified.binding, request.resolveCurrentSessionMachine)) return null;
        return admitted.verified;
    }

    const isTransitionRoot = binding.actionId === 'session.agent.transition';
    const transitionPurpose = isTransitionRoot && isSessionAgentTransitionRpcPurpose(binding, execution, request);
    if (isTransitionRoot && !transitionPurpose) return null;
    const effect = parseExternalActionEffectAction(binding, execution.effectActionId);
    if (!effect.success || !hasMatchingExecutionEffectFamily(binding.actionId, execution.effectActionId)
        || (binding.handoffContinuation || binding.handoffPreflight) && binding.actionId !== execution.effectActionId) return null;
    const guestMethod = [MANAGED_ACTIVITY_READ_RPC_METHOD, MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD]
        .find(method => request.method.endsWith(`:${method}`));
    const guestTarget = guestMethod === MANAGED_ACTIVITY_READ_RPC_METHOD
        ? ManagedActivityReadRequestV1Schema.safeParse(request.params)
        : guestMethod === MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD
            ? ManagedAdmissionDrainConfirmRequestV1Schema.safeParse(request.params) : null;
    const guestMachineId = guestMethod ? request.method.slice(0, -(guestMethod.length + 1)) : null;
    const encryptedGuestParams = typeof request.params === 'string';
    const managedGuestActivity = guestMachineId && (guestTarget?.success || encryptedGuestParams)
        ? await readCurrentManagedGuestActivityInTx(db, binding, guestMachineId, guestTarget?.success ? guestTarget.data : undefined) : null;
    // Home cannot open encrypted payloads. The signed root identifies the
    // exact retained current row; the guest decrypts and validates its target
    // revision/controller before observing activity or beginning a drain.
    if (guestMethod && encryptedGuestParams && managedGuestActivity?.encryptionMode !== 'e2ee') return null;
    // A managed root's ordinary RPC phases stay on its selected controller.
    // Only the proved private guest phase may cross that target boundary.
    if (ManagedMachineActionIdV1Schema.safeParse(binding.actionId).success
        && (guestMethod && !managedGuestActivity || !request.method.startsWith(`${binding.machineId}:`) && !managedGuestActivity)) return null;
    if ('authentication' in binding || binding.handoffContinuation || binding.handoffPreflight) {
        const workflowSessionTarget = binding.workflowActionOrigin && binding.target.kind === 'session' ? binding.target : null;
        const prefix = `${workflowSessionTarget?.sessionId ?? binding.machineId}:`;
        const method = managedGuestActivity && guestMethod ? guestMethod
            : request.method.startsWith(prefix) ? request.method.slice(prefix.length) : request.method;
        // Pending admission has its own signed socket event, not a Machine RPC
        // method. Preserve both existing epochs and their exact carrier name.
        const pendingEvent = request.event === SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1
            || request.event === SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2;
        const effectActionId = workflowSessionTarget
            ? request.method.startsWith(prefix) && (method === binding.actionId
                || binding.actionId === 'session.roles.apply_to_reports' && method === SESSION_RPC_METHODS.SESSION_ROLES_CONFIGURATION_SET)
                ? binding.actionId : null
            : pendingEvent
            ? request.method === request.event ? 'session.message.send' : null
            : resolveMachineRpcExternalActionEffectV1(method, binding);
        if (!transitionPurpose && (binding.actionId !== execution.effectActionId
                && !isSessionArchiveStopEffect(binding.actionId, execution.effectActionId)
            || effectActionId !== execution.effectActionId)) return null;
    }
    // Home proves the original Session or accepted handoff source. RPC effects
    // cannot substitute the destination signer for that original authority.
    const requiresSource = !managedGuestActivity && Boolean(binding.handoffContinuation || binding.handoffPreflight
        || 'authentication' in binding && binding.sessionActionOrigin);
    const sourceKey = requiresSource ? await readCurrentExternalActionSourceSigningPublicKey(binding) : null;
    if (requiresSource && !sourceKey) return null;
    const machine = await db.machine.findFirst({
        where: { id: binding.machineId, accountId: binding.custodianAccountId, installationId: binding.installationId },
        select: {
            accountId: true,
            kind: true,
            revokedAt: true,
            replacedByMachineId: true,
            installationId: true,
            installationPublicKey: true,
        },
    });
    const signingPublicKey = requiresSource ? sourceKey : machine?.installationPublicKey;
    if (
        !machine
        || classifyMachineAvailabilityState(machine) !== "available"
        || machine.installationId !== execution.installationId
        || binding.installationId !== execution.installationId
        || !signingPublicKey
        || !await hasCurrentExecutionMachineAdmission(binding, machine)
        || !verifyExternalActionMachineRpcRequestV1({
            authorizationToken: execution.authorization.token,
            requesterAccountContext: execution.authorization.requesterAccountContext,
            effectActionId: execution.effectActionId,
            target: execution.target,
            installationId: execution.installationId,
            event: request.event ?? SOCKET_RPC_EVENTS.CALL,
            method: request.method,
            requestId: request.requestId,
            ...(request.params === undefined ? {} : { params: request.params }),
            publicKey: signingPublicKey,
            signature: execution.machineSignature,
        })
    ) return null;
    const currentPrincipal = await verifyCurrentExternalActionPrincipal(binding);
    const principal = currentPrincipal && projectVerifiedExternalActionBoundPrincipal(binding, currentPrincipal);
    if (!principal || !await hasCurrentExternalActionSessionSource(binding, request.resolveCurrentSessionMachine)) return null;
    const credentialAction = isTransitionRoot ? parseExternalActionEffectAction(binding, binding.actionId) : binding.handoffContinuation
        ? PublicActionIdSchema.safeParse(readExternalActionCredentialActionId(binding)) : effect;
    if (!credentialAction.success || !await readCurrentExternalActionPrincipal(binding, db)
        || !await hasCurrentExecutionMachineAdmission(binding)
        || !resolveCredentialActionAdmissionV1({ spec: getActionSpec(credentialAction.data),
            authority: principal.authority, grant: 'grant' in binding ? binding.grant : null }).ok) return null;
    // Run the full derived guest scope last, after all other asynchronous
    // credential/source/controller work, including at the forwarding preIO guard.
    if (managedGuestActivity && (!guestMachineId || !guestTarget?.success && !encryptedGuestParams
        || !sameManagedInput(managedGuestActivity, await readCurrentManagedGuestActivityInTx(db, binding, guestMachineId,
            guestTarget?.success ? guestTarget.data : undefined)))) return null;
    return { binding, effectActionId: execution.effectActionId, target: execution.target, principal, effectiveAuthority: principal.authority,
        ...(managedGuestActivity ? { managedGuestActivity } : {}) };
}

export async function verifyExternalActionExecutionAuthorizationCurrentness(
    proof: ExternalActionExecutionRequestProof & Readonly<{ outerActionId: string }>,
): Promise<VerifiedExternalActionExecutionRequest | null> {
    const verified = await verifyCommon(proof);
    if (!verified) return null;
    if (verified.binding.actionId !== proof.outerActionId) return refuseExternalActionExecutionRequest('outer_action');
    if (
        proof.method.toUpperCase() !== "POST"
        || proof.path !== bindExternalActionExecutionAuthorizationVerifyHttpPathV1(proof.outerActionId)
    ) {
        return refuseExternalActionExecutionRequest('verification_purpose');
    }
    const effect = parseExternalActionEffectAction(verified.binding, verified.effectActionId);
    const credentialAction = verified.binding.handoffContinuation
        ? PublicActionIdSchema.safeParse(readExternalActionCredentialActionId(verified.binding)) : effect;
    if (!effect.success || !credentialAction.success || !resolveCredentialActionAdmissionV1({
        spec: getActionSpec(credentialAction.data),
        authority: verified.effectiveAuthority, grant: 'grant' in verified.binding ? verified.binding.grant : null,
        // This verifies the admitted proposal, not a native effect. Human
        // execution floors remain enforced by the domain and RPC owners.
        surface: readExternalActionSessionProposalSurface(verified.binding) }).ok) return refuseExternalActionExecutionRequest('credential_action_admission');
    return verified;
}
