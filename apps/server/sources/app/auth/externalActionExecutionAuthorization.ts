import {
    ExternalActionActionIdV1Schema,
    bindExternalActionExecutionAuthorizationVerifyHttpPathV1,
    bindExternalActionExecutionAuthorizationHttpPathV1,
    EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1,
    ExternalActionExecutionAuthorizationRequestV1Schema,
    ExternalActionExecutionAuthorizationVerifyRequestV1Schema,
    decodeExternalActionResolvedTargetV1,
    encodeExternalActionResolvedTargetV1,
    getActionSpec,
    isSettingsDeclarationActionIdV1,
    parseQualifiedPluginActionId,
    isExternalActionResolvedTargetAllowedV1,
    PublicActionIdSchema,
    SignedRootActionIdSchema,
    ActionIdSchema,
    MachineAccessActionIdSchema,
    verifyExternalActionMachineRpcRequestV1,
    verifyExternalActionMachineRequestV1,
    isExternalActionAuthorizationBoundToEnvelope,
    type ExternalActionExecutionAuthorizationBindingV1,
    type ExternalActionExecutionAuthorizationV1,
    type ExternalActionMachineRpcExecutionV1,
    type ExternalActionTargetV1,
    type ExternalActionMachineRpcEventV1,
    type ExternalActionServerPrincipalV1,
} from "@happier-dev/protocol/actions";
import { SOCKET_RPC_EVENTS, WorkspaceSyncSourceExecutionV1Schema, type WorkspaceSyncSourceRoutingV1, type WorkspaceSyncSourceWriterTargetRoutingV1,
    type WorkspaceSyncSourceExecutionV1, type WorkspaceSyncTargetRoutingV1, type WorkspaceSyncSeedRoutingV1 } from "@happier-dev/protocol/socketRpc";
import { OpenProjectInputV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { evaluateApiTokenGrantV1, isApiTokenGrantWithinV1, resolveCredentialActionAdmissionV1, ManagedMachineActionIdV1Schema,
    managedMachineActionEndpointPathV1, ManagedControllerReportV1Schema, ManagedControllerIntentReportV1Schema,
    type ManagedControllerReportV1, type ManagedControllerIntentReportV1, type AuthTokenAuthenticationEvidenceV1,
    decodeBase64, QualifiedConnectedServiceUsageSourceV4Schema, ProviderAccountUsageRecordIdSchema,
    parseQualifiedConnectedAccountV4StructuredQueryValue } from "@happier-dev/protocol";
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
import type { Tx } from "@/storage/inTx";
import { enforceLoginEligibility } from "./enforceLoginEligibility";
import { narrowCredentialAuthority } from './effectiveCredentialAuthority';
import { hasCurrentSessionActionRpcSourceBinding, hasCurrentSessionActionRpcSourceBindingInTx } from '@/app/api/socket/sessionScopedBinding';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { PROJECT_TRUST_ROUTE_V1, ProjectTrustMutationRequestV1Schema } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';
import { isRequesterProjectExecutionActionV1, PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';

import { auth, type VerifiedApiTokenPrincipal } from "./auth";
import { isAutomationOriginRunPublisherTx } from '@/app/automations/automationTriggerCauseChain';
import { QualifiedProviderAccountUsageHistoryRequestV4Schema } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { PendingResetStartsReadInputV1Schema } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { readExternalActionPendingResetStartPurpose } from './externalActionPendingResetStartPurpose';

export type VerifiedExternalActionPrincipal = VerifiedApiTokenPrincipal
    | (Extract<ExternalActionServerPrincipalV1, { authentication: unknown }>
        & Readonly<{ authenticationEvidence?: readonly AuthTokenAuthenticationEvidenceV1[] }>);

/** Original Account Project ingress still uses the canonical Action admission policy. */
export function isOriginalAccountProjectAction(actionId: string): boolean {
    return isRequesterProjectExecutionActionV1(actionId)
        || Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, actionId);
}
export function isOriginalAccountHandoffAction(actionId: string): boolean {
    return ActionIdSchema.safeParse(actionId).success
        && (actionId === 'session.handoff' || actionId.startsWith('session.handoff.'));
}

/** Interactive Account execution consumes the canonical signed-root catalog and declaration families. */
export function isOriginalAccountExecutionAction(actionId: string): boolean {
    const parsed = SignedRootActionIdSchema.safeParse(actionId);
    if (!parsed.success || parsed.data === 'session.spawn_new') return false;
    const spec = getActionSpec(parsed.data);
    return spec.executionPlacement === 'machine' || ManagedMachineActionIdV1Schema.safeParse(actionId).success
        || isOriginalAccountProjectAction(actionId) || isOriginalAccountHandoffAction(actionId)
        || isSettingsDeclarationActionIdV1(actionId)
        || actionId === 'connectedServices.quota.get'
        || actionId === 'session.pending.resetStart.set' || actionId === 'session.pending.resetStart.cancel'
        // The private approval owner reaches the exact daemon recorded by its
        // Account Artifact; native authority remains in that owner, not this reviewer.
        || spec.id === 'approval.request.decide';
}

/** Paired terminal roots retain automation authority and never invent a Session source. */
export function isOriginalTerminalExecutionAction(actionId: string,
    origin?: Pick<ExternalActionExecutionAuthorizationBindingV1, 'sessionActionOrigin' | 'sessionActionSource' | 'workflowActionOrigin'>): boolean {
    return Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, actionId)
        || (actionId === 'session.spawn_new' || isSettingsDeclarationActionIdV1(actionId))
            && !origin?.sessionActionOrigin && !origin?.sessionActionSource
            && !origin?.workflowActionOrigin
            && resolveCredentialActionAdmissionV1({ spec: getActionSpec(actionId), authority: 'account_automation', grant: null }).ok;
}

