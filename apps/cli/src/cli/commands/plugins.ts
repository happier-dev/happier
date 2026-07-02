import { cmd, createOutputBuilder, dim, errorFrame, fail, neutral, ok, renderHelpPage, sectionTitle } from '@happier-dev/cli-common/output';

import type { CommandContext } from '@/cli/commandRegistry';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readInstalledPluginCatalog, readInstalledPluginCatalogEntry, installPluginFromLocator, type PluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import { installMarketplacePlugin, readRemoteMarketplaceCatalog, readRemoteMarketplaceCatalogEntry, type MarketplaceCatalogEntry } from '@/plugins/store/marketplace/catalog';
import { createMarketplaceSourceRegistryStore } from '@/plugins/store/marketplace/sources/store';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import type { MarketplaceSourceRegistryV1, MarketplaceSourceV1 } from '@happier-dev/protocol';

type PublishInstalledManifestProjections = (params: Readonly<{
  pluginIds: readonly string[];
}>) => Promise<unknown>;

type PluginsCommandDeps = Readonly<{
  publishInstalledManifestProjections: PublishInstalledManifestProjections;
}>;

async function publishInstalledManifestProjectionsLazy(
  ...args: Parameters<PublishInstalledManifestProjections>
): Promise<unknown> {
  const { publishInstalledPluginManifestProjectionsToServer } = await import('@/plugins/projection/server/installedManifests');
  return await publishInstalledPluginManifestProjectionsToServer(...args);
}

const defaultPluginsCommandDeps: PluginsCommandDeps = {
  publishInstalledManifestProjections: publishInstalledManifestProjectionsLazy,
};

async function publishInstalledManifestProjectionBestEffort(
  deps: PluginsCommandDeps,
  pluginId: string,
): Promise<void> {
  try {
    await deps.publishInstalledManifestProjections({ pluginIds: [pluginId] });
  } catch {
    // Server projection sync is best-effort; the local plugin mutation remains authoritative on this machine.
  }
}

function usage(): string {
  return renderHelpPage({
    title: 'happier plugins',
    subtitle: 'Plugin discovery, local authoring, and machine-local installs',
    usage: [
      { label: 'happier plugins list [--json]', description: 'List installed plugins and their descriptors' },
      { label: 'happier plugins show <pluginId> [--json]', description: 'Show one installed plugin in detail' },
      { label: 'happier plugins install <path|archive> [--dry-run] [--force] [--json]', description: 'Install a local plugin directory or a local/remote archive' },
      { label: 'happier plugins reload [pluginId] [--json]', description: 'Reload plugin runtime contributions' },
      { label: 'happier plugins marketplace sources list [--json]', description: 'List shared marketplace sources' },
      { label: 'happier plugins marketplace sources add <catalogUrl> [--title <title>] [--description <description>] [--origin user|curated] [--disabled] [--json]', description: 'Persist a marketplace source' },
      { label: 'happier plugins marketplace sources enable <sourceRef> [--json]', description: 'Enable a persisted marketplace source' },
      { label: 'happier plugins marketplace sources disable <sourceRef> [--json]', description: 'Disable a persisted marketplace source' },
      { label: 'happier plugins marketplace sources remove <sourceRef> [--json]', description: 'Remove a persisted marketplace source' },
      { label: 'happier plugins marketplace list [<sourceRef>] [--json]', description: 'List marketplace entries from the preferred persisted source' },
      { label: 'happier plugins marketplace show [<sourceRef>] <pluginId> [--json]', description: 'Show one marketplace entry' },
      { label: 'happier plugins marketplace install [<sourceRef>] <pluginId> [--dry-run] [--force] [--json]', description: 'Install a marketplace plugin' },
    ],
    notes: [
      'Plugins are machine-local, descriptor-backed plugins.',
      'Current Wave 1 install support covers local directories, local archives, remote archive URLs, and marketplace entries that resolve to archives.',
      'Live authoring is local-path based: edit files in place, then run happier plugins reload.',
      'Package/npm/git install sources are not implemented yet.',
      'Marketplace browsing resolves through the machine-local shared source registry and still installs locally at install time.',
      `Use ${cmd('happier providers list')} to see plugin-provided provider CLI surfaces after install.`,
    ],
  });
}

function readSingleValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseInstallFlags(args: readonly string[]): Readonly<{ dryRun: boolean; skipIfInstalled: boolean }> {
  return {
    dryRun: args.includes('--dry-run'),
    skipIfInstalled: !args.includes('--force'),
  };
}

function collectPositionalArgs(args: readonly string[], startIndex: number, valueFlags: readonly string[] = []): string[] {
  const positional: string[] = [];
  for (let index = startIndex; index < args.length; index += 1) {
    const raw = String(args[index] ?? '').trim();
    if (!raw) continue;
    if (valueFlags.includes(raw)) {
      index += 1;
      continue;
    }
    if (raw.startsWith('-')) {
      continue;
    }
    positional.push(raw);
  }
  return positional;
}

function readMarketplaceSourceReference(args: readonly string[], startIndex: number): string | null {
  const positional = collectPositionalArgs(args, startIndex);
  return positional[0] ?? null;
}

