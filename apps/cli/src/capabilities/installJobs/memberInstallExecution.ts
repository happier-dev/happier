import { resolveMachineAgentExecutionPlacementV1 } from '@happier-dev/protocol/machines/agentIsolationV1';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ExecFileTerminationError } from '@happier-dev/cli-common/process';
import { AgentInstallJobEventSchema, AgentInstallJobOutcomeSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { projectAcpCatalogForMachineInventory } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { selectHostRequesterExecutionIdentity, resolveHostRequesterAgentExecutionIdentity,
  resolveHostRequesterAgentPlacementForHost, type HostAgentIsolationLaunchContext } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { AgentLaunchOperationMaterialization } from '@/daemon/agentIsolation/agentLaunchMaterials';
import { authorizeResolvedProjectExecLaunchForHost } from '@/plugins/runtime/invocation/services/exec';
import { runMemberAgentEffect } from '@/daemon/agentIsolation/runMemberNativeOperation';
import { prepareAgentIsolationMemberForIntent } from '@/daemon/agentIsolation/prepareNativeOperation';
import { buildMemberAgentInstallEnvironment } from './memberInstallEnvironment';
import type { MemberAgentInstallExecutor } from './agentInstallJobOwner';

export type MemberAgentInstallExecutionDeps = Readonly<{
  agentIsolation?: HostAgentIsolationLaunchContext;
  nativeOperationRuntime?: Pick<ApiMachineClient, 'prepareNativeOperation'>;
  resolveHostHomeServerIdentityId?: () => Promise<string | null>;
  platform?: NodeJS.Platform;
}>;
const RecordSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('event'), event: AgentInstallJobEventSchema }),
  z.strictObject({ t: z.literal('outcome'), outcome: AgentInstallJobOutcomeSchema, cleanupError: z.literal(true).optional() }),
]);

/** Agent placement owns scope, including the custodian on a separate-users Machine.
 * undefined retains machine execution; null refuses unavailable member execution.
 * Deliberate install admission prepares the requester through the native owner. */
export async function readMemberAgentInstallExecutor(context: RpcHandlerContext,
  deps: MemberAgentInstallExecutionDeps = {}): Promise<MemberAgentInstallExecutor | null | undefined> {
  const placement = resolveMachineAgentExecutionPlacementV1({
    policy: deps.agentIsolation?.read() ?? { enabled: false }, platform: deps.platform ?? process.platform,
  });
  if (placement !== 'member') return undefined;
  if ((deps.platform ?? process.platform) !== 'linux' || !deps.agentIsolation?.readMember || !deps.nativeOperationRuntime) return null;
  const homeServerIdentityId = deps.resolveHostHomeServerIdentityId
    ? await deps.resolveHostHomeServerIdentityId() : context.callerInputAuthorization?.binding.serverIdentityId;
  if (!homeServerIdentityId) return null;
  const selected = resolveHostRequesterAgentExecutionIdentity(selectHostRequesterExecutionIdentity({
    rpcContext: context, hostHomeServerIdentityId: homeServerIdentityId,
  }));
  const snapshot = deps.agentIsolation.read();
  if (selected.kind !== 'isolated' || resolveHostRequesterAgentPlacementForHost({ identity: selected, snapshot,
    platform: deps.platform }) !== 'member') return null;
  const requesterIdentity = { ...selected, homeServerIdentityId };
  const observed = await prepareAgentIsolationMemberForIntent(deps.agentIsolation,
    { requesterIdentity, rpcContext: context, signal: context.signal });
  context.signal.throwIfAborted();
  const preparedIdentity = { ...observed, kind: 'member' as const, requesterIdentity, snapshot };
  const nativeRuntime = deps.nativeOperationRuntime;
  return async (operation, signal, onEvent) => {
    const environment = buildMemberAgentInstallEnvironment(observed.identity.home);
    let material: AgentLaunchOperationMaterialization = { materializationKey: randomUUID(),
      environment, selectedMaterials: [] };
    const native = await nativeRuntime.prepareNativeOperation({ requesterIdentity: selected, preparedIdentity,
      allowMemberPreparation: false, signal, readMaterial: () => material });
    let physicalCleanupConfirmed = true;
    try {
      material = { ...material, environment: { ...environment, TMPDIR: native.materialTarget.runtimeHome,
        TMP: native.materialTarget.runtimeHome, TEMP: native.materialTarget.runtimeHome } };
      const installedBinary = native.agentIsolation.read()?.launch?.managedHappierBinaryPath;
      if (!installedBinary) throw new Error('Native install executable unavailable');
      const launch = await authorizeResolvedProjectExecLaunchForHost({
        launch: { command: installedBinary, args: ['agent-install-effect'], cwd: native.workingDirectory, env: environment },
        agentIsolation: native.agentIsolation, requesterIdentity: selected, agentLaunchKind: 'exec', signal,
        assertCurrent: () => signal.throwIfAborted(),
      });
      // Account-authored launch environment and auth/configuration are not
      // installer inputs. Reuse the inventory owner's value-free launch projection.
      const definition = operation.definition;
      const projected = definition && projectAcpCatalogForMachineInventory(undefined, [definition]).definitions?.[0];
      const installDefinition = definition && projected ? AcpBackendDefinitionV1Schema.parse({
        id: definition.id, name: definition.name, title: definition.title, launch: projected.launch,
        createdAt: definition.createdAt, updatedAt: definition.updatedAt,
      }) : undefined;
      return await runMemberAgentEffect({ launch, signal,
        request: { kind: 'install', ...operation, ...(installDefinition ? { definition: installDefinition } : {}) },
        readRecord(raw) {
          const record = RecordSchema.parse(raw);
          if (record.t === 'event') { onEvent(record.event); return undefined; }
          if (record.cleanupError) throw new ExecFileTerminationError(new Error('Member installer cleanup is unconfirmed'));
          // Vendor stderr can contain the member's native package credentials.
          // It stays in their private install log; transport only the closed failure.
          return record.outcome.kind === 'failed' ? { ...record.outcome,
            message: `Agent installation failed (${record.outcome.code}).` } : record.outcome;
        },
      });
    } catch (error) {
      if (error instanceof ExecFileTerminationError) physicalCleanupConfirmed = false;
      throw error;
    } finally {
      if (physicalCleanupConfirmed) await native.dispose();
    }
  };
}
