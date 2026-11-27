import { readProjectCloneSource } from './readProjectCloneSource';
import { selectHostRequesterExecutionIdentity, isHostRequesterUnrestrictedOwner, isRequesterOwnWorkPlacedOnDaemonForHost } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { readRequesterAccountActionContext, type RetainedRequesterAccountCustody } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { configuration } from '@/configuration';
import type { preparePrivateProjectOpenCheckout, PrivateProjectCheckoutOpenRuntime } from './privateProjectOpenCheckout';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { posix } from 'node:path';
import { ActionFailureCauseV1Schema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readHostReviewedChildReceivingAdmissionV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { OpenProjectResultV1Schema, ProjectOpenSyncMaterializationResultV1Schema, type ProjectOpenSyncMaterializationResultV1, type OpenProjectInputV1, type OpenProjectResultV1 } from '@happier-dev/protocol/projects/openProjectV1';
import { isManagedDevcontainerChildProjectionCurrentV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import { readWorkspaceSyncChildMachineFacts } from '@/workspaces/sync/workspaceSyncTargetAuthority';
import { resolveCanonicalAbsolutePathComparisonIdentity } from '@/utils/path/expandHomeDirPath';
import { resolveWorkspaceSyncEndpoint, resolveWorkspaceSyncExecutionMachineIdV1, resolveWorkspaceSyncTransportAddress } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isProjectWorkspaceSyncOpenActionV1 } from '@happier-dev/protocol/actions/projectActionIdsV1';
import { isManagedWorkspaceRefV2, type ManagedWorkspaceRefV2, type ManagedWorkspaceLocatorV2, type WorkspaceAddressV1, type WorkspaceProjectFactsV1, type WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { projectWorkspaceRefV1, resolveWorkspaceRefV1, workspaceAddressFromRefV1, workspaceAddressFromRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { StoredCredentials } from '@/persistence';
import type { ScmBackendRegistry } from '@/scm/registry';
import { inspectWorkspaceLocationWithScmWorkspace } from '@/scm/workspace/workspaceLocationInspection';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readProjectAccountRows, createProjectAccountSnapshotMutation, mutateProjectAccountOrganization, type ProjectAccountRowsInput } from '@/workspaces/projectAccountRows';
import { materializeWorkspaceRefForMachineRoot, materializeWorkspaceRefForManagedRoot, resolveWorkspaceRefForMachineRoot } from '@/workspaces/workspaceRefsV1';
import { resolveProjectAccountWorkspaceRefRemovalV1 } from '@happier-dev/protocol/projects/projectAccountSnapshotV1';
import { readAcceptedManagedWorkspaceRefFromRows } from '@/workspaces/acceptedManagedWorkspace';
import { registerManagedWorkspaceTarget } from '@/daemon/sessions/sessionTargetWorkspaces';
import { openSessionHolderWorkspaceChannel } from '@/subprocess/supervision/sessionHolder';
import { createHolderWorkspaceSource } from '@/workspaces/source/holderWorkspaceSource';
import { mapHolderWorkspacePath } from '@/workspaces/source/holderWorkspaceCommand';
import type { WorkspaceSyncHandoffAdapter } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import { materializeWorkspaceSyncForOpen } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import { WorkspaceSyncPreparationRefusal } from '@/workspaces/sync/workspaceSyncRelationshipOwner';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { materializeProjectCheckout } from './materializeProjectCheckout';
import { prepareProjectSetup, type ProjectSetupPreparationInput } from '@/workspaces/projectSetup/projectSetupPreparation';
import { projectNativeSystemIo } from '@/workspaces/projectSetup/projectNativeSystemIo';
import { readProjectEffectiveDefinition } from '@/workspaces/projectSetup/projectEffectiveDefinition';
import { isProjectSecretRequirement } from '@/settings/secrets/secretReferenceOverlay';
import { resolveProjectRequesterSecretInputs, type ProjectRequesterSecretRuntime } from '@/workspaces/projectSetup/projectSetupRequesterInputs';
import { admitProjectSourceSelectionV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { createCliProjectSourceActionDeps } from '@/session/actions/projectSourceActionDeps';
import type { ExternalActionMachineRequestSigningKey } from '@/api/externalActionExecutionAuthorization';
import { isServerProfileHomeIdentity, resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { logger } from '@/ui/logger';
import { isPluginError } from '@happier-dev/protocol/plugins/errors';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { doesWorkspaceSyncProjectSourceRequestMatchRouting } from '@/api/machine/machineRpcAuthorization';

type Opened = Extract<OpenProjectResultV1, { kind: 'opened' }>;

/** Host-only composition: setup classification is owned by plan 20, not by Open. */
export type ProjectOpenRuntime = Readonly<{
  serverId: string;
  serverHttpBaseUrl: string;
  machineId: string;
  accountId: string;
  readCredentials(): Promise<StoredCredentials | null>;
  registry?: ScmBackendRegistry;
  privateCheckout?: PrivateProjectCheckoutOpenRuntime;
  /** The Machine isolation policy the receiving admission reads; it places a grantee's own work. */
  readAgentIsolation?: Parameters<typeof isRequesterOwnWorkPlacedOnDaemonForHost>[1];
  setupPreparation?: Pick<ProjectSetupPreparationInput, 'nativeIo' | 'platform'> & Partial<Pick<ProjectSetupPreparationInput,
    'configEnvironment' | 'plugins' | 'successHomeDir'>>;
  /** The admitted requester's installed Project runtime: its own saved secrets, never the Machine custodian's. */
  resolveProjectRuntime?(context: RpcHandlerContext): Promise<ProjectRequesterSecretRuntime | null>;
  /** Existing daemon Sync preparation, including its transport and root custody. */
  workspaceSyncAdapter?: WorkspaceSyncHandoffAdapter;
  /** The daemon retains the native namespace; host filesystem preparation never handles it. */
  materializeManagedProjectTarget?(input: OpenProjectInputV1, context: RpcHandlerContext): Promise<OpenProjectResultV1>;
  openManagedProjectWorkspace?(request: Readonly<{
    workspace: Pick<ManagedWorkspaceLocatorV2, 'serverId' | 'managedId' | 'controller' | 'rootPath'>;
    requesterAccountId: string;
    lifetime: AbortSignal;
  }>): Promise<Parameters<typeof registerManagedWorkspaceTarget>[0]['target']>;
  /** Installed host key lends transport signatures, never requester authority. */
  requesterMachineRpcSigning?: Readonly<{ installationId: string; privateKey: ExternalActionMachineRequestSigningKey }>;
  /** The chosen installed child forwards only its admitted original Project SOURCE purpose. */
  callWorkspaceSource?: (input: Readonly<{ machineId: string; operationId: string;
    sourceWorkspace: import('@happier-dev/protocol/workspaces/workspaceRefV1').WorkspaceRefV1;
    request: OpenProjectInputV1; context: RpcHandlerContext }>) => Promise<unknown>;
}>;

function privateExecutionDiagnostic(error: unknown, code?: string): Readonly<{ reason: string; phase: string }> | undefined {
  const details = error && typeof error === 'object' && 'details' in error ? error.details : undefined;
  if (details && typeof details === 'object' && 'phase' in details && typeof details.phase === 'string'
    && 'reason' in details && typeof details.reason === 'string') return { reason: details.reason, phase: details.phase };
  if (code && (code.startsWith('workspace_private_checkout_') || code === 'requester_authority_unavailable'
    || code === 'session_requester_unavailable')) return { reason: code, phase: 'native_execution_admission' };
  return undefined;
}
function projectRefusal(code: string, error?: unknown): Extract<OpenProjectResultV1, { kind: 'refused' }> {
  let refusal: Extract<OpenProjectResultV1, { kind: 'refused' }> = { kind: 'refused', code };
  if (error && typeof error === 'object') {
    const failure = normalizeActionExecutorThrownError(error, 'projects.open');
    const details = failure.details;
    const result = OpenProjectResultV1Schema.safeParse({ kind: 'refused', code,
      ...('details' in error && error.details && typeof error.details === 'object' && 'destinationReview' in error.details
        ? { destinationReview: error.details.destinationReview } : {}),
      failureCause: failure.failureCause,
      ...(details && typeof details === 'object' && 'kind' in details && details.kind === 'managedNative' && 'nativeCause' in details
        ? { nativeCause: details.nativeCause } : {}),
      ...('retryNotBeforeMs' in error && error.retryNotBeforeMs !== undefined ? { retryNotBeforeMs: error.retryNotBeforeMs } : {}),
      ...('remediation' in error && error.remediation !== undefined ? { remediation: error.remediation } : {}),
    });
    if (result.success && result.data.kind === 'refused') refusal = result.data;
  }
  logger.warnLocalFile('[Project Open] Refused', { code, ...privateExecutionDiagnostic(error, code),
    ...(refusal.nativeCause ? { nativeCause: refusal.nativeCause } : {}) });
  return refusal;
}
function unconfirmedOutcome(reason: string, operationId?: string): Extract<OpenProjectResultV1, { kind: 'outcomeUnknown' }> {
  logger.warnLocalFile('[Project Open] Outcome unknown', { reason, ...(operationId ? { operationId } : {}) });
  return { kind: 'outcomeUnknown', ...(operationId ? { operationId } : {}) };
}
function codeOf(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : 'project_open_unavailable';
}
type ProjectRequester = Readonly<{
  rows: ProjectAccountRowsInput;
  credentials: StoredCredentials | null;
  externalAction?: NonNullable<Parameters<typeof callExactMachineRpc>[0]['externalAction']>;
  sessionProjectFiles?: true;
}>;
async function resolveProjectRequester(runtime: ProjectOpenRuntime, context: RpcHandlerContext): Promise<ProjectRequester> {
  const fail = (code: string, reason: string): never => {
    throw Object.assign(new Error(code), { code, details: { reason, phase: 'requester_projection' } });
  };
  const admission = context.machineAdmission!;
  if (context.sessionProjectOpenRows) {
    return { rows: { ...context.sessionProjectOpenRows, signal: context.signal },
      credentials: context.sessionProjectOpenRows.credentials, sessionProjectFiles: true };
  }
  const authorization = context.callerInputAuthorization;
  if (authorization) {
    const account = authorization.requesterAccountProjection;
    const http = authorization.requesterHttpProjection;
    if (!account) return fail('requester_authority_unavailable', 'requester_account_projection_missing');
    if (!http) return fail('requester_authority_unavailable', 'requester_http_projection_missing');
    // The admitted HTTP projection owns Account and installed-host currentness.
    // Physical execution identity is reconciled by selectHostRequesterExecutionIdentity.
    if (context.signal.aborted || !await http.isCurrent()) return fail('requester_authority_unavailable', 'requester_projection_not_current');
    const bootstrap = context.requesterSessionBootstrap;
    return { rows: { authorization, effectActionId: 'projects.open', serverId: runtime.serverId, signal: context.signal },
      credentials: bootstrap?.credentials ?? readRequesterAccountActionContext(authorization)?.credentials ?? null,
      ...(runtime.requesterMachineRpcSigning ? { externalAction: { ...runtime.requesterMachineRpcSigning, effectActionId: 'projects.open',
        context: { externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target,
          serverId: runtime.serverId, authority: context.callerAuthority, signal: context.signal,
          ...(authorization.binding.sessionActionSource ? { defaultSessionMachineId: authorization.binding.sessionActionSource.machineId } : {}),
        } } } : {}) };
  }
  if (context.callerAuthority !== 'present_user' || context.callerInputConstraints || context.sessionActionOrigin
    || context.authorization || context.localActionContext) return fail('requester_authority_unavailable', 'native_requester_not_present_owner');
  if (admission.actorAccountId !== runtime.accountId || admission.custodianAccountId !== runtime.accountId) return fail('requester_account_unavailable', 'native_requester_account_mismatch');
  const credentials = await runtime.readCredentials();
  if (!credentials || readAccountIdFromToken(credentials.token) !== runtime.accountId) return fail('requester_account_unavailable', 'native_requester_credentials_unavailable');
  return { rows: { credentials, serverId: runtime.serverId, signal: context.signal }, credentials };
}

function shouldListOpenedProject(requester: ProjectRequester): boolean {
  // A reviewed child of another Action keeps its parent binding and stays a Session folder.
  return !requester.sessionProjectFiles
    && (!requester.rows.authorization || isProjectWorkspaceSyncOpenActionV1(requester.rows.authorization.binding.actionId));
}

async function listOpenedProject(requester: ProjectRequester, ref: WorkspaceRefV1, signal: AbortSignal): Promise<void> {
  if (!shouldListOpenedProject(requester)) return;
  await mutateProjectAccountOrganization({ ...requester.rows, serverId: ref.serverId, projectKey: ref.projectKey ?? ref.id,
    mutate: value => value.hidden === false ? value : { ...value, hidden: false } }).catch(error => {
    signal.throwIfAborted();
    logger.warnLocalFile('[Project Open] Listing unavailable', { code: codeOf(error) });
  });
}

function admitOpenSource(input: OpenProjectInputV1 & { source: Extract<OpenProjectInputV1['source'], { kind: 'source' }> },
  runtime: ProjectOpenRuntime, requester: ProjectRequester, context: RpcHandlerContext) {
  const transport = createCliProjectSourceActionDeps({ serverHttpBaseUrl: runtime.serverHttpBaseUrl,
    admitAccount: serverId => serverId === runtime.serverId ? null
      : { ok: false, errorCode: 'target_mismatch', error: 'target_mismatch' },
    resolveRequestHeaders: async (_context, _actionId, request) => requester.rows.authorization
      ? requester.rows.authorization.requesterHttpProjection!.createRequestHeaders({ ...request,
        effectActionId: 'projects.open', signal: context.signal })
      : { Authorization: `Bearer ${requester.credentials!.token}` },
  });
  return admitProjectSourceSelectionV1({ serverId: runtime.serverId, sourceId: input.source.id,
    captured: input.source, ref: input.ref, subdir: input.subdir, signal: context.signal,
    readSource: async request => {
      context.signal.throwIfAborted();
      return transport.projectSourcesRead!(request, { authority: context.callerAuthority, signal: context.signal });
    },
  });
}

/** Account row acceptance is the only writer; SCM/Sync remain the checkout effect owners. */
export async function openProject(input: OpenProjectInputV1, runtime: ProjectOpenRuntime, context?: RpcHandlerContext,
  operationAcceptance?: NonNullable<RpcHandlerContext['localActionContext']>['operationAcceptance']): Promise<OpenProjectResultV1> {
  let effectsIssued = false;
  let copyOnceBaseline: Opened['copyOnceBaseline'];
  let copyOnceExcludedPaths: Opened['copyOnceExcludedPaths'];
  const refused = (code: string, error?: unknown): Extract<OpenProjectResultV1, { kind: 'refused' }> =>
    ({ ...projectRefusal(code, error), effectAttempted: effectsIssued,
      ...(code === 'workspace_private_checkout_required' ? { remediation: {
        kind: 'confirmation_required' as const, action: 'projects.open',
        label: 'This Machine requires your own private checkout. Open the repository with projects.open using clone, review your private destination, then open that checkout. A folder or another person’s checkout cannot be attached.',
      } } : {}) });
  const acceptance = operationAcceptance ?? context?.localActionContext?.operationAcceptance;
  // Observation metadata is not requester custody: keep authenticated ingress
  // intact rather than synthesizing a local Action invocation to carry the id.
  const outcomeUnknown = (reason: string) => unconfirmedOutcome(reason,
    acceptance?.actionId === 'projects.open' ? acceptance.operationId : undefined);
  const homeId = await resolveServerProfileHomeIdentityId(runtime.serverId);
  if (!homeId || input.machineId !== runtime.machineId || !await isServerProfileHomeIdentity(runtime.serverId, input.serverId)) return refused('target_mismatch');
  // Requester custody/credentials retain the local profile scope. Workspace and
  // Source effects use the exact saved Home identity even for a local-profile selector.
  const authorityRuntime = runtime;
  runtime = { ...runtime, serverId: homeId };
  // No local invocation or owner comparison can replace current authenticated ingress admission.
  const admission = context?.machineAdmission;
  if (!admission || admission.machineId !== runtime.machineId || !context?.verifyMachineAdmissionCurrent) return refused('machine_admission_unavailable');
  if (input.materialization.kind === 'sync' && !runtime.workspaceSyncAdapter) return refused('workspace_sync_unavailable');
  if (input.source.kind !== 'source' && (input.source.kind === 'repository') !== (input.materialization.kind === 'clone')) return refused('invalid_materialization');

  let privateCheckout: Awaited<ReturnType<typeof preparePrivateProjectOpenCheckout>> | undefined;
  let retainedRequesterCustody: RetainedRequesterAccountCustody | undefined;
  let privateSyncOperationId: string | undefined;
  let relationshipRetained = false;
  let managedTargetLifetime: AbortController | undefined;
  let managedTargetRetained = false;
  try {
    context.signal.throwIfAborted();
    if (!await context.verifyMachineAdmissionCurrent()) return refused('machine_access_denied');
    if (input.materialization.kind === 'sync' && input.materialization.targetManaged) {
      if (!runtime.materializeManagedProjectTarget) return refused('workspace_sync_unavailable');
      return await runtime.materializeManagedProjectTarget({ ...input, serverId: homeId }, context);
    }
    const requester = await resolveProjectRequester(authorityRuntime, context);
    const sourceAddress = input.materialization.kind === 'attach' && input.source.kind === 'workspace'
      && input.source.checkout && isManagedWorkspaceRefV2(input.source.checkout)
      ? { ...input.source.checkout, serverId: homeId } : undefined;
    const targetManaged = input.materialization.kind === 'attach' ? input.materialization.targetManaged : undefined;
    const destination = targetManaged ?? sourceAddress;
    if (destination) {
      if (!runtime.openManagedProjectWorkspace) return refused('workspace_target_unavailable');
      if (destination.controller.machineId !== runtime.machineId) return refused('source_machine_mismatch');
      const acceptedSource = sourceAddress
        ? await readAcceptedManagedWorkspaceRefFromRows(requester.rows, runtime.serverHttpBaseUrl, sourceAddress) : undefined;
      if (sourceAddress && !acceptedSource) return refused('workspace_unavailable');
      const selectedPath = acceptedSource?.ref.rootPath ?? (input.source.kind === 'folder' ? input.source.path : undefined);
      if (!selectedPath || !posix.isAbsolute(selectedPath)) return refused('workspace_target_unavailable');
      const rootPath = posix.normalize(selectedPath);
      const directory = mapHolderWorkspacePath(rootPath, rootPath, input.subdir ?? '');
      managedTargetLifetime = new AbortController();
      const cancel = () => managedTargetLifetime?.abort(context.signal.reason);
      context.signal.addEventListener('abort', cancel, { once: true });
      try {
        context.signal.throwIfAborted();
        const locator = { managedId: destination.managedId, controller: destination.controller, serverId: homeId, rootPath };
        const target = await runtime.openManagedProjectWorkspace({ workspace: locator,
          requesterAccountId: admission.actorAccountId, lifetime: managedTargetLifetime.signal });
        const signal = AbortSignal.any([target.lifetime, context.signal]);
        const argv = [target.holderPath, 'workspace', '--root', rootPath];
        // Tie the validated holder channel to target.lifetime so it can be handed off warm to the registry.
        let channelHandedOff = false;
        const channel = target.openChannel(argv, target.lifetime);
        const abortOpen = () => { if (!channelHandedOff) channel.end(); };
        context.signal.addEventListener('abort', abortOpen, { once: true });
        try {
          const holder = openSessionHolderWorkspaceChannel(channel);
          const source = createHolderWorkspaceSource({ id: destination.managedId, rootPath,
            holder, helperPath: target.helperPath });
          if (!(await source.stat(directory)).isDirectory()) return refused('workspace_target_unavailable');
          signal.throwIfAborted();
          return await runWithServerHttpBaseUrl(runtime.serverHttpBaseUrl, async () => {
            if (acceptedSource && sourceAddress) {
              const ref = acceptedSource.ref;
              managedTargetRetained = registerManagedWorkspaceTarget({ workspace: sourceAddress,
                requesterAccountId: admission.actorAccountId, target, initialChannel: { channel, holder } });
              channelHandedOff = managedTargetRetained;
              await listOpenedProject(requester, ref, signal);
              return { kind: 'opened', workspace: sourceAddress, directory, setup: 'notRequired',
                facts: { projectKey: ref.projectKey ?? ref.id,
                  ...(ref.repositoryIdentity ? { repositoryIdentity: ref.repositoryIdentity } : {}),
                  ...(ref.source ? { source: ref.source } : {}) } };
            }
            let acceptedRefId: string | undefined;
            effectsIssued = true;
            const accepted = await createProjectAccountSnapshotMutation(requester.rows)(current => {
              signal.throwIfAborted();
              const materialized = materializeWorkspaceRefForManagedRoot(current.workspaceRefs, {
                ...locator, nowMs: Date.now(), createId: randomUUID,
              });
              acceptedRefId = materialized.workspaceRef.id;
              return { ...current, workspaceRefs: materialized.workspaceRefs };
            }, signal, shouldListOpenedProject(requester) ? {
              ensureProjectListed: next => {
                const row = next.workspaceRefs.find(item => item.id === acceptedRefId);
                return row ? { serverId: row.serverId, projectKey: row.projectKey ?? row.id } : null;
              },
            } : undefined);
            if (accepted.status !== 'applied' && accepted.status !== 'unchanged') return outcomeUnknown(`Account row acceptance returned ${accepted.status}`);
            const ref = accepted.snapshot.workspaceRefs.find(row => row.id === acceptedRefId);
            if (!ref || !isManagedWorkspaceRefV2(ref)) return outcomeUnknown('Managed Workspace row was absent from accepted Account rows');
            const workspace = workspaceAddressFromRefV2(ref);
            if (workspace.kind !== 'managed') return outcomeUnknown('Managed Workspace address was unavailable');
            managedTargetRetained = registerManagedWorkspaceTarget({ workspace, requesterAccountId: admission.actorAccountId,
              target, initialChannel: { channel, holder } });
            channelHandedOff = managedTargetRetained;
            if (!accepted.projectListed) await listOpenedProject(requester, ref, signal);
            return { kind: 'opened', workspace, directory, setup: 'notRequired', facts: { projectKey: ref.projectKey ?? ref.id } };
          });
        } finally {
          context.signal.removeEventListener('abort', abortOpen);
          if (!channelHandedOff) channel.end();
        }
      } finally { context.signal.removeEventListener('abort', cancel); }
    }
    const executionIdentity = selectHostRequesterExecutionIdentity({ rpcContext: context, hostHomeServerIdentityId: homeId,
      sessionRequester: context.requesterSessionBootstrap?.attribution,
      sessionRequesterHomeServerIdentityId: context.requesterSessionBootstrap?.homeServerIdentityId });
    if (executionIdentity.kind === 'unknown') return refused(executionIdentity.reason);
    const selectedFolder = input.source.kind === 'folder' ? input.source.path
      : input.source.kind === 'source' ? input.source.checkoutPath : undefined;
    // Where the owner turned isolation off, a guest's own Project opens on the daemon like their Agent runs.
    const usesOwnerRoot = isHostRequesterUnrestrictedOwner(executionIdentity)
      || isRequesterOwnWorkPlacedOnDaemonForHost(executionIdentity, runtime.readAgentIsolation)
      || selectedFolder !== undefined && input.materialization.kind === 'attach'
        && executionIdentity.requester.accountId === admission.custodianAccountId;
    const ownerCloneAccount = usesOwnerRoot && input.materialization.kind === 'clone' ? input.materialization.gitAccount : undefined;
    // Native Machine management does not grant access to the daemon Account's GitHub connection.
    if (ownerCloneAccount && executionIdentity.requester.accountId !== runtime.accountId)
      return refused(SCM_OPERATION_ERROR_CODES.REMOTE_AUTH_REQUIRED);
    // Verified ingress admits this finite operation once. Its captured identity
    // remains local; cancellation and the native lifetime retire ongoing work.
    if (!usesOwnerRoot && !runtime.privateCheckout) return refused('workspace_private_checkout_required');
    const privateSync = !usesOwnerRoot && input.materialization.kind === 'sync';
    const credentials = requester.credentials;
    return await runWithServerHttpBaseUrl<Promise<OpenProjectResultV1>>(runtime.serverHttpBaseUrl, async () => {
      let selector = input.source.kind === 'repository' ? input.source.selector : undefined;
      let ref = input.ref;
      let subdir = input.subdir;
      let sourceProvenance: WorkspaceProjectFactsV1['source'];
      if (input.source.kind === 'source') {
        const admitted = await admitOpenSource({ ...input, source: input.source }, runtime, requester, context);
        if (admitted.kind === 'refused') return refused(admitted.code);
        selector = admitted.selector; ref = admitted.ref; subdir = admitted.subdir;
        sourceProvenance = { sourceId: input.source.id, revision: admitted.sourceRevision };
      }
      let snapshot = await readProjectAccountRows({ ...requester.rows,
        selection: { kinds: input.materialization.kind === 'sync' ? ['workspace-ref', 'relationship-graph'] : ['workspace-ref'] } });
      let sourceDirectory: string | undefined;
      let sourceRootPath: string | undefined;
      let sourceMachineId = runtime.machineId;
      let sourceWorkspaceRefId: string | undefined;
      let managedCopySource: ManagedWorkspaceRefV2 | undefined;
      let facts: WorkspaceProjectFactsV1 = {};
      let parentWorkspace: WorkspaceAddressV1 | undefined;
      if (selectedFolder !== undefined) {
        sourceDirectory = sourceRootPath = selectedFolder;
        if (input.materialization.kind === 'attach') sourceWorkspaceRefId = resolveWorkspaceRefForMachineRoot(snapshot.workspaceRefs,
          { serverId: runtime.serverId, machineId: runtime.machineId, rootPath: sourceRootPath })?.id;
      } else if (input.source.kind === 'workspace' || input.source.kind === 'source' && input.materialization.kind !== 'clone') {
        const selected = input.source.kind === 'workspace' ? input.source.checkout ?? { serverId: runtime.serverId, id: input.source.workspaceId }
          : input.source.checkout;
        if (!selected) return refused('workspace_unavailable');
        const source = resolveWorkspaceRefV1(snapshot.workspaceRefs, selected.serverId === authorityRuntime.serverId
          ? { ...selected, serverId: runtime.serverId } : selected);
        if (source.kind === 'ambiguous') return { kind: 'ambiguous', candidates: [...source.candidates] };
        if (source.kind !== 'resolved') return refused('workspace_unavailable');
        if (isManagedWorkspaceRefV2(source.ref)) {
          if (input.materialization.kind !== 'sync' || input.materialization.workspaceAction.kind !== 'copy_once'
            || privateSync || source.ref.controller.machineId !== runtime.machineId) {
            return refused('workspace_managed_target_required');
          }
          managedCopySource = source.ref;
        }
        sourceMachineId = resolveWorkspaceSyncExecutionMachineIdV1(source.ref);
        if (input.materialization.kind !== 'sync' && sourceMachineId !== runtime.machineId) return refused('source_machine_mismatch');
        sourceDirectory = sourceRootPath = source.ref.rootPath;
        sourceWorkspaceRefId = source.ref.id;
        if (input.materialization.kind === 'worktree') parentWorkspace = workspaceAddressFromRefV1(source.ref);
        facts = { ...(source.ref.repositoryIdentity ? { repositoryIdentity: source.ref.repositoryIdentity } : {}),
          ...(source.ref.source ? { source: source.ref.source } : {}) };
      }
      if (sourceProvenance) facts = { ...facts, source: sourceProvenance };
      if (!usesOwnerRoot) {
        const { preparePrivateProjectOpenCheckout } = await import('./privateProjectOpenCheckout');
        // The actual existing invocation lifetime names transient native material;
        // neither a new Session nor another Account/checkout identity is minted.
        const materializationKey = context.localActionContext?.actionRequestId ?? context.transportRequestId
          ?? context.callerInputAuthorization?.binding.requestId;
        if (!materializationKey || input.materialization.kind !== 'clone'
          && !(input.materialization.kind === 'worktree' && sourceWorkspaceRefId)
          && !(input.materialization.kind === 'attach' && (sourceWorkspaceRefId || selectedFolder !== undefined))
          && !(input.materialization.kind === 'sync' && sourceWorkspaceRefId && runtime.workspaceSyncAdapter?.preparePrivateExecution))
          return refused('workspace_private_checkout_required');
        const requesterAccount = readRequesterAccountActionContext(context.callerInputAuthorization
          ?? context.localActionContext?.externalActionExecutionAuthorization) ?? undefined;
        if (privateSync) {
          if (!credentials || !requesterAccount?.retainCustody) return refused('requester_authority_unavailable');
          retainedRequesterCustody = requesterAccount.retainCustody();
        }
        const privateRequest = input.materialization.kind === 'clone' && selector
          ? { ...input, source: { kind: 'repository' as const, selector }, ref, subdir }
          : (input.materialization.kind === 'attach' || input.materialization.kind === 'sync' || input.materialization.kind === 'worktree') && sourceWorkspaceRefId
            ? { ...input, ...(input.source.kind === 'source' && input.source.checkoutPath !== undefined ? { subdir } : {}),
              source: { kind: 'workspace' as const, workspaceId: sourceWorkspaceRefId } }
            : input.materialization.kind === 'attach' && selectedFolder !== undefined
              ? { ...input, subdir, source: { kind: 'folder' as const, path: selectedFolder } } : input;
        privateCheckout = await preparePrivateProjectOpenCheckout({ runtime: runtime.privateCheckout!,
          ingress: context,
          requesterAccount, ...(retainedRequesterCustody ? { retainedRequesterCustody } : {}),
          request: privateRequest, requesterIdentity: executionIdentity, workspaceRefs: snapshot.workspaceRefs,
          existingWorkspaceRefId: input.materialization.kind === 'sync'
            ? resolveWorkspaceRefForMachineRoot(snapshot.workspaceRefs, { serverId: runtime.serverId,
              machineId: runtime.machineId, rootPath: input.materialization.targetPath })?.id : sourceWorkspaceRefId,
          materializationKey, signal: context.signal,
          onEffectsIssued: () => { effectsIssued = true; } });
        if (input.materialization.kind === 'attach' && sourceRootPath !== privateCheckout.prepared.rootPath)
          return refused('workspace_private_checkout_required');
        if (privateSync) {
          const projected = materializeWorkspaceRefForMachineRoot(snapshot.workspaceRefs, { serverId: runtime.serverId,
            machineId: runtime.machineId, rootPath: privateCheckout.prepared.rootPath, ...facts,
            nowMs: Date.now(), createId: () => privateCheckout!.prepared.workspaceRefId });
          snapshot = { ...snapshot, workspaceRefs: projected.workspaceRefs };
        }
      }
      // Native selection/acquisition happens before Open. Qualify only the
      // caller's chosen Machine; a manifest cannot redirect browse acceptance.
      const receivingMachineId = readHostReviewedChildReceivingAdmissionV1(context.reviewedChildActionContext)?.machineId;
      const needsSyncMapping = input.materialization.kind === 'sync' && !managedCopySource
        && (input.materialization.workspaceAction.kind === 'copy_once' || input.materialization.workspaceAction.kind === 'create_relationship');
      const combinedPhysicalRead = !requester.rows.authorization && needsSyncMapping && Boolean(sourceRootPath);
      const children = await readWorkspaceSyncChildMachineFacts({ serverId: runtime.serverId,
        relationshipId: requester.rows.authorization?.binding.workspaceSyncAdmission?.relationshipId,
        serverHttpBaseUrl: runtime.serverHttpBaseUrl, ...(credentials ? { credentials } : {}),
        machineIds: combinedPhysicalRead ? [runtime.machineId, sourceMachineId] : [runtime.machineId],
        ...(requester.rows.authorization ? { authorization: requester.rows.authorization, effectActionId: 'projects.open', externalAction: requester.externalAction } : {}),
        ...(receivingMachineId === runtime.machineId ? { receivingMachineId } : {}),
        purpose: combinedPhysicalRead ? 'physical_sync' : 'child_namespace', signal: context.signal });
      const child = children.find(fact => fact.machineId === runtime.machineId);
      if (child?.managedMachine && !isManagedDevcontainerChildProjectionCurrentV1({ homeId: runtime.serverId,
        machineId: runtime.machineId, projection: child.projection, managedMachine: child.managedMachine })) return refused('workspace_sync_child_unavailable');
      let sync: Parameters<typeof materializeProjectCheckout>[0]['sync'];
      let remoteSyncSource: string | undefined;
      let sameSyncEndpoint = false;
      let admittedSyncSource: import('@happier-dev/protocol/workspaces/workspaceRefV1').WorkspaceRefV1 | undefined;
      if (input.materialization.kind === 'sync') {
        const action = input.materialization.workspaceAction;
        // These existing Sync operations execute under source-host controller custody.
        if (sourceMachineId !== runtime.machineId && (action.kind === 'copy_once' || action.kind === 'create_relationship')) {
          remoteSyncSource = sourceMachineId;
        }
        const target = resolveWorkspaceRefForMachineRoot(snapshot.workspaceRefs, {
          serverId: runtime.serverId, machineId: runtime.machineId, rootPath: input.materialization.targetPath,
        });
        if (!sourceRootPath) return refused('source_unavailable');
        let syncSourceMachineId = sourceMachineId;
        let syncSourceWorkspaceRefId = sourceWorkspaceRefId;
        let syncSourceRootPath = sourceRootPath;
        let syncTarget = target;
        if (!managedCopySource && (action.kind === 'copy_once' || action.kind === 'create_relationship')) {
          const mappingPurpose = requester.rows.authorization ? 'admitted_mapping' as const : 'physical_sync' as const;
          // Reuse the already-read receiving Machine facts; only fetch a distinct remote source under admitted mapping.
          const childMachines = combinedPhysicalRead || sourceMachineId === runtime.machineId
            ? children
            : [...await readWorkspaceSyncChildMachineFacts({ serverId: runtime.serverId,
              relationshipId: requester.rows.authorization?.binding.workspaceSyncAdmission?.relationshipId,
              serverHttpBaseUrl: runtime.serverHttpBaseUrl, purpose: mappingPurpose,
              ...(credentials ? { credentials } : {}), machineIds: [sourceMachineId], signal: context.signal,
              ...(requester.rows.authorization ? { authorization: requester.rows.authorization, effectActionId: 'projects.open', externalAction: requester.externalAction } : {}) }), ...children];
          const source = sourceWorkspaceRefId ? resolveWorkspaceRefV1(snapshot.workspaceRefs, { serverId: runtime.serverId, id: sourceWorkspaceRefId }) : null;
          if (requester.rows.authorization) {
            if (source?.kind !== 'resolved') return refused('workspace_sync_child_unavailable');
            admittedSyncSource = source.ref;
            const sourceAddress = resolveWorkspaceSyncTransportAddress({ namespace: source.ref, childMachines });
            const targetAddress = resolveWorkspaceSyncTransportAddress({ namespace: {
              serverId: runtime.serverId, machineId: runtime.machineId, rootPath: input.materialization.targetPath,
            }, childMachines });
            if (!sourceAddress.ok || !targetAddress.ok) return refused('workspace_sync_child_unavailable');
            // The admitted namespace remains logical. Its current controller is
            // only the transport address; that host qualifies its own source row.
            remoteSyncSource = sourceAddress.address.machineId !== runtime.machineId ? sourceAddress.address.machineId : undefined;
            sameSyncEndpoint = Boolean(target && source.ref.serverId === target.serverId
              && source.ref.machineId === target.machineId && source.ref.rootPath === target.rootPath && source.ref.id === target.id);
          } else if (source?.kind === 'resolved') {
            const endpoint = resolveWorkspaceSyncEndpoint({ workspace: source.ref, workspaceRefs: snapshot.workspaceRefs, childMachines, purpose: mappingPurpose });
            if (!endpoint.ok) return refused(endpoint.code);
            syncSourceMachineId = endpoint.endpoint.machineId;
            syncSourceWorkspaceRefId = endpoint.endpoint.id;
            syncSourceRootPath = endpoint.endpoint.rootPath;
          }
          if (!requester.rows.authorization && target) {
            const endpoint = resolveWorkspaceSyncEndpoint({ workspace: target, workspaceRefs: snapshot.workspaceRefs, childMachines, purpose: mappingPurpose });
            if (!endpoint.ok) return refused(endpoint.code);
            syncTarget = endpoint.endpoint;
          }
          if (!requester.rows.authorization) {
            remoteSyncSource = syncSourceMachineId !== runtime.machineId ? syncSourceMachineId : undefined;
            sameSyncEndpoint = syncTarget !== null && syncSourceWorkspaceRefId === syncTarget.id
              && syncSourceMachineId === syncTarget.machineId && syncSourceRootPath === syncTarget.rootPath;
          }
          if (sameSyncEndpoint && action.kind === 'create_relationship') return refused('workspace_sync_child_unavailable');
          if (sameSyncEndpoint) remoteSyncSource = undefined;
        }
        sync = { adapter: runtime.workspaceSyncAdapter!, context, request: {
          operationId: requester.rows.authorization?.binding.workspaceSyncAdmission
            ? requester.rows.authorization.binding.requestId : randomUUID(), accountServerId: runtime.serverId,
          sourceMachineId: syncSourceMachineId, targetMachineId: syncTarget?.machineId ?? runtime.machineId, sourceRootPath: syncSourceRootPath,
          ...(syncSourceWorkspaceRefId ? { sourceWorkspaceRefId: syncSourceWorkspaceRefId } : {}),
          ...(managedCopySource ? { managedCopySource } : {}),
          ...(syncTarget ? { targetWorkspaceRefId: syncTarget.id } : {}),
        } };
      }
      if (privateSync && input.materialization.kind === 'sync' && sync && privateCheckout
        && credentials && retainedRequesterCustody && executionIdentity.kind === 'isolated') {
        const checkout = privateCheckout;
        const custody = retainedRequesterCustody;
        privateSyncOperationId = sync.request.operationId;
        const { retainPrivateSyncCapture } = await import('./privateProjectOpenCheckout');
        await retainPrivateSyncCapture({ adapter: sync.adapter, checkout, context, snapshot, credentials, executionIdentity,
          syncInput: { ...sync.request, action: input.materialization.workspaceAction,
            targetRootPath: checkout.prepared.rootPath, signal: context.signal },
          accountRowsCustody: { serverId: runtime.serverId,
            accountId: admission.actorAccountId, serverHttpBaseUrl: runtime.serverHttpBaseUrl, isCurrent: custody.isCurrent },
          relationshipCustody: { happyHomeDir: configuration.happyHomeDir, homeServerIdentityId: runtime.serverId,
            machineAdmission: { custodianAccountId: admission.custodianAccountId, role: admission.role } },
          assertTransferCurrent: async () => {
            if (!await custody.isCurrent()) throw Object.assign(new Error('Requester Account custody is unavailable'),
              { code: 'requester_authority_unavailable' });
          },
          onRelationshipRetained: () => { relationshipRetained = true; },
          release: async () => {
            // A finite copy remains Open-owned through native checkout readback.
            // A bound relationship owns the same native lifetime thereafter.
            if (relationshipRetained) { try { await checkout.release(); } finally { await custody.release(); } }
          },
        });
      }
      const mutateProjectRows = createProjectAccountSnapshotMutation(requester.rows);
      const acceptDestination = async (rootPath: string, parentRootPath?: string, listProject = false) => {
        context.signal.throwIfAborted();
        const prepared = privateCheckout?.prepared;
        let acceptedId: string | undefined;
        let created = false;
        // Once submitted, row transport ambiguity or cancellation cannot be described as no effect.
        effectsIssued = true;
        const accepted = await mutateProjectRows(async current => {
          context.signal.throwIfAborted();
          privateCheckout?.validateCurrentRows(current.workspaceRefs);
          const materialized = materializeWorkspaceRefForMachineRoot(current.workspaceRefs, {
            serverId: runtime.serverId, machineId: runtime.machineId, rootPath,
            ...facts, ...(parentWorkspace ? { parentWorkspace } : {}), ...(parentRootPath ? { parentRootPath } : {}),
            nowMs: Date.now(), createId: prepared ? () => prepared.workspaceRefId : randomUUID,
          });
          if (prepared && materialized.workspaceRef.id !== prepared.workspaceRefId)
            throw Object.assign(new Error('Private checkout identity changed'), { code: 'workspace_private_checkout_required',
              details: { reason: 'workspace_private_checkout_required', phase: 'native_execution_admission' } });
          acceptedId = materialized.workspaceRef.id;
          created = materialized.created;
          return { ...current, workspaceRefs: materialized.workspaceRefs };
        }, context.signal, listProject ? {
          ensureProjectListed: next => {
            const row = acceptedId ? resolveWorkspaceRefV1(next.workspaceRefs, {
              serverId: runtime.serverId, workspaceId: acceptedId, machineId: runtime.machineId, rootPath,
            }) : null;
            return row?.kind === 'resolved' ? { serverId: row.ref.serverId, projectKey: row.ref.projectKey ?? row.ref.id } : null;
          },
        } : undefined);
        if (accepted.status !== 'applied' && accepted.status !== 'unchanged')
          return { kind: 'unconfirmed' as const, reason: `Account row acceptance returned ${accepted.status}` };
        const resolved = acceptedId ? resolveWorkspaceRefV1(accepted.snapshot.workspaceRefs, {
          serverId: runtime.serverId, workspaceId: acceptedId, machineId: runtime.machineId, rootPath,
        }) : { kind: 'missing' as const };
        if (resolved.kind !== 'resolved')
          return { kind: 'unconfirmed' as const, reason: `Accepted Workspace row readback was ${resolved.kind}` };
        return { kind: 'accepted' as const, ref: resolved.ref, created, projectListed: accepted.projectListed === true };
      };
      let publishedPreDispatch: WorkspaceRefV1 | undefined;
      context.signal.throwIfAborted();
      if (remoteSyncSource) {
        if (requester.rows.authorization && (!runtime.callWorkspaceSource || !admittedSyncSource || !sync)) {
          return refused('workspace_sync_update_required');
        }
        if (!requester.rows.authorization && !credentials) return refused('requester_account_unavailable');
        const copy = input.materialization.kind === 'sync' && input.materialization.workspaceAction.kind === 'copy_once'
          ? input.materialization : undefined;
        let createdCopyTarget: WorkspaceRefV1 | undefined;
        if (input.materialization.kind === 'sync' && (copy || privateSync && privateCheckout)) {
          // The receiving preflight resolves the selected root in its own rows.
          // Publish this host's identity before the Source asks it to qualify.
          const published = await acceptDestination(privateCheckout?.prepared.rootPath ?? input.materialization.targetPath, undefined, false);
          if (published.kind === 'unconfirmed') return outcomeUnknown(published.reason);
          if (copy && published.created) createdCopyTarget = published.ref;
          publishedPreDispatch = published.ref;
        }
        // Best effort: the Source's refusal is the outcome, so a cleanup
        // failure is logged and never replaces that typed cause.
        const discardRefusedCopyTarget = async () => {
          const row = createdCopyTarget;
          if (!row) return;
          try {
            const removed = await mutateProjectRows(async current => {
              const selected = resolveWorkspaceRefV1(current.workspaceRefs, { serverId: row.serverId, id: row.id });
              if (selected.kind === 'missing') return current;
              if (selected.kind !== 'resolved' || !isDeepStrictEqual(selected.ref, row))
                throw new Error('Copy target Workspace changed before cleanup');
              return { ...current, workspaceRefs: resolveProjectAccountWorkspaceRefRemovalV1(current,
                { serverId: row.serverId, workspaceRefId: row.id }) };
            }, context.signal);
            if (removed.status !== 'applied' && removed.status !== 'unchanged')
              throw new Error(`Copy target cleanup returned ${removed.status}`);
          } catch (error) {
            logger.warnLocalFile('[Project Open] Copy target cleanup failed', { code: codeOf(error),
              workspaceRefId: row.id, message: error instanceof Error ? error.message : String(error) });
          }
        };
        const effectsBeforeSource = effectsIssued;
        effectsIssued = true;
        const sourceMaterialization = await (requester.rows.authorization
          ? runtime.callWorkspaceSource!({ machineId: remoteSyncSource, operationId: sync!.request.operationId,
            sourceWorkspace: admittedSyncSource!, request: input, context })
          : callExactMachineRpc({
          credentials: credentials!, serverUrl: runtime.serverHttpBaseUrl, machineId: remoteSyncSource,
          ...(requester.externalAction ? { externalAction: requester.externalAction } : {}),
          // Physical custody routing never erases the reviewed Source or actual child namespace.
          method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN, request: input,
          requireCurrentMachine: true, timeoutMs: null, signal: context.signal,
        })).catch(async error => {
          if (readRpcRequestDisposition(error) === 'notSent') {
            effectsIssued = effectsBeforeSource;
            await discardRefusedCopyTarget();
          }
          throw error;
        });
        const materialized = ProjectOpenSyncMaterializationResultV1Schema.safeParse(sourceMaterialization);
        if (!materialized.success || materialized.data.kind === 'outcomeUnknown') return outcomeUnknown('Source Sync did not confirm materialization');
        // A definite refusal can retire this Open's new row. An unconfirmed
        // transfer may still be using it, so a retry adopts that same identity.
        if (materialized.data.kind === 'refused') {
          await discardRefusedCopyTarget();
          return refused(materialized.data.code, materialized.data.failureCause
            ? { failureCause: materialized.data.failureCause } : undefined);
        }
        copyOnceBaseline = materialized.data.copyOnceBaseline;
        copyOnceExcludedPaths = materialized.data.copyOnceExcludedPaths;
      }
      if (privateSync && sync && !remoteSyncSource && !sameSyncEndpoint && input.materialization.kind === 'sync') {
        const copyFacts = await materializeWorkspaceSyncForOpen(sync.adapter, { ...sync.request, action: input.materialization.workspaceAction,
          targetRootPath: privateCheckout!.prepared.rootPath, signal: context.signal,
          onEffectsIssued: () => { effectsIssued = true; } }, context);
        copyOnceBaseline = copyFacts.copyOnceBaseline;
        copyOnceExcludedPaths = copyFacts.copyOnceExcludedPaths;
      }
      const checkout = privateCheckout ? await privateCheckout.materialize() : await materializeProjectCheckout((remoteSyncSource || sameSyncEndpoint) && input.materialization.kind === 'sync' ? {
        materialization: { kind: 'attach' }, sourceDirectory: input.materialization.targetPath,
        subdir, signal: context.signal,
      } : {
        materialization: input.materialization,
        sourceDirectory: input.materialization.kind === 'sync' ? sync?.request.sourceRootPath : sourceDirectory,
        sourceRootPath,
        selector, ref, subdir, registry: runtime.registry, signal: context.signal, sync,
        ...(ownerCloneAccount ? { cloneAccountSelection: { account: ownerCloneAccount,
          operationId: acceptance?.operationId ?? context.localActionContext?.actionRequestId
            ?? context.transportRequestId ?? context.callerInputAuthorization?.binding.requestId } } : {}),
        onEffectsIssued: () => { effectsIssued = true; },
      });
      const cloneSource = input.cloneSource ? privateCheckout ? checkout.cloneSource : await readProjectCloneSource({
        directory: checkout.directory, registry: runtime.registry, signal: context.signal,
      }) : undefined;
      if (checkout.repositoryIdentity) facts = { ...facts, repositoryIdentity: checkout.repositoryIdentity };
      let parentRootPath: string | undefined;
      if (!privateCheckout && (input.materialization.kind === 'attach' || input.materialization.kind === 'worktree')) {
        const current = resolveWorkspaceRefForMachineRoot(snapshot.workspaceRefs, {
          serverId: runtime.serverId, machineId: runtime.machineId, rootPath: checkout.rootPath,
        });
        const discoverParent = !parentWorkspace && !current;
        const discoverRepository = input.materialization.kind === 'attach'
          && !facts.repositoryIdentity && !current?.repositoryIdentity;
        const inspected = discoverParent || discoverRepository ? await inspectWorkspaceLocationWithScmWorkspace({
          candidatePath: checkout.rootPath, registry: runtime.registry, signal: context.signal,
          includeRepositoryIdentity: discoverRepository,
        }).catch(error => {
          context.signal.throwIfAborted();
          logger.warnLocalFile('[Project Open] Repository association inspection unavailable', {
            code: codeOf(error), error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }) : null;
        if (inspected) {
          const rootIdentity = resolveCanonicalAbsolutePathComparisonIdentity(checkout.rootPath);
          if (rootIdentity !== null && rootIdentity === resolveCanonicalAbsolutePathComparisonIdentity(inspected.inspection.rootPath)) {
            if (discoverParent) parentRootPath = inspected.parentRootPath;
            if (inspected.repositoryIdentity) facts = { ...facts, repositoryIdentity: inspected.repositoryIdentity };
          }
        }
      }
      context.signal.throwIfAborted();
      const reusePublishedPreDispatch = publishedPreDispatch !== undefined
        && publishedPreDispatch.rootPath === checkout.rootPath
        && !parentRootPath
        && (!checkout.repositoryIdentity || isDeepStrictEqual(publishedPreDispatch.repositoryIdentity, checkout.repositoryIdentity));
      const accepted = reusePublishedPreDispatch
        ? { kind: 'accepted' as const, ref: publishedPreDispatch, projectListed: false }
        : await acceptDestination(checkout.rootPath, parentRootPath, shouldListOpenedProject(requester));
      if (accepted.kind === 'unconfirmed') return outcomeUnknown(accepted.reason);
      const acceptedRef = accepted.ref;
      const workspace = workspaceAddressFromRefV1(acceptedRef);
      if (!accepted.projectListed) await listOpenedProject(requester, acceptedRef, context.signal);
      let setup: Opened['setup'];
      try {
        const projected = projectWorkspaceRefV1(acceptedRef);
        const association = { workspace: acceptedRef, project: { serverId: projected.serverId, projectId: projected.projectKey } };
        // A declared secret is bound from the requester's own saved Secrets, as setup readiness binds it.
        // An unreadable definition is left to the preparation owner, which reports its own refusal.
        const definition = await readProjectEffectiveDefinition({ root: association.workspace.rootPath, account: requester.rows,
          project: association.project, serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal: context.signal }).catch(() => undefined);
        const requirements = definition?.effectiveDefinition.effectiveManifest?.environmentVariables ?? [];
        const projectRuntime = requirements.some(isProjectSecretRequirement)
          ? await runtime.resolveProjectRuntime?.(context) : undefined;
        const secrets = projectRuntime ? await resolveProjectRequesterSecretInputs(projectRuntime,
          { project: association.project, requirements }, context.signal) : undefined;
        const prepared = await prepareProjectSetup({ ...runtime.setupPreparation,
          ...(definition ? { acceptedSetup: definition.acceptedSetup } : {}),
          ...(secrets?.environmentBindings ? { environmentBindings: secrets.environmentBindings } : {}),
          ...(secrets?.secretEnvironment ? { secretEnvironment: secrets.secretEnvironment } : {}),
          requesterIdentity: executionIdentity,
          approvalContext: context.localActionContext,
          workspace: association.workspace, projectAssociation: association,
          requester: { ...(credentials ? { credentials } : {}), serverHttpBaseUrl: runtime.serverHttpBaseUrl,
            ...(requester.rows.authorization ? { authorization: requester.rows.authorization, effectActionId: 'projects.open' } : {}),
            signal: context.signal }, purpose: 'setup',
          nativeIo: runtime.setupPreparation?.nativeIo ?? projectNativeSystemIo,
          platform: runtime.setupPreparation?.platform ?? { os: process.platform === 'win32' ? 'windows' : process.platform, arch: process.arch },
          signal: context.signal,
        });
        // The preparation owner already matched the saved completion against this checkout and its current inputs.
        if (prepared.kind === 'notRequired' || (prepared.kind === 'prepared' && prepared.previousSuccess)) {
          setup = 'notRequired';
        } else {
          setup = prepared.kind === 'pendingApproval' ? 'approvalRequired' : prepared.kind === 'prepared' ? 'prepared' : 'failed';
        }
        if (setup === 'failed') logger.warnLocalFile('[Project Open] Passive setup failed', {
          kind: prepared.kind, ...(prepared.kind === 'refused' ? { code: prepared.code } : {}),
        });
      } catch (error) {
        logger.warnLocalFile('[Project Open] Passive setup failed', { code: codeOf(error),
          error: error instanceof Error ? error.stack ?? error.message : String(error) });
        // Browse acceptance and retained repository bytes do not depend on setup succeeding.
        setup = 'failed';
      }
      context.signal.throwIfAborted();
      return { kind: 'opened', workspace, directory: checkout.directory, setup,
        ...(cloneSource ? { cloneSource } : {}),
        ...((copyOnceBaseline ?? checkout.copyOnceBaseline) ? { copyOnceBaseline: copyOnceBaseline ?? checkout.copyOnceBaseline } : {}),
        ...((copyOnceExcludedPaths ?? checkout.copyOnceExcludedPaths) ? { copyOnceExcludedPaths: copyOnceExcludedPaths ?? checkout.copyOnceExcludedPaths } : {}),
        facts: { projectKey: acceptedRef.projectKey ?? acceptedRef.id,
          ...(acceptedRef.repositoryIdentity ? { repositoryIdentity: acceptedRef.repositoryIdentity } : {}),
          ...(acceptedRef.source ? { source: acceptedRef.source } : {}) } };
    });
  } catch (error) {
    logger.warnLocalFile('[Project Open] Settlement failed', { effectsIssued, code: codeOf(error),
      ...privateExecutionDiagnostic(error, codeOf(error)),
      ...(!privateExecutionDiagnostic(error, codeOf(error))
        ? { error: error instanceof Error ? error.stack ?? error.message : String(error) } : {}) });
    if (isPluginError(error) && error.data.failureCause?.phase === 'project_open.checkout_ref') return refused(error.code, error);
    if (error instanceof WorkspaceSyncPreparationRefusal && !context.signal.aborted) return refused(error.code, error.cause);
    // Raised while materializing, before any Account row is submitted: the checkout is kept and nothing else
    // happened, so the outcome is known even though the clone ran.
    if (codeOf(error) === 'repository_subfolder_missing') return refused('repository_subfolder_missing', error);
    return effectsIssued ? outcomeUnknown('Exception after materialization or row submission') : refused(context.signal.aborted ? 'cancelled' : codeOf(error), context.signal.aborted ? undefined : error);
  } finally {
    if (!managedTargetRetained) managedTargetLifetime?.abort();
    try {
      try {
        const retained = privateSyncOperationId
          ? runtime.workspaceSyncAdapter?.resolvePrivateExecution?.({ operationId: privateSyncOperationId }) : undefined;
        if (retained?.relationshipId) await retained.bindRelationship?.(retained.relationshipId, 'relationship');
        if (!relationshipRetained) {
          try {
            if (privateSyncOperationId) await runtime.workspaceSyncAdapter?.releasePrivateExecution?.(privateSyncOperationId);
          } finally { await retainedRequesterCustody?.release(); }
        }
      } finally { await privateCheckout?.dispose(); }
    } catch (error) {
      // Cleanup is awaited, but cannot replace the already-classified checkout
      // outcome with an untyped rejection after Account/SCM effects settled.
      logger.warnLocalFile('[Project Open] Cleanup failed', {
        code: codeOf(error), ...privateExecutionDiagnostic(error, codeOf(error)),
        ...(!privateExecutionDiagnostic(error, codeOf(error)) ? { phase: 'native_execution_cleanup' } : {}),
      });
    }
  }
}

/** Thin source-host route for the incumbent source-controller-only copy/create operations. */
export async function materializeProjectSyncOnSource(input: OpenProjectInputV1, runtime: ProjectOpenRuntime, context?: RpcHandlerContext): Promise<ProjectOpenSyncMaterializationResultV1> {
  // The wire settlement carries the code and, unchanged, a typed cause its owner attached.
  const refused = (code: string, error?: unknown): ProjectOpenSyncMaterializationResultV1 => {
    projectRefusal(code, error);
    const cause = error && typeof error === 'object' && 'failureCause' in error
      ? ActionFailureCauseV1Schema.safeParse(error.failureCause) : null;
    return { kind: 'refused', code, ...(cause?.success ? { failureCause: cause.data } : {}) };
  };
  const homeId = await resolveServerProfileHomeIdentityId(runtime.serverId);
  if (!homeId || !await isServerProfileHomeIdentity(runtime.serverId, input.serverId)) return refused('target_mismatch');
  if ((input.source.kind !== 'workspace' && input.source.kind !== 'source')
    || input.materialization.kind !== 'sync') return refused('invalid_materialization');
  const authorityRuntime = runtime;
  runtime = { ...runtime, serverId: homeId };
  const admission = context?.machineAdmission;
  const routing = context?.workspaceSyncSourceRouting;
  const originalRoot = context?.callerInputAuthorization;
  if (routing && originalRoot?.binding.actionId === 'projects.open') {
    // Home has admitted the installed chosen child's original packet. This
    // physical writer owns only its qualified source root; the chosen target
    // retains its own namespace and authority through the existing adapter.
    if (!context?.workspaceSyncSourceExecution || !admission || !routing.sourceContext
      || !context.verifyMachineAdmissionCurrent || !runtime.workspaceSyncAdapter
      || (input.materialization.workspaceAction.kind !== 'copy_once' && input.materialization.workspaceAction.kind !== 'create_relationship'
        && input.materialization.workspaceAction.kind !== 'relationship')
      || !doesWorkspaceSyncProjectSourceRequestMatchRouting(input, originalRoot, routing)) {
      return refused('machine_admission_unavailable');
    }
    let issued = false;
    try {
      context.signal.throwIfAborted();
      const selected = input.source.checkout;
      const copyFacts = await materializeWorkspaceSyncForOpen(runtime.workspaceSyncAdapter, { operationId: routing.operationId,
        accountServerId: runtime.serverId, action: input.materialization.workspaceAction,
        sourceMachineId: routing.sourceMachineId, sourceRootPath: routing.sourceRootPath,
        ...(selected ? { sourceWorkspaceRefId: selected.workspaceId } : {}), targetMachineId: input.machineId,
        ...(input.materialization.targetManaged ? { targetManaged: input.materialization.targetManaged } : {}),
        targetRootPath: input.materialization.targetPath, signal: context.signal,
        onEffectsIssued: () => { issued = true; },
      }, context, routing.sourceContext);
      return { kind: 'materialized', ...copyFacts };
    } catch (error) {
      logger.warnLocalFile('[Project Open] Source Sync settlement failed', { effectsIssued: issued, code: codeOf(error),
        error: error instanceof Error ? error.stack ?? error.message : String(error) });
      if (error instanceof WorkspaceSyncPreparationRefusal && !context.signal.aborted) return refused(error.code, error.cause);
      return issued ? unconfirmedOutcome('Source Sync exception after effects') : refused(codeOf(error), error);
    }
  }
  if (!admission || admission.machineId !== runtime.machineId || !context?.verifyMachineAdmissionCurrent) return refused('machine_admission_unavailable');
  const action = input.materialization.workspaceAction;
  if (action.kind !== 'copy_once' && action.kind !== 'create_relationship' && action.kind !== 'relationship') return refused('invalid_materialization');
  let effectsIssued = false;
  try {
    context.signal.throwIfAborted();
    if (!await context.verifyMachineAdmissionCurrent()) return refused('machine_access_denied');
    const requester = await resolveProjectRequester(authorityRuntime, context);
    const credentials = requester.credentials;
    return await runWithServerHttpBaseUrl<Promise<ProjectOpenSyncMaterializationResultV1>>(runtime.serverHttpBaseUrl, async () => {
      if (input.source.kind === 'source') {
        const admitted = await admitOpenSource({ ...input, source: input.source }, runtime, requester, context);
        if (admitted.kind === 'refused') return refused(admitted.code);
      }
      const snapshot = await readProjectAccountRows({ ...requester.rows, selection: { kinds: ['workspace-ref'] } });
      const selected = input.source.kind === 'workspace'
        ? input.source.checkout ?? { serverId: runtime.serverId, id: input.source.workspaceId }
        : input.source.kind === 'source' ? input.source.checkout : undefined;
      if (!selected) return refused('workspace_unavailable');
      const source = resolveWorkspaceRefV1(snapshot.workspaceRefs, selected.serverId === authorityRuntime.serverId
        ? { ...selected, serverId: runtime.serverId } : selected);
      if (source.kind !== 'resolved') return refused('source_machine_mismatch');
      if (isManagedWorkspaceRefV2(source.ref)) return refused('workspace_managed_target_required');
      const managedTarget = input.materialization.kind === 'sync' ? input.materialization.targetManaged : undefined;
      const managedTargetResolution = managedTarget && input.materialization.kind === 'sync'
        ? resolveWorkspaceRefV1(snapshot.workspaceRefs, { v: 2, kind: 'managed', serverId: runtime.serverId,
          ...managedTarget, rootPath: input.materialization.targetPath }) : undefined;
      if (managedTargetResolution?.kind === 'ambiguous' || managedTargetResolution?.kind === 'invalid') return refused('workspace_sync_child_unavailable');
      const target = managedTarget ? managedTargetResolution?.kind === 'resolved' ? managedTargetResolution.ref : undefined
        : resolveWorkspaceRefForMachineRoot(snapshot.workspaceRefs, {
          serverId: runtime.serverId, machineId: input.machineId, rootPath: input.materialization.kind === 'sync' ? input.materialization.targetPath : '',
        });
      const mappingPurpose = requester.rows.authorization ? 'admitted_mapping' as const : 'physical_sync' as const;
      const childMachines = await readWorkspaceSyncChildMachineFacts({ serverId: runtime.serverId,
        relationshipId: requester.rows.authorization?.binding.workspaceSyncAdmission?.relationshipId,
        serverHttpBaseUrl: runtime.serverHttpBaseUrl, purpose: mappingPurpose,
        ...(credentials ? { credentials } : {}), machineIds: [source.ref.machineId, input.machineId], signal: context.signal,
        ...(requester.rows.authorization ? { authorization: requester.rows.authorization, effectActionId: 'projects.open', externalAction: requester.externalAction } : {}) });
      const sourceEndpoint = resolveWorkspaceSyncEndpoint({ workspace: source.ref, workspaceRefs: snapshot.workspaceRefs, childMachines, purpose: mappingPurpose });
      const targetEndpoint = target ? resolveWorkspaceSyncEndpoint({ workspace: target, workspaceRefs: snapshot.workspaceRefs, childMachines, purpose: mappingPurpose }) : undefined;
      if (!sourceEndpoint.ok || targetEndpoint && !targetEndpoint.ok || !target && childMachines.some(child => child.machineId === input.machineId)) {
        return refused('workspace_sync_child_unavailable');
      }
      if (sourceEndpoint.endpoint.machineId !== runtime.machineId) return refused('source_machine_mismatch');
      if (targetEndpoint?.ok && sourceEndpoint.endpoint.id === targetEndpoint.endpoint.id) return action.kind === 'copy_once'
        ? { kind: 'materialized' } : refused('workspace_sync_child_unavailable');
      if (!runtime.workspaceSyncAdapter) return refused('workspace_sync_unavailable');
      context.signal.throwIfAborted();
      const copyFacts = await materializeWorkspaceSyncForOpen(runtime.workspaceSyncAdapter!, {
        operationId: requester.rows.authorization?.binding.workspaceSyncAdmission
          ? requester.rows.authorization.binding.requestId : randomUUID(), accountServerId: runtime.serverId, action,
        // Retain actual aliases until the incumbent Sync adapter derives physical copy custody.
        sourceMachineId: source.ref.machineId, sourceRootPath: source.ref.rootPath, sourceWorkspaceRefId: source.ref.id,
        targetMachineId: input.machineId, targetRootPath: input.materialization.kind === 'sync' ? input.materialization.targetPath : '',
        ...(managedTarget ? { targetManaged: managedTarget } : {}),
        ...(target ? { targetWorkspaceRefId: target.id } : {}), signal: context.signal,
        onEffectsIssued: () => { effectsIssued = true; },
      }, context);
      context.signal.throwIfAborted();
      return { kind: 'materialized', ...copyFacts };
    });
  } catch (error) {
    logger.warnLocalFile('[Project Open] Source Sync settlement failed', { effectsIssued, code: codeOf(error),
      error: error instanceof Error ? error.stack ?? error.message : String(error) });
    if (error instanceof WorkspaceSyncPreparationRefusal && !context.signal.aborted) return refused(error.code, error.cause);
    return effectsIssued ? unconfirmedOutcome('Source Sync exception after effects')
      : context.signal.aborted ? refused('cancelled') : refused(codeOf(error), error);
  }
}
