import * as React from 'react';
import { ManagedServiceNativeLogResultV1Schema, type ManagedServiceNativeLogResultV1 } from '@happier-dev/protocol/local/services/nativeLogsV1';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

type ReadError = Readonly<{ code: string; message: string }>;
export type MachineServiceFirstLogRead =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'reading' }>
  | Readonly<{ kind: 'approval' }>
  | Readonly<{ kind: 'read'; value: ManagedServiceNativeLogResultV1; readAt: number }>
  | Readonly<{ kind: 'failed'; error: ReadError }>;

const execute = createFrontDoorActionExecute();
function failure(result: Extract<ActionExecuteResult, { ok: false }>): ReadError {
  return { code: result.errorCode, message: result.error };
}

/** The original logs Action acquires the first page for this retained native generation. */
export function useMachineServiceFirstLogRead(input: Readonly<{
  serverId: string; machineId: string; serviceId: string;
  expectedGeneration: string | null; active: boolean;
}>) {
  const key = JSON.stringify([input.serverId, input.machineId, input.serviceId, input.expectedGeneration]);
  const { resolution, binding: lifetime } = useServerCredentialAccountScopeBinding(input.serverId);
  const [record, setRecord] = React.useState<Readonly<{
    key: string; lifetime: typeof lifetime; state: MachineServiceFirstLogRead;
  }>>({
    key, lifetime, state: { kind: 'idle' },
  });
  const generation = React.useRef(0);
  const pending = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => { generation.current += 1; pending.current?.abort(); }, [key, lifetime]);
  React.useEffect(() => {
    if (input.active) return;
    generation.current += 1;
    pending.current?.abort();
    pending.current = null;
    setRecord(previous => previous.key === key && previous.state.kind === 'reading'
      ? { key, lifetime, state: { kind: 'idle' } } : previous);
  }, [input.active, key, lifetime]);
  const read = React.useCallback(async () => {
    if (!input.active || input.expectedGeneration === null) return;
    if (!lifetime && (resolution.kind === 'resolving' || resolution.kind === 'bound')) return;
    // No ambient/uncaptured Account fallback may start a protected native read.
    if (!lifetime || !lifetime.isCurrent()) {
      setRecord({ key, lifetime, state: { kind: 'failed', error: {
        code: 'action_account_scope_changed', message: 'machines.services.logs.read',
      } } });
      return;
    }
    const current = ++generation.current;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const retirement = lifetime.onRetire(() => controller.abort());
    setRecord({ key, lifetime, state: { kind: 'reading' } });
    try {
      const result = await execute('machines.services.logs.read', {
        serverId: input.serverId, machineId: input.machineId, serviceId: input.serviceId,
      }, { serverId: input.serverId, surface: 'ui', expectedAccountId: lifetime.scope.accountId,
        signal: controller.signal, machineServiceLogsResource: { expectedGeneration: input.expectedGeneration },
      }).catch((error: unknown): ActionExecuteResult => ({ ok: false, errorCode: 'action_failed',
        error: error instanceof Error ? error.message : String(error) }));
      if (controller.signal.aborted || current !== generation.current || !lifetime.isCurrent()) return;
      let state: MachineServiceFirstLogRead;
      if (!result.ok) state = { kind: 'failed', error: failure(result) };
      else if (ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) state = { kind: 'approval' };
      else {
        const parsed = ManagedServiceNativeLogResultV1Schema.safeParse(result.result);
        state = parsed.success ? { kind: 'read', value: parsed.data, readAt: Date.now() }
          : { kind: 'failed', error: { code: 'invalid_result', message: 'machines.services.logs.read' } };
      }
      setRecord({ key, lifetime, state });
    } finally {
      retirement.dispose();
      if (pending.current === controller) pending.current = null;
    }
  }, [key, lifetime, resolution.kind, input.active, input.serverId, input.machineId, input.serviceId, input.expectedGeneration]);
  // A new target/generation is empty in this render, before any reset effect can run.
  const state: MachineServiceFirstLogRead = record.key === key && record.lifetime === lifetime
    && (lifetime === null || lifetime.isCurrent())
    ? record.state : { kind: 'idle' };
  return { state, read, accountLifetime: lifetime };
}