function readMarketplaceSelection(args: readonly string[], startIndex: number): Readonly<{
  sourceRef: string | null;
  pluginId: string | null;
}> {
  const positional = collectPositionalArgs(args, startIndex);
  if (positional.length === 1) {
    return { sourceRef: null, pluginId: positional[0] ?? null };
  }
  if (positional.length >= 2) {
    return { sourceRef: positional[0] ?? null, pluginId: positional[1] ?? null };
  }
  return { sourceRef: null, pluginId: null };
}

function readMarketplaceSourceUpsertInput(args: readonly string[]): Readonly<{
  sourceUrl: string | null;
  title: string | null;
  description: string | null;
  origin: 'user' | 'curated' | null;
  enabled: boolean;
}> {
  const positional = collectPositionalArgs(args, 3, ['--title', '--description', '--origin']);
  const origin = readSingleValue(args, '--origin');
  if (origin !== null && origin !== 'user' && origin !== 'curated') {
    throw new Error(`Unknown marketplace source origin: ${origin}`);
  }
  return {
    sourceUrl: positional[0] ?? null,
    title: readSingleValue(args, '--title'),
    description: readSingleValue(args, '--description'),
    origin: origin as 'user' | 'curated' | null,
    enabled: args.includes('--disabled') ? false : true,
  };
}

function describeMarketplaceSource(source: MarketplaceSourceV1): string {
  const status = source.enabled ? 'enabled' : 'disabled';
  return `${source.title} ${dim(source.sourceUrl)} ${dim(`(${status})`)}`;
}

async function resolveMarketplaceSourceForCommand(store: Readonly<{
  resolveSourceReference: (reference: string) => Promise<MarketplaceSourceV1 | null>;
  resolvePreferredSource: () => Promise<MarketplaceSourceV1 | null>;
}>, sourceRef: string | null): Promise<MarketplaceSourceV1 | null> {
  if (sourceRef) {
    return await store.resolveSourceReference(sourceRef);
  }
  return await store.resolvePreferredSource();
}

function formatContributionSummary(entry: Readonly<{ contributionIds: Readonly<{ providers: readonly string[]; backends: readonly string[]; hooks: readonly string[] }> }>): string {
  const parts = [
    `${entry.contributionIds.providers.length} providers`,
    `${entry.contributionIds.backends.length} backends`,
    `${entry.contributionIds.hooks.length} hooks`,
  ];
  return parts.join(', ');
}

function printHumanList(entries: readonly PluginCatalogEntry[]): void {
  const out = createOutputBuilder();
  if (entries.length === 0) {
    out.line(neutral('(no plugins installed)'));
    console.log(out.render());
    return;
  }

  for (const entry of entries) {
    const status = entry.enabled ? ok('enabled') : neutral('disabled');
    const source = dim(`(${entry.source.kind})`);
    out.line(`${entry.title} ${dim(entry.pluginId)} ${source} ${status}`);
    out.line(`  ${dim('Version:')} ${entry.version}`);
    out.line(`  ${dim('Manifest:')} ${entry.manifestPath}`);
    out.line(`  ${dim('Contributions:')} ${formatContributionSummary(entry)}`);
    if (entry.diagnostics.length > 0) {
      out.line(`  ${fail('Diagnostics:')} ${entry.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`);
    }
  }
  console.log(out.render());
}

function printHumanMarketplaceSources(registry: MarketplaceSourceRegistryV1): void {
  const out = createOutputBuilder();
  out.line(sectionTitle('Marketplace sources'));
  if (registry.sources.length === 0) {
    out.line(neutral('(no marketplace sources configured)'));
    console.log(out.render());
    return;
  }

  for (const source of registry.sources) {
    out.line(describeMarketplaceSource(source));
    out.line(`  ${dim('Source ID:')} ${source.id}`);
    if (source.description) {
      out.line(`  ${dim('Description:')} ${source.description}`);
    }
  }
  console.log(out.render());
}

function printHumanMarketplaceSource(source: MarketplaceSourceV1, actionLabel: string): void {
  const out = createOutputBuilder();
  out.line(ok(`${actionLabel}: ${source.title}`));
  out.line(`  ${dim('Source ID:')} ${source.id}`);
  out.line(`  ${dim('URL:')} ${source.sourceUrl}`);
  out.line(`  ${dim('Status:')} ${source.enabled ? 'enabled' : 'disabled'}`);
  console.log(out.render());
}

function findPersistedMarketplaceSource(registry: MarketplaceSourceRegistryV1, reference: string): MarketplaceSourceV1 | null {
  const normalized = String(reference ?? '').trim();
  if (!normalized) return null;
  const byId = registry.sources.find((entry) => entry.id === normalized) ?? null;
  if (byId) return byId;
  return registry.sources.find((entry) => entry.sourceUrl === normalized) ?? null;
}

