import chalk from 'chalk';
import { AutomationManualIdempotencyKeyV1Schema } from '@happier-dev/protocol/automations/automationOccurrenceV1';

import {
  listAutomationDefinitions,
  runAutomationNow,
  type AutomationRunSummary,
} from '@/api/automations';
import type { AutomationDefinitionListResponse } from '@happier-dev/protocol';
import type { CommandContext } from '@/cli/commandRegistry';
import { assertCommandArguments, readRawFlagValue } from '@/cli/commands/shared/argvFlags';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import { printJsonEnvelope, wantsJson } from '@/cli/output/jsonEnvelope';
import { readCredentials } from '@/persistence';
import { fail } from '@happier-dev/cli-common/output';

type AutomationCommandDeps = Readonly<{
  readCredentialsFn: typeof readCredentials;
  listAutomationDefinitionsFn: (params: Readonly<{
    token: string;
    limit?: number;
    cursor?: string;
  }>) => Promise<AutomationDefinitionListResponse>;
  runAutomationNowFn: (params: Readonly<{
    token: string;
    automationId: string;
    idempotencyKey?: string | null;
  }>) => Promise<AutomationRunSummary>;
}>;

const DEFAULT_DEPS: AutomationCommandDeps = {
  readCredentialsFn: readCredentials,
  listAutomationDefinitionsFn: listAutomationDefinitions,
  runAutomationNowFn: runAutomationNow,
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
  const credentials = await deps.readCredentialsFn();
  if (!credentials) {
    const error = new Error('Not authenticated. Run "happier auth login" first.');
    (error as Error & { code?: string }).code = 'not_authenticated';
    throw error;
  }
  const run = await deps.runAutomationNowFn({
    token: credentials.token,
    automationId: parsed.automationId,
    ...(parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {}),
  });
  if (wantsJson(args)) {
    await printJsonEnvelope({ ok: true, kind: 'automation_run', data: { run } });
    return;
  }
  console.log(chalk.green(`Queued automation run ${run.id}`));
}

export async function handleAutomationCliCommand(context: CommandContext): Promise<void> {
  const args = context.args.slice(1);
  try {
    await handleAutomationCommand(args);
  } catch (error) {
    if (wantsJson(args)) {
      const mapped = mapUnknownErrorToControlError(error);
      await printJsonEnvelope({
        ok: false,
        kind: args[0] === 'list' ? 'automation_list' : 'automation_run',
        error: { code: mapped.code, ...(mapped.message ? { message: mapped.message } : {}) },
      }, { exitCode: mapped.unexpected ? 2 : 1 });
      return;
    }
    console.error(fail(error instanceof Error ? error.message : 'Unknown error'));
    process.exitCode = 1;
  }
}
