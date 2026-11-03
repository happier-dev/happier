import { stat } from 'node:fs/promises';
import type { CommandSurfaceDescriptorInput } from '@/agent/runtime/registry/commandContracts';
import { takeCliApiTokenEnvironment } from '@/auth/cliApiTokenEnvironment';
import { resolveCliHappyHomeDir } from '@/configuration/resolveCliHappyHomeDir';
import { resolvePluginStorePathLayout } from '@/plugins/store/pathLayout';
import { defaultCanImportFirstPartyPluginSource } from '@/packagedRuntime/firstPartySourceRuntime';
import { readCurrentBundledPluginPublicationFailures } from '@/plugins/projection/registry/builtIn/publication';
import {
  BUNDLED_ACTION_CLI_COMMAND_PATHS,
  BUNDLED_FIRST_PARTY_PLUGIN_COMMAND_METADATA,
} from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';
import {
  DEFAULT_COMMAND_SURFACE,
  isStaticCommandSurfaceReserved,
  listStaticCommandSurfaceEntries,
  projectActionCommandSurface,
  projectAgentCommandSurface,
  resolveAdmittedAgentCommandMetadata,
  staticCommandDescriptors,
  type BundledPluginCommandMetadata,
} from './commandDescriptors';
import { findPluginCommandCompletionCommand, resolvePluginCommandMetadata } from './pluginCommandMetadata';
import type { PluginCommandActionInputRegistry } from './pluginCommandFields';
import type { loadAdmittedInstalledPluginDeclarations } from '@/plugins/discovery/load/admitted';
import { renderRootHelpText } from './rootHelpText';
import { ensureWindowsUtf8CodePage } from '@/utils/platform/windows/ensureWindowsUtf8CodePage';
import { installConsoleWriteErrorGuards, shouldInstallConsoleWriteErrorGuards } from '@/utils/writeConsoleBestEffort';
import { assertUniquePluginIdentities } from '@/plugins/projection/registry/normalize/pluginIdentities';

/** Uses the same static, Agent and plugin admission owners as executable dispatch. */
function projectCommandDeclarations(
  plugins: readonly BundledPluginCommandMetadata[],
) {
  assertUniquePluginIdentities(plugins);
  const entries: Record<string, CommandSurfaceDescriptorInput> = Object.fromEntries(
    listStaticCommandSurfaceEntries().map((entry) => [entry.command!, entry]),
  );
  const actionRoots = new Set<string>();
  for (const { path } of BUNDLED_ACTION_CLI_COMMAND_PATHS) {
    const root = path[0];
    if (!root) continue;
    actionRoots.add(root);
    if (!staticCommandDescriptors[root]?.handler) entries[root] = projectActionCommandSurface(root);
  }
  const agents = resolveAdmittedAgentCommandMetadata(plugins.flatMap((plugin) => plugin.agents), actionRoots);
  for (const agent of agents) entries[agent.cliSubcommand] = projectAgentCommandSurface(agent);

  const actions = plugins.flatMap((plugin) => plugin.actions);
  const reservedRoots = new Set([
    ...Object.entries(staticCommandDescriptors).filter(([, entry]) => entry.handler).map(([root]) => root),
    ...actionRoots,
    ...agents.map((agent) => agent.cliSubcommand),
  ]);
  for (const action of actions) {
    const cli = action.admittedTarget?.declaration.cli;
    for (const path of cli ? [cli.path, ...(cli.aliases ?? [])] : []) {
      const root = path[0];
      if (root && isStaticCommandSurfaceReserved(root)) reservedRoots.add(root);
    }
  }
  const projection = resolvePluginCommandMetadata({
    registry: { actions },
    reservedRoots,
    resolveAvailability: (command) => command.availability,
  });
  for (const root of projection.roots) {
    entries[root] = projection.rootHelpEntries.find((entry) => entry.command === root) ?? { command: root, allowTmux: false };
  }
  return {
    projection,
    entries: [DEFAULT_COMMAND_SURFACE, ...Object.values(entries)],
    commandNames: Object.freeze([...new Set([
      ...Object.entries(staticCommandDescriptors).filter(([, entry]) => entry.handler).map(([root]) => root),
      ...actionRoots,
      ...agents.map((agent) => agent.cliSubcommand),
      ...projection.roots,
    ])]),
  };
}

export function projectBundledRootHelpEntries(plugins: readonly BundledPluginCommandMetadata[]): readonly CommandSurfaceDescriptorInput[] {
  return projectCommandDeclarations(plugins).entries;
}

