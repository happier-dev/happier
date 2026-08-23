import chalk from 'chalk';

import { getAgentCliRuntimeSpec, isBundledAgentId, type BundledAgentId } from '@happier-dev/agents';
import type { AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';

import type { CommandContext } from '@/cli/commandRegistry';
import { hasFlag, readFlagValue } from '@/cli/commands/shared/argvFlags';
import {
  requestUserPluginChange,
  resolveUserPluginChangeApproval,
  type UserPluginChangeResult,
} from '@/plugins/daemon/changeClient';
import type { PluginChangeRequest } from '@/plugins/daemon/changeContract';
import { resolveArchiveExpectedIntegrity } from '@/plugins/distribution/archive/integrity';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { isInteractiveTerminal } from '@/terminal/prompts/promptInput';
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
    '  happier install plugin <path|archive-url|package> [--kind path|archive|npm] [--selector <version>] [--integrity <sha256-SRI>] [--dry-run]',
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
  invokeAgentCliInstall: typeof invokeProviderCliInstallDefault;
  isInteractiveTerminal?: () => boolean;
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

type PluginInstallSourceKind = 'path' | 'archive' | 'npm';

function parsePluginInstallFlags(args: readonly string[]): Readonly<{
  dryRun: boolean;
  sourceKind: PluginInstallSourceKind | null;
  selector: string | null;
  integrity: string | null;
}> {
  const sourceKindRaw = readFlagValue(args, '--kind');
  if (sourceKindRaw !== null && sourceKindRaw !== 'path' && sourceKindRaw !== 'archive' && sourceKindRaw !== 'npm') {
    throw new Error(`Unknown plugin source kind: ${sourceKindRaw}`);
  }

  return {
    dryRun: hasFlag(args, '--dry-run'),
    sourceKind: (sourceKindRaw as PluginInstallSourceKind | null) ?? null,
    selector: readFlagValue(args, '--selector'),
    integrity: readFlagValue(args, '--integrity'),
  };
}

function inferPluginInstallSourceKind(locator: string): Exclude<PluginInstallSourceKind, 'npm'> {
  const path = (() => {
    try {
      return new URL(locator).pathname;
    } catch {
      return locator;
    }
  })().toLowerCase();
  return ['.tar.gz', '.tgz', '.tar.xz', '.zip'].some((suffix) => path.endsWith(suffix))
    ? 'archive'
    : 'path';
}

async function createPluginInstallRequest(
  locator: string,
  sourceKind: PluginInstallSourceKind | null,
  selector: string | null,
  integrity: string | null,
): Promise<PluginChangeRequest> {
  const kind = sourceKind ?? inferPluginInstallSourceKind(locator);
  if (kind === 'archive') {
    const expectedIntegrity = await resolveArchiveExpectedIntegrity({
      locator,
      explicitIntegrity: integrity,
    });
    return {
      kind: 'installArchive',
      locator,
      ...(expectedIntegrity ? { expectedIntegrity } : {}),
    };
  }
  if (integrity) {
    throw new Error('--integrity is only valid for archive plugin installs');
  }
  if (kind === 'npm') {
    return {
      kind: 'installNpm',
      packageName: locator,
      ...(selector ? { selector } : {}),
    };
  }
  return { kind: 'installPath', locator, development: false };
}

function pluginChangeMessage(result: UserPluginChangeResult): string {
  switch (result.kind) {
    case 'sourceRootReviewRequired':
      return `Plugin source-root review is required (pending ${result.pendingChangeId}).`;
    case 'reviewRequired':
      return `Plugin installation review is required (pending ${result.pendingChangeId}).`;
    case 'cancelled':
      return 'Plugin installation was cancelled.';
    case 'expired':
      return 'Plugin installation review expired; run the command again to review the current candidate.';
    case 'busy':
      return `Another plugin change is already in progress for ${result.pluginId}.`;
    case 'unavailable':
      return `Plugin change is unavailable (${result.code}).`;
    case 'conflict':
      return `Plugin facts changed while applying ${result.pluginId}; review the candidate again.`;
    case 'failed':
      return result.message ?? `Plugin change failed (${result.code}).`;
    case 'outcomeUnknown':
      return `The daemon may have applied the change for ${result.pluginId}; inspect installed plugin state before retrying.`;
    case 'committed':
      return `Installed plugin ${result.pluginId}; desired and applied generation ${result.appliedGeneration ?? 'none'}.`;
  }
}

function readInstallableBuiltInProviderRows(registry: Pick<ResolvedContributionRegistry, 'agents'>): ProviderStatusRow[] {
  return registry.agents
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
  agentId: BundledAgentId,
  result: Awaited<ReturnType<typeof invokeProviderCliInstallDefault>>,
  log: InstallCliDeps['log'],
): void {
  if (!result.ok) return;
  const runtimeSpec = getAgentCliRuntimeSpec(agentId);
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

    const flags = parsePluginInstallFlags(context.args.slice(4));

    const stateStore = createPluginRegistryStateStore();
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
      const result = await requestUserPluginChange({
        request: { kind: 'uninstall', pluginId },
        approval: 'none',
      });
      if (result.kind !== 'committed') {
        deps.error(chalk.red('Error:'), pluginChangeMessage(result));
        deps.exit(1);
        return;
      }
      deps.log(`Removed plugin ${pluginId}.`);
      return;
    }

    if (flags.dryRun) {
      deps.log(`Dry run: would update plugin ${pluginId} from ${record.source.kind}.`);
      return;
    }

    const result = await requestUserPluginChange({
      request: { kind: 'update', pluginId },
      approval: resolveUserPluginChangeApproval({
        interactive: (deps.isInteractiveTerminal ?? isInteractiveTerminal)(),
      }),
    });
    if (result.kind !== 'committed') {
      deps.error(chalk.red('Error:'), pluginChangeMessage(result));
      deps.exit(1);
      return;
    }
    deps.log(`Updated plugin ${result.pluginId}.`);
    return;
  }

  const flags = parsePluginInstallFlags(context.args.slice(3));
  const request = await createPluginInstallRequest(target, flags.sourceKind, flags.selector, flags.integrity);
  if (flags.dryRun) {
    deps.log(`Dry run: would request ${request.kind} for ${target}.`);
    return;
  }
  const result = await requestUserPluginChange({
    request,
    approval: resolveUserPluginChangeApproval({
      interactive: (deps.isInteractiveTerminal ?? isInteractiveTerminal)(),
    }),
  });
  if (result.kind !== 'committed') {
    deps.error(chalk.red('Error:'), pluginChangeMessage(result));
    deps.exit(1);
    return;
  }
  deps.log(pluginChangeMessage(result));
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
    isInteractiveTerminal,
  },
): Promise<void> {
  try {
    const subcommand = context.args[1] ?? 'help';
    const needsRegistry = subcommand === 'help' || subcommand === '--help' || subcommand === '-h' || subcommand === 'provider';
    const mergedRegistry = needsRegistry
      ? await resolveMergedContributionRegistry({ happyHomeDir: resolvePluginStorePaths().happyHomeDir })
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
      // `happy install provider` drives the generated bundled CLI install
      // recipes, which exist only for bundled Agents.
      if (!isBundledAgentId(agentIdRaw)) {
        deps.error(chalk.red('Error:'), `Unknown provider id: ${agentIdRaw}`);
        deps.log(usage(installableProviderRows));
        deps.exit(1);
        return;
      }

      const flags = parseProviderInstallFlags(context.args.slice(3));
      const result = await deps.invokeAgentCliInstall({
        agentId: agentIdRaw,
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
      printProviderInstallResult(agentIdRaw, result, deps.log);
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