function printHumanShow(entry: PluginCatalogEntry): void {
  const out = createOutputBuilder();
  out.line(sectionTitle(entry.title));
  out.line(`${dim('Plugin ID:')} ${entry.pluginId}`);
  out.line(`${dim('Version:')} ${entry.version}`);
  out.line(`${dim('Source:')} ${entry.source.kind} ${entry.source.locator}`);
  out.line(`${dim('Install mode:')} ${entry.install.mode}`);
  out.line(`${dim('Enabled:')} ${entry.enabled ? 'yes' : 'no'}`);
  out.line(`${dim('Manifest:')} ${entry.manifestPath}`);
  out.line(`${dim('Contributions:')} ${formatContributionSummary(entry)}`);
  if (entry.contributionIds.providers.length > 0) {
    out.line(`  ${dim('Providers:')} ${entry.contributionIds.providers.join(', ')}`);
  }
  if (entry.contributionIds.backends.length > 0) {
    out.line(`  ${dim('Backends:')} ${entry.contributionIds.backends.join(', ')}`);
  }
  if (entry.contributionIds.hooks.length > 0) {
    out.line(`  ${dim('Hooks:')} ${entry.contributionIds.hooks.join(', ')}`);
  }
  if (entry.diagnostics.length > 0) {
    out.blank();
    out.line(sectionTitle('Diagnostics'));
    for (const diagnostic of entry.diagnostics) {
      out.line(`${fail('•')} ${diagnostic.message}`);
    }
  }
  console.log(out.render());
}

function printHumanMarketplaceList(params: Readonly<{
  title: string;
  sourceUrl: string;
  entries: readonly MarketplaceCatalogEntry[];
  diagnostics: readonly { message: string }[];
}>): void {
  const out = createOutputBuilder();
  out.line(sectionTitle(params.title));
  out.line(`${dim('Source:')} ${params.sourceUrl}`);
  if (params.entries.length === 0) {
    out.line(neutral('(no marketplace entries)'));
  }
  for (const entry of params.entries) {
    const installable = entry.installable ? ok('installable') : neutral('descriptor-only');
    const source = entry.source ? dim(`(${entry.source.kind})`) : neutral('(no source)');
    out.line(`${entry.title} ${dim(entry.pluginId)} ${source} ${installable}`);
    out.line(`  ${dim('Version:')} ${entry.version}`);
    out.line(`  ${dim('Contributions:')} ${formatContributionSummary(entry)}`);
    if (entry.diagnostics.length > 0) {
      out.line(`  ${fail('Diagnostics:')} ${entry.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`);
    }
  }
  for (const diagnostic of params.diagnostics) {
    out.line(`${fail('Diagnostics:')} ${diagnostic.message}`);
  }
  console.log(out.render());
}

function printHumanMarketplaceShow(params: Readonly<{
  title: string;
  sourceUrl: string;
  entry: MarketplaceCatalogEntry;
  diagnostics: readonly { message: string }[];
}>): void {
  const out = createOutputBuilder();
  out.line(sectionTitle(params.entry.title));
  out.line(`${dim('Marketplace:')} ${params.title}`);
  out.line(`${dim('Source:')} ${params.sourceUrl}`);
  out.line(`${dim('Plugin ID:')} ${params.entry.pluginId}`);
  out.line(`${dim('Version:')} ${params.entry.version}`);
  out.line(`${dim('Installable:')} ${params.entry.installable ? 'yes' : 'no'}`);
  if (params.entry.source) {
    out.line(`${dim('Entry Source:')} ${params.entry.source.kind} ${params.entry.source.locator}`);
  }
  out.line(`${dim('Contributions:')} ${formatContributionSummary(params.entry)}`);
  if (params.entry.contributionIds.providers.length > 0) {
    out.line(`  ${dim('Providers:')} ${params.entry.contributionIds.providers.join(', ')}`);
  }
  if (params.entry.contributionIds.backends.length > 0) {
    out.line(`  ${dim('Backends:')} ${params.entry.contributionIds.backends.join(', ')}`);
  }
  if (params.entry.contributionIds.hooks.length > 0) {
    out.line(`  ${dim('Hooks:')} ${params.entry.contributionIds.hooks.join(', ')}`);
  }
  if (params.entry.diagnostics.length > 0) {
    out.blank();
    out.line(sectionTitle('Diagnostics'));
    for (const diagnostic of params.entry.diagnostics) {
      out.line(`${fail('•')} ${diagnostic.message}`);
    }
  }
  for (const diagnostic of params.diagnostics) {
    out.line(`${fail('•')} ${diagnostic.message}`);
  }
  console.log(out.render());
}

async function runPluginsListCommand(args: readonly string[]): Promise<void> {
  const entries = await readInstalledPluginCatalog();
  const json = wantsJson(args);
  if (json) {
    printJsonEnvelope({
      ok: true,
      kind: 'plugins_list',
      data: {
        plugins: entries.map((entry) => ({
          pluginId: entry.pluginId,
          title: entry.title,
          version: entry.version,
          description: entry.description,
          enabled: entry.enabled,
          source: {
            kind: entry.source.kind,
            locator: entry.source.locator,
            trustPolicy: entry.source.trustPolicy,
            installPolicy: entry.source.installPolicy,
            resolvedVersion: entry.source.resolvedVersion ?? null,
            resolvedDigest: entry.source.resolvedDigest ?? null,
          },
          install: {
            mode: entry.install.mode,
            manifestVersion: entry.install.manifestVersion,
            manifestDigest: entry.install.manifestDigest ?? null,
            installedPath: entry.install.installedPath ?? null,
          },
          contributions: entry.contributionIds,
          diagnostics: entry.diagnostics,
        })),
      },
    });
    return;
  }

  printHumanList(entries);
}