/** Admission follows the actual existing native effect's C41 policy. */
export function resolveExternalActionExecutionMachineAdmissionInTx(reader: Tx,
    input: Readonly<{ actorAccountId: string; machineId: string; actionId: string }>): ReturnType<typeof resolveMachineAdmissionInTx> {
    return resolveMachineAdmissionInTx(reader, { actorAccountId: input.actorAccountId, machineId: input.machineId,
        ...(input.actionId === 'approval.request.decide'
            ? { rpcMethod: RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED } : { actionId: input.actionId }) });
}

/** Existing host-private phases are effects of an accepted root, never public originators. */
function parseExternalActionEffectAction(binding: ExternalActionExecutionAuthorizationBindingV1, actionId: string) {
    return binding.handoffContinuation && binding.handoffAdmission && binding.actionId === actionId
        && isOriginalAccountHandoffAction(actionId)
        ? ActionIdSchema.safeParse(actionId)
        : 'authentication' in binding && binding.authentication.kind === 'account'
            ? SignedRootActionIdSchema.safeParse(actionId) : PublicActionIdSchema.safeParse(actionId);
}

/** Private phases spend only the original accepted handoff grant, never a fresh spawn grant. */
export function readExternalActionCredentialActionId(binding: ExternalActionExecutionAuthorizationBindingV1): string {
    return binding.handoffContinuation && binding.handoffAdmission
        && (isOriginalAccountHandoffAction(binding.actionId) || binding.actionId === 'session.spawn_new')
        ? 'session.handoff' : binding.actionId;
}

export { isExternalActionAuthorizationBoundToEnvelope };

/** Always project the signed root's immutable authority, never a later broader credential. */
export function projectExternalActionBoundPrincipal(binding: ExternalActionExecutionAuthorizationBindingV1,
    current: VerifiedExternalActionPrincipal): ExternalActionServerPrincipalV1 | null {
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
            : { accountId: binding.accountId, authentication: binding.authentication, authority: 'present_user' };
    }
    if ('authentication' in current) return null;
    return { accountId: binding.accountId, authority: 'account_automation', principalId: binding.principalId,
        credentialId: binding.credentialId, grant: binding.grant };
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
type ExternalActionVerificationPurpose = IssuedAcquireNativeFactPurpose | IssuedHandoffContinuationPurpose | IssuedIntentNativeFactPurpose;

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
            && (binding.actionId === 'machines.managed.delete' ? pending!.intent === 'delete' : pending!.intent === 'stop' || pending!.intent === 'start');
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

