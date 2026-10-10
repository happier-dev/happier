import { randomUUID } from 'node:crypto';
import { OpenProjectResultV1Schema, ProjectOpenSyncMaterializationResultV1Schema, type ProjectOpenSyncMaterializationResultV1, type OpenProjectInputV1, type OpenProjectResultV1 } from '@happier-dev/protocol/projects/openProjectV1';
import { isManagedDevcontainerChildProjectionCurrentV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import { readWorkspaceSyncChildMachineFacts } from '@/workspaces/sync/workspaceSyncTargetAuthority';
import { resolveCanonicalAbsolutePathComparisonIdentity } from '@/utils/path/expandHomeDirPath';
import { resolveWorkspaceSyncEndpoint, resolveWorkspaceSyncTransportAddress } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { WorkspaceAddressV1, WorkspaceProjectFactsV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { resolveWorkspaceRefV1, workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { StoredCredentials } from '@/persistence';
import type { ScmBackendRegistry } from '@/scm/registry';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readProjectAccountRows, createProjectAccountSnapshotMutation, type ProjectAccountRowsInput } from '@/workspaces/projectAccountRows';
import { materializeWorkspaceRefForMachineRoot, resolveWorkspaceRefForMachineRoot } from '@/workspaces/workspaceRefsV1';
import type { WorkspaceSyncHandoffAdapter } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import { materializeWorkspaceSyncForOpen } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import { assertWorkspaceSyncRequesterBootstrapSupported, WorkspaceSyncInitialPreparationRefusal } from '@/workspaces/sync/workspaceSyncPreparation';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { materializeProjectCheckout } from './materializeProjectCheckout';
import { resolveProjectSetupAcceptedWorkspace } from '@/workspaces/projectSetup/projectSetupAcceptedWorkspace';
import { prepareProjectSetup, type ProjectSetupPreparationInput } from '@/workspaces/projectSetup/projectSetupPreparation';
import { projectNativeSystemIo } from '@/workspaces/projectSetup/projectNativeSystemIo';
import { admitProjectSourceSelectionV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { createCliProjectSourceActionDeps } from '@/session/actions/projectSourceActionDeps';
import type { ExternalActionMachineRequestSigningKey } from '@/api/externalActionExecutionAuthorization';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { logger } from '@/ui/logger';
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
  setupPreparation?: Pick<ProjectSetupPreparationInput, 'nativeIo' | 'platform'> & Partial<Pick<ProjectSetupPreparationInput,
    'environmentBindings' | 'secretEnvironment' | 'configEnvironment' | 'plugins' | 'successHomeDir'>>;
  /** Existing daemon Sync preparation, including its transport and root custody. */
  workspaceSyncAdapter?: WorkspaceSyncHandoffAdapter;
  /** Installed host key lends transport signatures, never requester authority. */
  requesterMachineRpcSigning?: Readonly<{ installationId: string; privateKey: ExternalActionMachineRequestSigningKey }>;
  /** The chosen installed child forwards only its admitted original Project SOURCE purpose. */
  callWorkspaceSource?: (input: Readonly<{ machineId: string; operationId: string;
    sourceWorkspace: import('@happier-dev/protocol/workspaces/workspaceRefV1').WorkspaceRefV1;
    request: OpenProjectInputV1; context: RpcHandlerContext }>) => Promise<unknown>;
}>;

function refused(code: string, error?: unknown): Extract<OpenProjectResultV1, { kind: 'refused' }> {
  logger.warnLocalFile('[Project Open] Refused', { code });
  if (error && typeof error === 'object') {
    const result = OpenProjectResultV1Schema.safeParse({ kind: 'refused', code,
      ...('retryNotBeforeMs' in error ? { retryNotBeforeMs: error.retryNotBeforeMs } : {}),
      ...('remediation' in error ? { remediation: error.remediation } : {}),
    });
    if (result.success && result.data.kind === 'refused') return result.data;
  }
  return { kind: 'refused', code };
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
  isCurrent(): Promise<boolean>;
  externalAction?: NonNullable<Parameters<typeof callExactMachineRpc>[0]['externalAction']>;
}>;
async function resolveProjectRequester(runtime: ProjectOpenRuntime, context: RpcHandlerContext): Promise<ProjectRequester> {
  const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
  const admission = context.machineAdmission!;
  const authorization = context.callerInputAuthorization;
  if (authorization) {
    const account = authorization.requesterAccountProjection;
    const http = authorization.requesterHttpProjection;
    if (!account || !http || authorization.binding.actionId !== 'projects.open'
      || authorization.binding.accountId !== admission.actorAccountId
      || authorization.binding.custodianAccountId !== admission.custodianAccountId
      || authorization.binding.machineId !== admission.machineId || authorization.binding.installationId !== admission.installationId
      || account.accountId !== admission.actorAccountId || http.accountId !== account.accountId
      || account.serverId !== runtime.serverId || http.serverId !== runtime.serverId
      || http.serverHttpBaseUrl.replace(/\/+$/, '') !== runtime.serverHttpBaseUrl.replace(/\/+$/, '')) return fail('requester_authority_unavailable');
    const isCurrent = async () => !context.signal.aborted && await account.isCurrent() && await http.isCurrent();
    if (!await isCurrent()) return fail('requester_authority_unavailable');
    const bootstrap = context.requesterSessionBootstrap;
    if (bootstrap && (bootstrap.attribution.accountId !== account.accountId || bootstrap.attribution.serverId !== runtime.serverId
      || !await bootstrap.isCurrent())) return fail('requester_authority_unavailable');
    return { rows: { authorization, effectActionId: 'projects.open', serverId: runtime.serverId, signal: context.signal },
      credentials: bootstrap?.credentials ?? null, isCurrent,
      ...(runtime.requesterMachineRpcSigning ? { externalAction: { ...runtime.requesterMachineRpcSigning, effectActionId: 'projects.open',
        context: { externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target,
          serverId: runtime.serverId, authority: context.callerAuthority, signal: context.signal,
          ...(authorization.binding.sessionActionSource ? { defaultSessionMachineId: authorization.binding.sessionActionSource.machineId } : {}),
        } } } : {}) };
  }
  if (context.callerAuthority !== 'present_user' || context.callerInputConstraints || context.sessionActionOrigin
    || context.authorization || context.localActionContext) return fail('requester_authority_unavailable');
  if (admission.actorAccountId !== runtime.accountId || admission.custodianAccountId !== runtime.accountId) return fail('requester_account_unavailable');
  const credentials = await runtime.readCredentials();
  if (!credentials || readAccountIdFromToken(credentials.token) !== runtime.accountId) return fail('requester_account_unavailable');
  return { rows: { credentials, serverId: runtime.serverId, signal: context.signal }, credentials,
    isCurrent: async () => (await runtime.readCredentials())?.token === credentials.token };
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
  return admitProjectSourceSelectionV1({ serverId: input.serverId, sourceId: input.source.id,
    captured: input.source, ref: input.ref, subdir: input.subdir, signal: context.signal,
    readSource: async request => {
      if (!await requester.isCurrent() || !await context.verifyMachineAdmissionCurrent!()) {
        return { ok: false, errorCode: 'project_open_scope_changed' };
      }
      return transport.projectSourcesRead!(request, { authority: context.callerAuthority, signal: context.signal });
    },
  });
}

/** Account row acceptance is the only writer; SCM/Sync remain the checkout effect owners. */
export async function openProject(input: OpenProjectInputV1, runtime: ProjectOpenRuntime, context?: RpcHandlerContext,
  operationAcceptance?: NonNullable<RpcHandlerContext['localActionContext']>['operationAcceptance']): Promise<OpenProjectResultV1> {
  const acceptance = operationAcceptance ?? context?.localActionContext?.operationAcceptance;
  // Observation metadata is not requester custody: keep authenticated ingress
  // intact rather than synthesizing a local Action invocation to carry the id.
  const outcomeUnknown = (reason: string) => unconfirmedOutcome(reason,
    acceptance?.actionId === 'projects.open' ? acceptance.operationId : undefined);
  if (input.machineId !== runtime.machineId || !await isServerProfileHomeIdentity(runtime.serverId, input.serverId)) return refused('target_mismatch');
  // Requester custody/credentials retain the local profile scope. Workspace and
  // Source effects use the admitted qualified Home address supplied by the caller.
  const authorityRuntime = runtime;
  if (runtime.serverId !== input.serverId) runtime = { ...runtime, serverId: input.serverId };
  // No local invocation or owner comparison can replace current authenticated ingress admission.
  const admission = context?.machineAdmission;
  if (!admission || admission.machineId !== runtime.machineId || !context?.verifyMachineAdmissionCurrent) return refused('machine_admission_unavailable');
  if (input.materialization.kind === 'sync' && !runtime.workspaceSyncAdapter) return refused('workspace_sync_unavailable');
  if (input.source.kind !== 'source' && (input.source.kind === 'repository') !== (input.materialization.kind === 'clone')) return refused('invalid_materialization');

  let effectsIssued = false;
  try {
    context.signal.throwIfAborted();
    if (!await context.verifyMachineAdmissionCurrent()) return refused('machine_access_denied');
    const requester = await resolveProjectRequester(authorityRuntime, context);
    if (input.materialization.kind === 'sync' && input.materialization.workspaceAction.kind === 'create_relationship') {
      assertWorkspaceSyncRequesterBootstrapSupported({ authorization: context.callerInputAuthorization, ownerKind: 'relationship' });
    }
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
      const snapshot = await readProjectAccountRows(requester.rows);
      let sourceDirectory: string | undefined;
      let sourceRootPath: string | undefined;
      let sourceMachineId = runtime.machineId;
      let sourceWorkspaceRefId: string | undefined;
      let facts: WorkspaceProjectFactsV1 = {};
      let parentWorkspace: WorkspaceAddressV1 | undefined;
      if (input.source.kind === 'workspace' || input.source.kind === 'source' && input.materialization.kind !== 'clone') {
        const selected = input.source.kind === 'workspace' ? input.source.checkout ?? { serverId: runtime.serverId, id: input.source.workspaceId }
          : input.source.checkout;
        if (!selected) return refused('workspace_unavailable');
        const source = resolveWorkspaceRefV1(snapshot.workspaceRefs, selected);
        if (source.kind === 'ambiguous') return { kind: 'ambiguous', candidates: [...source.candidates] };
        if (source.kind !== 'resolved') return refused('workspace_unavailable');
        if (input.materialization.kind !== 'sync' && source.ref.machineId !== runtime.machineId) return refused('source_machine_mismatch');
        sourceDirectory = sourceRootPath = source.ref.rootPath;
        sourceMachineId = source.ref.machineId;
        sourceWorkspaceRefId = source.ref.id;
        facts = { ...(source.ref.repositoryIdentity ? { repositoryIdentity: source.ref.repositoryIdentity } : {}),
          ...(source.ref.source ? { source: source.ref.source } : {}) };
      } else if (input.source.kind === 'folder') {
        sourceDirectory = sourceRootPath = input.source.path;
      }
      if (sourceProvenance) facts = { ...facts, source: sourceProvenance };
      // Native selection/acquisition happens before Open. Qualify only the
      // caller's chosen Machine; a manifest cannot redirect browse acceptance.
      const children = await readWorkspaceSyncChildMachineFacts({ serverId: runtime.serverId,
        serverHttpBaseUrl: runtime.serverHttpBaseUrl, ...(credentials ? { credentials } : {}), machineIds: [runtime.machineId],
        ...(requester.rows.authorization ? { authorization: requester.rows.authorization, effectActionId: 'projects.open', externalAction: requester.externalAction } : {}),
        purpose: 'child_namespace', signal: context.signal });
      const child = children[0];
      if (child && !isManagedDevcontainerChildProjectionCurrentV1({ homeId: runtime.serverId,
        machineId: runtime.machineId, projection: child.projection, managedMachine: child.managedMachine })) return refused('workspace_sync_child_unavailable');
      const acceptsSelectedRoot = (rootPath: string) => {
        if (!child) return true;
        const canonical = resolveCanonicalAbsolutePathComparisonIdentity(rootPath);
        return canonical !== null && canonical === resolveCanonicalAbsolutePathComparisonIdentity(child.projection.observation.workspaceFolder);
      };
      if (child?.projection.observation.storage.kind === 'bind') {
        const parent = resolveWorkspaceRefV1(snapshot.workspaceRefs, { serverId: runtime.serverId,
          machineId: child.managedMachine.controller.machineId, rootPath: child.projection.observation.storage.hostPath });
        if (parent.kind !== 'resolved') return refused('workspace_sync_child_unavailable');
        parentWorkspace = workspaceAddressFromRefV1(parent.ref);
        facts = { ...facts,
          ...(parent.ref.repositoryIdentity ? { repositoryIdentity: parent.ref.repositoryIdentity } : {}),
          ...(parent.ref.source ? { source: parent.ref.source } : {}) };
      }
      if (input.materialization.kind === 'attach' && sourceRootPath) {
        if (!acceptsSelectedRoot(sourceRootPath)) return refused('workspace_sync_child_unavailable');
      }
      if (input.materialization.kind === 'sync') {
        if (!acceptsSelectedRoot(input.materialization.targetPath)) return refused('workspace_sync_child_unavailable');
      }
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
        if (action.kind === 'copy_once' || action.kind === 'create_relationship') {
          const mappingPurpose = requester.rows.authorization ? 'admitted_mapping' as const : 'physical_sync' as const;
          const childMachines = await readWorkspaceSyncChildMachineFacts({ serverId: runtime.serverId,
            serverHttpBaseUrl: runtime.serverHttpBaseUrl, purpose: mappingPurpose,
            ...(credentials ? { credentials } : {}), machineIds: [sourceMachineId, runtime.machineId], signal: context.signal,
            ...(requester.rows.authorization ? { authorization: requester.rows.authorization, effectActionId: 'projects.open', externalAction: requester.externalAction } : {}) });
          const source = sourceWorkspaceRefId ? resolveWorkspaceRefV1(snapshot.workspaceRefs, { serverId: runtime.serverId, id: sourceWorkspaceRefId }) : null;
          if (!requester.rows.authorization && childMachines.some(child => child.projection.observation.storage.kind === 'bind'
            && ((child.machineId === sourceMachineId && source?.kind !== 'resolved') || (child.machineId === runtime.machineId && !target)))) {
            return refused('workspace_sync_child_unavailable');
          }
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
          operationId: randomUUID(), accountServerId: runtime.serverId,
          sourceMachineId: syncSourceMachineId, targetMachineId: syncTarget?.machineId ?? runtime.machineId, sourceRootPath: syncSourceRootPath,
          ...(syncSourceWorkspaceRefId ? { sourceWorkspaceRefId: syncSourceWorkspaceRefId } : {}),
          ...(syncTarget ? { targetWorkspaceRefId: syncTarget.id } : {}),
        } };
      }
      context.signal.throwIfAborted();
      const stillAdmitted = await context.verifyMachineAdmissionCurrent!();
      context.signal.throwIfAborted();
      if (!stillAdmitted) return refused('machine_access_denied');
      if (!await requester.isCurrent()) return refused('project_open_scope_changed');
      if (remoteSyncSource) {
        if (requester.rows.authorization && (!runtime.callWorkspaceSource || !admittedSyncSource || !sync)) {
          return refused('workspace_sync_update_required');
        }
        if (!requester.rows.authorization && !credentials) return refused('requester_account_unavailable');
        effectsIssued = true;
        const materialized = ProjectOpenSyncMaterializationResultV1Schema.safeParse(requester.rows.authorization
          ? await runtime.callWorkspaceSource!({ machineId: remoteSyncSource, operationId: sync!.request.operationId,
            sourceWorkspace: admittedSyncSource!, request: input, context })
          : await callExactMachineRpc({
          credentials: credentials!, serverUrl: runtime.serverHttpBaseUrl, machineId: remoteSyncSource,
          ...(requester.externalAction ? { externalAction: requester.externalAction } : {}),
          // Physical custody routing never erases the reviewed Source or actual child namespace.
          method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN, request: input,
          requireCurrentMachine: true, timeoutMs: null, signal: context.signal,
        }));
        if (!materialized.success || materialized.data.kind === 'outcomeUnknown') return outcomeUnknown('Source Sync did not confirm materialization');
        if (materialized.data.kind === 'refused') return refused(materialized.data.code);
      }
      const checkout = await materializeProjectCheckout((remoteSyncSource || sameSyncEndpoint) && input.materialization.kind === 'sync' ? {
        materialization: { kind: 'attach' }, sourceDirectory: input.materialization.targetPath,
        subdir, signal: context.signal,
      } : {
        materialization: input.materialization,
        sourceDirectory: input.materialization.kind === 'sync' ? sync?.request.sourceRootPath : sourceDirectory,
        sourceRootPath,
        selector, ref, subdir, registry: runtime.registry, signal: context.signal, sync,
        onEffectsIssued: () => { effectsIssued = true; },
      });
      if (!acceptsSelectedRoot(checkout.rootPath)) return refused('workspace_sync_child_unavailable');
      if (checkout.repositoryIdentity) facts = { ...facts, repositoryIdentity: checkout.repositoryIdentity };
      context.signal.throwIfAborted();
      if (!await context.verifyMachineAdmissionCurrent!()) return effectsIssued ? outcomeUnknown('Machine admission changed after materialization') : refused('machine_access_denied');
      let acceptedId: string | undefined;
      // Once submitted, row transport ambiguity or cancellation cannot be described as no effect.
      effectsIssued = true;
      const accepted = await createProjectAccountSnapshotMutation(requester.rows)(async current => {
        if (!await requester.isCurrent() || !await context.verifyMachineAdmissionCurrent!()) {
          throw Object.assign(new Error('Project Open scope is no longer current'), { code: 'project_open_scope_changed' });
        }
        const materialized = materializeWorkspaceRefForMachineRoot(current.workspaceRefs, {
          serverId: runtime.serverId, machineId: runtime.machineId, rootPath: checkout.rootPath,
          ...facts, ...(parentWorkspace ? { parentWorkspace } : {}), nowMs: Date.now(), createId: randomUUID,
        });
        acceptedId = materialized.workspaceRef.id;
        return { ...current, workspaceRefs: materialized.workspaceRefs };
      }, context.signal);
      if (accepted.status !== 'applied' && accepted.status !== 'unchanged') return outcomeUnknown(`Account row acceptance returned ${accepted.status}`);
      const acceptedRef = acceptedId ? resolveWorkspaceRefV1(accepted.snapshot.workspaceRefs, {
        serverId: runtime.serverId, workspaceId: acceptedId, machineId: runtime.machineId, rootPath: checkout.rootPath,
      }) : { kind: 'missing' as const };
      if (acceptedRef.kind !== 'resolved') return outcomeUnknown(`Accepted Workspace row readback was ${acceptedRef.kind}`);
      const workspace = workspaceAddressFromRefV1(acceptedRef.ref);
      let setup: Opened['setup'];
      try {
        const association = await resolveProjectSetupAcceptedWorkspace({ address: workspace, ...requester.rows,
          serverId: runtime.serverId, serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal: context.signal });
        const prepared = await prepareProjectSetup({ ...runtime.setupPreparation,
          workspace: association.workspace, projectAssociation: association,
          requester: { ...(credentials ? { credentials } : {}), serverHttpBaseUrl: runtime.serverHttpBaseUrl,
            ...(requester.rows.authorization ? { authorization: requester.rows.authorization, effectActionId: 'projects.open' } : {}),
            signal: context.signal }, purpose: 'setup',
          nativeIo: runtime.setupPreparation?.nativeIo ?? projectNativeSystemIo,
          platform: runtime.setupPreparation?.platform ?? { os: process.platform === 'win32' ? 'windows' : process.platform, arch: process.arch },
          signal: context.signal,
        });
        // "prepared" is B's reviewed execution plan, never a completion or a launch waiver.
        setup = prepared.kind === 'pendingApproval' ? 'approvalRequired' : prepared.kind === 'notRequired' ? 'notRequired'
          : prepared.kind === 'prepared' ? 'prepared' : 'failed';
        if (setup === 'failed') logger.warnLocalFile('[Project Open] Passive setup failed', { kind: prepared.kind });
      } catch (error) {
        logger.warnLocalFile('[Project Open] Passive setup failed', { code: codeOf(error),
          error: error instanceof Error ? error.stack ?? error.message : String(error) });
        // Browse acceptance and retained repository bytes do not depend on setup succeeding.
        setup = 'failed';
      }
      context.signal.throwIfAborted();
      if (!await requester.isCurrent() || !await context.verifyMachineAdmissionCurrent!()) {
        return outcomeUnknown('Requester or Machine admission changed after row acceptance');
      }
      return { kind: 'opened', workspace, directory: checkout.directory, setup,
        facts: { projectKey: acceptedRef.ref.projectKey ?? acceptedRef.ref.id,
          ...(acceptedRef.ref.repositoryIdentity ? { repositoryIdentity: acceptedRef.ref.repositoryIdentity } : {}),
          ...(acceptedRef.ref.source ? { source: acceptedRef.ref.source } : {}) } };
    });
  } catch (error) {
    logger.warnLocalFile('[Project Open] Settlement failed', { effectsIssued, code: codeOf(error),
      error: error instanceof Error ? error.stack ?? error.message : String(error) });
    if (error instanceof WorkspaceSyncInitialPreparationRefusal) return refused(context.signal.aborted ? 'cancelled' : codeOf(error));
    return effectsIssued ? outcomeUnknown('Exception after materialization or row submission') : refused(context.signal.aborted ? 'cancelled' : codeOf(error), context.signal.aborted ? undefined : error);
  }
}

