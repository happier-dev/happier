import chalk from 'chalk';

import type { AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';

import type { CommandContext } from '@/cli/commandRegistry';
import { hasFlag } from '@/cli/commands/shared/argvFlags';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type {
  invokeAgentCliInstall as invokeProviderCliInstallDefault,
} from '@/packagedRuntime/managedTools/invokeAgentCliInstall';
import type { runDoctorCommand as runDoctorCommandDefault } from '@/ui/doctor';

type ProviderStatusRow = Readonly<{
  id: string;
  title: string;
  runtimeSpec: AgentCliRuntimeDescriptor;
}>;

function usage(providerRows: readonly ProviderStatusRow[] = []): string {
  const lines = [
    `${chalk.bold('happier install')} - Installation helpers`,
    '',
    `${chalk.bold('Usage:')}`,
    '  happier install doctor',
    '  happier install provider <providerId> [--dry-run] [--force]',
    '',
  ];
  if (providerRows.length > 0) {
    lines.push(
      `${chalk.bold('Available providers:')}`,
      ...providerRows.map((row) => `  ${row.title} (${row.id}) — Install with happier install provider ${row.id}`),
      '',
    );
  }
  return lines.join('\n');
}

type InstallCliDeps = Readonly<{
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => never | void;
  runDoctorCommand: typeof runDoctorCommandDefault;
  invokeAgentCliInstall: typeof invokeProviderCliInstallDefault;
  runPluginsCommand?: (context: CommandContext) => Promise<void>;
}>;

async function runDoctorCommandLazy(): Promise<void> {
  const { runDoctorCommand } = await import('@/ui/doctor');
  await runDoctorCommand();
}

async function invokeProviderCliInstallLazy(
  ...args: Parameters<typeof invokeProviderCliInstallDefault>
): Promise<Awaited<ReturnType<typeof invokeProviderCliInstallDefault>>> {
  const { invokeAgentCliInstall } = await import('@/packagedRuntime/managedTools/invokeAgentCliInstall');
  return await invokeAgentCliInstall(...args);
}

async function runPluginsCommandLazy(context: CommandContext): Promise<void> {
  const { handlePluginsCliCommand } = await import('@/cli/commands/plugins');
  await handlePluginsCliCommand(context);
}

function readAgentCliRuntimeDescriptor(
  contribution: ResolvedContributionRegistry['agents'][number],
): AgentCliRuntimeDescriptor | null {
  return contribution.runtimeSpec ?? null;
}

function parseProviderInstallFlags(args: readonly string[]): Readonly<{ dryRun: boolean; skipIfInstalled: boolean }> {
  return {
    dryRun: hasFlag(args, '--dry-run'),
    skipIfInstalled: !hasFlag(args, '--force'),
  };
}

function readInstallableProviderRows(registry: Pick<ResolvedContributionRegistry, 'agents'>): ProviderStatusRow[] {
  return registry.agents
    .map((contribution) => {
      const runtimeSpec = readAgentCliRuntimeDescriptor(contribution);
      if (!runtimeSpec) return null;
      if (runtimeSpec.manualInstallKind === 'none') return null;
      return {
        id: contribution.id,
        title: runtimeSpec.title,
        runtimeSpec,
      } satisfies ProviderStatusRow;
    })
    .filter((row): row is ProviderStatusRow => row !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function printProviderInstallResult(
  result: Awaited<ReturnType<typeof invokeProviderCliInstallDefault>>,
  log: InstallCliDeps['log'],
): void {
  if (!result.ok) return;
  const title = result.plan.title;
  if (result.alreadyInstalled) {
    log(`${title} is already installed.`);
  } else if (result.plan.installMode === 'vendor_recipe') {
    log(`Installed ${title}.`);
  } else if (result.plan.installMode === 'github_release_binary') {
    log(`Installed ${title} via managed release binary.`);
  } else if (result.plan.installMode === 'managed_package') {
    log(`Installed ${title} via managed package runtime.`);
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
    invokeAgentCliInstall: invokeProviderCliInstallLazy,
    runPluginsCommand: runPluginsCommandLazy,
  },
): Promise<void> {
  try {
    const subcommand = context.args[1] ?? 'help';
    const needsRegistry = subcommand === 'help' || subcommand === '--help' || subcommand === '-h' || subcommand === 'provider';
    const mergedRegistry = needsRegistry
      ? await resolveMergedContributionRegistry({ happyHomeDir: resolvePluginStorePaths().happyHomeDir })
      : null;
    const installableProviderRows = mergedRegistry ? readInstallableProviderRows(mergedRegistry) : [];
    if (subcommand === 'doctor') {
      await deps.runDoctorCommand();
      return;
    }
    if (subcommand === 'plugin') {
      // `happier install plugin ...` shipped before plugin lifecycle commands
      // moved under their one canonical owner. Keep that released spelling as
      // a pure argv redirect: it owns no parsing, preparation, approval, or
      // mutation behavior of its own.
      const legacyArgs = context.args.slice(2);
      const pluginsArgs = legacyArgs[0] === 'update'
        ? ['plugins', 'update', ...legacyArgs.slice(1)]
        : ['plugins', 'install', ...legacyArgs];
      await (deps.runPluginsCommand ?? runPluginsCommandLazy)({ ...context, args: pluginsArgs });
      return;
    }
    if (subcommand === 'provider') {
      const agentIdRaw = context.args[2]?.trim() ?? '';
      if (!agentIdRaw) {
        deps.error(chalk.red('Error:'), 'Missing provider id.');
        deps.log(usage(installableProviderRows));
        deps.exit(1);
        return;
      }
      if (agentIdRaw === 'help' || agentIdRaw === '--help' || agentIdRaw === '-h') {
        deps.log(usage(installableProviderRows));
        return;
      }
      const providerRow = installableProviderRows.find((row) => row.id === agentIdRaw);
      if (!providerRow) {
        deps.error(chalk.red('Error:'), `Unknown provider id: ${agentIdRaw}`);
        deps.log(usage(installableProviderRows));
        deps.exit(1);
        return;
      }

      const flags = parseProviderInstallFlags(context.args.slice(3));
      const result = await deps.invokeAgentCliInstall({
        agentId: agentIdRaw,
        runtimeSpec: providerRow.runtimeSpec,
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
      printProviderInstallResult(result, deps.log);
      return;
    }
    if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
      deps.log(usage(installableProviderRows));
      return;
    }
    deps.error(chalk.red('Error:'), `Unknown install subcommand: ${subcommand}`);
    deps.log(usage(installableProviderRows));
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
