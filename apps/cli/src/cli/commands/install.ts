import chalk from 'chalk';

import { AGENT_IDS, getProviderCliRuntimeSpec, type AgentId } from '@happier-dev/agents';

import type { CommandContext } from '@/cli/commandRegistry';
import type {
  invokeProviderCliInstall as invokeProviderCliInstallDefault,
} from '@/runtime/managedTools/invokeProviderCliInstall';
import type { runDoctorCommand as runDoctorCommandDefault } from '@/ui/doctor';

function usage(): string {
  return [
    `${chalk.bold('happier install')} - Installation helpers`,
    '',
    `${chalk.bold('Usage:')}`,
    '  happier install doctor',
    '  happier install provider <providerId> [--dry-run] [--force]',
    '',
  ].join('\n');
}

type InstallCliDeps = Readonly<{
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => never | void;
  runDoctorCommand: typeof runDoctorCommandDefault;
  invokeProviderCliInstall: typeof invokeProviderCliInstallDefault;
}>;

async function runDoctorCommandLazy(): Promise<void> {
  const { runDoctorCommand } = await import('@/ui/doctor');
  await runDoctorCommand();
}

async function invokeProviderCliInstallLazy(
  ...args: Parameters<typeof invokeProviderCliInstallDefault>
): Promise<Awaited<ReturnType<typeof invokeProviderCliInstallDefault>>> {
  const { invokeProviderCliInstall } = await import('@/runtime/managedTools/invokeProviderCliInstall');
  return await invokeProviderCliInstall(...args);
}

function parseProviderInstallFlags(args: readonly string[]): Readonly<{ dryRun: boolean; skipIfInstalled: boolean }> {
  return {
    dryRun: args.includes('--dry-run'),
    skipIfInstalled: !args.includes('--force'),
  };
}

function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

function printProviderInstallResult(
  providerId: AgentId,
  result: Awaited<ReturnType<typeof invokeProviderCliInstallDefault>>,
  log: InstallCliDeps['log'],
): void {
  if (!result.ok) return;
  const runtimeSpec = getProviderCliRuntimeSpec(providerId);
  if (result.alreadyInstalled) {
    log(`${runtimeSpec.title} is already installed.`);
  } else if (result.plan.installMode === 'vendor_recipe') {
    log(`Installed ${runtimeSpec.title}.`);
  } else if (result.plan.installMode === 'github_release_binary') {
    log(`Installed ${runtimeSpec.title} via managed release binary.`);
  } else if (result.plan.installMode === 'managed_package') {
    log(`Installed ${runtimeSpec.title} via managed package runtime.`);
  }
  if (result.logPath) {
    log(`Install log: ${result.logPath}`);
  }
}

export async function runInstallCliCommand(
  context: CommandContext,
  deps: InstallCliDeps = {
    log: console.log,
    error: console.error,
    exit: (code: number) => {
      process.exitCode = code;
    },
    runDoctorCommand: runDoctorCommandLazy,
    invokeProviderCliInstall: invokeProviderCliInstallLazy,
  },
): Promise<void> {
  try {
    const subcommand = context.args[1] ?? 'help';
    if (subcommand === 'doctor') {
      await deps.runDoctorCommand();
      return;
    }
    if (subcommand === 'provider') {
      const providerIdRaw = context.args[2]?.trim() ?? '';
      if (!providerIdRaw) {
        deps.error(chalk.red('Error:'), 'Missing provider id.');
        deps.log(usage());
        deps.exit(1);
        return;
      }
      if (providerIdRaw === 'help' || providerIdRaw === '--help' || providerIdRaw === '-h') {
        deps.log(usage());
        return;
      }
      if (!isAgentId(providerIdRaw)) {
        deps.error(chalk.red('Error:'), `Unknown provider id: ${providerIdRaw}`);
        deps.log(usage());
        deps.exit(1);
        return;
      }

      const flags = parseProviderInstallFlags(context.args.slice(3));
      const result = await deps.invokeProviderCliInstall({
        agentId: providerIdRaw,
        params: flags,
        env: process.env,
        nodePlatform: process.platform,
      });
      if (!result.ok) {
        deps.error(chalk.red('Error:'), result.errorMessage);
        if (result.logPath) {
          deps.log(`Install log: ${result.logPath}`);
        }
        deps.exit(1);
        return;
      }
      if (flags.dryRun) {
        deps.log(`Dry run: would install ${result.plan.title} via ${result.plan.installMode}.`);
        if (result.logPath) {
          deps.log(`Install log: ${result.logPath}`);
        }
        return;
      }
      printProviderInstallResult(providerIdRaw, result, deps.log);
      return;
    }
    if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
      deps.log(usage());
      return;
    }
    deps.error(chalk.red('Error:'), `Unknown install subcommand: ${subcommand}`);
    deps.log(usage());
    deps.exit(1);
  } catch (error) {
    deps.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    if (process.env.DEBUG) {
      deps.error(error);
    }
    if (error && typeof error === 'object' && 'logPath' in error && typeof error.logPath === 'string') {
      deps.log(`Install log: ${error.logPath}`);
    }
    deps.exit(1);
    return;
  }
}

export async function handleInstallCliCommand(context: CommandContext): Promise<void> {
  await runInstallCliCommand(context);
}
