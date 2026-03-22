import type { AgentId } from '../types.js';
import {
  getProviderCliRuntimeSpec,
  type ProviderCliInstallCommand,
  type ProviderCliInstallPlatform,
} from './providerCliRuntime.js';

function formatProviderCliInstallCommand(command: ProviderCliInstallCommand): string {
  if (command.cmd === 'bash' && command.args[0] === '-lc' && typeof command.args[1] === 'string') {
    return command.args[1];
  }
  if (
    command.cmd === 'powershell'
    && command.args[0] === '-NoProfile'
    && command.args[1] === '-ExecutionPolicy'
    && command.args[2] === 'Bypass'
    && command.args[3] === '-Command'
    && typeof command.args[4] === 'string'
  ) {
    return command.args[4];
  }
  if (command.cmd === 'cmd.exe' && command.args[0] === '/c' && typeof command.args[1] === 'string') {
    return command.args[1];
  }
  return [command.cmd, ...command.args].join(' ');
}

type PlatformRecipeLine = Readonly<{
  platforms: ReadonlyArray<ProviderCliInstallPlatform>;
  command: string;
}>;

function buildPlatformRecipeLines(providerId: AgentId): ReadonlyArray<PlatformRecipeLine> {
  const recipes = getProviderCliRuntimeSpec(providerId).manualInstallRecipes;
  if (!recipes) return [];

  const grouped = new Map<string, PlatformRecipeLine>();
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    const firstRecipe = recipes[platform]?.[0];
    if (!firstRecipe) continue;
    const command = formatProviderCliInstallCommand(firstRecipe);
    const existing = grouped.get(command);
    if (existing) {
      grouped.set(command, { ...existing, platforms: [...existing.platforms, platform] });
      continue;
    }
    grouped.set(command, { platforms: [platform], command });
  }
  return [...grouped.values()];
}

function formatPlatformLabel(platforms: ReadonlyArray<ProviderCliInstallPlatform>): string {
  if (platforms.includes('darwin') && platforms.includes('linux') && platforms.length === 2) {
    return 'macOS/Linux';
  }
  if (platforms.length === 1) {
    return platforms[0] === 'darwin' ? 'macOS' : platforms[0] === 'linux' ? 'Linux' : 'Windows (PowerShell)';
  }
  return platforms
    .map((platform) => (platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : 'Windows'))
    .join(', ');
}

export function getProviderCliInstallGuideUrl(providerId: AgentId): string | null {
  const spec = getProviderCliRuntimeSpec(providerId);
  return spec.installGuideUrl ?? spec.docsUrl ?? null;
}

export function getProviderCliManualInstallSummaryLines(providerId: AgentId): ReadonlyArray<string> {
  return buildPlatformRecipeLines(providerId).map(
    (entry) => `  ${formatPlatformLabel(entry.platforms)}: ${entry.command}`,
  );
}