async function readCurrentExternalActionPrincipal(
    binding: ExternalActionExecutionAuthorizationBindingV1,
    reader: Tx,
    purpose?: ExternalActionVerificationPurpose,
): Promise<VerifiedExternalActionPrincipal | null> {
    if (purpose?.kind === 'issued-managed-acquire-native-fact'
        && !await isIssuedAcquireNativeFactReportInTx(reader, binding, purpose.report)) return null;
    if (purpose?.kind === 'issued-managed-intent-native-fact'
        && !await isIssuedIntentNativeFactReportInTx(reader, binding, purpose.report)) return null;
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
        if (binding.handoffAdmission && (binding.sessionActionSource.machineId !== binding.handoffAdmission.sourceMachineId
            || binding.sessionActionSource.installationId !== binding.handoffAdmission.sourceInstallationId)) return null;
    }
    if (binding.workflowActionOrigin && (!('authentication' in binding)
        || !ManagedMachineActionIdV1Schema.safeParse(binding.actionId).success
        || purpose?.kind !== 'issued-managed-intent-native-fact' && !await isAutomationOriginRunPublisherTx(reader, { accountId: binding.accountId, machineId: binding.machineId,
            runId: binding.workflowActionOrigin.runId, requireCurrentScopeEnd: true }))) return null;
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
        if (!isOriginalAccountExecutionAction(binding.actionId)
            && !(binding.authentication.kind === 'terminal' && isOriginalTerminalExecutionAction(binding.actionId, binding))
            && !(['session.spawn_new', 'machines.environment.apply'].includes(binding.actionId) && binding.managedContinuation)
            && !(binding.actionId === 'session.spawn_new' && binding.handoffContinuation)
            && !(binding.handoffContinuation && isOriginalAccountHandoffAction(binding.actionId))) return null;
        if (!await auth.isSignedCredentialCurrent(reader, binding.accountId, binding.authentication.tokenEpoch)) return null;
        const base = { accountId: binding.accountId, authentication: binding.authentication,
            ...(binding.authentication.evidence ? { authenticationEvidence: binding.authentication.evidence } : {}) };
        if (binding.workflowActionOrigin) return { ...base, authority: 'account_automation', workflowActionOrigin: binding.workflowActionOrigin };
        if (binding.authentication.kind === 'terminal') {
            if (!isOriginalTerminalExecutionAction(binding.actionId, binding)) return null;
            return { accountId: binding.accountId, authentication: binding.authentication, authority: 'account_automation',
                ...(binding.authentication.evidence ? { authenticationEvidence: binding.authentication.evidence } : {}),
                ...(binding.sessionActionOrigin ? { sessionActionOrigin: binding.sessionActionOrigin } : {}) };
        }
        const authority = narrowCredentialAuthority('present_user', binding.sessionActionOrigin ? 'account_automation' : undefined);
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
        ...(qualifiedAction ? { contributedQualifiedId: binding.actionId } : {}),
        target: binding.target,
        targetMachineId: binding.machineId,
    }).ok) return null;
    return principal;
}

