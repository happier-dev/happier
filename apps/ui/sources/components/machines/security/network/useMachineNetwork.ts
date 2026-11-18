import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { MachineReachabilityInspectResultV1Schema, type MachineReachabilityInspectResultV1 } from '@happier-dev/protocol/machines/reachability/actionsV1';
import { resumeActionExecutionResult, type ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { buildNetworkInspectInput, presentMachineNetwork, type MachineNetworkRead } from './networkSurface';
import { inspectMachineNetwork } from './networkActions';
import { useMachineNetworkFacts } from './useMachineNetworkFacts';
import { useMachineServicesList } from '@/components/machines/services/useMachineServicesList';
import { useMachineNetworkExposure } from './useMachineNetworkExposure';

export type MachineNetworkModel = ReturnType<typeof presentMachineNetwork> & Readonly<{
  read: MachineNetworkRead;
  approval: ActionApprovalContinuation | null;
  /** Effective Docker bindings retain their own admission, push, failure and refresh owner. */
  services: ReturnType<typeof useMachineServicesList>;
  exposure: ReturnType<typeof useMachineNetworkExposure>;
  refresh(): Promise<void>;
}>;

/** One visible Network read retains its answer until a newer Machine observation arrives. */
export function useMachineNetwork(input: Readonly<{
  serverId: string; machineId: string; enabled: boolean; reachable: boolean | null;
  /** A Use grantee: Home admits inspect only for Manage, so this surface never demands it. */
  needsManage: boolean;
  /** Omit for the first admitted Environment; use inventory paging/selection for further Domains. */
  environmentId?: string | null;
}>): MachineNetworkModel {
  const { resolution, binding: lifetime } = useServerCredentialAccountScopeBinding(input.serverId);
  const services = useMachineServicesList({ serverId: input.serverId, machineId: input.machineId,
    active: input.enabled && !input.needsManage && input.reachable === true });
  const key = JSON.stringify([input.serverId, input.machineId]);
  const [record, setRecord] = React.useState<Readonly<{
    key: string; lifetime: typeof lifetime; read: MachineNetworkRead; approval: ActionApprovalContinuation | null;
    inspection: MachineReachabilityInspectResultV1 | null;
  }>>({ key, lifetime, read: { kind: 'unrequested' }, approval: null, inspection: null });
  const bound = record.key === key && record.lifetime === lifetime;
  const facts = useMachineNetworkFacts({ ...input, enabled: input.enabled && !input.needsManage, scope: lifetime?.scope,
    inspection: bound && !input.needsManage ? record.inspection : null });
  const exposure = useMachineNetworkExposure({ ...input, facts, services: services.rows });
  const pending = React.useRef<Readonly<{ controller: AbortController; promise: Promise<void> }> | null>(null);

  const refresh = React.useCallback((): Promise<void> => {
    if (!input.enabled || input.needsManage || input.reachable !== true || !lifetime) return Promise.resolve();
    if (pending.current) return pending.current.promise;
    const controller = new AbortController();
    const retirement = lifetime.onRetire(() => controller.abort());
    setRecord(previous => ({ key, lifetime, read: { kind: 'pending' }, approval: null,
      inspection: previous.key === key && previous.lifetime === lifetime ? previous.inspection : null }));
    const promise = (async () => {
      const actionInput = buildNetworkInspectInput({ serverId: input.serverId, machineId: input.machineId });
      let result: ActionExecuteResult;
      try {
        result = await resumeActionExecutionResult({
          result: await inspectMachineNetwork({ serverId: input.serverId, machineId: input.machineId }, undefined, {
            expectedAccountId: lifetime.scope.accountId, signal: controller.signal,
          }),
          actionId: 'machines.reachability.inspect', actionInput, scope: lifetime.scope, signal: controller.signal,
          onApprovalPending: approval => {
            if (!controller.signal.aborted) setRecord(previous => ({ ...previous, key, lifetime, read: { kind: 'pending' }, approval }));
          },
        });
      } catch (error: unknown) {
        result = { ok: false, ...normalizeActionExecutorThrownError(error, 'machines.reachability.inspect') };
      } finally {
        retirement.dispose();
      }
      if (!controller.signal.aborted) {
        const inspected = result.ok ? MachineReachabilityInspectResultV1Schema.safeParse(result.result) : null;
        setRecord(previous => ({ key, lifetime,
          read: result.ok ? { kind: 'settled' } : { kind: 'failed', failure: result }, approval: null,
          inspection: inspected?.success ? inspected.data : previous.inspection }));
      }
    })().finally(() => { if (pending.current?.controller === controller) pending.current = null; });
    pending.current = { controller, promise };
    return promise;
  }, [input.enabled, input.needsManage, input.reachable, input.serverId, input.machineId, lifetime, key]);

  // Visibility, reconnect and Account binding are demand. Content publications do not trigger native reads.
  React.useEffect(() => {
    void refresh();
    return () => { pending.current?.controller.abort(); pending.current = null; };
  }, [refresh]);

  const unresolved = resolution.kind === 'resolving' || resolution.kind === 'bound' && lifetime === null;
  const read: MachineNetworkRead = input.enabled && !lifetime && !unresolved
    ? { kind: 'failed', failure: { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' } }
    : bound && (input.enabled && input.reachable === true || record.read.kind !== 'pending')
      ? record.read : { kind: 'unrequested' };
  return { ...presentMachineNetwork({ facts: { ...facts, exposure: exposure.facts }, read,
    reachable: input.reachable, needsManage: input.needsManage }),
    read, approval: bound && input.enabled && input.reachable === true ? record.approval : null, services, exposure, refresh };
}