/** Thin source-host route for the incumbent source-controller-only copy/create operations. */
export async function materializeProjectSyncOnSource(input: OpenProjectInputV1, runtime: ProjectOpenRuntime, context?: RpcHandlerContext): Promise<ProjectOpenSyncMaterializationResultV1> {
  if (!await isServerProfileHomeIdentity(runtime.serverId, input.serverId)) return refused('target_mismatch');
  if ((input.source.kind !== 'workspace' && input.source.kind !== 'source')
    || input.materialization.kind !== 'sync') return refused('invalid_materialization');
  const authorityRuntime = runtime;
  if (runtime.serverId !== input.serverId) runtime = { ...runtime, serverId: input.serverId };
  const admission = context?.machineAdmission;
  const routing = context?.workspaceSyncSourceRouting;
  const originalRoot = context?.callerInputAuthorization;
  if (routing && originalRoot?.binding.actionId === 'projects.open') {
    // Home has admitted the installed chosen child's original packet. This
    // physical writer owns only its qualified source root; the chosen target
    // retains its own namespace and authority through the existing adapter.
    if (!context?.workspaceSyncSourceExecution || !admission || !routing.sourceContext
      || !context.verifyMachineAdmissionCurrent || !runtime.workspaceSyncAdapter
      || (input.materialization.workspaceAction.kind !== 'copy_once' && input.materialization.workspaceAction.kind !== 'create_relationship')
      || !doesWorkspaceSyncProjectSourceRequestMatchRouting(input, originalRoot, routing)) {
      return refused('machine_admission_unavailable');
    }
    let issued = false;
    try {
      context.signal.throwIfAborted();
      if (!await context.verifyMachineAdmissionCurrent()) return refused('machine_access_denied');
      const selected = input.source.checkout;
      issued = true;
      await materializeWorkspaceSyncForOpen(runtime.workspaceSyncAdapter, { operationId: routing.operationId,
        accountServerId: input.serverId, action: input.materialization.workspaceAction,
        sourceMachineId: routing.sourceMachineId, sourceRootPath: routing.sourceRootPath,
        ...(selected ? { sourceWorkspaceRefId: selected.workspaceId } : {}), targetMachineId: input.machineId,
        targetRootPath: input.materialization.targetPath, signal: context.signal,
      }, context, routing.sourceContext);
      return { kind: 'materialized' };
    } catch (error) {
      logger.warnLocalFile('[Project Open] Source Sync settlement failed', { effectsIssued: issued, code: codeOf(error),
        error: error instanceof Error ? error.stack ?? error.message : String(error) });
      return issued ? unconfirmedOutcome('Source Sync exception after effects') : refused(codeOf(error));
    }
  }
  if (!admission || admission.machineId !== runtime.machineId || !context?.verifyMachineAdmissionCurrent) return refused('machine_admission_unavailable');
  const action = input.materialization.workspaceAction;
  if (action.kind !== 'copy_once' && action.kind !== 'create_relationship') return refused('invalid_materialization');
  let effectsIssued = false;
  try {
    context.signal.throwIfAborted();
    if (!await context.verifyMachineAdmissionCurrent()) return refused('machine_access_denied');
    const requester = await resolveProjectRequester(authorityRuntime, context);
    if (action.kind === 'create_relationship') {
      assertWorkspaceSyncRequesterBootstrapSupported({ authorization: context.callerInputAuthorization, ownerKind: 'relationship' });
    }
    const credentials = requester.credentials;
    return await runWithServerHttpBaseUrl<Promise<ProjectOpenSyncMaterializationResultV1>>(runtime.serverHttpBaseUrl, async () => {
      if (input.source.kind === 'source') {
        const admitted = await admitOpenSource({ ...input, source: input.source }, runtime, requester, context);
        if (admitted.kind === 'refused') return refused(admitted.code);
      }
      const snapshot = await readProjectAccountRows(requester.rows);
      const selected = input.source.kind === 'workspace'
        ? input.source.checkout ?? { serverId: runtime.serverId, id: input.source.workspaceId }
        : input.source.kind === 'source' ? input.source.checkout : undefined;
      if (!selected) return refused('workspace_unavailable');
      const source = resolveWorkspaceRefV1(snapshot.workspaceRefs, selected);
      if (source.kind !== 'resolved') return refused('source_machine_mismatch');
      const target = resolveWorkspaceRefForMachineRoot(snapshot.workspaceRefs, {
        serverId: runtime.serverId, machineId: input.machineId, rootPath: input.materialization.kind === 'sync' ? input.materialization.targetPath : '',
      });
      const mappingPurpose = requester.rows.authorization ? 'admitted_mapping' as const : 'physical_sync' as const;
      const childMachines = await readWorkspaceSyncChildMachineFacts({ serverId: runtime.serverId,
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
      const stillAdmitted = await context.verifyMachineAdmissionCurrent!();
      context.signal.throwIfAborted();
      if (!stillAdmitted) return refused('machine_access_denied');
      if (!await requester.isCurrent()) return refused('project_open_scope_changed');
      effectsIssued = true;
      await materializeWorkspaceSyncForOpen(runtime.workspaceSyncAdapter!, {
        operationId: randomUUID(), accountServerId: runtime.serverId, action,
        // Retain actual aliases until the incumbent Sync adapter derives physical copy custody.
        sourceMachineId: source.ref.machineId, sourceRootPath: source.ref.rootPath, sourceWorkspaceRefId: source.ref.id,
        targetMachineId: input.machineId, targetRootPath: input.materialization.kind === 'sync' ? input.materialization.targetPath : '',
        ...(target ? { targetWorkspaceRefId: target.id } : {}), signal: context.signal,
      }, context);
      context.signal.throwIfAborted();
      if (!await context.verifyMachineAdmissionCurrent!()) return unconfirmedOutcome('Source Machine admission changed after Sync effects');
      return { kind: 'materialized' };
    });
  } catch (error) {
    logger.warnLocalFile('[Project Open] Source Sync settlement failed', { effectsIssued, code: codeOf(error),
      error: error instanceof Error ? error.stack ?? error.message : String(error) });
    if (error instanceof WorkspaceSyncInitialPreparationRefusal) return refused(context.signal.aborted ? 'cancelled' : codeOf(error));
    return effectsIssued ? unconfirmedOutcome('Source Sync exception after effects') : refused(context.signal.aborted ? 'cancelled' : codeOf(error));
  }
}