async function runPluginsShowCommand(args: readonly string[]): Promise<void> {
  const pluginId = String(args[1] ?? '').trim();
  if (!pluginId || pluginId === 'help' || pluginId === '--help' || pluginId === '-h') {
    console.log(usage());
    return;
  }

  const entries = await readInstalledPluginCatalog();
  const entry = entries.find((candidate) => candidate.pluginId === pluginId);
  if (!entry) {
    throw new Error(`Unknown plugin id: ${pluginId}`);
  }

  if (wantsJson(args)) {
    printJsonEnvelope({
      ok: true,
      kind: 'plugins_show',
      data: {
        plugin: {
          pluginId: entry.pluginId,
          title: entry.title,
          version: entry.version,
          description: entry.description,
          enabled: entry.enabled,
          source: entry.source,
          install: entry.install,
          compatibility: entry.compatibility,
          manifestPath: entry.manifestPath,
          manifestDigest: entry.manifestDigest,
          contributions: entry.contributionIds,
          diagnostics: entry.diagnostics,
        },
      },
    });
    return;
  }

  printHumanShow(entry);
}

async function runPluginsInstallCommand(args: readonly string[], deps: PluginsCommandDeps): Promise<void> {
  const locator = String(args[1] ?? '').trim();
  if (!locator || locator === 'help' || locator === '--help' || locator === '-h') {
    console.log(usage());
    return;
  }

  const flags = parseInstallFlags(args.slice(2));
  const result = await installPluginFromLocator({
    locator,
    skipIfInstalled: flags.skipIfInstalled,
    dryRun: flags.dryRun,
  });

  if (wantsJson(args)) {
    if (!result.ok) {
      printJsonEnvelope(
        {
          ok: false,
          kind: 'plugins_install',
          error: {
            code: 'install_failed',
            diagnostics: result.diagnostics,
          },
        },
        { exitCode: 1 },
      );
      return;
    }

    if (!flags.dryRun) {
      await publishInstalledManifestProjectionBestEffort(deps, result.entry.pluginId);
    }

    printJsonEnvelope(
      {
        ok: true,
        kind: 'plugins_install',
        data: {
          alreadyInstalled: result.alreadyInstalled,
          plugin: {
            pluginId: result.entry.pluginId,
            title: result.entry.title,
            version: result.entry.version,
            description: result.entry.description,
            enabled: result.entry.enabled,
            source: result.entry.source,
            install: result.entry.install,
            compatibility: result.entry.compatibility,
            manifestPath: result.entry.manifestPath,
            manifestDigest: result.entry.manifestDigest,
            contributions: result.entry.contributionIds,
          },
        },
      },
      { exitCode: 0 },
    );
    return;
  }

  if (!result.ok) {
    console.error(errorFrame('Error:', result.diagnostics.map((diagnostic) => diagnostic.message)));
    process.exitCode = 1;
    return;
  }

  if (!flags.dryRun) {
    await publishInstalledManifestProjectionBestEffort(deps, result.entry.pluginId);
  }

  const out = createOutputBuilder();
  if (flags.dryRun) {
    out.line(`Dry run: would install plugin ${result.entry.title} from ${locator}.`);
  } else if (result.alreadyInstalled) {
    out.line(ok(`${result.entry.title} is already installed.`));
  } else {
    out.line(ok(`Installed ${result.entry.title}.`));
  }
  out.line(`  ${dim('Plugin ID:')} ${result.entry.pluginId}`);
  out.line(`  ${dim('Manifest:')} ${result.entry.manifestPath}`);
  out.line(`  ${dim('Contributions:')} ${formatContributionSummary(result.entry)}`);
  console.log(out.render());
}

async function runPluginsReloadCommand(args: readonly string[]): Promise<void> {
  const pluginId = String(args[1] ?? '').trim();
  if (pluginId === 'help' || pluginId === '--help' || pluginId === '-h') {
    console.log(usage());
    return;
  }

  const result = await pluginReloadController.reload({
    pluginId: pluginId && !pluginId.startsWith('-') ? pluginId : null,
  });

  if (wantsJson(args)) {
    if (!result.ok) {
      printJsonEnvelope(
        {
          ok: false,
          kind: 'plugins_reload',
          error: {
            code: 'reload_failed',
            diagnostics: result.diagnostics,
          },
        },
        { exitCode: 1 },
      );
      return;
    }

    printJsonEnvelope({
      ok: true,
      kind: 'plugins_reload',
      data: {
        generation: result.generation,
        attemptedGeneration: result.attemptedGeneration,
        activeGenerationId: result.activeGenerationId,
        registryStatus: result.registryStatus,
        changedPluginIds: result.changedPluginIds,
        affectedPluginIds: result.affectedPluginIds,
        diagnostics: result.diagnostics,
        diagnosticsByPluginId: result.diagnosticsByPluginId,
      },
    });
    return;
  }

  if (!result.ok) {
    console.error(errorFrame('Error:', result.diagnostics.map((diagnostic) => diagnostic.message)));
    process.exitCode = 1;
    return;
  }

  const out = createOutputBuilder();
  out.line(ok(`Reloaded plugin runtime generation ${result.generation}.`));
  if (result.affectedPluginIds.length > 0) {
    out.line(`  ${dim('Plugins:')} ${result.affectedPluginIds.join(', ')}`);
  }
  console.log(out.render());
}

