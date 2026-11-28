import type { MachineSetupObservationV1 } from '@happier-dev/protocol';
import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { MACHINE_SECURITY_INSPECT_ACTION_ID_V1 } from '@happier-dev/protocol/actions/specs/machineConnectionActionIdsV1';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { MachineSecurityInspectResultV1Schema, type MachineSecurityInspectResultV1 } from '@happier-dev/protocol/machines/security/machineSecurityInspectV1';
import { isRpcMethodNotFoundResult } from '@happier-dev/protocol/rpcErrors';
import { resumeActionExecutionResult, type ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { useMachineField } from '@/sync/store/hooks';
import { planMachineUpdates } from './machineUpdatesActions';

export type MachineUpdatesObservation = NonNullable<MachineSetupObservationV1['updates']>;
export type UseMachineUpdatesInput = Readonly<{
  serverId: string; machineId: string; enabled: boolean; reachable: boolean | null;
}>;
export type MachineUpdatesRead = Readonly<{ kind: 'unrequested' | 'pending' | 'settled' }>
  | Readonly<{ kind: 'failed'; failure: Extract<ActionExecuteResult, { ok: false }> }>;

const execute = createFrontDoorActionExecute();

/** Data port for the visible Security consumer; composition stays with the page owner. */
export function useMachineUpdates(input: UseMachineUpdatesInput, inspectSecurity = false) {
  const setup = useMachineField(input.machineId, 'daemonState', 'setup', { serverId: input.serverId, enabled: input.enabled });
  const publishedUpdates = setup?.updates ?? null;
  const demanded = input.enabled && input.reachable === true;
  const { resolution, binding: lifetime } = useServerCredentialAccountScopeBinding(demanded ? input.serverId : null);
  const key = JSON.stringify([input.serverId, input.machineId]);
  const [record, setRecord] = React.useState<Readonly<{
    key: string; lifetime: typeof lifetime; read: MachineUpdatesRead; approval: ActionApprovalContinuation | null;
    projection?: MachineSecurityInspectResultV1;
  }>>({ key, lifetime, read: { kind: 'unrequested' }, approval: null });
  const pending = React.useRef<Readonly<{ controller: AbortController; promise: Promise<void> }> | null>(null);
  const refresh = React.useCallback((observation?: 'settled'): Promise<void> => {
    if (!demanded || !lifetime) return Promise.resolve();
    if (pending.current) return pending.current.promise;
    const controller = new AbortController();
    const retirement = lifetime.onRetire(() => controller.abort());
    setRecord({ key, lifetime, read: { kind: 'pending' }, approval: null });
    const promise = (async () => {
      const target = { serverId: input.serverId, homeId: lifetime.scope.serverId, machineId: input.machineId };
      let result: ActionExecuteResult | undefined;
      let projection: MachineSecurityInspectResultV1 | undefined;
      let actionId: typeof MACHINE_SECURITY_INSPECT_ACTION_ID_V1 | 'machines.setup.plan' =
        inspectSecurity ? MACHINE_SECURITY_INSPECT_ACTION_ID_V1 : 'machines.setup.plan';
      const context = { expectedAccountId: lifetime.scope.accountId, signal: controller.signal };
      const onApprovalPending = (approval: ActionApprovalContinuation) => {
        if (!controller.signal.aborted) setRecord({ key, lifetime, read: { kind: 'pending' }, approval });
      };
      try {
        if (inspectSecurity) {
          const actionInput = { serverId: target.serverId, machineId: target.machineId, ...(observation ? { observation } : {}) };
          result = await resumeActionExecutionResult({
            result: await execute(MACHINE_SECURITY_INSPECT_ACTION_ID_V1, actionInput, {
              ...context, serverId: target.serverId, surface: 'ui',
            }), actionId: MACHINE_SECURITY_INSPECT_ACTION_ID_V1, actionInput, scope: lifetime.scope,
            signal: controller.signal, onApprovalPending,
          });
          if (result.ok) {
            const parsed = MachineSecurityInspectResultV1Schema.safeParse(result.result);
            if (parsed.success) projection = parsed.data;
            else result = { ok: false, errorCode: 'action_invalid_output', error: 'action_invalid_output' };
          } else if (isRpcMethodNotFoundResult(result)) {
            actionId = 'machines.setup.plan';
          }
        }
        if (actionId === 'machines.setup.plan') {
          const actionInput = { homeId: target.homeId, machineId: target.machineId, mode: 'check', updates: { scope: 'all' } };
          result = await resumeActionExecutionResult({
            result: await planMachineUpdates(target, 'all', 'check', context), actionId, actionInput, scope: lifetime.scope,
            signal: controller.signal, onApprovalPending,
          });
        }
      } catch (error: unknown) {
        result = { ok: false, ...normalizeActionExecutorThrownError(error, actionId) };
      } finally { retirement.dispose(); }
      if (result && !controller.signal.aborted) setRecord({ key, lifetime,
        read: result.ok ? { kind: 'settled' } : { kind: 'failed', failure: result }, approval: null, projection });
    })().finally(() => { if (pending.current?.controller === controller) pending.current = null; });
    pending.current = { controller, promise };
    return promise;
  }, [demanded, input.serverId, input.machineId, inspectSecurity, lifetime, key]);
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
  const projection = bound && demanded ? record.projection ?? null : null;
  const observation = projection?.updates ?? publishedUpdates;
  return {
    observation, status: observation?.status ?? 'unknown', reason: observation?.reason ?? null,
    backend: observation?.backend ?? null,
    pendingSecurity: observation?.pendingSecurity ?? null, pendingAll: observation?.pendingAll ?? null,
    rebootNeeded: observation?.rebootNeeded ?? null,
    stale: observation !== null && (input.reachable !== true || read.kind !== 'settled'
      || observation.status === 'unavailable' || observation.status === 'unverifiable'),
    refreshing: demanded && read.kind === 'pending', read,
    failure: read.kind === 'failed' ? read.failure : null,
    approval: bound && demanded ? record.approval : null, projection, refresh,
  };
}
