import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';

import { cmd, createOutputBuilder, dim, errorFrame, fail, neutral, ok, renderHelpPage, sectionTitle } from '@happier-dev/cli-common/output';

import type { CommandContext } from '@/cli/commandRegistry';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { configuration } from '@/configuration';
import { readInstalledPluginCatalog, readInstalledPluginCatalogEntry, type PluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import { readActivePluginAccountSettings, updateActivePluginAccountSettings } from '@/plugins/runtime/context/accountSettingsStorage';
import { preparePluginSecretsDataRemoval } from '@/plugins/runtime/context/secrets';
import { preparePluginStorageDataRemoval, type PluginSyncedStorageRemovalAdapter } from '@/plugins/runtime/context/storage';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
  projectPluginCatalogEntrySnapshot,
} from '@/plugins/projection/introspection/catalogSnapshot';
import type { MarketplaceCatalogEntry } from '@/plugins/store/marketplace/catalog';
import {
  COMMUNITY_NPM_MARKETPLACE_SOURCE,
  createMarketplaceIndexService,
  type MarketplaceIndexSourceConfig,
} from '@/plugins/store/marketplace/service';
import { createMarketplaceSourceRegistryStore } from '@/plugins/store/marketplace/sources/store';
import { createNpmRegistryProfileService } from '@/plugins/distribution/npm/profiles/service';
import { createNpmRegistryProfileProbe } from '@/plugins/distribution/npm/profiles/probe';
import { resolveArchiveExpectedIntegrity } from '@/plugins/distribution/archive/integrity';
import { isInteractiveTerminal, promptSecretInput } from '@/terminal/prompts/promptInput';
import { handlePluginsRegistryCommand, type PluginsRegistryCommandDeps } from './pluginsRegistry';
import { readDaemonPluginCatalog } from '@/daemon/controlClient';
import { packLocalPlugin } from '@/plugins/packaging/pack';
import { scaffoldLocalPlugin, type PluginScaffoldUiMode } from '@/plugins/scaffold/scaffold';
import {
  normalizePluginSdkRegistryOrigin,
  runPluginAuthorToolchain,
  type PluginAuthorToolchainOperation,
} from '@/plugins/authoring/toolchain';
import {
  runPackedPluginTest as runPackedPluginTestOwner,
  type PackedPluginTestResult,
} from '@/plugins/authoring/packedTest';
import {
  inspectPluginDevelopmentSource,
  startPluginDevelopmentSourceObserver,
  type PluginDevelopmentSourceRequest,
} from '@/plugins/authoring/sourceObserver';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import { requestPluginDevelopmentChange } from '@/plugins/daemon/developmentClient';
import { requestUserPluginChange, type UserPluginChangeResult } from '@/plugins/daemon/changeClient';
import type { PluginChangeRequest } from '@/plugins/daemon/changeContract';
import { isReservedHappierPluginId, PluginIdSchema, type MarketplaceIndexItemV1, type MarketplaceSourceRegistryV1, type MarketplaceSourceV1 } from '@happier-dev/protocol';
import {
  marketplaceInstallUnavailableReason,
  queryAllMarketplaceSourceItems,
  requestExactMarketplaceInstall,
} from '@/plugins/store/marketplace/exactInstall';

function projectMarketplaceIndexItemForLegacyCli(item: MarketplaceIndexItemV1): MarketplaceCatalogEntry {
  const unavailableReason = marketplaceInstallUnavailableReason(item);
  return {
    pluginId: item.pluginId,
    title: item.display.title,
    description: item.display.description,
    version: item.distribution.version,
    manifest: null,
    source: null,
    manifestDigest: item.manifestDigest,
    contributionIds: {
      agents: [], agentRuntimes: [], actions: [], tools: [], commands: [], resources: [], settings: [], hooks: [], hostedWeb: [], reactNativeBundles: [], uiArtifacts: [], surfacePlacements: [],
    },
    installable: unavailableReason === null,
    diagnostics: [],
  };
}

