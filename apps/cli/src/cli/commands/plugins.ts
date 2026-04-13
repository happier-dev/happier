import { cmd, createOutputBuilder, dim, errorFrame, fail, neutral, ok, renderHelpPage, sectionTitle } from '@happier-dev/cli-common/output';

import type { CommandContext } from '@/cli/commandRegistry';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readInstalledPluginCatalog, installLocalPathPlugin, type PluginCatalogEntry } from '@/extensions/plugins/catalog/pluginCatalog';
import { installMarketplacePlugin, readRemoteMarketplaceCatalog, readRemoteMarketplaceCatalogEntry, type MarketplaceCatalogEntry } from '@/extensions/plugins/catalog/marketplaceCatalog';

function usage(): string {
  return renderHelpPage({
    title: 'happier plugins',
    subtitle: 'Plugin discovery and local installs',
    usage: [
      { label: 'happier plugins list [--json]', description: 'List installed plugins and their descriptors' },
      { label: 'happier plugins show <pluginId> [--json]', description: 'Show one installed plugin in detail' },
      { label: 'happier plugins install <path> [--dry-run] [--force] [--json]', description: 'Install a local-path plugin' },
      { label: 'happier plugins marketplace list <catalogUrl> [--json]', description: 'List remote curated marketplace entries' },
      { label: 'happier plugins marketplace show <catalogUrl> <pluginId> [--json]', description: 'Show one curated marketplace entry' },
      { label: 'happier plugins marketplace install <catalogUrl> <pluginId> [--dry-run] [--force] [--json]', description: 'Install a curated marketplace plugin' },
    ],
    notes: [
      'Plugins are machine-local, descriptor-backed extensions.',
      'Current Wave 1 support covers local-path installs and machine-side execution.',
      'Curated marketplace browsing and install are remote-metadata driven and still resolve to machine-local installs at install time.',
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

async function runPluginsInstallCommand(args: readonly string[]): Promise<void> {
  const locator = String(args[1] ?? '').trim();
  if (!locator || locator === 'help' || locator === '--help' || locator === '-h') {
    console.log(usage());
    return;
  }

  const flags = parseInstallFlags(args.slice(2));
  const result = await installLocalPathPlugin({
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

function parseMarketplaceFlags(args: readonly string[]): Readonly<{ dryRun: boolean; skipIfInstalled: boolean }> {
  return parseInstallFlags(args);
}

async function runPluginsMarketplaceListCommand(args: readonly string[]): Promise<void> {
  const sourceUrl = String(args[2] ?? '').trim();
  if (!sourceUrl || sourceUrl === 'help' || sourceUrl === '--help' || sourceUrl === '-h') {
    console.log(usage());
    return;
  }

  const result = await readRemoteMarketplaceCatalog({ sourceUrl });
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
    sourceUrl: result.catalog.sourceUrl,
    entries: result.catalog.entries,
    diagnostics: result.diagnostics,
  });
}

async function runPluginsMarketplaceShowCommand(args: readonly string[]): Promise<void> {
  const sourceUrl = String(args[2] ?? '').trim();
  const pluginId = String(args[3] ?? '').trim();
  if (!sourceUrl || !pluginId || sourceUrl === 'help' || sourceUrl === '--help' || sourceUrl === '-h') {
    console.log(usage());
    return;
  }

  const result = await readRemoteMarketplaceCatalogEntry({
    sourceUrl,
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
    sourceUrl: result.catalog.sourceUrl,
    entry: result.entry,
    diagnostics: result.diagnostics,
  });
}

async function runPluginsMarketplaceInstallCommand(args: readonly string[]): Promise<void> {
  const sourceUrl = String(args[2] ?? '').trim();
  const pluginId = String(args[3] ?? '').trim();
  if (!sourceUrl || !pluginId || sourceUrl === 'help' || sourceUrl === '--help' || sourceUrl === '-h') {
    console.log(usage());
    return;
  }

  const flags = parseMarketplaceFlags(args.slice(4));
  const result = await installMarketplacePlugin({
    sourceUrl,
    pluginId,
    skipIfInstalled: flags.skipIfInstalled,
    dryRun: flags.dryRun,
  });

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

    printJsonEnvelope(
      {
        ok: true,
        kind: 'plugins_marketplace_install',
        data: {
          alreadyInstalled: result.alreadyInstalled,
          plugin: {
            pluginId: result.entry.pluginId,
            title: result.entry.title,
            version: result.entry.version,
            description: result.entry.description,
            source: result.entry.source,
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

  const out = createOutputBuilder();
  if (flags.dryRun) {
    out.line(`Dry run: would install marketplace plugin ${result.entry.title} from ${sourceUrl}.`);
  } else if (result.alreadyInstalled) {
    out.line(ok(`${result.entry.title} is already installed.`));
  } else {
    out.line(ok(`Installed ${result.entry.title} from curated marketplace.`));
  }
  out.line(`  ${dim('Plugin ID:')} ${result.entry.pluginId}`);
  out.line(`  ${dim('Marketplace:')} ${sourceUrl}`);
  out.line(`  ${dim('Contributions:')} ${formatContributionSummary(result.entry)}`);
  console.log(out.render());
}

export async function handlePluginsCommand(args: string[]): Promise<void> {
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
    await runPluginsInstallCommand(args);
    return;
  }

  if (subcommand === 'marketplace') {
    const marketplaceSubcommand = String(args[1] ?? '').trim();
    if (!marketplaceSubcommand || marketplaceSubcommand === 'help' || marketplaceSubcommand === '--help' || marketplaceSubcommand === '-h') {
      console.log(usage());
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
      await runPluginsMarketplaceInstallCommand(args);
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