export async function resolveReadOnlyHelpDeclarations(happyHomeDir: string) {
  const paths = resolvePluginStorePathLayout(happyHomeDir);
  let hasInstalledAuthority = true;
  try {
    await stat(paths.registryCurrentFilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    hasInstalledAuthority = false;
  }
  const failures = defaultCanImportFirstPartyPluginSource() ? [] : readCurrentBundledPluginPublicationFailures();
  const excluded = new Set(failures.map((failure) => failure.pluginId));
  let installedMetadata: readonly BundledPluginCommandMetadata[] = [];
  let installedPlugins: Awaited<ReturnType<typeof loadAdmittedInstalledPluginDeclarations>>['loadedPlugins'] = [];
  if (hasInstalledAuthority) {
    const [{ loadAdmittedInstalledPluginDeclarations }, { projectPluginCommandDeclarations }] = await Promise.all([
      import('@/plugins/discovery/load/admitted'),
      import('./pluginCommandDeclarations'),
    ]);
    const installed = await loadAdmittedInstalledPluginDeclarations(happyHomeDir);
    installedPlugins = installed.loadedPlugins;
    installedMetadata = installed.loadedPlugins.map((plugin) => projectPluginCommandDeclarations({
      manifest: plugin.manifest, provenance: 'external', source: { kind: plugin.sourceSpec.kind },
    }));
  }
  return {
    ...projectCommandDeclarations([
      ...BUNDLED_FIRST_PARTY_PLUGIN_COMMAND_METADATA.filter((plugin) => !excluded.has(plugin.pluginId)),
      ...installedMetadata,
    ]),
    installedPlugins,
    pluginIds: [...BUNDLED_FIRST_PARTY_PLUGIN_COMMAND_METADATA.filter((plugin) => !excluded.has(plugin.pluginId)), ...installedMetadata].map((plugin) => plugin.pluginId),
  };
}

export async function resolveRootHelpEntries(happyHomeDir: string): Promise<readonly CommandSurfaceDescriptorInput[]> {
  return (await resolveReadOnlyHelpDeclarations(happyHomeDir)).entries;
}

export async function resolveRootCommandNames(happyHomeDir: string): Promise<readonly string[]> {
  return (await resolveReadOnlyHelpDeclarations(happyHomeDir)).commandNames;
}

/** Same admitted path/availability projection; only the selected Action's input facet is needed. */
export async function resolveReadOnlyCommandCompletionDeclarations(happyHomeDir: string, words: readonly string[]) {
  const declarations = await resolveReadOnlyHelpDeclarations(happyHomeDir);
  const committed = words.slice(0, -1);
  const command = findPluginCommandCompletionCommand(declarations.projection, committed);
  const registry = await resolveReadOnlyCommandActionInputRegistry(declarations, command?.qualifiedActionId);
  return {
    paths: [
      ...declarations.commandNames.map((root) => [root]),
      ...declarations.projection.commands.filter((candidate) => candidate.status === 'available').map((candidate) => candidate.path),
    ],
    pluginSources: { registry, projection: declarations.projection },
  };
}

/** One selected input facet of the same admitted declarations, for help or completion. */
export async function resolveReadOnlyCommandActionInputRegistry(
  declarations: Awaited<ReturnType<typeof resolveReadOnlyHelpDeclarations>>,
  qualifiedActionId: string | undefined,
): Promise<PluginCommandActionInputRegistry> {
  const actions: NonNullable<PluginCommandActionInputRegistry['actions']>[number][] = [];
  if (qualifiedActionId) {
    let manifest = declarations.installedPlugins.find((plugin) => (
      (plugin.manifest.contributes.actions ?? []).some((action) => `${plugin.pluginId}/${action.id}` === qualifiedActionId)
    ))?.manifest;
    if (!manifest) {
      const { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } = await import('@/plugins/projection/registry/sources/generatedBundledPluginManifests');
      const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find((candidate) => qualifiedActionId.startsWith(`${candidate.pluginId}/`));
      if (locator) {
        const { readBundledPluginManifest } = await import('@/plugins/projection/registry/builtIn/manifestFile');
        // The canonical publisher already admitted these normalized assets.
        manifest = readBundledPluginManifest(locator) as NonNullable<typeof manifest>;
      }
    }
    const definition = manifest?.contributes.actions?.find((action) => `${manifest.id}/${action.id}` === qualifiedActionId);
    if (manifest && definition) {
      const { projectPluginActionInputDefinition } = await import('@/plugins/projection/registry/normalize/actionInput');
      actions.push({ pluginId: manifest.id, definition: projectPluginActionInputDefinition(definition) });
    }
  }
  return { actions };
}

export async function printRootHelp(): Promise<void> {
  ensureWindowsUtf8CodePage();
  if (shouldInstallConsoleWriteErrorGuards({ processVersions: process.versions })) {
    installConsoleWriteErrorGuards();
  }
  // Local help consumes ambient credentials without validating or exposing them.
  takeCliApiTokenEnvironment();
  console.log(renderRootHelpText(await resolveRootHelpEntries(resolveCliHappyHomeDir(process.env))));
}
