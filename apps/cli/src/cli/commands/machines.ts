import chalk from 'chalk';
import { definitionList, renderHelpPage } from '@happier-dev/cli-common/output';

import type { CommandContext } from '@/cli/commandRegistry';
import { assertCommandArguments, readCommandPositionals } from '@/cli/commands/shared/argvFlags';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import { printJsonEnvelope, wantsJson } from '@/cli/output/jsonEnvelope';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import type { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';

const USAGE = 'Usage: happier machines list [--json]';
type AccountMachines = Awaited<ReturnType<
  ReturnType<typeof createCliActionExecutorFromCredentials>['listAccountMachines']
>>;
type MachinesDeps = Readonly<{
  readCredentialsFn: () => Promise<StoredCredentials | null>;
  listMachinesFn?: (credentials: StoredCredentials, signal?: AbortSignal) => Promise<AccountMachines>;
}>;

function showHelp(): void {
  console.log(renderHelpPage({
    title: 'happier machines',
    subtitle: 'Discover Account machines for API targeting',
    usage: [{ label: 'happier machines list [--json]', description: 'List machines registered to the current Account' }],
    notes: ['Authentication may come from happier auth login or HAPPIER_TOKEN.'],
  }));
}

async function list(credentials: StoredCredentials, signal?: AbortSignal): Promise<AccountMachines> {
  const { createCliActionExecutorFromCredentials } = await import('@/session/actions/createCliActionExecutorFromCredentials');
  const executor = createCliActionExecutorFromCredentials({ credentials });
  return await executor.listAccountMachines(signal);
}

export async function handleMachinesCommand(args: string[], deps: Partial<MachinesDeps> = {}, signal?: AbortSignal): Promise<void> {
  try {
    const subcommand = args[0];
    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') { showHelp(); return; }
    assertCommandArguments(args, { usage: USAGE, startIndex: 1, booleanFlags: ['--json'], maxPositionals: 0 });
    if (subcommand !== 'list' || readCommandPositionals(args, { startIndex: 1 }).length > 0) {
      throw Object.assign(new Error(`Unknown machines subcommand: ${subcommand}\n${USAGE}`), { code: 'unknown_subcommand' });
    }
    const credentials = await (deps.readCredentialsFn ?? readStoredCredentials)();
    if (!credentials) throw Object.assign(new Error('Not authenticated. Run "happier auth login" first.'), { code: 'not_authenticated' });
    const machines = await (deps.listMachinesFn ?? list)(credentials, signal);
    if (wantsJson(args)) { await printJsonEnvelope({ ok: true, kind: 'machines_list', data: { machines } }); return; }
    console.log(machines.length ? definitionList(machines.map((machine) => ({
      label: machine.id,
      value: `${machine.revokedAt !== null ? 'revoked' : machine.active ? 'active' : 'inactive'}${machine.replacedByMachineId ? ` -> ${machine.replacedByMachineId}` : ''}`,
    }))) : '(no machines registered)');
  } catch (error) {
    const mapped = mapUnknownErrorToControlError(error);
    if (wantsJson(args)) await printJsonEnvelope({ ok: false, kind: 'machines_list', error: { code: mapped.code, ...(mapped.message ? { message: mapped.message } : {}) } }, { exitCode: mapped.unexpected ? 2 : 1 });
    else { console.error(chalk.red('Error:'), mapped.message ?? mapped.code); if (mapped.code === 'invalid_arguments' || mapped.code === 'unknown_subcommand') showHelp(); process.exitCode = mapped.unexpected ? 2 : 1; }
  }
}

export async function handleMachinesCliCommand(context: CommandContext): Promise<void> {
  await handleMachinesCommand(context.args.slice(1), undefined, context.signal);
}
