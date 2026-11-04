import {
  MachineAccessLossCustodyRequestV1Schema,
  MachineAccessLossCustodyResponseV1Schema,
  SocketRpcMachineAdmissionContextV1Schema,
  type MachineAccessLossCustodyResponseV1,
  type MachineAccessLossRequesterCensusResponseV1,
} from '@happier-dev/protocol/machines/machineAccessV1';
import { isSocketRpcMachineAccessLossServerOriginAuthorizationContext } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { LiveWorkInventoryV1 } from '../lifecycle/managedActivity';
import type { AgentIsolationMemberOperations } from '../agentIsolation/createAgentIsolationMemberOperations';

export type CleanupRequesterMachineTerminals = (input: Readonly<{
  requesterAccountId: string;
  machineId: string;
  installationId: string;
  remainingRole?: 'use';
  signal: AbortSignal;
  /** Local installation custody, never transported or caller supplied. */
  isCurrentInstallation: () => boolean;
}>) => Promise<MachineAccessLossCustodyResponseV1>;

/**
 * The Home owns effective access loss; this receiver only proves current host
 * custody and delegates exact requester cleanup to the existing lifecycle owners.
 * `settled` covers the registered scopes, not unregistered whole-Machine work.
 */
export function registerMachineAccessLossReceiver(rpc: RpcHandlerRegistrar, options: Readonly<{
  serverId: string;
  machineId: string;
  readLiveWorkInventory?: () => Promise<LiveWorkInventoryV1>;
  resolveInstallationId: () => string | null;
  cleanupRequesterMachineTerminals?: CleanupRequesterMachineTerminals;
  /** Same P11 owner for admitted retirement and retained-binding reconciliation. */
  memberOperations?: AgentIsolationMemberOperations;
  /** Open-ended host resources close on access loss, before member retirement
   * waits for already-admitted finite work to finish. */
  cleanupRequesterMachineResources?: CleanupRequesterMachineTerminals;
}>): void {
  rpc.registerHandler(RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS, async (raw: unknown, context) => {
    const forbidden = { error: RPC_ERROR_MESSAGES.FORBIDDEN, errorCode: RPC_ERROR_CODES.FORBIDDEN };
    if (!isSocketRpcMachineAccessLossServerOriginAuthorizationContext(context?.authorization)) return forbidden;
    const request = MachineAccessLossCustodyRequestV1Schema.safeParse(raw);
    const admission = SocketRpcMachineAdmissionContextV1Schema.safeParse(context?.machineAdmission);
    if (!request.success || !admission.success || !context) return forbidden;
    const custody = admission.data;
    const isCurrentInstallation = () => custody.installationId === options.resolveInstallationId();
    try {
      if (context.signal.aborted
        || custody.actorAccountId !== custody.custodianAccountId
        || custody.machineId !== options.machineId
        || !isCurrentInstallation()) return forbidden;
    } catch { return forbidden; }

    try {
      const stillCurrent = () => !context.signal.aborted && isCurrentInstallation();
      if ('kind' in request.data) {
        if (!options.readLiveWorkInventory) return { kind: 'incomplete' as const };
        // Capture the retained target before either read can yield. An admitted
        // census completes on that pin; replacement refuses the next request.
        const [retained, inventory] = await Promise.all([
          options.memberOperations?.readProvisionedRequesterAccounts({ rpcContext: context }),
          options.readLiveWorkInventory(),
        ]);
        const accountIds = new Set<string>();
        let coverage = inventory.coverage;
        if (retained) {
          for (const accountId of retained.accountIds) accountIds.add(accountId);
          if (retained.coverage !== 'complete') coverage = 'unknown';
        }
        for (const item of inventory.items) {
          if (item.category === 'service' && item.serviceIdentity?.kind === 'deployment') continue;
          // A settled Session item is a still-hosted idle runtime, not a dead process.
          if (item.state === 'settled' && item.category !== 'session') continue;
          const attribution = item.attribution;
          if ('kind' in attribution || attribution.serverId !== options.serverId
            || attribution.machineId !== custody.machineId || attribution.installationId !== custody.installationId) {
            coverage = 'unknown';
            continue;
          }
          accountIds.add(attribution.accountId);
        }
        if (context.signal.aborted) return { kind: 'incomplete' as const };
        return { kind: 'requesters', accountIds: [...accountIds], coverage } satisfies MachineAccessLossRequesterCensusResponseV1;
      }
      const input = Object.freeze({
        requesterAccountId: request.data.subjectAccountId,
        machineId: custody.machineId,
        installationId: custody.installationId,
        ...(request.data.remainingRole ? { remainingRole: request.data.remainingRole } : {}),
        signal: context.signal,
        isCurrentInstallation,
      });
      // Open-ended interactive work closes on loss. Admitted finite work stays
      // with its incumbent owner and is awaited by the same member operation.
      const terminalOutcome = options.cleanupRequesterMachineTerminals
        ? await options.cleanupRequesterMachineTerminals(input)
        : { kind: 'settled' as const };
      const terminal = MachineAccessLossCustodyResponseV1Schema.safeParse(terminalOutcome);
      if (!terminal.success || terminal.data.kind !== 'settled' || !stillCurrent()) return { kind: 'incomplete' as const };
      // Use retains Project/Session execution and its member identity. Only the
      // Machine terminal owner consumes this narrower withdrawal.
      if (request.data.remainingRole === 'use') return terminal.data;
      const cleanupOwnedWork = async (): Promise<MachineAccessLossCustodyResponseV1> => {
        if (!options.cleanupRequesterMachineResources || !stillCurrent()) return { kind: 'incomplete' };
        const result = MachineAccessLossCustodyResponseV1Schema.safeParse(await options.cleanupRequesterMachineResources(input));
        return { kind: result.success && result.data.kind === 'settled' && stillCurrent() ? 'settled' : 'incomplete' };
      };
      const resources = await cleanupOwnedWork();
      const outcome = options.memberOperations
        ? await options.memberOperations.retire({ accountId: input.requesterAccountId,
          rpcContext: context, isCurrentInstallation, cleanupOwnedWork: async () => resources })
        : options.cleanupRequesterMachineResources ? resources : terminal.data;
      const parsed = MachineAccessLossCustodyResponseV1Schema.safeParse(outcome);
      return { kind: parsed.success && parsed.data.kind === 'settled' && stillCurrent() ? 'settled' as const : 'incomplete' as const };
    } catch { return { kind: 'incomplete' as const }; }
  });
}
