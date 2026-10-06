import { ok } from '@happier-dev/cli-common/output';
import { resolveSessionWaitTimeoutSeconds } from '@happier-dev/protocol/actions/specs/sessionCommandCli';

import { readIntFlagValue } from '@/cli/commands/shared/argvFlags';
import type { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';

import {
  normalizeActionExecuteResult,
  type NormalizedCliActionExecuteResult,
} from './normalizeActionExecuteResult';

/**
 * The idle wait `happier session create --wait` composes.
 *
 * `happier session wait` itself is a compiled `session.wait.idle` command and
 * owns no grammar here; these helpers exist for the create workflow, which
 * waits as one step of a longer local flow. The timeout default and ceiling
 * come from the same Action-owned resolver the compiled command's binder uses.
 */
export function readSessionWaitTimeoutSecondsFlag(argv: readonly string[]): number {
  return resolveSessionWaitTimeoutSeconds(readIntFlagValue(argv, '--timeout', { min: 1 }));
}

export async function executeSessionWaitAction(params: Readonly<{
  executor: ReturnType<typeof createCliActionExecutorFromCredentials>;
  sessionId: string;
  timeoutSeconds: number;
}>): Promise<NormalizedCliActionExecuteResult> {
  return normalizeActionExecuteResult(await params.executor.execute(
    'session.wait.idle',
    { sessionId: params.sessionId, timeoutSeconds: params.timeoutSeconds },
    { surface: 'cli', defaultSessionId: null },
  ));
}

export function printSessionWaitSuccess(): void {
  console.log(ok('Session idle'));
}
