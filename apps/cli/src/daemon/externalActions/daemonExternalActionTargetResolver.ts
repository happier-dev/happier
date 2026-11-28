import { resolveMachineControlLocalityProof } from '@/session/machineControlLocality';
import { readSessionOwnerLocality, tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import type { StoredCredentials } from '@/persistence';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { fetchAccountProfile } from '@/api/accountProfile';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { resolveAvailableAccountSettings } from '@/settings/accountSettings/resolveAvailableAccountSettings';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAuthoritativePluginSlotOccurrence } from '@/plugins/runtime/reload/runtimeLease';
import { resolvePermissionIntentFromSessionMetadata } from '@happier-dev/agents';
import type {
  ActionExecutorContext,
  AccountApiTokensListActionOutputV1,
  ApprovalExecutionOriginV1,
  SessionAgentSpawnPolicyV1,
} from '@happier-dev/protocol';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { assertNonEscalatingPermissionMode, resolveEffectivePermissionMode } from '@happier-dev/protocol/actions/permissionPrivilege';
import { getActionSpec, resolveActionExecutionPlacementForInput, SignedRootActionIdSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { verifyExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ApprovalExecutionOriginV1Schema, isHistoricalPublishApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ApprovalStaleReason } from '@happier-dev/protocol/approvals/approvalExecutionFailure';
import type { SessionInputSourceSessionV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

import type { ResolveExternalActionTarget } from './executeExternalAction';
import { rethrowRequesterHomeReadFailure } from "@/daemon/sessionEncryption/requesterCurrentness";
import { timeApprovalPhase, withApprovalActionTrace } from './webLatencyTrace';
import { createCredentialedWorkflowActionAdmissionReader, createCredentialedWorkflowRunEncryptionResolver,
  readWorkflowActionInvocationEffect, type createWorkflowActionAdmissionReader } from '../workflows/workflowActionAdmission';
import type { WorkflowDiscussionModelReservationCustody } from '../workflows/recovery';
import { createWorkflowRunStorageClient } from '../workflows/workflowRunStorageClient';

type CurrentMachineExecutionOrigin = Readonly<{
  serverIdentityId: string;
  machineId: string;
}>;

/** Closed diagnostic codes only; never log origin, policy, or credential content. */
export type DaemonApprovalExecutionOriginStaleReason = ApprovalStaleReason;

export type AdmittedWorkflowApprovalRequester = Readonly<{
  serverId: string;
  homeServerIdentityId: string;
  accountId: string;
  machineId: string;
  runId: string;
  requestId: string;
  /** A host-principal Run is a host Workflow requester; other principals keep their own source. */
  principal: 'host' | 'requester';
}>;

export type DaemonApprovalExecutionOriginCurrentness = (args: Readonly<{
  origin: ApprovalExecutionOriginV1;
  request?: Parameters<NonNullable<ActionExecutorDeps['isApprovalExecutionOriginCurrent']>>[0]['request'];
  /** Actual signed continuation input; no synthetic consent record is needed. */
  actionInput?: unknown;
  signal?: AbortSignal;
  reportStale?: (reason: DaemonApprovalExecutionOriginStaleReason) => void;
  onWorkflowRequesterAdmitted?: (requester: AdmittedWorkflowApprovalRequester) => void;
  onVerifiedDaemonReplayHome?: (homeId: string) => void;
}>) => Promise<boolean>;

function doesCurrentPermissionModeAdmitApprovedMode(origin: ApprovalExecutionOriginV1, currentMode: string | null): boolean {
  if (origin.causalPermissionAuthority && !origin.callerPermissionMode) return false;
  if (origin.callerPermissionMode === undefined) return true;
  if (!origin.callerPermissionMode || !currentMode) return false;
  if (origin.causalPermissionAuthority) {
    const admittedPermissionCeiling = origin.causalPermissionAuthority.admittedPermissionCeiling;
    const approved = resolveEffectivePermissionMode({ currentMode: origin.callerPermissionMode, admittedPermissionCeiling });
    const current = resolveEffectivePermissionMode({ currentMode, admittedPermissionCeiling });
    return approved.ok && current.ok && assertNonEscalatingPermissionMode({
      requestedMode: approved.effectiveMode, callerMode: current.effectiveMode }).ok;
  }
  return assertNonEscalatingPermissionMode({ requestedMode: origin.callerPermissionMode, callerMode: currentMode }).ok;
}

/** Reviewed publication retains its original input, not a fresh Agent turn. */
function readRetainedDiscussionPublicationSource(origin: ApprovalExecutionOriginV1,
  request: Parameters<DaemonApprovalExecutionOriginCurrentness>[0]['request']): SessionInputSourceSessionV1 | null {
  return origin.caller.kind === 'session'
    && request?.v === 2 && request.actionId === origin.actionId
    && (request.actionId === 'discussion.post' || request.actionId === 'discussion.reply')
    && (request.status === 'approved' || request.status === 'executing')
    && request.decision?.kind === 'approve' && request.decision.authority === 'present_user'
    && request.execution === undefined
    && origin.sessionInputSource?.sourceSessionId === origin.caller.sessionId
    && Boolean(origin.sessionInputSource.sourceInputId && origin.sessionInputSource.sourceTurnId)
    ? origin.sessionInputSource : null;
}

/**
 * Composes the existing Account credential, Home/Machine identity, and
 * external Session-locality owners for durable Action replay. Unknown owner
 * state is stale: this adapter never substitutes the approving caller.
 */
export function createDaemonApprovalExecutionOriginCurrentness(input: Readonly<{
  accountId: string;
  machineId: string;
  /** Local profile identifier that owns routing to the configured Home. */
  serverId: string;
  resolveCurrentMachineExecutionOriginContext: (
    signal?: AbortSignal,
  ) => Promise<CurrentMachineExecutionOrigin | null>;
  resolveTarget: ResolveExternalActionTarget;
  /** Authenticated Account eligibility, independent of API-token management. */
  isAccountCurrent: (signal?: AbortSignal) => Promise<boolean>;
  listAccountApiTokens: (
    signal?: AbortSignal,
  ) => Promise<AccountApiTokensListActionOutputV1>;
  externalActionMachinePublicKey?: string | Uint8Array;
  verifyExternalExecutionAuthorization?: (input: Readonly<{
    authorization: NonNullable<ApprovalExecutionOriginV1['externalActionExecutionAuthorization']>;
    effectActionId: string;
    target: NonNullable<ApprovalExecutionOriginV1['target']>;
    retainedDiscussionSource?: SessionInputSourceSessionV1;
    onSessionSourceNotCurrent?: () => void;
    signal?: AbortSignal;
  }>) => Promise<boolean>;
  /** Whether the plugin is still installed here (runtime slot); defaults to the authoritative slot. */
  isPluginInstalled?: (pluginId: string) => boolean | Promise<boolean>;
  isAutomationRunCurrent?: (caller: Extract<
    ApprovalExecutionOriginV1['caller'],
    Readonly<{ kind: 'automationRun' }>
  >) => Promise<boolean> | boolean;
  /** Reuses the tracked Session authority owner; a target lookup is not caller proof. */
  isSessionCallerCurrent?: (input: Readonly<{
    caller: Extract<ApprovalExecutionOriginV1['caller'], Readonly<{ kind: 'session' }>>;
    signal?: AbortSignal;
  }>) => Promise<boolean> | boolean;
  /** Binds editable invitation consent to the exact accepted Run and input. */
  workflowDiscussionModelReservationCustody?: WorkflowDiscussionModelReservationCustody;
  resolveCurrentPermissionMode?: (
    origin: ApprovalExecutionOriginV1,
    signal?: AbortSignal,
  ) => Promise<string | null>;
  /** Opens the immutable accepted ceiling for a signed Workflow root, never an editable approval assertion. */
  readWorkflowActionAdmission?: ReturnType<typeof createWorkflowActionAdmissionReader>;
  resolveCurrentSessionAgentSpawnPolicyV1?: (
    origin: ApprovalExecutionOriginV1,
    signal?: AbortSignal,
  ) => Promise<SessionAgentSpawnPolicyV1 | null>;
  now?: () => number;
}>): DaemonApprovalExecutionOriginCurrentness {
  const now = input.now ?? Date.now;
  return async ({ origin, request, actionInput, signal, reportStale, onWorkflowRequesterAdmitted, onVerifiedDaemonReplayHome }) => withApprovalActionTrace(request ? 'approval.request.decide' : origin.actionId,
    () => timeApprovalPhase('approval.origin.currentness', async () => {
    const phase = <T>(name: string, read: () => T | Promise<T>): Promise<T> =>
      timeApprovalPhase(`approval.origin.${name}`, read);
    const stale = (reason: DaemonApprovalExecutionOriginStaleReason) => {
      reportStale?.(reason);
      return false;
    };
    const readApprovedWorkflowInvocation = async (runId: string, context: ActionExecutorContext, actionId: string) => {
      const admission = await input.readWorkflowActionAdmission?.({ runId, phase: 'approval_replay',
        context: { ...context, actionRequestId: origin.requestId, ...(signal ? { signal } : {}) } });
      if (!admission || admission.run.ownerAccountId !== input.accountId) return null;
      const invocation = await admission.readActionInvocation('approval_replay');
      const execution = invocation?.progress.execution;
      if (execution?.kind !== 'action' || execution.actionRequestId !== origin.requestId) return null;
      const effect = readWorkflowActionInvocationEffect(execution);
      const approved = readWorkflowActionInvocationEffect({ kind: 'action', actionId,
        input: request?.v === 2 ? request.actionArgs : actionInput });
      return effect && approved && effect.actionId === approved.actionId ? { admission, effect, approved } : null;
    };
    try {
      // Descriptive PAT ids from legacy API approvals are never sufficient to
      // begin replay currentness checks. They lack the signed exact invocation.
      if (
        origin.surface === 'api'
        && origin.credentialId !== undefined
        && !origin.externalActionExecutionAuthorization
      ) return stale('credential_changed');
      const currentMachineOrigin = await phase('home_identity', () => input.resolveCurrentMachineExecutionOriginContext(signal));
      if (!currentMachineOrigin) return stale('home_unavailable');
      if (currentMachineOrigin.machineId !== input.machineId) return stale('machine_changed');
      if (origin.serverIdentityId !== undefined
          ? currentMachineOrigin.serverIdentityId !== origin.serverIdentityId
          : origin.serverId !== input.serverId) return stale('home_changed');
      const current = () => {
        if (origin.serverIdentityId !== undefined) onVerifiedDaemonReplayHome?.(currentMachineOrigin.serverIdentityId);
        return true;
      };
      // The one plugin decider. Plugins are trusted code: a genuine update keeps the person's
      // approval of this exact Action and input (ruling 2026-11-02), so neither generation nor
      // source is compared. Uninstalling is the person's revocation, refused at the next execution.
      if (origin.caller.kind === 'plugin'
        && !await (input.isPluginInstalled ?? (pluginId => readAuthoritativePluginSlotOccurrence(pluginId) !== null))(origin.caller.pluginId)) {
        return stale('plugin_source_changed');
      }
      const externalAuthorization = origin.externalActionExecutionAuthorization;
      const retainedDiscussionSource = readRetainedDiscussionPublicationSource(origin, request);
      // Requester identity in editable Artifact content is not an immutable
      // subject unless the original installation signed that exact subject.
      if (request?.v === 2 && request.requesterConfirmation && !externalAuthorization) return stale('credential_changed');
      let hasVerifiedRemoteSessionSource = false;
      if (externalAuthorization) {
        const binding = externalAuthorization.binding;
        const sessionOrigin = 'authentication' in binding ? binding.sessionActionOrigin : undefined;
        const acceptedSession = sessionOrigin !== undefined
          && origin.authority === 'account_automation' && origin.surface === 'agent'
          && origin.caller.kind === 'session'
          && sameStrictJsonValue(origin.caller, sessionOrigin.caller)
          && origin.sessionInputSource?.sourceSessionId === sessionOrigin.caller.sessionId
          && origin.sessionInputSource.sourceTurnId === sessionOrigin.sourceTurnId
          && origin.callerPermissionMode === sessionOrigin.callerPermissionMode
          && sameStrictJsonValue(origin.causalPermissionAuthority ?? null, sessionOrigin.causalPermissionAuthority ?? null);
        // The strict origin owner binds Account, Session, PAT provenance and the
        // root request ID (Workflow leaves and host children carry their own).
        // Rechecking its contract preserves a narrowed Account authority rather
        // than introducing a second human-only interpretation during replay.
        const principalMatches = ApprovalExecutionOriginV1Schema.safeParse(origin).success;
        const retainedWorkflow = principalMatches && origin.caller.kind === 'workflowRun';
        if (
          (request ? request.v !== 2 : actionInput === undefined)
          || !origin.externalActionInputSignature
          || !origin.target
          || !input.externalActionMachinePublicKey
          || (!retainedWorkflow && !input.verifyExternalExecutionAuthorization)
          || !principalMatches
          || (!acceptedSession && !retainedWorkflow && origin.caller.kind !== 'host' && origin.caller.kind !== 'plugin')
          || origin.serverIdentityId !== externalAuthorization.binding.serverIdentityId
          || origin.accountId !== input.accountId
          || origin.accountId !== externalAuthorization.binding.accountId
          || origin.machineId !== input.machineId
          || origin.machineId !== externalAuthorization.binding.machineId
          || !verifyExternalActionApprovalInputV1({
            authorizationToken: externalAuthorization.token,
            actionId: origin.actionId,
            target: origin.target,
            input: request ? request.actionArgs : actionInput,
            ...(request?.v === 2 && request.requesterConfirmation ? { requesterConfirmation: request.requesterConfirmation } : {}),
            ...(origin.sessionTargetsV1 ? { sessionTargetsV1: origin.sessionTargetsV1 } : {}),
            publicKey: input.externalActionMachinePublicKey,
            signature: origin.externalActionInputSignature,
          })
        ) return stale('credential_changed');
        const target = origin.target;
        let authorizationStaleReason: DaemonApprovalExecutionOriginStaleReason = 'credential_changed';
        if (!retainedWorkflow && !await phase('external_authorization', () => input.verifyExternalExecutionAuthorization!({
          authorization: externalAuthorization,
          // Account currentness verifies the retained root; the installation
          // signature above binds its exact approved effect. PAT currentness
          // also enforces the captured grant against that resolved effect.
          effectActionId: 'authentication' in binding ? binding.actionId : origin.actionId,
          target,
          // Generic retained publications keep their incumbent local caller
          // exemption. Only an addressed original can prove this Home purpose.
          ...(retainedDiscussionSource?.discussionAddressing
            ? { retainedDiscussionSource } : {}),
          ...(acceptedSession ? { onSessionSourceNotCurrent: () => { authorizationStaleReason = 'session_changed'; } } : {}),
          ...(signal ? { signal } : {}),
        }))) return stale(authorizationStaleReason);
        // The verified Home binding owns the remote Session source for an
        // exact same-Account Machine relay or a retained managed creation.
        hasVerifiedRemoteSessionSource = acceptedSession
          && binding.sessionActionSource !== undefined
          && binding.sessionActionSource.machineId !== input.machineId
          && ((binding.actionId === 'session.spawn_new' && binding.managedContinuation !== undefined)
            || (binding.accountId === binding.custodianAccountId && binding.target.kind === 'machine'
              && binding.actionId === origin.actionId));
        // The signature above binds the approved Action and input; plugin presence was decided above.
        if (origin.caller.kind === 'plugin') return current();
        // Home admitted the exact original turn. Accepted Session work still
        // passes the ordinary current Session/permission/Account checks below;
        // naturally ending the old turn is not itself a revocation.
        if (!acceptedSession) {
          const workflow = binding.workflowActionOrigin;
          const retainedCaller = retainedWorkflow && origin.caller.kind === 'workflowRun' ? origin.caller : undefined;
          const runId = retainedCaller?.runId
            ?? (workflow && !workflow.sessionLeaf && !workflow.sessionAuthority ? workflow.runId : undefined);
          if (runId) {
            if (!input.readWorkflowActionAdmission) return stale('workflow_authorization_unavailable');
            const approved = await readApprovedWorkflowInvocation(runId, {
              externalActionExecutionAuthorization: externalAuthorization,
              ...(retainedCaller ? { actionCaller: retainedCaller, executionRunWorkflowRunId: runId } : {}),
            }, origin.actionId);
            if (!approved) return stale('workflow_authorization_changed');
            // The signature above binds the prepared effect. This read recovers
            // only its accepted ceiling, never fresh authority over its operands.
            if (origin.callerPermissionMode === undefined || !doesCurrentPermissionModeAdmitApprovedMode(origin,
              approved.admission.accepted.authorization.admittedPermissionCeiling)) return stale('permission_changed');
          }
          return current();
        }
      }
      if (origin.accountId !== undefined && origin.accountId !== input.accountId) return stale('account_changed');
      if (origin.machineId !== undefined && origin.machineId !== input.machineId) return stale('machine_changed');

      const operands = request?.actionArgs ?? actionInput;
      const hasSessionOperand = operands !== null && typeof operands === 'object' && 'sessionId' in operands
        && typeof operands.sessionId === 'string' && operands.sessionId.trim().length > 0;
      // Historical publish has no executable spec; preserve the existing stale refusal.
      if (request && isHistoricalPublishApprovalRequestV2(request)) return stale('currentness_read_failed');
      const requestSpec = request?.v === 2 ? getActionSpec(request.actionId) : null;
      // Live input remains on this exact origin Machine. The durable projection
      // cannot be parsed as executable input to infer placement; a contextual
      // Session does not own those retained operands. Explicit Session targets
      // still pass their ordinary locality checks below.
      const liveInputCustody = requestSpec?.approvalInputCustody === 'live_only';
      const machineEffect = requestSpec !== null && !liveInputCustody
        && resolveActionExecutionPlacementForInput(requestSpec, operands, origin.caller, origin.surface) === 'machine';
      const target = origin.target
        // Machine-only effects replay on the recorded Machine. A contextual
        // Session is not their target; explicit Session operands still recheck locality.
        ?? ((liveInputCustody || machineEffect) && !hasSessionOperand && origin.machineId
          ? { kind: 'machine' as const, machineId: origin.machineId }
          : origin.sessionId
          ? { kind: 'session' as const, sessionId: origin.sessionId }
          : origin.machineId
            ? { kind: 'machine' as const, machineId: origin.machineId }
            : undefined);
      if (target) {
        const signedRootActionId = SignedRootActionIdSchema.safeParse(origin.actionId);
        if (!signedRootActionId.success) return stale('origin_action_changed');
        const currentTarget = await input.resolveTarget({
          actionId: signedRootActionId.data,
          target,
          currentMachineId: input.machineId,
          context: { actionCaller: origin.caller, surface: origin.surface },
          ...(signal ? { signal } : {}),
        });
        if (!currentTarget) return stale('target_unavailable');
      }

      if (origin.caller.kind === 'automationRun') {
        if (!input.isAutomationRunCurrent) return stale('automation_run_changed');
        if (!await input.isAutomationRunCurrent(origin.caller)) return stale('automation_run_changed');
      }

      // Posting a person's reviewed Discussion body consumes durable original
      // input custody, not a new Agent turn. The publisher still reopens the
      // executing Artifact and Home rechecks its source and owning Machine.
      if (origin.caller.kind === 'session' && !hasVerifiedRemoteSessionSource && !retainedDiscussionSource) {
        if (!input.isSessionCallerCurrent) return stale('session_changed');
        if (!await input.isSessionCallerCurrent({ caller: origin.caller,
          ...(signal ? { signal } : {}) })) return stale('session_changed');
      }

      // A model invitation's editable pointer still binds to its original Run;
      // the Run's admitted principal is not re-authorized during replay.
      if (origin.caller.kind === 'workflowRun' && origin.caller.discussionModelReservation) {
        if (!input.workflowDiscussionModelReservationCustody) return stale('workflow_authorization_unavailable');
        const { isWorkflowDiscussionModelReservationCurrent } = await import('../workflows/recovery');
        if (!await isWorkflowDiscussionModelReservationCurrent({
          ...input.workflowDiscussionModelReservationCustody,
          accountId: input.accountId,
          reservation: { origin, input: operands },
          ...(signal ? { signal } : {}),
        })) return stale('workflow_authorization_changed');
      }

      if (origin.callerPermissionMode !== undefined || origin.causalPermissionAuthority !== undefined) {
        // Local Workflow callers retain their accepted authorization ceiling.
        const currentPermissionMode = origin.caller.kind === 'workflowRun'
          ? origin.caller.authorization.admittedPermissionCeiling
          : input.resolveCurrentPermissionMode ? await input.resolveCurrentPermissionMode(origin, signal) : null;
        if (!doesCurrentPermissionModeAdmitApprovedMode(origin, currentPermissionMode)) return stale('permission_changed');
      }

      if (
        origin.surface === 'agent'
        && origin.actionId === 'session.spawn_new'
        && origin.sessionAgentSpawnPolicyV1 === undefined
      ) return stale('spawn_policy_unavailable');
      if (origin.sessionAgentSpawnPolicyV1 !== undefined) {
        if (!input.resolveCurrentSessionAgentSpawnPolicyV1) return stale('spawn_policy_unavailable');
        const currentPolicy = await input.resolveCurrentSessionAgentSpawnPolicyV1(origin, signal);
        if (!currentPolicy) return stale('spawn_policy_unavailable');
        if (!doesCurrentSpawnPolicyAdmitApprovedPolicy({
          approved: origin.sessionAgentSpawnPolicyV1,
          current: currentPolicy,
        })) return stale('spawn_policy_changed');
      }

      // An unsigned UI/host origin has no API token to recheck. Token-list
      // availability (including its separate rate limit) is not Account
      // eligibility; the authenticated Account owner must prove that instead.
      if (origin.credentialId === undefined) {
        try { if (!await input.isAccountCurrent(signal)) return stale('account_changed'); }
        catch (error) { rethrowRequesterHomeReadFailure(error); return stale('account_unavailable'); }
      } else {
        const tokenList = await input.listAccountApiTokens(signal);
        if (origin.accountId !== input.accountId || origin.principalId !== input.accountId) return stale('account_changed');
        const token = tokenList.tokens.find((candidate) => candidate.tokenId === origin.credentialId);
        if (!token) return stale('credential_changed');
        if (token.expiresAt !== null && Date.parse(token.expiresAt) <= now()) return stale('credential_expired');
      }
      // Any admitted Run principal replays with its Run's requester custody, as its live steps do.
      if (onWorkflowRequesterAdmitted && origin.caller.kind === 'workflowRun'
        && !externalAuthorization && origin.accountId && origin.machineId && origin.serverIdentityId && request?.v === 2) {
        const runId = origin.caller.runId;
        const approved = await readApprovedWorkflowInvocation(runId, { runtimeAccountId: origin.accountId,
          actionCaller: origin.caller, executionRunWorkflowRunId: runId }, request.actionId);
        if (approved?.admission.run.machineId === origin.machineId && sameStrictJsonValue(approved.effect.input, approved.approved.input)) {
          onWorkflowRequesterAdmitted({ serverId: origin.serverId, homeServerIdentityId: origin.serverIdentityId,
            accountId: origin.accountId, machineId: origin.machineId, runId, requestId: origin.requestId,
            principal: origin.caller.authorization.principal.kind === 'host' ? 'host' : 'requester' });
        }
      }
      return current();
    } catch (error) {
      rethrowRequesterHomeReadFailure(error);
      return stale('currentness_read_failed');
    }
  }));
}

const SPAWN_POLICY_ALLOWANCE_FIELDS = [
  'allowCustomDirectory',
  'allowCrossMachine',
  'allowBackendTargetOverride',
  'allowModelOverride',
  'allowPermissionModeOverride',
  'allowAgentModeOverride',
  'allowConfigOptionOverrides',
  'allowProfileOverride',
  'allowConnectedServicesOverride',
  'allowMcpSelectionOverride',
  'allowTranscriptStorageOverride',
] as const satisfies readonly (keyof SessionAgentSpawnPolicyV1)[];

function doesCurrentSpawnPolicyAdmitApprovedPolicy(input: Readonly<{
  approved: SessionAgentSpawnPolicyV1;
  current: SessionAgentSpawnPolicyV1;
}>): boolean {
  for (const field of SPAWN_POLICY_ALLOWANCE_FIELDS) {
    if (input.approved[field] && !input.current[field]) return false;
  }
  if (input.approved.permissionCeiling === null) {
    return input.current.permissionCeiling === null;
  }
  if (input.current.permissionCeiling === null) return true;
  const resolved = resolveEffectivePermissionMode({
    currentMode: input.approved.permissionCeiling,
    admittedPermissionCeiling: input.current.permissionCeiling,
  });
  return resolved.ok && resolved.effectiveMode === input.approved.permissionCeiling;
}

/** Canonical production composition for every credential-backed Action executor. */
export function createDaemonApprovalExecutionOriginCurrentnessFromCredentials(input: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  serverId: string;
  serverApiUrl: string;
  resolveCurrentMachineExecutionOriginContext?: Parameters<typeof createDaemonApprovalExecutionOriginCurrentness>[0]['resolveCurrentMachineExecutionOriginContext'];
  currentMachineHost?: string | null;
  currentMachineHomeDir?: string | null;
  isAutomationRunCurrent?: Parameters<typeof createDaemonApprovalExecutionOriginCurrentness>[0]['isAutomationRunCurrent'];
  isSessionCallerCurrent?: Parameters<typeof createDaemonApprovalExecutionOriginCurrentness>[0]['isSessionCallerCurrent'];
  resolveCurrentPermissionMode?: Parameters<typeof createDaemonApprovalExecutionOriginCurrentness>[0]['resolveCurrentPermissionMode'];
  resolveCurrentSessionAgentSpawnPolicyV1?: Parameters<typeof createDaemonApprovalExecutionOriginCurrentness>[0]['resolveCurrentSessionAgentSpawnPolicyV1'];
  resolveServerFeaturesSnapshot?: () =>
    | CliServerFeaturesSnapshot
    | undefined
    | Promise<CliServerFeaturesSnapshot | undefined>;
}>): ReturnType<typeof createDaemonApprovalExecutionOriginCurrentness> | undefined {
  const accountId = readAccountIdFromToken(input.credentials.token);
  if (!accountId) return undefined;
  const createAccountServerActionDepsForHome = () => createAccountServerActionDeps({
    token: input.credentials.token,
    serverId: input.serverId,
    serverHttpBaseUrl: input.serverApiUrl,
    ...(input.resolveServerFeaturesSnapshot
      ? { resolveServerFeaturesSnapshot: input.resolveServerFeaturesSnapshot }
      : {}),
  });
  const installationIdentity = readInstallationIdentityIfExistsSync();
  if (!createAccountServerActionDepsForHome().accountApiTokensListAction) return undefined;

  const readCurrentSession = async (origin: ApprovalExecutionOriginV1, signal?: AbortSignal) => {
    const sessionId = origin.caller.kind === 'session' ? origin.caller.sessionId : origin.sessionId;
    if (!sessionId) return null;
    const serverFeaturesSnapshot = await input.resolveServerFeaturesSnapshot?.();
    const transport = await resolveSessionTransportContext({ reason: 'session-action',
      credentials: input.credentials,
      idOrPrefix: sessionId,
      ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
      ...(signal ? { signal } : {}),
    });
    return transport.ok && transport.sessionId === sessionId && transport.rawSession.id === sessionId
      ? transport : null;
  };
  const checker = createDaemonApprovalExecutionOriginCurrentness({
    accountId,
    get machineId() { return input.machineId; },
    serverId: input.serverId,
    resolveCurrentMachineExecutionOriginContext: input.resolveCurrentMachineExecutionOriginContext ?? createCurrentMachineExecutionOriginContextResolver({
      get serverUrl() { return input.serverApiUrl; },
      resolveCurrentMachineId: () => input.machineId,
    }),
    resolveTarget: createDaemonExternalActionTargetResolver({
      credentials: input.credentials,
      get serverApiUrl() { return input.serverApiUrl; },
      currentMachineHost: input.currentMachineHost,
      currentMachineHomeDir: input.currentMachineHomeDir,
      ...(input.resolveServerFeaturesSnapshot
        ? { resolveServerFeaturesSnapshot: input.resolveServerFeaturesSnapshot }
        : {}),
    }),
    isAccountCurrent: async signal => (await fetchAccountProfile({
      token: input.credentials.token, projection: 'self', ...(signal ? { signal } : {}),
    })).id === accountId,
    listAccountApiTokens: async (signal) => {
      const result = await createAccountServerActionDepsForHome().accountApiTokensListAction!({
        input: {},
        context: { surface: 'rpc', authority: 'account_automation', serverId: input.serverId },
        ...(signal ? { signal } : {}),
      });
      if ('ok' in result) throw new Error(result.errorCode);
      return result;
    },
    ...(installationIdentity
      ? {
          externalActionMachinePublicKey: installationIdentity.publicKey,
          verifyExternalExecutionAuthorization: async ({
            authorization, effectActionId, target, retainedDiscussionSource, onSessionSourceNotCurrent, signal,
          }) =>
            await verifyExternalActionExecutionAuthorizationCurrent({
              authorization,
              effectActionId,
              target,
              privateKey: installationIdentity.privateKey,
              installationId: installationIdentity.installationId,
              serverHttpBaseUrl: input.serverApiUrl,
              ...(retainedDiscussionSource ? { retainedDiscussionSource } : {}),
              ...(onSessionSourceNotCurrent ? { onSessionSourceNotCurrent } : {}),
              ...(signal ? { signal } : {}),
            }),
        }
      : {}),
    ...(input.isAutomationRunCurrent ? { isAutomationRunCurrent: input.isAutomationRunCurrent } : {}),
    ...(input.isSessionCallerCurrent ? { isSessionCallerCurrent: input.isSessionCallerCurrent } : {}),
    workflowDiscussionModelReservationCustody: {
      storage: createWorkflowRunStorageClient({ token: input.credentials.token, get serverHttpBaseUrl() { return input.serverApiUrl; } }),
      resolveAccountEncryption: signal => createCredentialedWorkflowRunEncryptionResolver({
        credentials: input.credentials, serverHttpBaseUrl: input.serverApiUrl,
      })({ ...(signal ? { signal } : {}) }),
    },
    readWorkflowActionAdmission: request => createCredentialedWorkflowActionAdmissionReader({
      credentials: input.credentials, serverHttpBaseUrl: input.serverApiUrl })(request),
    resolveCurrentPermissionMode: input.resolveCurrentPermissionMode ?? (async (origin, signal) => {
      const transport = await readCurrentSession(origin, signal);
      if (!transport) return null;
      const metadata = tryDecryptSessionOwnerMetadataView({
        credentials: input.credentials,
        accountEncryptionMode: transport.accountEncryptionCurrentness.mode,
        rawSession: transport.rawSession,
      });
      return resolvePermissionIntentFromSessionMetadata(metadata)?.intent ?? null;
    }),
    resolveCurrentSessionAgentSpawnPolicyV1: input.resolveCurrentSessionAgentSpawnPolicyV1 ?? (async () => {
      const settings = await resolveAvailableAccountSettings({ credentials: input.credentials });
      return settings?.sessionAgentSpawnPolicyV1 ?? null;
    }),
  });
  return (args) => runWithServerHttpBaseUrl(input.serverApiUrl, () => checker(args));
}

/**
 * Rechecks the effect target through the existing Account Session owner. Only
 * machine/session-placed execution also requires daemon locality; Account
 * Actions may operate on an accessible Session on another machine.
 */
export function createDaemonExternalActionTargetResolver(input: Readonly<{
  credentials: StoredCredentials;
  serverApiUrl?: string;
  resolveServerFeaturesSnapshot?: () =>
    | CliServerFeaturesSnapshot
    | undefined
    | Promise<CliServerFeaturesSnapshot | undefined>;
  currentMachineHost?: string | null;
  currentMachineHomeDir?: string | null;
}>): ResolveExternalActionTarget {
  return async ({ actionId, actionInput, target, currentMachineId, context, onAdmittedSessionMachine, signal }) => {
    if (!target) {
      return { kind: 'machine', machineId: currentMachineId };
    }

    if (target.kind === 'machine') {
      return target.machineId === currentMachineId ? target : null;
    }

    const serverFeaturesSnapshot = await input.resolveServerFeaturesSnapshot?.();
    if (resolveActionExecutionPlacementForInput(getActionSpec(actionId), actionInput, context?.actionCaller, context?.surface ?? 'api') === 'account') {
      const session = await fetchSessionById({ reason: 'session-action',
        token: input.credentials.token,
        sessionId: target.sessionId,
        ...(input.serverApiUrl ? { serverUrl: input.serverApiUrl } : {}),
        ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
        ...(signal ? { signal } : {}),
      });
      return session?.id === target.sessionId ? target : null;
    }
    const resolveTransport = () => resolveSessionTransportContext({ reason: 'session-action',
      credentials: input.credentials, idOrPrefix: target.sessionId,
      ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
      ...(signal ? { signal } : {}),
    });
    const transport = input.serverApiUrl
      ? await runWithServerHttpBaseUrl(input.serverApiUrl, resolveTransport)
      : await resolveTransport();
    if (!transport.ok || transport.sessionId !== target.sessionId || transport.rawSession.id !== target.sessionId) return null;
    const localityRecord = readSessionOwnerLocality({
      metadata: tryDecryptSessionOwnerMetadataView({ credentials: input.credentials,
        accountEncryptionMode: transport.accountEncryptionCurrentness.mode, rawSession: transport.rawSession }),
      rawSession: transport.rawSession,
    });
    if (!localityRecord?.machineId) return null;

    const locality = await resolveMachineControlLocalityProof({
      sessionMachineId: localityRecord.machineId,
      currentMachineId,
      sessionHost: localityRecord.host,
      sessionHomeDir: localityRecord.homeDir,
      ...(input.currentMachineHost ? { currentMachineHost: input.currentMachineHost } : {}),
      ...(input.currentMachineHomeDir
        ? { currentMachineHomeDir: input.currentMachineHomeDir }
        : {}),
      credentials: { token: input.credentials.token },
    });
    if (!locality) return null;
    onAdmittedSessionMachine?.(localityRecord.machineId);
    return target;
  };
}
