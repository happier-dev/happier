import chalk from 'chalk';
import { AutomationManualIdempotencyKeyV1Schema } from '@happier-dev/protocol';

import { runAutomationNow, type AutomationRunSummary } from '@/api/automations';
import type { CommandContext } from '@/cli/commandRegistry';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import { printJsonEnvelope, wantsJson } from '@/cli/output/jsonEnvelope';
import { readCredentials } from '@/persistence';

type AutomationCommandDeps = Readonly<{
  readCredentialsFn: typeof readCredentials;
  runAutomationNowFn: (params: Readonly<{
    token: string;
    automationId: string;
    idempotencyKey?: string | null;
  }>) => Promise<AutomationRunSummary>;
}>;

const DEFAULT_DEPS: AutomationCommandDeps = {
  readCredentialsFn: readCredentials,
  runAutomationNowFn: runAutomationNow,
};

function showAutomationHelp(): void {
  console.log(`
${chalk.bold('happier automation')} - Manage automations

${chalk.bold('Usage:')}
  happier automation run <automation-id> [--idempotency-key <key>] [--json]

${chalk.bold('Commands:')}
  run    Queue an immediate run through the automation's existing assignments

${chalk.bold('Options:')}
  --idempotency-key <key>  Reuse the same run when a trigger occurrence is retried
  --json                   Print a machine-readable result
`);
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
  if (subcommand !== 'run') throw new Error(`Unknown automation subcommand: ${subcommand}`);

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
        kind: 'automation_run',
        error: { code: mapped.code, ...(mapped.message ? { message: mapped.message } : {}) },
      }, { exitCode: mapped.unexpected ? 2 : 1 });
      return;
    }
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    process.exitCode = 1;
  }
}
