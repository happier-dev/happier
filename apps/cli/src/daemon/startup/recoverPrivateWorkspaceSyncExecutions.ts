import { resolveWorkspaceSyncRelationshipEndpointRoles } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import type { WorkspaceSyncHandoffAdapter, WorkspaceSyncPrivateExecution } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import type { StoredCredentials } from '@/persistence';
import type { HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { resolveWorkspaceRefById } from '@/workspaces/workspaceRefsV1';
import { recoverPrivateProjectSyncCheckout, type PrivateProjectCheckoutOpenRuntime } from '@/workspaces/activation/privateProjectOpenCheckout';
import { listRequesterSessionCredentialBindings, resolveWorkspaceSyncRelationshipCredentialCustody,
  resolveWorkspaceSyncSourceCredentialCustody, retireRequesterSessionCredentialCustody,
  verifyWorkspaceSyncSourceMachineAdmissionCurrent, type RequesterSessionMachineAdmissionBoundary } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import type { ProductionDaemonWorkspaceSyncFactories } from './createProductionDaemonWorkspaceSyncRuntime';

/** Recovery feeds the existing operation/relationship owner, never a parallel registry. */
export async function recoverPrivateWorkspaceSyncExecutions(input: Readonly<{
  happyHomeDir: string;
  localProfileId: string;
  serverId: string;
  serverHttpBaseUrl: string;
  boundary: RequesterSessionMachineAdmissionBoundary;
  privateCheckout?: PrivateProjectCheckoutOpenRuntime;
  adapter: WorkspaceSyncHandoffAdapter;
  readProjectRows: ProductionDaemonWorkspaceSyncFactories['refreshProjectRows'];
  relationshipId?: string;
}>): Promise<boolean> {
  const installation = input.boundary.readInstallation();
  if (!installation || !input.boundary.isHomeCurrent()) return false;
  let matched = false;
  const accountSnapshots = new Map<string, Awaited<ReturnType<typeof input.readProjectRows>>>();
  for (const endpointRole of [undefined, 'source'] as const) {
    const listed = await listRequesterSessionCredentialBindings({ happyHomeDir: input.happyHomeDir,
      serverId: endpointRole === 'source' ? input.localProfileId : input.serverId,
      machineId: input.boundary.machineId, installationId: installation.installationId,
      ...(input.relationshipId ? { sessionId: input.relationshipId } : {}),
      scope: 'workspace_sync_relationship', ...(endpointRole ? { endpointRole } : {}) });
    if (listed.status !== 'ready') throw Object.assign(new Error(listed.reason), { code: listed.reason });
    for (const binding of listed.bindings) {
      const relationshipId = binding.sessionId;
      matched = true;
      if (input.adapter.resolvePrivateExecution?.({ relationshipId })) continue;
      const scope = { happyHomeDir: input.happyHomeDir, relationshipId, attribution: binding.attribution,
        serverHttpBaseUrl: input.serverHttpBaseUrl, machineAdmissionBoundary: input.boundary,
        ...(input.boundary.signal ? { signal: input.boundary.signal } : {}) };
      let recovered: Readonly<{ credentials: StoredCredentials; executionIdentity?: Extract<HostRequesterExecutionIdentity, { kind: 'isolated' }> }> | null;
      if (endpointRole === 'source') {
        const credentials = await resolveWorkspaceSyncSourceCredentialCustody(scope);
        recovered = credentials ? { credentials } : null;
      } else recovered = await resolveWorkspaceSyncRelationshipCredentialCustody(scope);
      if (!recovered) continue;
      const { credentials } = recovered;
      let active = true;
      const custody = { serverId: input.serverId, accountId: binding.attribution.accountId,
        serverHttpBaseUrl: input.serverHttpBaseUrl, isCurrent: async () => active && input.boundary.isHomeCurrent() };
      let snapshot = accountSnapshots.get(binding.attribution.accountId)
        ?? await input.readProjectRows({ credentials, sessionCustody: custody, serverId: input.serverId,
          selection: { kinds: ['workspace-ref', 'relationship-graph'] } });
      accountSnapshots.set(binding.attribution.accountId, snapshot);
      const relationship = snapshot.relationships.find(value => value.relationshipId === relationshipId);
      if (!relationship) {
        await retireRequesterSessionCredentialCustody({ happyHomeDir: input.happyHomeDir, ...binding });
        continue;
      }
      const alpha = resolveWorkspaceRefById(snapshot.workspaceRefs, relationship.alphaWorkspaceRefId, input.serverId);
      const beta = resolveWorkspaceRefById(snapshot.workspaceRefs, relationship.betaWorkspaceRefId, input.serverId);
      const roles = alpha && beta ? resolveWorkspaceSyncRelationshipEndpointRoles({ mode: relationship.mode,
        controllerMachineId: relationship.controllerMachineId, alphaMachineId: alpha.machineId, betaMachineId: beta.machineId }) : null;
      if (!alpha || !beta || !roles) continue;
      const target = roles.targetEndpointRole === 'alpha' ? alpha : beta;
      const source = roles.targetEndpointRole === 'alpha' ? beta : alpha;
      if ((endpointRole === 'source' ? source.machineId : target.machineId) !== input.boundary.machineId) continue;
      const executionInput = { operationId: relationshipId, accountServerId: input.serverId,
        action: { kind: 'relationship' as const, relationshipId, flushBeforeCommit: false },
        sourceMachineId: source.machineId, targetMachineId: target.machineId,
        sourceWorkspaceRefId: source.id, targetWorkspaceRefId: target.id,
        sourceRootPath: source.rootPath, targetRootPath: target.rootPath };
      const assertTransferCurrent = async () => {
        if (!await custody.isCurrent() || endpointRole === 'source' && !await verifyWorkspaceSyncSourceMachineAdmissionCurrent({
          credentials, sessionId: relationshipId, attribution: binding.attribution,
          serverHttpBaseUrl: input.serverHttpBaseUrl, boundary: input.boundary })) {
          throw Object.assign(new Error('Requester Sync custody is unavailable'), { code: 'project_requester_authority_unavailable' });
        }
      };
      let execution: WorkspaceSyncPrivateExecution;
      if (endpointRole === 'source') {
        execution = { credentials, accountRowsCustody: custody, assertTransferCurrent,
          getSnapshot: () => snapshot, replaceSnapshot: async next => { snapshot = next; },
          release: async () => { active = false; } };
      } else {
        const executionIdentity = recovered.executionIdentity;
        const privateCheckout = input.privateCheckout;
        if (!privateCheckout || !input.adapter.preparePrivateExecution || !executionIdentity) continue;
        let releaseNative: (() => Promise<void>) | undefined;
        execution = await input.adapter.preparePrivateExecution({ input: executionInput, credentials,
          accountRowsCustody: custody, executionIdentity, snapshot, assertTransferCurrent,
          createNativeSync: async ({ configuration, network }) => {
            const native = await recoverPrivateProjectSyncCheckout({ runtime: privateCheckout,
              requesterIdentity: executionIdentity, target, relationship, configuration, network,
              signal: input.boundary.signal ?? new AbortController().signal });
            releaseNative = native.release;
            return native.native;
          },
          release: async () => { active = false; await releaseNative?.(); } });
      }
      input.adapter.retainPrivateExecution?.({ input: executionInput, execution, phase: 'relationship' });
      await input.adapter.bindPrivateExecutionRelationship?.(relationshipId, relationshipId);
    }
  }
  return matched;
}
