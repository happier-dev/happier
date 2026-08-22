import chalk from 'chalk';

import type {
  AccountSettingsMutationResult,
} from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { printJsonEnvelope } from '@/cli/output/jsonEnvelope';

export type McpServersCommandErrorCode = 'invalid_arguments';

export function createMcpServersCommandError(
  code: McpServersCommandErrorCode,
  message: string,
): Error & { code: McpServersCommandErrorCode } {
  const error = new Error(message) as Error & { code: McpServersCommandErrorCode };
  error.code = code;
  return error;
}

export function createInvalidArgumentsError(message: string): Error & { code: 'invalid_arguments' } {
  return createMcpServersCommandError('invalid_arguments', message) as Error & { code: 'invalid_arguments' };
}

function isSettledAccountSettingsSuccess(
  result: AccountSettingsMutationResult,
): result is Extract<AccountSettingsMutationResult, Readonly<{
  status: 'applied' | 'satisfied' | 'unchanged';
}>> {
  return result.status === 'applied'
    || result.status === 'satisfied'
    || result.status === 'unchanged';
}

function redactAccountSettingsMutationFailure(
  result: Exclude<AccountSettingsMutationResult, Readonly<{
    status: 'applied' | 'satisfied' | 'unchanged';
  }>>,
): Readonly<Record<string, string | boolean | number>> {
  switch (result.status) {
    case 'conflict':
      return { status: result.status, currentVersion: result.currentVersion };
    case 'outcomeUnknown':
      return { status: result.status, lastKnownVersion: result.lastKnownVersion };
    case 'cancelled':
      return { status: result.status, submitted: result.submitted };
    case 'locked':
    case 'invalid':
      return { status: result.status, reason: result.reason };
    case 'unavailable':
      return { status: result.status, retryable: result.retryable };
  }
}

function accountSettingsFailureCode(result: Exclude<AccountSettingsMutationResult, Readonly<{
  status: 'applied' | 'satisfied' | 'unchanged';
}>>): string {
  switch (result.status) {
    case 'conflict': return 'account_settings_conflict';
    case 'outcomeUnknown': return 'account_settings_outcome_unknown';
    case 'cancelled': return 'account_settings_cancelled';
    case 'locked': return 'account_settings_locked';
    case 'invalid': return 'account_settings_invalid';
    case 'unavailable': return 'account_settings_unavailable';
  }
}

/**
 * MCP mutators use the shared Settings owner but retain a CLI-visible
 * settlement record. The record deliberately omits the full Account Settings
 * projection so a failed mutation cannot disclose unrelated configuration.
 */
export async function reportMcpServersAccountSettingsMutation(
  result: AccountSettingsMutationResult,
  input: Readonly<{ kind: string; json: boolean }>,
): Promise<boolean> {
  if (isSettledAccountSettingsSuccess(result)) return true;

  const settlement = redactAccountSettingsMutationFailure(result);
  const code = accountSettingsFailureCode(result);
  if (input.json) {
    await printJsonEnvelope({
      ok: false,
      kind: input.kind,
      error: { code, settlement },
    }, { exitCode: 1 });
  } else {
    console.error(chalk.red('Error:'), `MCP Servers Settings mutation did not settle: ${result.status}`);
    process.exitCode = 1;
  }
  return false;
}