function parseMarketplaceFlags(args: readonly string[]): Readonly<{ dryRun: boolean; skipIfInstalled: boolean }> {
  return parseInstallFlags(args);
}

async function runPluginsMarketplaceListCommand(args: readonly string[]): Promise<void> {
  const sourceRef = readMarketplaceSourceReference(args, 2);
  if (sourceRef === 'help' || sourceRef === '--help' || sourceRef === '-h') {
    console.log(usage());
    return;
  }

  const registryStore = createMarketplaceSourceRegistryStore();
  const source = await resolveMarketplaceSourceForCommand(registryStore, sourceRef);
  if (!source) {
    const error = 'No enabled marketplace source is configured';
    if (wantsJson(args)) {
      printJsonEnvelope(
        {
          ok: false,
          kind: 'plugins_marketplace_list',
          error: {
            code: 'not_found',
            message: error,
          },
        },
        { exitCode: 1 },
      );
      return;
    }
    console.error(errorFrame('Error:', [error]));
    process.exitCode = 1;
    return;
  }

  const result = await readRemoteMarketplaceCatalog({ sourceUrl: source.sourceUrl });
  if (wantsJson(args)) {
    if (!result.ok) {
      printJsonEnvelope(
        {
          ok: false,
          kind: 'plugins_marketplace_list',
          error: {
            code: 'catalog_load_failed',
            diagnostics: result.diagnostics,
          },
        },
        { exitCode: 1 },
      );
      return;
    }

    printJsonEnvelope({
      ok: true,
      kind: 'plugins_marketplace_list',
      data: {
        source: {
          id: source.id,
          title: source.title,
          sourceUrl: source.sourceUrl,
          enabled: source.enabled,
          origin: source.origin,
          description: source.description ?? null,
        },
        catalog: {
          title: result.catalog.title,
          description: result.catalog.description,
          sourceUrl: result.catalog.sourceUrl,
          cache: result.cache,
        },
        plugins: result.catalog.entries.map((entry) => ({
          pluginId: entry.pluginId,
          title: entry.title,
          description: entry.description,
          version: entry.version,
          source: entry.source,
          installable: entry.installable,
          contributions: entry.contributionIds,
          diagnostics: entry.diagnostics,
        })),
      },
    });
    return;
  }

  if (!result.ok) {
    console.error(errorFrame('Error:', result.diagnostics.map((diagnostic) => diagnostic.message)));
    process.exitCode = 1;
    return;
  }

  printHumanMarketplaceList({
    title: result.catalog.title,
    sourceUrl: source.sourceUrl,
    entries: result.catalog.entries,
    diagnostics: result.diagnostics,
  });
}

async function runPluginsMarketplaceShowCommand(args: readonly string[]): Promise<void> {
  const { sourceRef, pluginId } = readMarketplaceSelection(args, 2);
  if (!pluginId || pluginId === 'help' || pluginId === '--help' || pluginId === '-h') {
    console.log(usage());
    return;
  }

  const registryStore = createMarketplaceSourceRegistryStore();
  const source = await resolveMarketplaceSourceForCommand(registryStore, sourceRef);
  if (!source) {
    const error = 'No enabled marketplace source is configured';
    if (wantsJson(args)) {
      printJsonEnvelope(
        {
          ok: false,
          kind: 'plugins_marketplace_show',
          error: {
            code: 'not_found',
            message: error,
          },
        },
        { exitCode: 1 },
      );
      return;
    }
    console.error(errorFrame('Error:', [error]));
    process.exitCode = 1;
    return;
  }

  const result = await readRemoteMarketplaceCatalogEntry({
    sourceUrl: source.sourceUrl,
    pluginId,
  });
  if (wantsJson(args)) {
    if (!result.ok) {
      printJsonEnvelope(
        {
          ok: false,
          kind: 'plugins_marketplace_show',
          error: {
            code: 'catalog_load_failed',
            diagnostics: result.diagnostics,
          },
        },
        { exitCode: 1 },
      );
      return;
    }

    if (!result.entry) {
      printJsonEnvelope(
        {
          ok: false,
          kind: 'plugins_marketplace_show',
          error: {
            code: 'not_found',
            message: `Unknown marketplace plugin id: ${pluginId}`,
          },
        },
        { exitCode: 1 },
      );
      return;
    }

    printJsonEnvelope({
      ok: true,
      kind: 'plugins_marketplace_show',
      data: {
        source: {
          id: source.id,
          title: source.title,
          sourceUrl: source.sourceUrl,
          enabled: source.enabled,
          origin: source.origin,
          description: source.description ?? null,
        },
        catalog: {
          title: result.catalog.title,
          description: result.catalog.description,
          sourceUrl: result.catalog.sourceUrl,
          cache: result.cache,
        },
        plugin: {
          pluginId: result.entry.pluginId,
          title: result.entry.title,
          description: result.entry.description,
          version: result.entry.version,
          source: result.entry.source,
          installable: result.entry.installable,
          contributions: result.entry.contributionIds,
          diagnostics: result.entry.diagnostics,
        },
      },
    });
    return;
  }

  if (!result.ok) {
    console.error(errorFrame('Error:', result.diagnostics.map((diagnostic) => diagnostic.message)));
    process.exitCode = 1;
    return;
  }

  if (!result.entry) {
    console.error(errorFrame('Error:', [`Unknown marketplace plugin id: ${pluginId}`]));
    process.exitCode = 1;
    return;
  }

  printHumanMarketplaceShow({
    title: result.catalog.title,
    sourceUrl: source.sourceUrl,
    entry: result.entry,
    diagnostics: result.diagnostics,
  });
}

