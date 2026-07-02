import chalk from 'chalk';

import { AGENT_IDS, getAgentCliRuntimeSpec, type AgentId } from '@happier-dev/agents';
import type { ProviderCliRuntimeDescriptor } from '@happier-dev/cli-common/providers';

import type { CommandContext } from '@/cli/commandRegistry';
import { installPluginFromSource, type PluginInstallKind } from '@/plugins/store/install/source';
import { removeInstalledPlugin } from '@/plugins/store/install/remove';
import { createPluginStateStore } from '@/plugins/store/state';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type {
  invokeProviderCliInstall as invokeProviderCliInstallDefault,
} from '@/packagedRuntime/managedTools/invokeProviderCliInstall';
import type { runDoctorCommand as runDoctorCommandDefault } from '@/ui/doctor';

type ProviderStatusRow = Readonly<{
  id: string;
  title: string;
  runtimeSpec: ProviderCliRuntimeDescriptor;
}>;

function usage(providerRows: readonly ProviderStatusRow[] = []): string {
  const lines = [
    `${chalk.bold('happier install')} - Installation helpers`,
    '',
    `${chalk.bold('Usage:')}`,
    '  happier install doctor',
    '  happier install provider <providerId> [--dry-run] [--force]',
    '  happier install plugin <path|archive-url> [--kind path|archive] [--dry-run] [--force]',
    '  happier install plugin update <pluginId> [--dry-run]',
    '  happier install plugin remove <pluginId> [--dry-run]',
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
  invokeProviderCliInstall: typeof invokeProviderCliInstallDefault;
  publishInstalledManifestProjections?: (params: Readonly<{
    pluginIds: readonly string[];
  }>) => Promise<unknown>;
}>;

async function runDoctorCommandLazy(): Promise<void> {
  const { runDoctorCommand } = await import('@/ui/doctor');
  await runDoctorCommand();
}

async function invokeProviderCliInstallLazy(
  ...args: Parameters<typeof invokeProviderCliInstallDefault>
): Promise<Awaited<ReturnType<typeof invokeProviderCliInstallDefault>>> {
  const { invokeProviderCliInstall } = await import('@/packagedRuntime/managedTools/invokeProviderCliInstall');
  return await invokeProviderCliInstall(...args);
}

async function publishInstalledManifestProjectionsLazy(params: Readonly<{
  pluginIds: readonly string[];
}>): Promise<unknown> {
  const { publishInstalledPluginManifestProjectionsToServer } = await import('@/plugins/projection/server/installedManifests');
  return await publishInstalledPluginManifestProjectionsToServer(params);
}

async function publishPluginManifestProjectionBestEffort(
  deps: InstallCliDeps,
  pluginId: string,
): Promise<void> {
  try {
    await (deps.publishInstalledManifestProjections ?? publishInstalledManifestProjectionsLazy)({
      pluginIds: [pluginId],
    });
  } catch {
    // Server projection sync is best-effort; the local plugin mutation remains authoritative on this machine.
  }
}

function readAgentCliRuntimeDescriptor(
  contribution: ResolvedContributionRegistry['providers'][number],
): ProviderCliRuntimeDescriptor | null {
  return contribution.runtimeSpec ?? null;
}

function parseProviderInstallFlags(args: readonly string[]): Readonly<{ dryRun: boolean; skipIfInstalled: boolean }> {
  return {
    dryRun: args.includes('--dry-run'),
    skipIfInstalled: !args.includes('--force'),
  };
}

function readFlagValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parsePluginInstallFlags(args: readonly string[]): Readonly<{
  dryRun: boolean;
  skipIfInstalled: boolean;
  sourceKind: PluginInstallKind | null;
}> {
  const sourceKindRaw = readFlagValue(args, '--kind');
  if (sourceKindRaw !== null && sourceKindRaw !== 'path' && sourceKindRaw !== 'archive') {
    throw new Error(`Unknown plugin source kind: ${sourceKindRaw}`);
  }

  return {
    dryRun: args.includes('--dry-run'),
    skipIfInstalled: !args.includes('--force'),
    sourceKind: (sourceKindRaw as PluginInstallKind | null) ?? null,
  };
}

function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

function readInstallableBuiltInProviderRows(registry: Pick<ResolvedContributionRegistry, 'providers'>): ProviderStatusRow[] {
  return registry.providers
    .filter((contribution) => contribution.provenance === 'first_party')
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
  providerId: AgentId,
  result: Awaited<ReturnType<typeof invokeProviderCliInstallDefault>>,
  log: InstallCliDeps['log'],
): void {
  if (!result.ok) return;
  const runtimeSpec = getAgentCliRuntimeSpec(providerId);
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

async function runPluginInstallCommand(
  context: CommandContext,
  deps: InstallCliDeps,
): Promise<void> {
  const target = context.args[2]?.trim() ?? '';
  if (!target || target === 'help' || target === '--help' || target === '-h') {
    deps.log(usage());
    return;
  }

  if (target === 'update' || target === 'remove') {
    const pluginId = context.args[3]?.trim() ?? '';
    if (!pluginId) {
      deps.error(chalk.red('Error:'), `Missing plugin id for ${target}.`);
      deps.log(usage());
      deps.exit(1);
      return;
    }

    const flags = {
      dryRun: context.args.slice(4).includes('--dry-run'),
    };

    const stateStore = createPluginStateStore();
    const state = await stateStore.read();
    const record = state.plugins[pluginId];
    if (!record) {
      deps.error(chalk.red('Error:'), `Unknown plugin id: ${pluginId}`);
      deps.exit(1);
      return;
    }

    if (target === 'remove') {
      if (flags.dryRun) {
        deps.log(`Dry run: would remove plugin ${pluginId}.`);
        return;
      }
      const result = await removeInstalledPlugin({
        happyHomeDir: stateStore.paths.happyHomeDir,
        pluginId,
      });
      if (!result.ok) {
        deps.error(chalk.red('Error:'), result.errorMessage);
        deps.exit(1);
        return;
      }
      await publishPluginManifestProjectionBestEffort(deps, pluginId);
      deps.log(`Removed plugin ${pluginId}.`);
      return;
    }

    if (flags.dryRun) {
      deps.log(`Dry run: would update plugin ${pluginId} from ${record.source.kind}.`);
      return;
    }

    const result = await installPluginFromSource({
      happyHomeDir: stateStore.paths.happyHomeDir,
      locator: record.source.locator,
      sourceKind: record.source.kind === 'archive' ? 'archive' : 'path',
      skipIfInstalled: false,
    });
    if (!result.ok) {
      deps.error(chalk.red('Error:'), result.errorMessage);
      deps.exit(1);
      return;
    }

    if (result.alreadyInstalled) {
      await publishPluginManifestProjectionBestEffort(deps, result.pluginId);
      deps.log(`Plugin ${pluginId} is already installed.`);
      return;
    }

    await publishPluginManifestProjectionBestEffort(deps, result.pluginId);
    deps.log(`Updated plugin ${result.pluginId} from ${result.sourceKind}.`);
    return;
  }

  const flags = parsePluginInstallFlags(context.args.slice(3));
  const result = await installPluginFromSource({
    happyHomeDir: createPluginStateStore().paths.happyHomeDir,
    locator: target,
    sourceKind: flags.sourceKind ?? undefined,
    skipIfInstalled: flags.skipIfInstalled,
    dryRun: flags.dryRun,
  });
  if (!result.ok) {
    deps.error(chalk.red('Error:'), result.errorMessage);
    deps.exit(1);
    return;
  }

  if (flags.dryRun) {
    deps.log(`Dry run: would install plugin ${result.pluginId} from ${result.sourceKind}.`);
    return;
  }

  if (result.alreadyInstalled) {
    await publishPluginManifestProjectionBestEffort(deps, result.pluginId);
    deps.log(`Plugin ${result.pluginId} is already installed.`);
    return;
  }

  await publishPluginManifestProjectionBestEffort(deps, result.pluginId);
  if (result.sourceKind === 'archive') {
    deps.log(`Installed plugin ${result.pluginId} from archive.`);
    return;
  }

  deps.log(`Installed plugin ${result.pluginId}.`);
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
    publishInstalledManifestProjections: publishInstalledManifestProjectionsLazy,
  },
): Promise<void> {
  try {
    const subcommand = context.args[1] ?? 'help';
    const needsRegistry = subcommand === 'help' || subcommand === '--help' || subcommand === '-h' || subcommand === 'provider';
    const mergedRegistry = needsRegistry
      ? await resolveMergedContributionRegistry({ happyHomeDir: createPluginStateStore().paths.happyHomeDir })
      : null;
    const installableProviderRows = mergedRegistry ? readInstallableBuiltInProviderRows(mergedRegistry) : [];
    if (subcommand === 'doctor') {
      await deps.runDoctorCommand();
      return;
    }
    if (subcommand === 'plugin') {
      await runPluginInstallCommand(context, deps);
      return;
    }
    if (subcommand === 'provider') {
      const providerIdRaw = context.args[2]?.trim() ?? '';
      if (!providerIdRaw) {
        deps.error(chalk.red('Error:'), 'Missing provider id.');
        deps.log(usage(installableProviderRows));
        deps.exit(1);
        return;
      }
      if (providerIdRaw === 'help' || providerIdRaw === '--help' || providerIdRaw === '-h') {
        deps.log(usage(installableProviderRows));
        return;
      }
      if (!isAgentId(providerIdRaw)) {
        deps.error(chalk.red('Error:'), `Unknown provider id: ${providerIdRaw}`);
        deps.log(usage(installableProviderRows));
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