async function verifyCurrentExternalActionPrincipalForPurpose(
    binding: ExternalActionExecutionAuthorizationBindingV1,
    purpose?: ExternalActionVerificationPurpose,
): Promise<VerifiedExternalActionPrincipal | null> {
    const principal = await readCurrentExternalActionPrincipal(binding, db, purpose);
    if (!principal) return null;
    const eligibility = await enforceLoginEligibility({ accountId: principal.accountId, env: process.env });
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
        const controller = await resolveExternalActionExecutionMachineAdmissionInTx(reader, {
            actorAccountId: binding.accountId, machineId: binding.machineId, actionId: binding.actionId,
        });
        if (controller.kind !== 'admitted' || controller.custodianAccountId !== binding.custodianAccountId
            || controller.installationId !== binding.installationId) return null;
        const enrolled = await reader.managedMachine.findUnique({ where: { enrolledMachineId: machineId } });
        if (!enrolled || enrolled.homeId !== binding.serverIdentityId || enrolled.custodianAccountId !== binding.custodianAccountId) return null;
        const currentTarget = target ?? { homeId: enrolled.homeId, managedId: enrolled.id, expectedRevision: enrolled.intentRevision,
            controller: { machineId: binding.machineId, installationId: binding.installationId } };
        const row = await requireCurrentManagedMachineInTx(reader, { ...currentTarget,
            expectedIntentRevision: currentTarget.expectedRevision, requestId: binding.requestId });
        const admission = readManagedAdmissionState(row.admittedInput).currentAdmission;
        if (row.id !== enrolled.id || row.enrolledMachineId !== machineId || row.allocation !== 'bound'
            || !row.resource || row.desiredWhen !== 'after-idle'
            || row.controllerMachineId !== binding.machineId || row.controllerInstallationId !== binding.installationId
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
    if (binding.handoffContinuation) {
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

async function verifyCommon(
    proof: ExternalActionExecutionRequestProof,
): Promise<VerifiedExternalActionExecutionRequest | null> {
    const effectActionId = ExternalActionActionIdV1Schema.safeParse(proof.effectActionId);
    const target = decodeExternalActionResolvedTargetV1(proof.encodedTarget);
    if (!effectActionId.success || !target) return null;

    const binding = await auth.verifyExternalActionExecutionAuthorization(proof.authorizationToken);
    if (!binding || !isExternalActionResolvedTargetAllowedV1({
        authorizedTarget: binding.target,
        resolvedTarget: target,
        selectedMachineId: binding.machineId,
    })) return null;
    if (!hasMatchingExecutionEffectFamily(binding.actionId, effectActionId.data)
        || ('authentication' in binding || binding.handoffContinuation) && binding.actionId !== effectActionId.data) return null;
    if (binding.serverIdentityId !== await getOrCreateServerIdentityId()) return null;
    const currentnessBody = ExternalActionExecutionAuthorizationVerifyRequestV1Schema.safeParse(proof.body);
    const custodyTarget = currentnessBody.success ? currentnessBody.data.managedFiniteWakeTarget : undefined;
    const readCustody = custodyTarget ? async () => {
        const { readCurrentManagedFiniteWakeCustodyInTx } = await import('@/app/machines/managed/managedWake');
        return readCurrentManagedFiniteWakeCustodyInTx(db, {
            actionOrigin: { v: 1, token: proof.authorizationToken, binding }, target: custodyTarget,
        });
    } : undefined;
    if (custodyTarget && (proof.method.toUpperCase() !== 'POST'
        || proof.path !== bindExternalActionExecutionAuthorizationVerifyHttpPathV1(binding.actionId))) return null;
    const custody = await readCustody?.();
    if (custodyTarget && !custody) return null;
    const report = proof.method.toUpperCase() === 'POST' && proof.path.split('?')[0] === '/v1/machines/managed/controller/report'
        ? ManagedControllerReportV1Schema.safeParse(proof.body) : null;
    const intentReport = proof.method.toUpperCase() === 'POST' && proof.path.split('?')[0] === '/v1/machines/managed/controller/report-intent'
        ? ManagedControllerIntentReportV1Schema.safeParse(proof.body) : null;
    const handoffChild = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(proof.body);
    const isHandoffChildIssue = proof.method.toUpperCase() === 'POST' && binding.actionId === 'session.handoff'
        && binding.handoffAdmission && !binding.handoffContinuation && handoffChild.success
        && handoffChild.data.handoffContinuation?.authorization.token === proof.authorizationToken
        && readHandoffContinuationIssuanceAction(proof.path) !== null;
    const purpose: ExternalActionVerificationPurpose | undefined = report?.success
        && await isIssuedAcquireNativeFactReportInTx(db, binding, report.data)
        ? { kind: 'issued-managed-acquire-native-fact', report: report.data }
        : intentReport?.success && await isIssuedIntentNativeFactReportInTx(db, binding, intentReport.data)
            ? { kind: 'issued-managed-intent-native-fact', report: intentReport.data }
            : isHandoffChildIssue ? { kind: 'issued-handoff-continuation' } : undefined;
    if (!purpose && !await hasCurrentExternalActionSessionSource(binding, proof.resolveCurrentSessionMachine)) return null;

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
    if (!signatureCurrent && !custodyTarget && !managedGuestMetadata) {
        const sourceKey = await readCurrentExternalActionSourceSigningPublicKey(binding);
        signatureCurrent = sourceKey !== null && verifySignature(sourceKey);
    }
    if (
        !machine
        || classifyMachineAvailabilityState(machine) !== "available"
        || !machine.installationId
        || !machine.installationPublicKey
        || !await hasCurrentExecutionMachineAdmission(binding, machine)
        || !signatureCurrent
    ) {
        return null;
    }

    // Login eligibility may await a provider; publisher currentness is checked
    // afterwards, followed by the current persisted credential and admissions.
    const principal = await verifyCurrentExternalActionPrincipalForPurpose(binding, purpose);
    if (!principal || !await hasCurrentExecutionMachineAdmission(binding)) return null;
    if (!purpose && !await hasCurrentExternalActionSessionSource(binding, proof.resolveCurrentSessionMachine)) return null;
    if (!await readCurrentExternalActionPrincipal(binding, db, purpose)
        || !await hasCurrentExecutionMachineAdmission(binding)) return null;
    if (readCustody) {
        const current = await readCustody();
        if (!current || current.installationPublicKey !== custody?.installationPublicKey) return null;
    }
    return { binding, effectActionId: effectActionId.data, target, principal };
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
    if (['/v1/account/encryption/currentness', '/v1/account/encryption', '/v2/account/settings'].includes(url.pathname)) {
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

export async function verifyExternalActionDomainExecutionRequest(
    proof: ExternalActionExecutionRequestProof,
): Promise<VerifiedExternalActionExecutionRequest | null> {
    const verified = await verifyCommon(proof);
    if (!verified) return null;
    const relay = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(proof.body);
    const isAdmittedRootRelay = proof.method.toUpperCase() === 'POST'
        && proof.path === `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${encodeURIComponent(verified.binding.actionId)}`
        && relay.success && relay.data.executionAuthorization?.token === proof.authorizationToken
        && sameManagedInput(relay.data.executionAuthorization.binding, verified.binding)
        && isExternalActionAuthorizationBoundToEnvelope(verified.binding, { actionId: verified.effectActionId,
            machineId: relay.data.machineId, envelope: relay.data.envelope });
    const managedRoot = ManagedMachineActionIdV1Schema.safeParse(verified.binding.actionId);
    let managedGuestActivity: VerifiedExternalActionExecutionRequest['managedGuestActivity'];
    if (isAdmittedRootRelay) {
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
            || proof.method.toUpperCase() !== 'POST' || !child.success || !child.data.handoffContinuation
            || readHandoffContinuationIssuanceAction(path) === null) return null;
    } else if (verified.binding.actionId === 'connectedServices.quota.get') {
        if (verified.effectActionId !== verified.binding.actionId || !isQuotaReadHttpPurpose(proof)) return null;
    } else if (verified.binding.actionId === 'session.pending.resetStart.set'
        || verified.binding.actionId === 'session.pending.resetStart.cancel') {
        const purpose = readExternalActionPendingResetStartPurpose({ actionId: verified.effectActionId,
            method: proof.method, path: proof.path, body: proof.body });
        if (verified.effectActionId !== verified.binding.actionId || !purpose
            || verified.binding.target.kind !== 'session' || purpose.sessionId !== verified.binding.target.sessionId) return null;
    } else if ('authentication' in verified.binding) {
        const path = proof.path.split('?')[0];
        const childPurpose = verified.binding.actionId === 'session.spawn_new' && verified.binding.managedContinuation
            && proof.method.toUpperCase() === 'POST' && path === '/v1/sessions';
        if (!childPurpose) return null;
    }
    const rootMachineAction = MachineAccessActionIdSchema.safeParse(verified.binding.actionId);
    const effectMachineAction = MachineAccessActionIdSchema.safeParse(verified.effectActionId);
    if (!isAdmittedRootRelay && (rootMachineAction.success || effectMachineAction.success)) {
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
    }
    const effect = parseExternalActionEffectAction(verified.binding, verified.effectActionId);
    const credentialAction = verified.binding.handoffContinuation
        ? PublicActionIdSchema.safeParse(readExternalActionCredentialActionId(verified.binding)) : effect;
    if (!effect.success || !credentialAction.success || !resolveCredentialActionAdmissionV1({
        spec: getActionSpec(credentialAction.data),
        authority: verified.principal.authority, ...('grant' in verified.binding ? { grant: verified.binding.grant } : {}) }).ok) return null;
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
        || binding.accountEncryptionMode !== supplied.accountEncryptionMode
        || !sameManagedInput(binding.managedContinuation, supplied.managedContinuation)
        || !sameManagedInput(binding.handoffAdmission, supplied.handoffAdmission)
        || !sameManagedInput(binding.handoffContinuation, supplied.handoffContinuation)
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
        || binding.actionId !== 'session.handoff' || binding.handoffContinuation || !binding.handoffAdmission
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
    const principal = current && projectExternalActionBoundPrincipal(binding, current);
    if (!principal || narrowCredentialAuthority(principal.authority, context.callerAuthority) !== context.callerAuthority
        || !await hasCurrentExecutionMachineAdmission(binding)
        || !resolveCredentialActionAdmissionV1({ spec: getActionSpec(action.data), authority: context.callerAuthority,
            ...('grant' in binding ? { grant: binding.grant } : {}) }).ok) return null;
    if (binding.sessionActionOrigin && ((context.callerPermissionMode != null
        && context.callerPermissionMode !== binding.sessionActionOrigin.callerPermissionMode)
        || (context.causalPermissionAuthority != null
            && !sameManagedInput(context.causalPermissionAuthority, binding.sessionActionOrigin.causalPermissionAuthority))
        || context.workspaceWrites !== binding.sessionActionOrigin.workspaceWrites)) return null;
    const source = await resolveMachineAdmission({ actorAccountId: binding.accountId, machineId: routing.sourceMachineId, requiredRole: claimed.role });
    if (source.kind !== 'admitted' || source.custodianAccountId !== claimed.custodianAccountId
        || source.installationId !== claimed.installationId || source.encryptionMode !== claimed.encryptionMode) return null;
    if (!await hasCurrentExternalActionSessionSource(binding, resolveCurrentSessionMachine)) return null;
    return { binding, principal: { ...principal, authority: context.callerAuthority }, effectActionId: binding.actionId, target: binding.target };
}

/** Only an installed D proof or its retained original packet can attest this exact Project purpose. */
export async function readCurrentWorkspaceSyncProjectSourceAuthorization(
    authorization: ExternalActionExecutionAuthorizationV1,
    routing: WorkspaceSyncSourceRoutingV1,
    writerMachineId: string,
    resolveCurrentSessionMachine?: ExternalActionExecutionRequestProof['resolveCurrentSessionMachine'],
): Promise<Readonly<{ verified: VerifiedExternalActionExecutionRequest;
    route: NonNullable<Awaited<ReturnType<typeof readMachineDevcontainerWorkspaceSyncRouteInTx>>> }> | null> {
    const binding = await auth.verifyExternalActionExecutionAuthorization(authorization.token);
    const envelope = routing.originalActionEnvelope;
    if (!binding || !matchesExternalActionAuthorizationBinding(binding, authorization.binding)
        || binding.actionId !== 'projects.open' || binding.handoffAdmission || binding.handoffContinuation
        || routing.phase !== 'prepare' || routing.sourceSessionId !== undefined || !envelope
        || binding.serverIdentityId !== await getOrCreateServerIdentityId() || routing.accountServerId !== binding.serverIdentityId
        || !isExternalActionAuthorizationBoundToEnvelope(binding, { actionId: 'projects.open', machineId: binding.machineId, envelope })) return null;
    const verified = await readCurrentWorkspaceSyncSourceAuthorization(binding, routing, resolveCurrentSessionMachine);
    if (!verified) return null;
    if (envelope.v === 1) {
        const input = OpenProjectInputV1Schema.safeParse(envelope.input);
        if (!input.success || !matchesWorkspaceSyncProjectSourceInput(input.data, binding, routing)) return null;
    }
    const route = await readMachineDevcontainerWorkspaceSyncRouteInTx(db, { accountServerId: routing.accountServerId,
        childMachineId: routing.sourceMachineId, childRootPath: routing.sourceRootPath,
        parentMachineId: writerMachineId, releaseOnly: false });
    return route && await hasCurrentExternalActionSessionSource(binding, resolveCurrentSessionMachine) ? { verified, route } : null;
}

function matchesWorkspaceSyncProjectSourceInput(input: ReturnType<typeof OpenProjectInputV1Schema.parse>,
    binding: ExternalActionExecutionAuthorizationBindingV1, routing: WorkspaceSyncSourceRoutingV1): boolean {
    return input.serverId === binding.serverIdentityId && input.machineId === binding.machineId
        && input.materialization.kind === 'sync' && (input.source.kind === 'workspace' || input.source.kind === 'source')
        && input.source.checkout?.machineId === routing.sourceMachineId && input.source.checkout.rootPath === routing.sourceRootPath;
}

/** The current installed D's original packet attests verified decryption; P1 never signs as D. */
export async function verifyWorkspaceSyncProjectSourceAuthorization(
    authorization: ExternalActionExecutionAuthorizationV1, routing: WorkspaceSyncSourceRoutingV1,
    execution: WorkspaceSyncSourceExecutionV1,
    resolveCurrentSessionMachine?: ExternalActionExecutionRequestProof['resolveCurrentSessionMachine'],
): Promise<Awaited<ReturnType<typeof readCurrentWorkspaceSyncProjectSourceAuthorization>>> {
    const suffix = `:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`;
    if (!execution.method.endsWith(suffix)) return null;
    const admitted = await readCurrentWorkspaceSyncProjectSourceAuthorization(authorization, routing,
        execution.method.slice(0, -suffix.length), resolveCurrentSessionMachine);
    if (!admitted) return null;
    const { binding } = admitted.verified;
    const envelope = routing.originalActionEnvelope;
    const packet = execution.externalActionExecution;
    if (!envelope || packet.authorization.token !== authorization.token
        || !matchesExternalActionAuthorizationBinding(binding, packet.authorization.binding)
        || packet.effectActionId !== 'projects.open' || packet.installationId !== binding.installationId
        || encodeExternalActionResolvedTargetV1(packet.target) !== encodeExternalActionResolvedTargetV1(binding.target)) return null;
    // Plain decoded packets can also be checked against the canonical Open input.
    // For opaque transport params, the same installed D signature binds the
    // unchanged envelope and exact Source facts after D's verified decryption.
    if (typeof execution.params !== 'string') {
        const input = OpenProjectInputV1Schema.safeParse(execution.params);
        if (!input.success || !matchesWorkspaceSyncProjectSourceInput(input.data, binding, routing)
            || envelope.v === 1 && !sameManagedInput(envelope.input, input.data)) return null;
    }
    const rootMachine = await db.machine.findUnique({ where: { id: binding.machineId } });
    if (!rootMachine?.installationPublicKey || rootMachine.installationId !== binding.installationId
        || classifyMachineAvailabilityState(rootMachine) !== 'available'
        || !verifyExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
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
        resolveCurrentSessionMachine?: ExternalActionExecutionRequestProof['resolveCurrentSessionMachine'] }>,
): Promise<VerifiedExternalActionExecutionRequest | null> {
    if (!request.requestId) return null;
    const binding = await auth.verifyExternalActionExecutionAuthorization(execution.authorization.token);
    if (!binding || binding.serverIdentityId !== await getOrCreateServerIdentityId()
        || !await hasCurrentExternalActionSessionSource(binding, request.resolveCurrentSessionMachine)
        || !matchesExternalActionAuthorizationBinding(binding, execution.authorization.binding)
        || !isExternalActionResolvedTargetAllowedV1({ authorizedTarget: binding.target,
            resolvedTarget: execution.target, selectedMachineId: binding.machineId })) return null;

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
            installationId: execution.installationId, event: request.event ?? SOCKET_RPC_EVENTS.CALL,
            method: request.method, requestId: request.requestId, ...(request.params === undefined ? {} : { params: request.params }),
            workspaceSyncSourceWriterTargetRouting: routing, publicKey: writer.installationPublicKey,
            signature: execution.machineSignature })) return null;
        if (!await hasCurrentExternalActionSessionSource(admitted.verified.binding, request.resolveCurrentSessionMachine)) return null;
        return admitted.verified;
    }

    const effect = parseExternalActionEffectAction(binding, execution.effectActionId);
    if (!effect.success || !hasMatchingExecutionEffectFamily(binding.actionId, execution.effectActionId)
        || binding.handoffContinuation && binding.actionId !== execution.effectActionId) return null;
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
    if ('authentication' in binding || binding.handoffContinuation) {
        const prefix = `${binding.machineId}:`;
        const method = managedGuestActivity && guestMethod ? guestMethod
            : request.method.startsWith(prefix) ? request.method.slice(prefix.length) : request.method;
        if (binding.actionId !== execution.effectActionId
            || resolveMachineRpcExternalActionEffectV1(method, binding) !== execution.effectActionId) return null;
    }
    // Home proves the original Session or accepted handoff source. RPC effects
    // cannot substitute the destination signer for that original authority.
    const requiresSource = !managedGuestActivity && Boolean(binding.handoffContinuation
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
    const principal = await verifyCurrentExternalActionPrincipal(binding);
    if (!principal || !await hasCurrentExternalActionSessionSource(binding, request.resolveCurrentSessionMachine)) return null;
    const credentialAction = binding.handoffContinuation
        ? PublicActionIdSchema.safeParse(readExternalActionCredentialActionId(binding)) : effect;
    if (!credentialAction.success || !await readCurrentExternalActionPrincipal(binding, db)
        || !await hasCurrentExecutionMachineAdmission(binding)
        || !resolveCredentialActionAdmissionV1({ spec: getActionSpec(credentialAction.data),
            authority: principal.authority, ...('grant' in binding ? { grant: binding.grant } : {}) }).ok) return null;
    // Run the full derived guest scope last, after all other asynchronous
    // credential/source/controller work, including at the forwarding preIO guard.
    if (managedGuestActivity && (!guestMachineId || !guestTarget?.success && !encryptedGuestParams
        || !sameManagedInput(managedGuestActivity, await readCurrentManagedGuestActivityInTx(db, binding, guestMachineId,
            guestTarget?.success ? guestTarget.data : undefined)))) return null;
    return { binding, effectActionId: execution.effectActionId, target: execution.target, principal,
        ...(managedGuestActivity ? { managedGuestActivity } : {}) };
}

export async function verifyExternalActionExecutionAuthorizationCurrentness(
    proof: ExternalActionExecutionRequestProof & Readonly<{ outerActionId: string }>,
): Promise<VerifiedExternalActionExecutionRequest | null> {
    const verified = await verifyCommon(proof);
    if (!verified || verified.binding.actionId !== proof.outerActionId) return null;
    if (
        proof.method.toUpperCase() !== "POST"
        || proof.path !== bindExternalActionExecutionAuthorizationVerifyHttpPathV1(proof.outerActionId)
    ) {
        return null;
    }
    const effect = parseExternalActionEffectAction(verified.binding, verified.effectActionId);
    const credentialAction = verified.binding.handoffContinuation
        ? PublicActionIdSchema.safeParse(readExternalActionCredentialActionId(verified.binding)) : effect;
    if (!effect.success || !credentialAction.success || !resolveCredentialActionAdmissionV1({
        spec: getActionSpec(credentialAction.data),
        authority: verified.principal.authority, ...('grant' in verified.binding ? { grant: verified.binding.grant } : {}) }).ok) return null;
    return verified;
}