async function runPluginsMarketplaceInstallCommand(args: readonly string[], deps: PluginsCommandDeps): Promise<void> {
  const { sourceRef, pluginId } = readMarketplaceSelection(args, 2);
  if (!pluginId || pluginId === 'help' || pluginId === '--help' || pluginId === '-h') {
    console.log(usage());
    return;
  }

  const flags = parseMarketplaceFlags(args);
  const registryStore = createMarketplaceSourceRegistryStore();
  const source = await resolveMarketplaceSourceForCommand(registryStore, sourceRef);
  if (!source) {
    const error = 'No enabled marketplace source is configured';
    if (wantsJson(args)) {
      printJsonEnvelope(
        {
          ok: false,
          kind: 'plugins_marketplace_install',
          error: {
            code: 'not_found',
            message: error,
          },
        },
        { exitCode: 1 },
      );
      return;
    }
    console.error(errorFrame('Error:', [error]));
    process.exitCode = 1;
    return;
  }

  const result = await installMarketplacePlugin({
    sourceUrl: source.sourceUrl,
    pluginId,
    skipIfInstalled: flags.skipIfInstalled,
    dryRun: flags.dryRun,
  });
  const resolvedEntry = flags.dryRun
    ? result.ok
      ? result.entry
      : null
    : await readInstalledPluginCatalogEntry({ pluginId });

  if (wantsJson(args)) {
    if (!result.ok) {
      printJsonEnvelope(
        {
          ok: false,
          kind: 'plugins_marketplace_install',
          error: {
            code: 'install_failed',
            diagnostics: result.diagnostics,
          },
        },
        { exitCode: 1 },
      );
      return;
    }

    if (!flags.dryRun) {
      await publishInstalledManifestProjectionBestEffort(deps, (resolvedEntry ?? result.entry).pluginId);
    }

    printJsonEnvelope(
      {
        ok: true,
        kind: 'plugins_marketplace_install',
        data: {
          alreadyInstalled: result.alreadyInstalled,
          plugin: {
            pluginId: (resolvedEntry ?? result.entry).pluginId,
            title: (resolvedEntry ?? result.entry).title,
            version: (resolvedEntry ?? result.entry).version,
            description: (resolvedEntry ?? result.entry).description,
            source: (resolvedEntry ?? result.entry).source,
            contributions: (resolvedEntry ?? result.entry).contributionIds,
          },
        },
      },
      { exitCode: 0 },
    );
    return;
  }

  if (!result.ok) {
    console.error(errorFrame('Error:', result.diagnostics.map((diagnostic) => diagnostic.message)));
    process.exitCode = 1;
    return;
  }

  if (!flags.dryRun) {
    await publishInstalledManifestProjectionBestEffort(deps, (resolvedEntry ?? result.entry).pluginId);
  }

  const out = createOutputBuilder();
  if (flags.dryRun) {
    out.line(`Dry run: would install marketplace plugin ${result.entry.title} from ${source.sourceUrl}.`);
  } else if (result.alreadyInstalled) {
    out.line(ok(`${result.entry.title} is already installed.`));
  } else {
    out.line(ok(`Installed ${result.entry.title} from curated marketplace.`));
  }
  out.line(`  ${dim('Plugin ID:')} ${(resolvedEntry ?? result.entry).pluginId}`);
  out.line(`  ${dim('Marketplace:')} ${source.sourceUrl}`);
  out.line(`  ${dim('Contributions:')} ${formatContributionSummary(resolvedEntry ?? result.entry)}`);
  console.log(out.render());
}

