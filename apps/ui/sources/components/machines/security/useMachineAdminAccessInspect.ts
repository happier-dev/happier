import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
  MachineAdminAccessInspectResultV1Schema,
  type MachinePreauthorizationIssueV1,
} from '@happier-dev/protocol/machines/adminAccessV1';

import {
  createFrontDoorActionExecute,
  type FrontDoorActionExecute,
} from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

import type {
  AdminAccessPreauthorizationRead,
  AdminAccessPreauthorizationSettled,
} from './adminPower';
import { useScopedActionRun } from './useScopedActionRun';

const defaultExecute = createFrontDoorActionExecute();
const idle: AdminAccessPreauthorizationRead = {
  settled: null,
  checking: false,
};

/**
 * The Machine's own passwordless sudo issue and console steps: one `machines.setup.adminAccess.inspect` when the
 * section needs them (`enabled`), again on Check again, never on a timer. A save that settled with the Machine's
 * issue hands it over through `adopt`, so the latest typed answer is the one shown. Inspect also republishes a
 * changed observation, which is what clears the notice once the Machine allows it.
 */
export function useMachineAdminAccessInspect(
  input: Readonly<{
    serverId: string;
    machineId: string;
    enabled: boolean;
    /** The Action front door; tests pass one built over the real executor with only the Machine RPC substituted. */
    execute?: FrontDoorActionExecute;
  }>,
) {
  const execute = input.execute ?? defaultExecute;
  const { run, abort } = useScopedActionRun(input.serverId);
  const [read, setRead] = React.useState<AdminAccessPreauthorizationRead>(idle);

  const check = React.useCallback(async () => {
    abort();
    setRead((prev) => (prev.checking ? prev : { ...prev, checking: true }));
    const actionInput = {
      serverId: input.serverId,
      machineId: input.machineId,
    };
    const result = await run(
      'machines.setup.adminAccess.inspect',
      actionInput,
      (signal, bound) =>
        execute('machines.setup.adminAccess.inspect', actionInput, {
          surface: 'ui',
          serverId: input.serverId,
          expectedAccountId: bound.scope.accountId,
          signal,
        }),
      () => {},
    );
    if (!result) return;
    setRead({ settled: settleAdminAccessInspect(result), checking: false });
  }, [abort, execute, input.machineId, input.serverId, run]);

  React.useEffect(() => {
    if (!input.enabled) return;
    void check();
    return () => {
      abort();
      setRead(idle);
    };
  }, [input.enabled, check, abort]);

  const adopt = React.useCallback(
    (issue: MachinePreauthorizationIssueV1 | null) => {
      abort();
      setRead({ settled: { kind: 'read', issue }, checking: false });
    },
    [abort],
  );

  return { read, check, adopt };
}

export function settleAdminAccessInspect(
  result: ActionExecuteResult,
): AdminAccessPreauthorizationSettled {
  if (!result.ok) return { kind: 'failed', code: result.errorCode };
  const parsed = MachineAdminAccessInspectResultV1Schema.safeParse(
    result.result,
  );
  if (!parsed.success) return { kind: 'failed', code: 'action_invalid_output' };
  return 'status' in parsed.data
    ? { kind: 'failed', code: parsed.data.status }
    : { kind: 'read', issue: parsed.data.preauthorizationIssue ?? null };
}
