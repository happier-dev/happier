import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resumeActionExecutionResult, type ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { buildNetworkInspectInput, presentMachineNetwork, type MachineNetworkRead } from './networkSurface';
import { inspectMachineNetwork } from './networkActions';
import { useMachineNetworkFacts } from './useMachineNetworkFacts';

export type MachineNetworkModel = ReturnType<typeof presentMachineNetwork> & Readonly<{
  read: MachineNetworkRead;
  approval: ActionApprovalContinuation | null;
  refresh(): Promise<void>;
}>;

/** One visible Network read; pushed Machine fields remain the only fact owner. */
export function useMachineNetwork(input: Readonly<{
  serverId: string; machineId: string; enabled: boolean; reachable: boolean | null;
}>): MachineNetworkModel {
  const { resolution, binding: lifetime } = useServerCredentialAccountScopeBinding(input.serverId);
  const facts = useMachineNetworkFacts({ ...input, scope: lifetime?.scope });
  const key = JSON.stringify([input.serverId, input.machineId]);
  const [record, setRecord] = React.useState<Readonly<{
    key: string; lifetime: typeof lifetime; read: MachineNetworkRead; approval: ActionApprovalContinuation | null;
  }>>({ key, lifetime, read: { kind: 'unrequested' }, approval: null });
  const pending = React.useRef<Readonly<{ controller: AbortController; promise: Promise<void> }> | null>(null);

  const refresh = React.useCallback((): Promise<void> => {
    if (!input.enabled || input.reachable !== true || !lifetime) return Promise.resolve();
    if (pending.current) return pending.current.promise;
    const controller = new AbortController();
    const retirement = lifetime.onRetire(() => controller.abort());
    setRecord({ key, lifetime, read: { kind: 'pending' }, approval: null });
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
            if (!controller.signal.aborted) setRecord({ key, lifetime, read: { kind: 'pending' }, approval });
          },
        });
      } catch (error: unknown) {
        result = { ok: false, errorCode: 'action_failed', error: error instanceof Error ? error.message : String(error) };
      } finally {
        retirement.dispose();
      }
      if (!controller.signal.aborted) setRecord({ key, lifetime,
        read: result.ok ? { kind: 'settled' } : { kind: 'failed', failure: result }, approval: null });
    })().finally(() => { if (pending.current?.controller === controller) pending.current = null; });
    pending.current = { controller, promise };
    return promise;
  }, [input.enabled, input.reachable, input.serverId, input.machineId, lifetime, key]);

  // Visibility, reconnect and Account binding are demand. Content publications do not trigger native reads.
  React.useEffect(() => {
    void refresh();
    return () => { pending.current?.controller.abort(); pending.current = null; };
  }, [refresh]);

  const bound = record.key === key && record.lifetime === lifetime;
  const unresolved = resolution.kind === 'resolving' || resolution.kind === 'bound' && lifetime === null;
  const read: MachineNetworkRead = input.enabled && !lifetime && !unresolved
    ? { kind: 'failed', failure: { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' } }
    : bound && (input.enabled && input.reachable === true || record.read.kind !== 'pending')
      ? record.read : { kind: 'unrequested' };
  return { ...presentMachineNetwork({ facts, read, reachable: input.reachable }),
    read, approval: bound && input.enabled && input.reachable === true ? record.approval : null, refresh };
}
