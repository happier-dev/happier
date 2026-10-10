import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import { AutomationManualIdempotencyKeyV1Schema } from '@happier-dev/protocol/automations/automationOccurrenceV1';

import { listAutomationDefinitions } from '@/api/automations';
import { WorkflowActionOutputSchemasV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { AutomationDefinitionListResponse } from '@happier-dev/protocol';
import type { CommandContext } from '@/cli/commandRegistry';
import { assertCommandArguments, readRawFlagValue } from '@/cli/commands/shared/argvFlags';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import { printJsonEnvelope, wantsJson } from '@/cli/output/jsonEnvelope';
import { readCredentials, readStoredCredentialsForServerId, type StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import type { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { tryHandleApprovalRequestCreated } from '@/cli/commands/session/shared/tryHandleApprovalRequestCreated';
import { fail } from '@happier-dev/cli-common/output';

type AutomationCommandDeps = Readonly<{
  readCredentialsFn: (serverId?: string) => Promise<StoredCredentials | null>;
  listAutomationDefinitionsFn: (params: Readonly<{
    token: string;
    limit?: number;
    cursor?: string;
  }>) => Promise<AutomationDefinitionListResponse>;
  createExecutorFn: (params: Parameters<typeof createCliActionExecutorFromCredentials>[0]) =>
    Pick<ReturnType<typeof createCliActionExecutorFromCredentials>, 'execute'> |
    Promise<Pick<ReturnType<typeof createCliActionExecutorFromCredentials>, 'execute'>>;
}>;

const DEFAULT_DEPS: AutomationCommandDeps = {
  readCredentialsFn: (serverId) => serverId ? readStoredCredentialsForServerId(serverId) : readCredentials(),
  listAutomationDefinitionsFn: listAutomationDefinitions,
  createExecutorFn: async (params) => (await import('@/session/actions/createCliActionExecutorFromCredentials'))
    .createCliActionExecutorFromCredentials(params),
};

function showAutomationHelp(): void {
  console.log(`
${chalk.bold('happier automation')} - Manage automations

${chalk.bold('Usage:')}
  happier automation list [--cursor <opaque>] [--json]
  happier automation run <automation-id> [--idempotency-key <key>] [--json]

${chalk.bold('Commands:')}
  list   List automations with their stable IDs
  run    Queue an immediate run through the automation's existing assignments

${chalk.bold('Options:')}
  --cursor <opaque>        Continue listing from an opaque cursor
  --idempotency-key <key>  Reuse the same run when a trigger occurrence is retried
  --json                   Print a machine-readable result
`);
}

function parseListArgs(args: readonly string[]): Readonly<{ cursor: string | null }> {
  const usage = 'Usage: happier automation list [--cursor <opaque>] [--json]';
  assertCommandArguments(args, {
    usage,
    startIndex: 1,
    booleanFlags: ['--json'],
    valueFlags: ['--cursor'],
    inlineValueFlags: [],
    maxPositionals: 0,
  });
  const cursor = readRawFlagValue(args, '--cursor');
  if (cursor !== null && cursor.trim().length === 0) throw new Error(usage);
  return { cursor };
}

function parseRunArgs(args: readonly string[]): Readonly<{
  automationId: string;
  idempotencyKey: string | null;
}> {
  const positionals: string[] = [];
  let idempotencyKey: string | null = null;
  for (let index = 1; index < args.length; index += 1) {
    const value = args[index] ?? '';
    if (value === '--json') continue;
    if (value === '--idempotency-key') {
      const next = args[index + 1]?.trim();
      if (!next || next.startsWith('-')) throw new Error('Missing value for --idempotency-key');
      idempotencyKey = next;
      index += 1;
      continue;
    }
    if (value.startsWith('--idempotency-key=')) {
      idempotencyKey = value.slice('--idempotency-key='.length).trim();
      if (!idempotencyKey) throw new Error('Missing value for --idempotency-key');
      continue;
    }
    if (value.startsWith('-')) throw new Error(`Unknown automation run option: ${value}`);
    positionals.push(value.trim());
  }
  if (positionals.length !== 1 || !positionals[0]) {
    throw new Error('Usage: happier automation run <automation-id> [--idempotency-key <key>] [--json]');
  }
  if (idempotencyKey) {
    const parsedKey = AutomationManualIdempotencyKeyV1Schema.safeParse(idempotencyKey);
    if (!parsedKey.success) {
      throw new Error('--idempotency-key must be NFC-normalized and at most 191 UTF-8 bytes');
    }
    idempotencyKey = parsedKey.data;
  }
  return { automationId: positionals[0], idempotencyKey };
}

export async function handleAutomationCommand(
  args: string[],
  deps: AutomationCommandDeps = DEFAULT_DEPS,
): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    showAutomationHelp();
    return;
  }
  if (subcommand !== 'list' && subcommand !== 'run') {
    throw new Error(`Unknown automation subcommand: ${subcommand}`);
  }

  if (subcommand === 'list') {
    const parsed = parseListArgs(args);
    const credentials = await deps.readCredentialsFn();
    if (!credentials) {
      const error = new Error('Not authenticated. Run "happier auth login" first.');
      (error as Error & { code?: string }).code = 'not_authenticated';
      throw error;
    }
    const result = await deps.listAutomationDefinitionsFn({
      token: credentials.token,
      ...(parsed.cursor !== null ? { cursor: parsed.cursor } : {}),
    });
    if (wantsJson(args)) {
      await printJsonEnvelope({ ok: true, kind: 'automation_list', data: result });
      return;
    }
    if (result.automations.length === 0) {
      console.log('No automations.');
    } else {
      for (const automation of result.automations) {
        const state = automation.enabled ? chalk.green('active') : chalk.yellow('paused');
        console.log(`${automation.id}\t${automation.name || '(unnamed)'}\t${state}`);
      }
    }
    if (result.nextCursor) {
      console.log(chalk.dim(
        `More automations are available. Continue with: happier automation list --cursor ${result.nextCursor}`,
      ));
    }
    return;
  }

  const parsed = parseRunArgs(args);
  const serverId = configuration.activeServerId;
  const serverApiUrl = configuration.apiServerUrl;
  const credentials = await deps.readCredentialsFn(serverId);
  if (!credentials) {
    const error = new Error('Not authenticated. Run "happier auth login" first.');
    (error as Error & { code?: string }).code = 'not_authenticated';
    throw error;
  }
  const executor = await deps.createExecutorFn({ credentials, serverId, serverApiUrl });
  const outcome = await executor.execute('workflow.trigger.run_now', {
    automationId: parsed.automationId,
    ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
  }, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, serverId, actionRequestId: randomUUID() });
  if (!outcome.ok) {
    throw Object.assign(new Error(outcome.error), { code: outcome.errorCode, actionFailure: true,
      ...(outcome.details === undefined ? {} : { details: outcome.details }) });
  }
  if (await tryHandleApprovalRequestCreated({ envelopeKind: 'automation_run', json: wantsJson(args), result: outcome.result })) return;
  const receipt = WorkflowActionOutputSchemasV1['workflow.trigger.run_now'].parse(outcome.result);
  if (wantsJson(args)) {
    await printJsonEnvelope({ ok: true, kind: 'automation_run', data: receipt });
    return;
  }
  console.log(chalk.green(`Queued automation run ${receipt.run.id}`));
}

export async function handleAutomationCliCommand(context: CommandContext): Promise<void> {
  const args = context.args.slice(1);
  try {
    await handleAutomationCommand(args);
  } catch (error) {
    if (wantsJson(args)) {
      const mapped = mapUnknownErrorToControlError(error);
      const failure = error !== null && typeof error === 'object' && 'actionFailure' in error && error.actionFailure === true
        && 'code' in error && typeof error.code === 'string' ? error : null;
      await printJsonEnvelope({
        ok: false,
        kind: args[0] === 'list' ? 'automation_list' : 'automation_run',
        error: { code: failure?.code ?? mapped.code, ...(mapped.message ? { message: mapped.message } : {}),
          ...(failure && 'details' in failure ? { details: failure.details } : {}) },
      }, { exitCode: failure ? 1 : mapped.unexpected ? 2 : 1 });
      return;
    }
    console.error(fail(error instanceof Error ? error.message : 'Unknown error'));
    process.exitCode = 1;
  }
}