async function runPluginsMarketplaceSourcesListCommand(args: readonly string[]): Promise<void> {
  if (wantsJson(args)) {
    const registry = await createMarketplaceSourceRegistryStore().read();
    printJsonEnvelope({
      ok: true,
      kind: 'plugins_marketplace_sources_list',
      data: {
        sources: registry.sources.map((source) => ({
          id: source.id,
          title: source.title,
          sourceUrl: source.sourceUrl,
          enabled: source.enabled,
          origin: source.origin,
          description: source.description ?? null,
          addedAtMs: source.addedAtMs ?? null,
          updatedAtMs: source.updatedAtMs ?? null,
        })),
      },
    });
    return;
  }

  const registry = await createMarketplaceSourceRegistryStore().read();
  printHumanMarketplaceSources(registry);
}

async function runPluginsMarketplaceSourcesAddCommand(args: readonly string[]): Promise<void> {
  const input = readMarketplaceSourceUpsertInput(args);
  if (!input.sourceUrl || input.sourceUrl === 'help' || input.sourceUrl === '--help' || input.sourceUrl === '-h') {
    console.log(usage());
    return;
  }

  const store = createMarketplaceSourceRegistryStore();
  const source = await store.upsertSource({
    sourceUrl: input.sourceUrl,
    title: input.title ?? undefined,
    description: input.description ?? undefined,
    origin: input.origin ?? undefined,
    enabled: input.enabled,
  });

  if (wantsJson(args)) {
    printJsonEnvelope({
      ok: true,
      kind: 'plugins_marketplace_sources_add',
      data: {
        source: {
          id: source.id,
          title: source.title,
          sourceUrl: source.sourceUrl,
          enabled: source.enabled,
          origin: source.origin,
          description: source.description ?? null,
        },
      },
    });
    return;
  }

  printHumanMarketplaceSource(source, 'Added marketplace source');
}

async function runPluginsMarketplaceSourcesSetEnabledCommand(args: readonly string[], enabled: boolean): Promise<void> {
  const sourceRef = readMarketplaceSourceReference(args, 3);
  if (!sourceRef || sourceRef === 'help' || sourceRef === '--help' || sourceRef === '-h') {
    console.log(usage());
    return;
  }

  const store = createMarketplaceSourceRegistryStore();
  const registry = await store.read();
  const source = findPersistedMarketplaceSource(registry, sourceRef);
  if (!source) {
    const error = `Unknown marketplace source reference: ${sourceRef}`;
    if (wantsJson(args)) {
      printJsonEnvelope(
        {
          ok: false,
          kind: enabled ? 'plugins_marketplace_sources_enable' : 'plugins_marketplace_sources_disable',
          error: {
            code: 'not_found',
            message: error,
          },
        },
        { exitCode: 1 },
      );
      return;
    }
    console.error(errorFrame('Error:', [error]));
    process.exitCode = 1;
    return;
  }

  const nextSource = await store.setSourceEnabled(source.id, enabled);
  if (!nextSource) {
    const error = `Unknown marketplace source reference: ${sourceRef}`;
    if (wantsJson(args)) {
      printJsonEnvelope(
        {
          ok: false,
          kind: enabled ? 'plugins_marketplace_sources_enable' : 'plugins_marketplace_sources_disable',
          error: {
            code: 'not_found',
            message: error,
          },
        },
        { exitCode: 1 },
      );
      return;
    }
    console.error(errorFrame('Error:', [error]));
    process.exitCode = 1;
    return;
  }

  if (wantsJson(args)) {
    printJsonEnvelope({
      ok: true,
      kind: enabled ? 'plugins_marketplace_sources_enable' : 'plugins_marketplace_sources_disable',
      data: {
        source: {
          id: nextSource.id,
          title: nextSource.title,
          sourceUrl: nextSource.sourceUrl,
          enabled: nextSource.enabled,
          origin: nextSource.origin,
          description: nextSource.description ?? null,
        },
      },
    });
    return;
  }

  printHumanMarketplaceSource(nextSource, enabled ? 'Enabled marketplace source' : 'Disabled marketplace source');
}

async function runPluginsMarketplaceSourcesRemoveCommand(args: readonly string[]): Promise<void> {
  const sourceRef = readMarketplaceSourceReference(args, 3);
  if (!sourceRef || sourceRef === 'help' || sourceRef === '--help' || sourceRef === '-h') {
    console.log(usage());
    return;
  }

  const store = createMarketplaceSourceRegistryStore();
  const registry = await store.read();
  const source = findPersistedMarketplaceSource(registry, sourceRef);
  if (!source) {
    const error = `Unknown marketplace source reference: ${sourceRef}`;
    if (wantsJson(args)) {
      printJsonEnvelope(
        {
          ok: false,
          kind: 'plugins_marketplace_sources_remove',
          error: {
            code: 'not_found',
            message: error,
          },
        },
        { exitCode: 1 },
      );
      return;
    }
    console.error(errorFrame('Error:', [error]));
    process.exitCode = 1;
    return;
  }

  const removed = await store.removeSource(source.id);
  if (wantsJson(args)) {
    printJsonEnvelope({
      ok: true,
      kind: 'plugins_marketplace_sources_remove',
      data: {
        removed,
        source: {
          id: source.id,
          title: source.title,
          sourceUrl: source.sourceUrl,
          enabled: source.enabled,
          origin: source.origin,
          description: source.description ?? null,
        },
      },
    });
    return;
  }

  if (removed) {
    printHumanMarketplaceSource(source, 'Removed marketplace source');
    return;
  }

  console.error(errorFrame('Error:', [`Unknown marketplace source reference: ${sourceRef}`]));
  process.exitCode = 1;
}

