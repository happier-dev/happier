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

export type CleanupRequesterMachineSessions = (input: Readonly<{
  requesterAccountId: string;
  machineId: string;
  installationId: string;
  /** Host-bound to this exact frozen custody request; never transported or caller supplied. */
  verifyCurrentMachineAdmission: () => Promise<boolean>;
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
  cleanupRequesterMachineSessions: CleanupRequesterMachineSessions;
  cleanupRequesterMachineActionOperations?: CleanupRequesterMachineSessions;
  cleanupRequesterMachineServices?: CleanupRequesterMachineSessions;
  cleanupRequesterMachineTerminals?: CleanupRequesterMachineSessions;
}>): void {
  rpc.registerHandler(RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS, async (raw: unknown, context) => {
    const forbidden = { error: RPC_ERROR_MESSAGES.FORBIDDEN, errorCode: RPC_ERROR_CODES.FORBIDDEN };
    if (!isSocketRpcMachineAccessLossServerOriginAuthorizationContext(context?.authorization)) return forbidden;
    const request = MachineAccessLossCustodyRequestV1Schema.safeParse(raw);
    const admission = SocketRpcMachineAdmissionContextV1Schema.safeParse(context?.machineAdmission);
    if (!request.success || !admission.success || !context?.verifyMachineAdmissionCurrent) return forbidden;
    const verifyMachineAdmissionCurrent = context.verifyMachineAdmissionCurrent;
    const custody = admission.data;
    try {
      if (context.signal.aborted
        || custody.actorAccountId !== custody.custodianAccountId
        || custody.machineId !== options.machineId
        || custody.installationId !== options.resolveInstallationId()
        || !await verifyMachineAdmissionCurrent()
        || custody.installationId !== options.resolveInstallationId()
        || context.signal.aborted) return forbidden;
    } catch { return forbidden; }

    try {
      const stillCurrent = async () => !context.signal.aborted
        && custody.installationId === options.resolveInstallationId()
        && await verifyMachineAdmissionCurrent()
        && custody.installationId === options.resolveInstallationId()
        && !context.signal.aborted;
      if ('kind' in request.data) {
        if (!options.readLiveWorkInventory) return { kind: 'incomplete' as const };
        const inventory = await options.readLiveWorkInventory();
        const accountIds = new Set<string>();
        let coverage = inventory.coverage;
        for (const item of inventory.items) {
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
        if (!await stillCurrent()) return { kind: 'incomplete' as const };
        return { kind: 'requesters', accountIds: [...accountIds], coverage } satisfies MachineAccessLossRequesterCensusResponseV1;
      }
      const input = Object.freeze({
        requesterAccountId: request.data.subjectAccountId,
        machineId: custody.machineId,
        installationId: custody.installationId,
        verifyCurrentMachineAdmission: verifyMachineAdmissionCurrent,
      });
      const outcomes = await Promise.allSettled([
        options.cleanupRequesterMachineSessions(input),
        ...(options.cleanupRequesterMachineActionOperations ? [options.cleanupRequesterMachineActionOperations(input)] : []),
        ...(options.cleanupRequesterMachineServices ? [options.cleanupRequesterMachineServices(input)] : []),
        ...(options.cleanupRequesterMachineTerminals ? [options.cleanupRequesterMachineTerminals(input)] : []),
      ]);
      const settled = outcomes.every(outcome => {
        if (outcome.status !== 'fulfilled') return false;
        const parsed = MachineAccessLossCustodyResponseV1Schema.safeParse(outcome.value);
        return parsed.success && parsed.data.kind === 'settled';
      });
      return { kind: settled && await stillCurrent() ? 'settled' as const : 'incomplete' as const };
    } catch { return { kind: 'incomplete' as const }; }
  });
}
