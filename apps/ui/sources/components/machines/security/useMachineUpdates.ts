import type { MachineSetupObservationV1 } from '@happier-dev/protocol';
import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resumeActionExecutionResult, type ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useMachineField } from '@/sync/store/hooks';
import { planMachineUpdates } from './machineUpdatesActions';

export type MachineUpdatesObservation = NonNullable<MachineSetupObservationV1['updates']>;
export type UseMachineUpdatesInput = Readonly<{
  serverId: string; machineId: string; enabled: boolean; reachable: boolean | null;
}>;
export type MachineUpdatesRead = Readonly<{ kind: 'unrequested' | 'pending' | 'settled' }>
  | Readonly<{ kind: 'failed'; failure: Extract<ActionExecuteResult, { ok: false }> }>;

/** Data port for the visible Security consumer; composition stays with the page owner. */
export function useMachineUpdates(input: UseMachineUpdatesInput) {
  const setup = useMachineField(input.machineId, 'daemonState', 'setup', { serverId: input.serverId, enabled: input.enabled });
  const observation = setup?.updates ?? null;
  const demanded = input.enabled && input.reachable === true;
  const { resolution, binding: lifetime } = useServerCredentialAccountScopeBinding(demanded ? input.serverId : null);
  const key = JSON.stringify([input.serverId, input.machineId]);
  const [record, setRecord] = React.useState<Readonly<{
    key: string; lifetime: typeof lifetime; read: MachineUpdatesRead; approval: ActionApprovalContinuation | null;
  }>>({ key, lifetime, read: { kind: 'unrequested' }, approval: null });
  const pending = React.useRef<Readonly<{ controller: AbortController; promise: Promise<void> }> | null>(null);
  const refresh = React.useCallback((): Promise<void> => {
    if (!demanded || !lifetime) return Promise.resolve();
    if (pending.current) return pending.current.promise;
    const controller = new AbortController();
    const retirement = lifetime.onRetire(() => controller.abort());
    setRecord({ key, lifetime, read: { kind: 'pending' }, approval: null });
    const promise = (async () => {
      const target = { serverId: input.serverId, homeId: lifetime.scope.serverId, machineId: input.machineId };
      const actionInput = { homeId: target.homeId, machineId: target.machineId, mode: 'check', updates: { scope: 'all' } };
      let result: ActionExecuteResult;
      try {
        result = await resumeActionExecutionResult({
          result: await planMachineUpdates(target, 'all', 'check', {
            expectedAccountId: lifetime.scope.accountId, signal: controller.signal,
          }), actionId: 'machines.setup.plan', actionInput, scope: lifetime.scope, signal: controller.signal,
          onApprovalPending: approval => {
            if (!controller.signal.aborted) setRecord({ key, lifetime, read: { kind: 'pending' }, approval });
          },
        });
      } catch (error: unknown) {
        result = { ok: false, errorCode: 'action_failed', error: error instanceof Error ? error.message : String(error) };
      } finally { retirement.dispose(); }
      if (!controller.signal.aborted) setRecord({ key, lifetime,
        read: result.ok ? { kind: 'settled' } : { kind: 'failed', failure: result }, approval: null });
    })().finally(() => { if (pending.current?.controller === controller) pending.current = null; });
    pending.current = { controller, promise };
    return promise;
  }, [demanded, input.serverId, input.machineId, lifetime, key]);
  // Opening/reconnecting and explicit refresh are demand. Publications never trigger a native read.
  React.useEffect(() => {
    void refresh();
    return () => { pending.current?.controller.abort(); pending.current = null; };
  }, [refresh]);
  const bound = record.key === key && record.lifetime === lifetime;
  const unresolved = resolution.kind === 'resolving' || resolution.kind === 'bound' && lifetime === null;
  const read: MachineUpdatesRead = demanded && !lifetime && !unresolved
    ? { kind: 'failed', failure: { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' } }
    : bound ? record.read : { kind: 'unrequested' };
  return {
    observation, status: observation?.status ?? 'unknown', reason: observation?.reason ?? null,
    backend: observation?.backend ?? null,
    pendingSecurity: observation?.pendingSecurity ?? null, pendingAll: observation?.pendingAll ?? null,
    rebootNeeded: observation?.rebootNeeded ?? null,
    stale: observation !== null && (input.reachable !== true || read.kind !== 'settled'
      || observation.status === 'unavailable' || observation.status === 'unverifiable'),
    refreshing: demanded && read.kind === 'pending', read,
    failure: read.kind === 'failed' ? read.failure : null,
    approval: bound && demanded ? record.approval : null, refresh,
  };
}