type PluginsCommandDeps = Readonly<{
  isInteractiveTerminal?: () => boolean;
  registry?: Omit<PluginsRegistryCommandDeps, 'write'>;
  runPluginAuthorToolchain?: typeof runPluginAuthorToolchain;
  runPackedPluginTest?: (params: Readonly<{ projectRoot: string }>) => Promise<PackedPluginTestResult>;
  inspectPluginDevelopmentSource?: typeof inspectPluginDevelopmentSource;
  startPluginDevelopmentSourceObserver?: typeof startPluginDevelopmentSourceObserver;
  requestDevelopmentChange?: (
    request: PluginDevelopmentSourceRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<Readonly<{
    ok: boolean;
    diagnostics?: readonly Readonly<{ code: string; message: string }>[];
  }>>;
  pluginDataRemoval?: Readonly<{
    accountSettings: PluginSyncedStorageRemovalAdapter;
    removeDirectory?: (directoryPath: string) => Promise<void>;
  }>;
  marketplaceIndexService?: Pick<ReturnType<typeof createMarketplaceIndexService>, 'querySources'>;
}>;

type PluginsCommandRuntime = Readonly<{
  signal?: AbortSignal;
}>;

const defaultPluginsCommandDeps: PluginsCommandDeps = {
  isInteractiveTerminal,
  requestDevelopmentChange: async (request, options) => await requestPluginDevelopmentChange(request, {}, options),
  runPackedPluginTest: runPackedPluginTestOwner,
  pluginDataRemoval: {
    accountSettings: {
      getSettings: readActivePluginAccountSettings,
      updateSettings: updateActivePluginAccountSettings,
    },
  },
};

function usage(): string {
  return renderHelpPage({
    title: 'happier plugins',
    subtitle: 'Plugin discovery, local authoring, and machine-local installs',
    usage: [
      { label: 'happier plugins list [--json]', description: 'List installed plugins and their descriptors' },
      { label: 'happier plugins show <pluginId> [--json]', description: 'Show one installed plugin in detail' },
      { label: 'happier plugins actions <pluginId> [--json]', description: 'List invocable actions and tools declared by one installed plugin' },
      { label: 'happier plugins install <path|archive|package> [--kind path|archive|npm] [--selector <version>] [--integrity <sha256-SRI>] [--dev] [--dry-run] [--json]', description: 'Review, trust, and install through the active daemon' },
      { label: 'happier plugins rollback <pluginId> [--json]', description: 'Restore the retained prior plugin version through the active daemon' },
      { label: 'happier plugins enable|disable <pluginId> [--json]', description: 'Change plugin admission through the active daemon' },
      { label: 'happier plugins uninstall <pluginId> [--delete-data --yes] [--json]', description: 'Remove a local installed plugin; preserve its data unless --delete-data --yes is supplied' },
      { label: 'happier plugins create <name> [--id <plugin.id>] [--sdk-version <exact>] [--json]', description: 'Create a minimal TypeScript plugin ready for the normal development loop' },
      { label: 'happier plugins dev [path] [--json]', description: 'Install declared dependencies and watch a source plugin through the daemon' },
      { label: 'happier plugins test [path] [--packed] [--json]', description: 'Run unit tests or pack, install, and exercise the plugin through a disposable daemon' },
      { label: 'happier plugins scaffold <target-dir> --id <plugin.id> --name <display name> [--sdk-version <exact>] [--ui hostedWeb|reactNative] [--json]', description: 'Create a minimal public SDK plugin template for local authoring' },
      { label: 'happier plugins author install <path> [--json]', description: 'Materialize an external-author fixture with the managed package toolchain' },
      { label: 'happier plugins author typecheck|build|test <path> [--json]', description: 'Run managed author typecheck, build, or test checks' },
      { label: 'happier plugins pack <path> [--out <archive.tgz>] [--json]', description: 'Validate and package a local plugin into an installable archive' },
      { label: 'happier plugins reload <developmentPluginId> [--json]', description: 'Reapply the current development source through the active daemon' },
      { label: 'happier plugins registry add <origin> [--id <id>] [--name <name>] [--scope <@scope>] [--default] [--allow-private-network] [--json]', description: 'Add a private npm registry profile' },
      { label: 'happier plugins registry login <profileId> [--json]', description: 'Store a registry token through a hidden prompt' },
      { label: 'happier plugins registry test|logout|remove <profileId> [--json]', description: 'Test or change one private registry profile' },
      { label: 'happier plugins registry list [--json]', description: 'List private registry profiles and paused sources' },
      { label: 'happier plugins marketplace sources list [--json]', description: 'List shared marketplace sources' },
      { label: 'happier plugins marketplace sources add <catalogUrl> [--title <title>] [--description <description>] [--registry-profile <profileId>|--no-registry-profile] [--disabled] [--json]', description: 'Persist a user marketplace source and optional private registry binding' },
      { label: 'happier plugins marketplace sources enable <sourceRef> [--json]', description: 'Enable a persisted marketplace source' },
      { label: 'happier plugins marketplace sources disable <sourceRef> [--json]', description: 'Disable a persisted marketplace source' },
      { label: 'happier plugins marketplace sources remove <sourceRef> [--json]', description: 'Remove a persisted marketplace source' },
      { label: 'happier plugins marketplace list [<sourceRef>] [--json]', description: 'List marketplace entries from the preferred persisted source' },
      { label: 'happier plugins marketplace show [<sourceRef>] <pluginId> [--json]', description: 'Show one marketplace entry' },
      { label: 'happier plugins marketplace install [<sourceRef>] <pluginId> [--json]', description: 'Install and trust one exact curated or community npm listing through the active daemon' },
    ],
    notes: [
      'Plugins are machine-local, descriptor-backed plugins.',
      'Current install support covers local directories, reviewed npm packages, local/remote archives, and exact curated or community npm marketplace listings.',
      'Live authoring is local-path based: create a plugin, then run happier plugins dev from its directory.',
      'Packed real-host testing uses a disposable authenticated daemon home and does not read or copy user credentials or installed-plugin state.',
      'Direct npm installation is staged behind the install-and-trust flow; private registry profiles are managed with the registry commands.',
      'Marketplace Install and trust rechecks exact version, integrity, manifest, source, and review facts; community code remains unreviewed until its staged Install & Trust decision.',
      `Use ${cmd('happier agents list')} to see plugin-provided agent CLI surfaces after install.`,
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

type PluginInstallSourceKind = 'path' | 'archive' | 'npm';

function parseInstallFlags(args: readonly string[]): Readonly<{
  dryRun: boolean;
  sourceKind: PluginInstallSourceKind | null;
  selector: string | null;
  integrity: string | null;
  dev: boolean;
  sdkRegistryOrigin: string | null;
}> {
  const rawKind = readSingleValue(args, '--kind');
  if (rawKind !== null && rawKind !== 'path' && rawKind !== 'archive' && rawKind !== 'npm') {
    throw new Error(`Unknown plugin source kind: ${rawKind}`);
  }
  return {
    dryRun: args.includes('--dry-run'),
    sourceKind: rawKind,
    selector: readSingleValue(args, '--selector'),
    integrity: readSingleValue(args, '--integrity'),
    dev: args.includes('--dev'),
    sdkRegistryOrigin: normalizePluginSdkRegistryOrigin(readSingleValue(args, '--sdk-registry')),
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
  flags: ReturnType<typeof parseInstallFlags>,
): Promise<PluginChangeRequest> {
  const kind = flags.sourceKind ?? inferPluginInstallSourceKind(locator);
  if (kind === 'archive') {
    const expectedIntegrity = await resolveArchiveExpectedIntegrity({
      locator,
      explicitIntegrity: flags.integrity,
    });
    return {
      kind: 'installArchive',
      locator,
      ...(expectedIntegrity ? { expectedIntegrity } : {}),
    };
  }
  if (flags.integrity) {
    throw new Error('--integrity is only valid for archive plugin installs');
  }
  if (kind === 'npm') {
    return {
      kind: 'installNpm',
      packageName: locator,
      ...(flags.selector ? { selector: flags.selector } : {}),
    };
  }
  return {
    kind: 'installPath',
    locator,
    development: flags.dev,
    ...(flags.dev && flags.sdkRegistryOrigin
      ? { sdkRegistryOrigin: flags.sdkRegistryOrigin }
      : {}),
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
  origin: 'user' | null;
  registryProfileId: string | null | undefined;
  enabled: boolean;
}> {
  const positional = collectPositionalArgs(args, 3, ['--title', '--description', '--origin', '--registry-profile']);
  const origin = readSingleValue(args, '--origin');
  const registryProfileId = readSingleValue(args, '--registry-profile');
  if (origin !== null && origin !== 'user') {
    throw new Error(`Unknown marketplace source origin: ${origin}`);
  }
  if (registryProfileId !== null && args.includes('--no-registry-profile')) {
    throw new Error('Choose either --registry-profile or --no-registry-profile');
  }
  return {
    sourceUrl: positional[0] ?? null,
    title: readSingleValue(args, '--title'),
    description: readSingleValue(args, '--description'),
    origin: origin as 'user' | null,
    registryProfileId: args.includes('--no-registry-profile') ? null : registryProfileId ?? undefined,
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
}>, sourceRef: string | null): Promise<(MarketplaceIndexSourceConfig & Readonly<{
  description?: string | null;
}>) | null> {
  if (sourceRef) {
    if (
      sourceRef === COMMUNITY_NPM_MARKETPLACE_SOURCE.id
      || sourceRef === COMMUNITY_NPM_MARKETPLACE_SOURCE.sourceUrl
    ) {
      return COMMUNITY_NPM_MARKETPLACE_SOURCE;
    }
    return await store.resolveSourceReference(sourceRef);
  }
  return await store.resolvePreferredSource();
}

function formatMarketplaceContributionSummary(entry: Readonly<{ contributionIds: MarketplaceCatalogEntry['contributionIds'] }>): string {
  const parts = [
    `${entry.contributionIds.agents.length} agents`,
    `${entry.contributionIds.agentRuntimes.length} agent runtimes`,
    `${entry.contributionIds.actions.length} actions`,
    `${entry.contributionIds.tools.length} tools`,
    `${entry.contributionIds.commands.length} commands`,
    `${entry.contributionIds.hooks.length} hooks`,
    `${entry.contributionIds.reactNativeBundles.length + entry.contributionIds.uiArtifacts.length} UI`,
  ];
  return parts.join(', ');
}

function readContributionIdentityDisplayValue(
  contribution: PluginCatalogEntry['contributionIntrospection']['contributions'][number]['contribution'],
): string {
  if (contribution.kind === 'localId') return contribution.localId;
  if (contribution.kind === 'locale') return contribution.locale;
  return contribution.domainId;
}

function formatInstalledContributionSummary(entry: PluginCatalogEntry): string {
  const counts = new Map<string, number>();
  for (const contribution of entry.contributionIntrospection.contributions) {
    const family = contribution.contribution.family;
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([family, count]) => `${count} ${family}`)
    .join(', ');
}

type PluginActionCatalogRow = Readonly<{
  actionId: string;
  kind: 'action' | 'tool';
  title: string;
  description: string | null;
  surfaces: readonly string[];
}>;

function readPluginActionCatalog(entry: PluginCatalogEntry): readonly PluginActionCatalogRow[] {
  const manifest = entry.manifest;
  if (!manifest) {
    return [];
  }
  const actions = manifest.contributes.actions.map((action) => ({
    actionId: action.id,
    kind: 'action' as const,
    title: typeof action.title === 'string' ? action.title : action.title.fallback,
    description: typeof action.description === 'string' ? action.description : null,
    surfaces: [...action.surfaces],
  }));
  const tools = manifest.contributes.tools.map((tool) => ({
    actionId: tool.id,
    kind: 'tool' as const,
    title: typeof tool.title === 'string' ? tool.title : tool.title.fallback,
    description: typeof tool.description === 'string' ? tool.description : null,
    surfaces: [...tool.surfaces],
  }));
  return Object.freeze([...actions, ...tools].sort((left, right) => (
    left.actionId.localeCompare(right.actionId)
  )));
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
    out.line(`  ${dim('Contributions:')} ${formatInstalledContributionSummary(entry)}`);
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
    if (source.registryProfileId) out.line(`  ${dim('Registry profile:')} ${source.registryProfileId}`);
  }
  console.log(out.render());
}

function printHumanMarketplaceSource(source: MarketplaceSourceV1, actionLabel: string): void {
  const out = createOutputBuilder();
  out.line(ok(`${actionLabel}: ${source.title}`));
  out.line(`  ${dim('Source ID:')} ${source.id}`);
  out.line(`  ${dim('URL:')} ${source.sourceUrl}`);
  out.line(`  ${dim('Status:')} ${source.enabled ? 'enabled' : 'disabled'}`);
  if (source.registryProfileId) out.line(`  ${dim('Registry profile:')} ${source.registryProfileId}`);
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
  out.line(`${dim('Desired generation:')} ${entry.desiredGeneration ?? 'none'}`);
  out.line(`${dim('Applied generation:')} ${entry.appliedGeneration ?? 'none'}`);
  out.line(`${dim('Manifest:')} ${entry.manifestPath}`);
  out.line(`${dim('Contributions:')} ${formatInstalledContributionSummary(entry)}`);
  const families = new Map<string, string[]>();
  for (const contribution of entry.contributionIntrospection.contributions) {
    const ids = families.get(contribution.contribution.family) ?? [];
    ids.push(readContributionIdentityDisplayValue(contribution.contribution));
    families.set(contribution.contribution.family, ids);
  }
  for (const [family, ids] of [...families.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    out.line(`  ${dim(`${family}:`)} ${ids.join(', ')}`);
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
    out.line(`  ${dim('Contributions:')} ${formatMarketplaceContributionSummary(entry)}`);
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
  out.line(`${dim('Contributions:')} ${formatMarketplaceContributionSummary(params.entry)}`);
  if (params.entry.contributionIds.agents.length > 0) {
    out.line(`  ${dim('Agents:')} ${params.entry.contributionIds.agents.join(', ')}`);
  }
  if (params.entry.contributionIds.agentRuntimes.length > 0) {
    out.line(`  ${dim('Agent runtimes:')} ${params.entry.contributionIds.agentRuntimes.join(', ')}`);
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
  const catalog = await readDaemonPluginCatalog();
  if (catalog.kind === 'unavailable') {
    printPluginCatalogUnavailable(args, 'plugins_list', catalog.code);
    return;
  }
  const entries = catalog.plugins;
  const json = wantsJson(args);
  if (json) {
    printJsonEnvelope({
      ok: true,
      kind: 'plugins_list',
      data: {
        plugins: entries.map((entry) => projectPluginCatalogEntrySnapshot(entry)),
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

  const catalog = await readDaemonPluginCatalog();
  if (catalog.kind === 'unavailable') {
    printPluginCatalogUnavailable(args, 'plugins_show', catalog.code);
    return;
  }
  const entries = catalog.plugins;
  const entry = entries.find((candidate) => candidate.pluginId === pluginId);
  if (!entry) {
    throw new Error(`Unknown plugin id: ${pluginId}`);
  }

  if (wantsJson(args)) {
    printJsonEnvelope({
      ok: true,
      kind: 'plugins_show',
      data: {
        plugin: projectPluginCatalogEntrySnapshot(entry),
      },
    });
    return;
  }

  printHumanShow(entry);
}

function printPluginCatalogUnavailable(
  args: readonly string[],
  kind: 'plugins_list' | 'plugins_show',
  code: string,
): void {
  const message = `The active daemon plugin catalog is unavailable (${code})`;
  if (wantsJson(args)) {
    printJsonEnvelope({
      ok: false,
      kind,
      error: { code, message },
    }, { exitCode: 1 });
    return;
  }
  console.error(errorFrame('Error:', [message]));
  process.exitCode = 1;
}

async function runPluginsActionsCommand(args: readonly string[]): Promise<void> {
  const pluginId = String(args[1] ?? '').trim();
  if (!pluginId || pluginId === 'help' || pluginId === '--help' || pluginId === '-h') {
    console.log(usage());
    return;
  }

  const entry = await readInstalledPluginCatalogEntry({ pluginId });
  if (!entry) {
    const message = `Unknown plugin id: ${pluginId}`;
    if (wantsJson(args)) {
      printJsonEnvelope({
        ok: false,
        kind: 'plugins_actions',
        error: {
          code: 'plugin_not_found',
          message,
        },
      }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Error:', [message]));
    process.exitCode = 1;
    return;
  }

  const actions = readPluginActionCatalog(entry);
  if (wantsJson(args)) {
    printJsonEnvelope({
      ok: true,
      kind: 'plugins_actions',
      data: {
        pluginId: entry.pluginId,
        actions,
        diagnostics: entry.diagnostics,
      },
    });
    return;
  }

  const out = createOutputBuilder();
  out.line(sectionTitle(`${entry.title} actions`));
  if (actions.length === 0) {
    out.line(neutral('(no plugin actions or tools declared)'));
  }
  for (const action of actions) {
    out.line(`${action.actionId} ${dim(`(${action.kind})`)}`);
    out.line(`  ${dim('Title:')} ${action.title}`);
    out.line(`  ${dim('Surfaces:')} ${action.surfaces.join(', ') || '(none)'}`);
  }
  console.log(out.render());
}

function describePluginChangeFailure(result: Exclude<UserPluginChangeResult, { kind: 'committed' }>): Readonly<{
  code: string;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}> {
  switch (result.kind) {
    case 'reviewRequired':
      return {
        code: 'review_required',
        message: `Install and trust review is required for ${result.review.displayName}.`,
        details: { pendingChangeId: result.pendingChangeId, review: result.review },
      };
    case 'cancelled':
      return { code: 'cancelled', message: 'The plugin change was cancelled before it was applied.' };
    case 'expired':
      return { code: 'expired', message: 'The plugin review expired; run the command again to review the current candidate.' };
    case 'busy':
      return { code: 'busy', message: `Another plugin change is already in progress for ${result.pluginId}.`, details: { pluginId: result.pluginId } };
    case 'unavailable':
      return { code: 'unavailable', message: `The daemon plugin-change service is unavailable (${result.code}).`, details: { causeCode: result.code } };
    case 'conflict':
      return { code: 'conflict', message: `Plugin facts changed while applying ${result.pluginId}; review the candidate again.`, details: { pluginId: result.pluginId } };
    case 'failed':
      return {
        code: 'failed',
        message: result.message ?? `The daemon rejected the plugin change (${result.code}).`,
        details: {
          causeCode: result.code,
          ...(result.message ? { causeMessage: result.message } : {}),
        },
      };
    case 'outcomeUnknown':
      return {
        code: 'outcome_unknown',
        message: `The daemon may have applied the change for ${result.pluginId}; inspect installed state before retrying.`,
        details: { pluginId: result.pluginId, ...(result.expectedCandidate ? { expectedCandidate: result.expectedCandidate } : {}) },
      };
  }
}

function reportPluginChangeFailure(
  args: readonly string[],
  outputKind: string,
  result: Exclude<UserPluginChangeResult, { kind: 'committed' }>,
): void {
  const failure = describePluginChangeFailure(result);
  if (wantsJson(args)) {
    printJsonEnvelope({
      ok: false,
      kind: outputKind,
      error: {
        code: failure.code,
        message: failure.message,
        ...(failure.details ?? {}),
      },
    }, { exitCode: 1 });
    return;
  }
  console.error(errorFrame('Error:', [failure.message]));
  process.exitCode = 1;
}

function interactivePluginApproval(deps: PluginsCommandDeps, args: readonly string[]): 'prompt' | 'none' {
  return wantsJson(args) || !(deps.isInteractiveTerminal ?? isInteractiveTerminal)()
    ? 'none'
    : 'prompt';
}

async function runPluginsInstallCommand(args: readonly string[], deps: PluginsCommandDeps): Promise<void> {
  const locator = String(args[1] ?? '').trim();
  if (!locator || locator === 'help' || locator === '--help' || locator === '-h') {
    console.log(usage());
    return;
  }

  const flags = parseInstallFlags(args.slice(2));
  const request = await createPluginInstallRequest(locator, flags);
  if (flags.dryRun) {
    if (wantsJson(args)) {
      printJsonEnvelope({ ok: true, kind: 'plugins_install', data: { dryRun: true, request } });
      return;
    }
    console.log(`Dry run: would request ${request.kind} for ${locator}.`);
    return;
  }
  const approval = interactivePluginApproval(deps, args);
  const result = await requestUserPluginChange({ request, approval });

  if (result.kind !== 'committed') {
    reportPluginChangeFailure(args, 'plugins_install', result);
    return;
  }
  const catalog = await readDaemonPluginCatalog();
  const entry = catalog.kind === 'available'
    ? catalog.plugins.find((candidate) => candidate.pluginId === result.pluginId) ?? null
    : null;

  if (wantsJson(args)) {
    printJsonEnvelope({
      ok: true,
      kind: 'plugins_install',
      data: {
        pluginId: result.pluginId,
        desiredGeneration: result.desiredGeneration,
        appliedGeneration: result.appliedGeneration,
        pendingSurfaces: result.pendingSurfaces,
        ...(entry ? { plugin: projectPluginCatalogEntrySnapshot(entry) } : {}),
      },
    });
    return;
  }

  const out = createOutputBuilder();
  out.line(ok(`Installed ${entry?.title ?? result.pluginId}.`));
  out.line(`  ${dim('Plugin ID:')} ${result.pluginId}`);
  if (entry) {
    out.line(`  ${dim('Manifest:')} ${entry.manifestPath}`);
    out.line(`  ${dim('Contributions:')} ${formatInstalledContributionSummary(entry)}`);
  }
  if (result.pendingSurfaces.length > 0) {
    out.line(neutral(`  Pending reconciliation: ${result.pendingSurfaces.join(', ')}`));
  }
  console.log(out.render());
}

function summarizePluginForCommand(entry: PluginCatalogEntry) {
  return projectPluginCatalogEntrySnapshot(entry);
}

type PluginDataRemovalStep = 'uninstall' | 'syncedStorage' | 'localStorage' | 'secrets';

function pluginDataRemovalCauseCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') {
      return descriptor.value;
    }
  }
  return 'plugin_data_removal_step_failed';
}

async function runPluginsDestructiveUninstallCommand(
  args: readonly string[],
  deps: PluginsCommandDeps,
  rawPluginId: string,
): Promise<void> {
  if (!args.includes('--yes') && !args.includes('-y')) {
    const error = {
      code: 'confirmation_required',
      message: 'Destructive plugin data removal requires explicit --yes confirmation. The plugin remains installed and no data was changed.',
    };
    if (wantsJson(args)) {
      printJsonEnvelope({ ok: false, kind: 'plugins_uninstall', error }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Error:', [error.message]));
    process.exitCode = 1;
    return;
  }

  const parsedPluginId = PluginIdSchema.safeParse(rawPluginId);
  if (!parsedPluginId.success) {
    const error = {
      code: 'plugin_data_removal_identity_invalid',
      message: 'Destructive plugin data removal requires a canonical plugin id. No data was changed.',
    };
    if (wantsJson(args)) {
      printJsonEnvelope({ ok: false, kind: 'plugins_uninstall', error }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Error:', [error.message]));
    process.exitCode = 1;
    return;
  }
  const pluginId = parsedPluginId.data;
  const entry = await readInstalledPluginCatalogEntry({ pluginId });
  if (entry?.source.kind === 'bundled' || (!entry && isReservedHappierPluginId(pluginId))) {
    const error = {
      code: 'plugin_data_removal_ownership_unsupported',
      message: 'Destructive data removal is unavailable for a bundled or unowned Happier plugin namespace. No data was changed.',
    };
    if (wantsJson(args)) {
      printJsonEnvelope({ ok: false, kind: 'plugins_uninstall', error }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Error:', [error.message]));
    process.exitCode = 1;
    return;
  }

  const removalDeps = deps.pluginDataRemoval ?? defaultPluginsCommandDeps.pluginDataRemoval;
  if (!removalDeps) throw new Error('Plugin data removal dependencies are unavailable');
  const paths = resolvePluginStorePaths({ happyHomeDir: configuration.happyHomeDir });
  let storageRemoval: Awaited<ReturnType<typeof preparePluginStorageDataRemoval>>;
  let secretsRemoval: Awaited<ReturnType<typeof preparePluginSecretsDataRemoval>>;
  try {
    storageRemoval = await preparePluginStorageDataRemoval({
      pluginId,
      paths,
      synced: removalDeps.accountSettings,
      ...(removalDeps.removeDirectory ? { removeDirectory: removalDeps.removeDirectory } : {}),
    });
    secretsRemoval = await preparePluginSecretsDataRemoval({
      pluginId,
      paths,
      ...(removalDeps.removeDirectory ? { removeDirectory: removalDeps.removeDirectory } : {}),
    });
  } catch (cause) {
    const error = {
      code: 'plugin_data_removal_preflight_failed',
      causeCode: pluginDataRemovalCauseCode(cause),
      message: 'Plugin data removal could not validate every owned namespace before mutation. No data was changed.',
    };
    if (wantsJson(args)) {
      printJsonEnvelope({ ok: false, kind: 'plugins_uninstall', error }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Error:', [error.message]));
    process.exitCode = 1;
    return;
  }

  const completed: PluginDataRemovalStep[] = [];
  const remainingSteps = (): readonly PluginDataRemovalStep[] => {
    const required: PluginDataRemovalStep[] = [
      'uninstall',
      'syncedStorage',
      'localStorage',
      'secrets',
    ];
    return required.filter((step) => !completed.includes(step));
  };
  const reportPartial = (failedStep: PluginDataRemovalStep, cause: unknown): void => {
    const error = {
      code: 'plugin_data_removal_partial',
      causeCode: pluginDataRemovalCauseCode(cause),
      message: `Plugin data removal stopped during ${failedStep}. Completed steps are not rolled back; retrying the same confirmed command is safe.`,
      completed: Object.freeze([...completed]),
      pending: Object.freeze([...remainingSteps()]),
    };
    if (wantsJson(args)) {
      printJsonEnvelope({ ok: false, kind: 'plugins_uninstall', error }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Error:', [error.message]));
    process.exitCode = 1;
  };

  try {
    const uninstall = await requestUserPluginChange({
      request: {
        kind: 'uninstall',
        pluginId,
        clearHealthHistory: true,
        actorEvidence: {
          kind: 'authenticatedLocalUser',
          interactionId: randomUUID(),
          occurredAtMs: Date.now(),
        },
      },
      approval: 'none',
    });
    if (uninstall.kind !== 'committed') {
      reportPartial('uninstall', { code: describePluginChangeFailure(uninstall).code });
      return;
    }
    completed.push('uninstall');
  } catch (cause) {
    reportPartial('uninstall', cause);
    return;
  }

  const destructiveSteps: ReadonlyArray<Readonly<{
    id: Extract<PluginDataRemovalStep, 'syncedStorage' | 'localStorage' | 'secrets'>;
    run: () => Promise<void>;
  }>> = [
    { id: 'syncedStorage', run: storageRemoval.removeSynced },
    { id: 'localStorage', run: storageRemoval.removeLocal },
    { id: 'secrets', run: secretsRemoval.remove },
  ];
  for (const step of destructiveSteps) {
    try {
      await step.run();
      completed.push(step.id);
    } catch (cause) {
      reportPartial(step.id, cause);
      return;
    }
  }

  const data = {
    pluginId,
    alreadyUninstalled: entry === null,
    ...(entry ? { plugin: summarizePluginForCommand(entry) } : {}),
    removedData: {
      localStorage: storageRemoval.hadLocalData,
      syncedStorage: storageRemoval.hadSyncedData,
      secrets: secretsRemoval.hadSecrets,
    },
  };
  if (wantsJson(args)) {
    printJsonEnvelope({ ok: true, kind: 'plugins_uninstall', data });
    return;
  }
  const out = createOutputBuilder();
  out.line(ok(`Removed plugin data for ${pluginId}.`));
  out.line(`  ${dim('Uninstall:')} ${entry ? 'completed' : 'already absent'}`);
  out.line(`  ${dim('Data:')} local, synced, and encrypted plugin-secret namespaces processed`);
  console.log(out.render());
}

async function runPluginsUninstallCommand(args: readonly string[], deps: PluginsCommandDeps): Promise<void> {
  const pluginId = String(args[1] ?? '').trim();
  if (!pluginId || pluginId === 'help' || pluginId === '--help' || pluginId === '-h') {
    console.log(usage());
    return;
  }

  if (args.includes('--delete-data')) {
    await runPluginsDestructiveUninstallCommand(args, deps, pluginId);
    return;
  }

  const entry = await readInstalledPluginCatalogEntry({ pluginId });
  const result = await requestUserPluginChange({
    request: { kind: 'uninstall', pluginId },
    approval: 'none',
  });
  if (result.kind !== 'committed') {
    reportPluginChangeFailure(args, 'plugins_uninstall', result);
    return;
  }

  if (wantsJson(args)) {
    printJsonEnvelope({
      ok: true,
      kind: 'plugins_uninstall',
      data: {
        pluginId: result.pluginId,
        ...(entry ? { plugin: summarizePluginForCommand(entry) } : {}),
        desiredGeneration: result.desiredGeneration,
        appliedGeneration: result.appliedGeneration,
        pendingSurfaces: result.pendingSurfaces,
      },
    });
    return;
  }

  const out = createOutputBuilder();
  out.line(ok(`Uninstalled ${entry?.title ?? result.pluginId}.`));
  out.line(`  ${dim('Plugin ID:')} ${result.pluginId}`);
  if (result.pendingSurfaces.length > 0) out.line(neutral(`  Pending reconciliation: ${result.pendingSurfaces.join(', ')}`));
  console.log(out.render());
}

async function runPluginsEnabledCommand(
  args: readonly string[],
  deps: PluginsCommandDeps,
  enabled: boolean,
): Promise<void> {
  const pluginId = String(args[1] ?? '').trim();
  const outputKind = enabled ? 'plugins_enable' : 'plugins_disable';
  if (!pluginId || pluginId === 'help' || pluginId === '--help' || pluginId === '-h') {
    console.log(usage());
    return;
  }
  const result = await requestUserPluginChange({
    request: { kind: enabled ? 'enable' : 'disable', pluginId },
    approval: 'none',
  });
  if (result.kind !== 'committed') {
    reportPluginChangeFailure(args, outputKind, result);
    return;
  }
  if (wantsJson(args)) {
    printJsonEnvelope({
      ok: true,
      kind: outputKind,
      data: {
        pluginId: result.pluginId,
        enabled,
        desiredGeneration: result.desiredGeneration,
        appliedGeneration: result.appliedGeneration,
        pendingSurfaces: result.pendingSurfaces,
      },
    });
    return;
  }
  const out = createOutputBuilder();
  out.line(ok(`${enabled ? 'Enabled' : 'Disabled'} plugin ${result.pluginId}.`));
  if (result.pendingSurfaces.length > 0) out.line(neutral(`  Pending reconciliation: ${result.pendingSurfaces.join(', ')}`));
  console.log(out.render());
}

async function runPluginsRollbackCommand(args: readonly string[], deps: PluginsCommandDeps): Promise<void> {
  const pluginId = String(args[1] ?? '').trim();
  if (!pluginId || pluginId === 'help' || pluginId === '--help' || pluginId === '-h') {
    console.log(usage());
    return;
  }

  const entry = await readInstalledPluginCatalogEntry({ pluginId });
  const result = await requestUserPluginChange({
    request: { kind: 'rollback', pluginId },
    approval: 'none',
  });
  if (result.kind !== 'committed') {
    reportPluginChangeFailure(args, 'plugins_rollback', result);
    return;
  }

  if (wantsJson(args)) {
    printJsonEnvelope({
      ok: true,
      kind: 'plugins_rollback',
      data: {
        pluginId: result.pluginId,
        ...(entry ? { plugin: summarizePluginForCommand(entry) } : {}),
        desiredGeneration: result.desiredGeneration,
        appliedGeneration: result.appliedGeneration,
        pendingSurfaces: result.pendingSurfaces,
      },
    });
    return;
  }

  const out = createOutputBuilder();
  out.line(ok(`Rolled back ${entry?.title ?? result.pluginId}.`));
  if (result.pendingSurfaces.length > 0) out.line(neutral(`  Pending reconciliation: ${result.pendingSurfaces.join(', ')}`));
  console.log(out.render());
}

async function runPluginsScaffoldCommand(args: readonly string[]): Promise<void> {
  const targetDir = collectPositionalArgs(args, 1, ['--id', '--name', '--ui', '--sdk-version'])[0] ?? null;
  if (!targetDir || targetDir === 'help' || targetDir === '--help' || targetDir === '-h') {
    console.log(usage());
    return;
  }

  const ui = readSingleValue(args, '--ui');
  const result = await scaffoldLocalPlugin({
    targetDir,
    pluginId: readSingleValue(args, '--id') ?? '',
    displayName: readSingleValue(args, '--name') ?? '',
    pluginSdkVersion: readSingleValue(args, '--sdk-version') ?? undefined,
    ...(ui ? { ui: ui as PluginScaffoldUiMode } : {}),
  });

  if (wantsJson(args)) {
    if (!result.ok) {
      printJsonEnvelope(
        {
          ok: false,
          kind: 'plugins_scaffold',
          error: {
            code: 'scaffold_failed',
            diagnostics: result.diagnostics,
          },
        },
        { exitCode: 1 },
      );
      return;
    }

    printJsonEnvelope({
      ok: true,
      kind: 'plugins_scaffold',
      data: {
        plugin: {
          pluginId: result.pluginId,
          title: result.title,
          version: result.version,
        },
        scaffold: {
          targetDir: result.targetDir,
          manifestPath: result.manifestPath,
          manifestSchemaPath: result.manifestSchemaPath,
          packageJsonPath: result.packageJsonPath,
          sourceEntryPath: result.sourceEntryPath,
          ...(result.uiEntryPath ? { uiEntryPath: result.uiEntryPath } : {}),
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

  const out = createOutputBuilder();
  out.line(ok(`Created ${result.title} plugin scaffold.`));
  out.line(`  ${dim('Plugin ID:')} ${result.pluginId}`);
  out.line(`  ${dim('Directory:')} ${result.targetDir}`);
  out.line(`  ${dim('Manifest:')} ${result.manifestPath}`);
  out.line(`  ${dim('JSON Schema:')} ${result.manifestSchemaPath}`);
  out.line(`  ${dim('Source entry:')} ${result.sourceEntryPath}`);
  out.line(`  ${dim('Develop:')} cd ${result.targetDir} && happier plugins dev`);
  out.line(`  ${dim('Pack:')} happier plugins pack ${result.targetDir}`);
  console.log(out.render());
}

function normalizePluginCreateName(rawName: string): Readonly<{
  slug: string;
  displayName: string;
}> {
  const directoryName = basename(resolve(rawName));
  const slug = directoryName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-{2,}/gu, '-');
  const displayName = slug
    .split('-')
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
  return { slug, displayName };
}

async function runPluginsCreateCommand(args: readonly string[]): Promise<void> {
  const targetDir = collectPositionalArgs(args, 1, ['--id', '--sdk-version'])[0] ?? null;
  if (!targetDir || targetDir === 'help' || targetDir === '--help' || targetDir === '-h') {
    console.log(usage());
    return;
  }
  const { slug, displayName } = normalizePluginCreateName(targetDir);
  const result = await scaffoldLocalPlugin({
    targetDir,
    pluginId: readSingleValue(args, '--id') ?? `local.${slug}`,
    displayName,
    pluginSdkVersion: readSingleValue(args, '--sdk-version') ?? undefined,
  });

  if (!result.ok) {
    if (wantsJson(args)) {
      printJsonEnvelope({
        ok: false,
        kind: 'plugins_create',
        error: { code: 'create_failed', diagnostics: result.diagnostics },
      }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Error:', result.diagnostics.map((entry) => entry.message)));
    process.exitCode = 1;
    return;
  }

  if (wantsJson(args)) {
    printJsonEnvelope({
      ok: true,
      kind: 'plugins_create',
      data: {
        plugin: { pluginId: result.pluginId, title: result.title, version: result.version },
        scaffold: {
          targetDir: result.targetDir,
          manifestPath: result.manifestPath,
          manifestSchemaPath: result.manifestSchemaPath,
          packageJsonPath: result.packageJsonPath,
          sourceEntryPath: result.sourceEntryPath,
        },
      },
    });
    return;
  }

  const out = createOutputBuilder();
  out.line(ok(`Created ${result.title}.`));
  out.line(`  ${dim('Directory:')} ${result.targetDir}`);
  out.line(`  ${dim('Plugin ID:')} ${result.pluginId}`);
  out.line(`  ${dim('Next:')} cd ${result.targetDir} && happier plugins dev`);
  console.log(out.render());
}

async function waitForPluginDevStop(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolveStop) => {
    const finish = (): void => {
      signal?.removeEventListener('abort', finish);
      process.removeListener('SIGINT', finish);
      process.removeListener('SIGTERM', finish);
      resolveStop();
    };
    signal?.addEventListener('abort', finish, { once: true });
    if (!signal) {
      process.once('SIGINT', finish);
      process.once('SIGTERM', finish);
    }
  });
}

async function runPluginsDevCommand(
  args: readonly string[],
  deps: PluginsCommandDeps,
  runtime: PluginsCommandRuntime,
): Promise<void> {
  const requestedPath = collectPositionalArgs(args, 1, ['--sdk-registry'])[0] ?? '.';
  if (requestedPath === 'help' || requestedPath === '--help' || requestedPath === '-h') {
    console.log(usage());
    return;
  }
  if (!deps.requestDevelopmentChange) {
    const message = 'Plugin development daemon integration is not available in this build.';
    if (wantsJson(args)) {
      printJsonEnvelope({
        ok: false,
        kind: 'plugins_dev',
        error: { code: 'plugin_dev_daemon_unavailable', message },
      }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Error:', [message]));
    process.exitCode = 1;
    return;
  }

  let sdkRegistryOrigin: string | null;
  try {
    sdkRegistryOrigin = normalizePluginSdkRegistryOrigin(readSingleValue(args, '--sdk-registry'));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Plugin SDK registry is invalid.';
    if (wantsJson(args)) {
      printJsonEnvelope({
        ok: false,
        kind: 'plugins_dev',
        error: { code: 'plugin_dev_dependency_install_failed', diagnostics: [{ code: 'plugin_author_invalid_input', message }] },
      }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Error:', [message]));
    process.exitCode = 1;
    return;
  }

  const sourceInspection = await (deps.inspectPluginDevelopmentSource ?? inspectPluginDevelopmentSource)({
    projectRoot: requestedPath,
    ...(sdkRegistryOrigin ? { sdkRegistryOrigin } : {}),
  });
  if (!sourceInspection.ok) {
    if (wantsJson(args)) {
      printJsonEnvelope({
        ok: false,
        kind: 'plugins_dev',
        error: { code: 'plugin_dev_source_invalid', diagnostics: sourceInspection.diagnostics },
      }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Plugin source diagnostics:', sourceInspection.diagnostics.map((entry) => entry.message)));
    process.exitCode = 1;
    return;
  }

  const toolchainResult = await (deps.runPluginAuthorToolchain ?? runPluginAuthorToolchain)({
    operation: 'install',
    projectRoot: requestedPath,
    ...(sdkRegistryOrigin ? { sdkRegistryOrigin } : {}),
    ...(runtime.signal ? { signal: runtime.signal } : {}),
  });
  if (runtime.signal?.aborted) return;
  if (!toolchainResult.ok) {
    if (wantsJson(args)) {
      printJsonEnvelope({
        ok: false,
        kind: 'plugins_dev',
        error: { code: 'plugin_dev_dependency_install_failed', diagnostics: toolchainResult.diagnostics },
      }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Error:', toolchainResult.diagnostics.map((entry) => entry.message)));
    process.exitCode = 1;
    return;
  }

  const observer = await (deps.startPluginDevelopmentSourceObserver ?? startPluginDevelopmentSourceObserver)({
    projectRoot: toolchainResult.projectRoot,
    ...(sdkRegistryOrigin ? { sdkRegistryOrigin } : {}),
    onObservation: async (observation) => {
      if (!observation.ok) {
        if (wantsJson(args)) {
          printJsonEnvelope({
            ok: false,
            kind: 'plugins_dev_change',
            error: { code: 'plugin_dev_source_invalid', diagnostics: observation.diagnostics },
          }, { exitCode: 0 });
          return;
        }
        console.error(errorFrame('Plugin source diagnostics:', observation.diagnostics.map((entry) => entry.message)));
        return;
      }

      let response: Awaited<ReturnType<NonNullable<PluginsCommandDeps['requestDevelopmentChange']>>>;
      try {
        response = runtime.signal
          ? await deps.requestDevelopmentChange!(observation.request, { signal: runtime.signal })
          : await deps.requestDevelopmentChange!(observation.request);
      } catch (error) {
        if (runtime.signal?.aborted) return;
        response = {
          ok: false,
          diagnostics: [{
            code: 'plugin_dev_candidate_request_failed',
            message: error instanceof Error
              ? `Unable to submit the development candidate: ${error.message}`
              : 'Unable to submit the development candidate.',
          }],
        };
      }
      if (runtime.signal?.aborted) return;
      if (!response.ok) {
        const diagnostics = response.diagnostics ?? [{
          code: 'plugin_dev_candidate_rejected',
          message: 'The daemon rejected the development candidate.',
        }];
        if (wantsJson(args)) {
          printJsonEnvelope({
            ok: false,
            kind: 'plugins_dev_change',
            error: { code: diagnostics[0]?.code ?? 'plugin_dev_candidate_rejected', diagnostics },
          }, { exitCode: 0 });
          return;
        }
        console.error(errorFrame('Plugin candidate diagnostics:', diagnostics.map((entry) => entry.message)));
        return;
      }

      if (wantsJson(args)) {
        printJsonEnvelope({
          ok: true,
          kind: 'plugins_dev_change',
          data: {
            projectRoot: observation.request.projectRoot,
            observedFiles: observation.observedRelativePaths.length,
          },
        });
        return;
      }
      console.log(ok(`Development candidate accepted from ${observation.request.projectRoot}.`));
    },
  });

  try {
    await waitForPluginDevStop(runtime.signal);
  } finally {
    observer.stop();
  }
}

function isPluginAuthorOperation(value: string): value is PluginAuthorToolchainOperation {
  return value === 'install' || value === 'typecheck' || value === 'build' || value === 'test';
}

async function runPluginsAuthorCommand(
  args: readonly string[],
  deps: PluginsCommandDeps,
): Promise<void> {
  const rawOperation = String(args[1] ?? '').trim();
  const projectRoot = collectPositionalArgs(args, 2, ['--sdk-registry'])[0] ?? null;
  if (!isPluginAuthorOperation(rawOperation) || !projectRoot) {
    console.log(usage());
    return;
  }

  await runPluginToolchainCommand({
    args,
    deps,
    operation: rawOperation,
    projectRoot,
    kind: `plugins_author_${rawOperation}`,
    ...(rawOperation === 'install' ? { sdkRegistryOrigin: readSingleValue(args, '--sdk-registry') } : {}),
  });
}

async function runPluginToolchainCommand(params: Readonly<{
  args: readonly string[];
  deps: PluginsCommandDeps;
  operation: PluginAuthorToolchainOperation;
  projectRoot: string;
  kind: string;
  mode?: 'unit';
  sdkRegistryOrigin?: string | null;
}>): Promise<void> {
  const result = await (params.deps.runPluginAuthorToolchain ?? runPluginAuthorToolchain)({
    operation: params.operation,
    projectRoot: params.projectRoot,
    ...(params.sdkRegistryOrigin !== undefined ? { sdkRegistryOrigin: params.sdkRegistryOrigin } : {}),
  });

  if (wantsJson(params.args)) {
    if (!result.ok) {
      printJsonEnvelope({
        ok: false,
        kind: params.kind,
        error: {
          code: 'plugin_author_failed',
          diagnostics: result.diagnostics,
        },
      }, { exitCode: 1 });
      return;
    }
    printJsonEnvelope({
      ok: true,
      kind: params.kind,
      data: {
        ...(params.mode ? { mode: params.mode } : {}),
        operation: result.operation,
        projectRoot: result.projectRoot,
      },
    });
    return;
  }

  if (!result.ok) {
    console.error(errorFrame('Error:', result.diagnostics.map((diagnostic) => diagnostic.message)));
    process.exitCode = 1;
    return;
  }
  console.log(ok(`Plugin author ${result.operation} completed for ${result.projectRoot}.`));
}

async function runPluginsTestCommand(
  args: readonly string[],
  deps: PluginsCommandDeps,
): Promise<void> {
  const projectRoot = collectPositionalArgs(args, 1)[0] ?? '.';
  if (projectRoot === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    return;
  }
  if (args.includes('--packed')) {
    const result = await (deps.runPackedPluginTest ?? runPackedPluginTestOwner)({ projectRoot });
    if (wantsJson(args)) {
      if (!result.ok) {
        printJsonEnvelope({
          ok: false,
          kind: 'plugins_test',
          error: {
            code: 'plugin_test_packed_failed',
            diagnostics: result.diagnostics,
          },
        }, { exitCode: 1 });
        return;
      }
      printJsonEnvelope({
        ok: true,
        kind: 'plugins_test',
        data: {
          mode: result.mode,
          projectRoot: result.projectRoot,
          pluginId: result.pluginId,
          archiveDigest: result.archiveDigest,
          invocation: result.invocation,
          daemon: result.daemon,
        },
      });
      return;
    }
    if (!result.ok) {
      console.error(errorFrame('Error:', result.diagnostics.map((diagnostic) => diagnostic.message)));
      process.exitCode = 1;
      return;
    }
    console.log(ok(
      result.invocation
        ? `Packed plugin ${result.pluginId} installed and invoked ${result.invocation.actionId}.`
        : `Packed plugin ${result.pluginId} installed and activated through the disposable daemon.`,
    ));
    return;
  }
  await runPluginToolchainCommand({
    args,
    deps,
    operation: 'test',
    projectRoot,
    kind: 'plugins_test',
    mode: 'unit',
  });
}

async function runPluginsPackCommand(args: readonly string[]): Promise<void> {
  const locator = collectPositionalArgs(args, 1, ['--out'])[0] ?? null;
  if (!locator || locator === 'help' || locator === '--help' || locator === '-h') {
    console.log(usage());
    return;
  }

  const result = await packLocalPlugin({
    locator,
    outPath: readSingleValue(args, '--out'),
  });

  if (wantsJson(args)) {
    if (!result.ok) {
      printJsonEnvelope(
        {
          ok: false,
          kind: 'plugins_pack',
          error: {
            code: 'pack_failed',
            diagnostics: result.diagnostics,
          },
        },
        { exitCode: 1 },
      );
      return;
    }

    printJsonEnvelope({
      ok: true,
      kind: 'plugins_pack',
      data: {
        plugin: {
          pluginId: result.pluginId,
          title: result.title,
          version: result.version,
        },
        package: {
          packageRootPath: result.packageRootPath,
          manifestPath: result.manifestPath,
          manifestDigest: result.manifestDigest,
          archivePath: result.archivePath,
          archiveDigest: result.archiveDigest,
          digestPath: result.digestPath,
          archiveSizeBytes: result.archiveSizeBytes,
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

  const out = createOutputBuilder();
  out.line(ok(`Packed ${result.title}.`));
  out.line(`  ${dim('Plugin ID:')} ${result.pluginId}`);
  out.line(`  ${dim('Archive:')} ${result.archivePath}`);
  out.line(`  ${dim('Archive digest:')} ${result.archiveDigest}`);
  out.line(`  ${dim('Digest file:')} ${result.digestPath}`);
  out.line(`  ${dim('Manifest digest:')} ${result.manifestDigest}`);
  console.log(out.render());
}

async function runPluginsReloadCommand(args: readonly string[], deps: PluginsCommandDeps): Promise<void> {
  const pluginId = String(args[1] ?? '').trim();
  if (!pluginId || pluginId === 'help' || pluginId === '--help' || pluginId === '-h') {
    if (wantsJson(args) && !pluginId) {
      printJsonEnvelope({
        ok: false,
        kind: 'plugins_reload',
        error: { code: 'plugin_id_required', message: 'Explicit reload requires one development plugin id.' },
      }, { exitCode: 1 });
      return;
    }
    console.log(usage());
    return;
  }

  const entry = await readInstalledPluginCatalogEntry({ pluginId });
  if (!entry || entry.source.kind !== 'path' || entry.source.devWatch !== true) {
    const message = entry
      ? `Explicit reload is supported only for development path plugins; use install/update with --dev or use rollback for this plugin.`
      : `Unknown installed plugin id: ${pluginId}`;
    if (wantsJson(args)) {
      printJsonEnvelope({ ok: false, kind: 'plugins_reload', error: { code: entry ? 'development_source_required' : 'plugin_not_found', message } }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Error:', [message]));
    process.exitCode = 1;
    return;
  }

  const result = await requestUserPluginChange({
    request: {
      kind: 'development',
      pluginId,
      sourceRootPath: entry.source.locator,
    },
    approval: interactivePluginApproval(deps, args),
  });
  if (result.kind !== 'committed') {
    reportPluginChangeFailure(args, 'plugins_reload', result);
    return;
  }

  if (wantsJson(args)) {
    printJsonEnvelope({
      ok: true,
      kind: 'plugins_reload',
      data: {
        pluginId: result.pluginId,
        desiredGeneration: result.desiredGeneration,
        appliedGeneration: result.appliedGeneration,
        pendingSurfaces: result.pendingSurfaces,
      },
    });
    return;
  }

  const out = createOutputBuilder();
  out.line(ok(`Reloaded development plugin ${result.pluginId}.`));
  if (result.pendingSurfaces.length > 0) out.line(neutral(`  Pending reconciliation: ${result.pendingSurfaces.join(', ')}`));
  console.log(out.render());
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

  const result = await queryAllMarketplaceSourceItems(source);
  const projectedEntries = result.items.map(projectMarketplaceIndexItemForLegacyCli);
  if (wantsJson(args)) {
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
          registryProfileId: source.registryProfileId ?? null,
        },
        catalog: {
          title: source.title,
          description: source.description ?? null,
          sourceUrl: source.sourceUrl,
          cache: result.sources[0]?.freshness ?? null,
        },
        plugins: result.items.map((entry) => ({
          pluginId: entry.pluginId,
          title: entry.display.title,
          description: entry.display.description,
          version: entry.distribution.version,
          distribution: entry.distribution,
          source: entry.source,
          review: entry.review,
          admission: entry.admission,
          contributions: entry.summary.contributions,
        })),
        diagnostics: result.diagnostics,
      },
    });
    return;
  }

  printHumanMarketplaceList({
    title: source.title,
    sourceUrl: source.sourceUrl,
    entries: projectedEntries,
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

  const result = await queryAllMarketplaceSourceItems(source);
  const indexEntry = result.items.find((entry) => entry.pluginId === pluginId) ?? null;
  const projectedEntry = indexEntry ? projectMarketplaceIndexItemForLegacyCli(indexEntry) : null;
  if (wantsJson(args)) {
    if (!indexEntry) {
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
          title: source.title,
          description: source.description ?? null,
          sourceUrl: source.sourceUrl,
          cache: result.sources[0]?.freshness ?? null,
        },
        plugin: {
          ...indexEntry,
        },
      },
    });
    return;
  }

  if (!projectedEntry) {
    console.error(errorFrame('Error:', [`Unknown marketplace plugin id: ${pluginId}`]));
    process.exitCode = 1;
    return;
  }

  printHumanMarketplaceShow({
    title: source.title,
    sourceUrl: source.sourceUrl,
    entry: projectedEntry,
    diagnostics: result.diagnostics,
  });
}

function reportMarketplaceInstallUnavailable(args: readonly string[], message: string): void {
  if (wantsJson(args)) {
    printJsonEnvelope(
      {
        ok: false,
        kind: 'plugins_marketplace_install',
        error: { code: 'install_unavailable', message },
      },
      { exitCode: 1 },
    );
    return;
  }
  console.error(errorFrame('Error:', [message]));
  process.exitCode = 1;
}

async function runPluginsMarketplaceInstallCommand(args: readonly string[], _deps: PluginsCommandDeps): Promise<void> {
  const { sourceRef, pluginId } = readMarketplaceSelection(args, 2);
  if (!pluginId || pluginId === 'help' || pluginId === '--help' || pluginId === '-h') {
    console.log(usage());
    return;
  }

  const registryStore = createMarketplaceSourceRegistryStore();
  const source = await resolveMarketplaceSourceForCommand(registryStore, sourceRef);
  if (!source || !source.enabled) {
    reportMarketplaceInstallUnavailable(args, 'No enabled marketplace source is configured for this Install and trust action.');
    return;
  }

  const exactInstall = await requestExactMarketplaceInstall({
    happyHomeDir: configuration.happyHomeDir,
    sourceId: source.id,
    pluginId,
    approval: interactivePluginApproval(_deps, args),
  }, {
    marketplaceIndexService: _deps.marketplaceIndexService,
  });
  if (!exactInstall.ok) {
    reportMarketplaceInstallUnavailable(args, exactInstall.message);
    return;
  }
  const { listing, change } = exactInstall;
  if (change.kind !== 'committed') {
    reportPluginChangeFailure(args, 'plugins_marketplace_install', change);
    return;
  }

  if (wantsJson(args)) {
    printJsonEnvelope({
      ok: true,
      kind: 'plugins_marketplace_install',
      data: {
        pluginId: change.pluginId,
        desiredGeneration: change.desiredGeneration,
        appliedGeneration: change.appliedGeneration,
        pendingSurfaces: change.pendingSurfaces,
      },
    });
    return;
  }

  const out = createOutputBuilder();
  out.line(ok(`Installed and trusted ${listing.display.title}.`));
  out.line(`  ${dim('Plugin ID:')} ${change.pluginId}`);
  out.line(`  ${dim('Version:')} ${listing.distribution.version}`);
  if (change.pendingSurfaces.length > 0) {
    out.line(neutral(`  Pending reconciliation: ${change.pendingSurfaces.join(', ')}`));
  }
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
    registryProfileId: input.registryProfileId,
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
          registryProfileId: source.registryProfileId ?? null,
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
  runtime: PluginsCommandRuntime = {},
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

  if (subcommand === 'actions') {
    await runPluginsActionsCommand(args);
    return;
  }

  if (subcommand === 'install') {
    await runPluginsInstallCommand(args, deps);
    return;
  }

  if (subcommand === 'rollback') {
    await runPluginsRollbackCommand(args, deps);
    return;
  }

  if (subcommand === 'enable' || subcommand === 'disable') {
    await runPluginsEnabledCommand(args, deps, subcommand === 'enable');
    return;
  }

  if (subcommand === 'uninstall') {
    await runPluginsUninstallCommand(args, deps);
    return;
  }

  if (subcommand === 'scaffold') {
    await runPluginsScaffoldCommand(args);
    return;
  }

  if (subcommand === 'create') {
    await runPluginsCreateCommand(args);
    return;
  }

  if (subcommand === 'dev') {
    await runPluginsDevCommand(args, deps, runtime);
    return;
  }

  if (subcommand === 'test') {
    await runPluginsTestCommand(args, deps);
    return;
  }

  if (subcommand === 'author') {
    await runPluginsAuthorCommand(args, deps);
    return;
  }

  if (subcommand === 'pack') {
    await runPluginsPackCommand(args);
    return;
  }

  if (subcommand === 'reload') {
    await runPluginsReloadCommand(args, deps);
    return;
  }

  if (subcommand === 'registry') {
    const registryDeps = deps.registry ?? {
      service: createNpmRegistryProfileService({
        happyHomeDir: configuration.happyHomeDir,
        probe: createNpmRegistryProfileProbe(),
      }),
      machineId: 'local-cli',
      promptSecret: promptSecretInput,
    };
    await handlePluginsRegistryCommand(args.slice(1), {
      ...registryDeps,
      write: (value) => {
        if (wantsJson(args)) {
          printJsonEnvelope({ ok: true, kind: 'plugins_registry', data: value });
          return;
        }
        const out = createOutputBuilder();
        out.line(sectionTitle('Plugin registries'));
        out.line(JSON.stringify(value, null, 2));
        console.log(out.render());
      },
    });
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
    await handlePluginsCommand(context.args.slice(1), defaultPluginsCommandDeps, { signal: context.signal });
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