export async function handlePluginsCommand(
  args: string[],
  deps: PluginsCommandDeps = defaultPluginsCommandDeps,
): Promise<void> {
  const subcommand = String(args[0] ?? '').trim();
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    console.log(usage());
    return;
  }

  if (subcommand === 'list') {
    await runPluginsListCommand(args);
    return;
  }

  if (subcommand === 'show') {
    await runPluginsShowCommand(args);
    return;
  }

  if (subcommand === 'install') {
    await runPluginsInstallCommand(args, deps);
    return;
  }

  if (subcommand === 'reload') {
    await runPluginsReloadCommand(args);
    return;
  }

  if (subcommand === 'marketplace') {
    const marketplaceSubcommand = String(args[1] ?? '').trim();
    if (!marketplaceSubcommand || marketplaceSubcommand === 'help' || marketplaceSubcommand === '--help' || marketplaceSubcommand === '-h') {
      console.log(usage());
      return;
    }

    if (marketplaceSubcommand === 'sources') {
      const marketplaceSourcesSubcommand = String(args[2] ?? '').trim();
      if (!marketplaceSourcesSubcommand || marketplaceSourcesSubcommand === 'help' || marketplaceSourcesSubcommand === '--help' || marketplaceSourcesSubcommand === '-h') {
        console.log(usage());
        return;
      }

      if (marketplaceSourcesSubcommand === 'list') {
        await runPluginsMarketplaceSourcesListCommand(args);
        return;
      }

      if (marketplaceSourcesSubcommand === 'add') {
        await runPluginsMarketplaceSourcesAddCommand(args);
        return;
      }

      if (marketplaceSourcesSubcommand === 'enable') {
        await runPluginsMarketplaceSourcesSetEnabledCommand(args, true);
        return;
      }

      if (marketplaceSourcesSubcommand === 'disable') {
        await runPluginsMarketplaceSourcesSetEnabledCommand(args, false);
        return;
      }

      if (marketplaceSourcesSubcommand === 'remove') {
        await runPluginsMarketplaceSourcesRemoveCommand(args);
        return;
      }

      if (wantsJson(args)) {
        printJsonEnvelope({ ok: false, kind: `plugins_marketplace_sources_${marketplaceSourcesSubcommand}`, error: { code: 'unknown_subcommand' } }, { exitCode: 1 });
        return;
      }

      console.error(errorFrame('Error:', [`Unknown plugins marketplace sources subcommand: ${marketplaceSourcesSubcommand}`]));
      console.log(usage());
      process.exitCode = 1;
      return;
    }

    if (marketplaceSubcommand === 'list') {
      await runPluginsMarketplaceListCommand(args);
      return;
    }

    if (marketplaceSubcommand === 'show') {
      await runPluginsMarketplaceShowCommand(args);
      return;
    }

    if (marketplaceSubcommand === 'install') {
      await runPluginsMarketplaceInstallCommand(args, deps);
      return;
    }

    if (wantsJson(args)) {
      printJsonEnvelope({ ok: false, kind: `plugins_marketplace_${marketplaceSubcommand}`, error: { code: 'unknown_subcommand' } }, { exitCode: 1 });
      return;
    }

    console.error(errorFrame('Error:', [`Unknown plugins marketplace subcommand: ${marketplaceSubcommand}`]));
    console.log(usage());
    process.exitCode = 1;
    return;
  }

  if (wantsJson(args)) {
    printJsonEnvelope({ ok: false, kind: `plugins_${subcommand}`, error: { code: 'unknown_subcommand' } }, { exitCode: 1 });
    return;
  }

  console.error(errorFrame('Error:', [`Unknown plugins subcommand: ${subcommand}`]));
  console.log(usage());
  process.exitCode = 1;
}

export async function handlePluginsCliCommand(context: CommandContext): Promise<void> {
  try {
    await handlePluginsCommand(context.args.slice(1));
  } catch (error) {
    const args = context.args.slice(1);
    if (wantsJson(args)) {
      const subcommand = String(args[0] ?? '').trim();
      const kind = subcommand ? `plugins_${subcommand}` : 'plugins_unknown';
      printJsonEnvelope(
        {
          ok: false,
          kind,
          error: {
            code: 'operation_failed',
            message: error instanceof Error ? error.message : 'Unknown error',
          },
        },
        { exitCode: 1 },
      );
      return;
    }
    console.error(errorFrame('Error:', [error instanceof Error ? error.message : 'Unknown error']));
    if (process.env.DEBUG) console.error(error);
    console.log(usage());
    process.exitCode = typeof process.exitCode === 'number' && process.exitCode > 1 ? process.exitCode : 1;
  }
}
