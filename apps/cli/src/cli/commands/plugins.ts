import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { cmd, createOutputBuilder, dim, errorFrame, fail, neutral, ok, renderHelpPage, sectionTitle } from '@happier-dev/cli-common/output';
import {
  buildPosixShellCommand,
  buildPowerShellCommand,
  buildWindowsCmdCommand,
} from '@happier-dev/agents/process/shellCommand';

import type { CommandContext } from '@/cli/commandRegistry';
import {
  hasFlag,
  hasFlagValue,
  readCommandPositionals,
  readFlagValue,
  readRepeatedFlagValues,
} from '@/cli/commands/shared/argvFlags';
import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { configuration } from '@/configuration';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { readInstalledPluginCatalog, readInstalledPluginCatalogEntry, type PluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import {
  projectPluginCatalogEntrySnapshot,
  type PluginCatalogEntryIntrospectionSnapshot,
} from '@/plugins/projection/introspection/catalogSnapshot';
import { readPluginDiagnosticDisplayMessage } from '@/plugins/projection/introspection/project';
import {
  COMMUNITY_NPM_MARKETPLACE_SOURCE,
  createMarketplaceIndexService,
  type MarketplaceIndexSourceConfig,
} from '@/plugins/store/marketplace/service';
import { createMarketplaceSourceRegistryStore } from '@/plugins/store/marketplace/sources/store';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createNpmRegistryProfileService } from '@/plugins/distribution/npm/profiles/service';
import { createNpmRegistryProfileProbe } from '@/plugins/distribution/npm/profiles/probe';
import { resolveArchiveExpectedIntegrity } from '@/plugins/distribution/archive/integrity';
import { isInteractiveTerminal, promptSecretInput } from '@/terminal/prompts/promptInput';
import { delay } from '@/utils/time';
import { handlePluginsRegistryCommand, type PluginsRegistryCommandDeps } from './pluginsRegistry';
import {
  handlePluginsSettingsCommand,
  type PluginsSettingsCommandDeps,
} from './pluginsSettings';
import { readDaemonPluginCatalog } from '@/daemon/controlClient';
import type { PluginInvocationLogQuery } from '@/ui/logger';
import {
  readPluginInvocationLogsOnMachine,
  resolvePluginInvocationLogTarget,
  type MachinePluginInvocationLogReadResult,
  type PluginInvocationLogMachineTarget,
  type PluginInvocationLogTargetResolution,
} from './pluginInvocationLogsMachine';
import { packLocalPlugin } from '@/plugins/packaging/pack';
import { scaffoldLocalPlugin } from '@/plugins/scaffold/scaffold';
import {
  isPluginAuthorRootMaterialized,
  normalizePluginSdkRegistryOrigin,
  runPluginAuthorToolchain,
  type PluginAuthorToolchainOperation,
} from '@/plugins/authoring/toolchain';
import {
  describePluginAuthoringStageReport,
  pluginAuthoringStageFailure,
  pluginAuthoringStageReached,
  projectPluginAuthoringAdmission,
  type PluginAuthoringStageReport,
} from '@/plugins/authoring/lifecycleStage';
import { formatPluginDiagnosticSourceLocation } from '@/plugins/validation/diagnostics/sourceLocation';
import { runPluginDevelopmentCycle } from '@/plugins/authoring/developmentCycle';
import {
  runPackedPluginTest as runPackedPluginTestOwner,
  type PackedPluginTestDiagnostic,
  type PackedPluginTestResult,
} from '@/plugins/authoring/packedTest';
import {
  inspectPluginDevelopmentSource,
  startPluginDevelopmentSourceObserver,
  type PluginDevelopmentSourceRequest,
} from '@/plugins/authoring/sourceObserver';
import { runPluginAuthorDoctor } from '@/plugins/authoring/doctor';
import {
  diagnoseInstalledPluginGenerations,
  type InstalledPluginGenerationReport,
} from '@/plugins/store/registry/installedGenerationDiagnosis';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import {
  requestPluginDevelopmentChange,
  type DevelopmentChangeResult,
} from '@/plugins/daemon/developmentClient';
import {
  decideUserPluginChange,
  requestUserPluginChange,
  readUserPluginChangeStatus,
  resolvePluginChangeRequestClientPaths,
  resolveUserPluginChangeApproval,
  type UserPluginChangeDecisionResult,
  type UserPluginChangeResult,
  type UserPluginChangeStatusResult,
} from '@/plugins/daemon/changeClient';
import type {
  PluginChangePendingReviewResult,
  PluginChangeRequest,
} from '@/plugins/daemon/changeContract';
import {
  PluginIdSchema,
  PluginScaffoldUiModeSchema,
  type MarketplaceIndexItemV1,
  type MarketplaceSourceRegistryV1,
  type MarketplaceSourceV1,
  type PluginScaffoldUiMode,
} from '@happier-dev/protocol';
import {
  marketplaceInstallUnavailableReason,
  queryAllMarketplaceSourceItems,
  requestExactMarketplaceInstall,
} from '@/plugins/store/marketplace/exactInstall';

function projectMarketplaceIndexItemForCliOutput(
  item: MarketplaceIndexItemV1,
): Omit<MarketplaceIndexItemV1, 'manifestDigest'> {
  const { manifestDigest: _manifestDigest, ...projected } = item;
  return projected;
}

type PluginsCommandDeps = Readonly<{
  isInteractiveTerminal?: () => boolean;
  registry?: Omit<PluginsRegistryCommandDeps, 'write'>;
  runPluginAuthorToolchain?: typeof runPluginAuthorToolchain;
  runPackedPluginTest?: (params: Readonly<{
    projectRoot: string;
    sdkRegistryOrigin?: string | null;
    prerequisiteLocators?: readonly string[];
  }>) => Promise<PackedPluginTestResult>;
  runPluginAuthorDoctor?: typeof runPluginAuthorDoctor;
  diagnoseInstalledPluginGenerations?: typeof diagnoseInstalledPluginGenerations;
  inspectPluginDevelopmentSource?: typeof inspectPluginDevelopmentSource;
  startPluginDevelopmentSourceObserver?: typeof startPluginDevelopmentSourceObserver;
  requestDevelopmentChange?: (
    request: PluginDevelopmentSourceRequest,
    options?: Readonly<{
      signal?: AbortSignal;
      approval?: 'prompt' | 'none';
    }>,
  ) => Promise<DevelopmentChangeResult>;
  readPluginChangeStatus?: typeof readUserPluginChangeStatus;
  resolvePluginInvocationLogTarget?: (params: Readonly<{
    requestedMachineId?: string;
    signal?: AbortSignal;
  }>) => Promise<PluginInvocationLogTargetResolution>;
  readPluginInvocationLogsOnMachine?: (params: Readonly<{
    target: PluginInvocationLogMachineTarget;
    request: PluginInvocationLogQuery;
    signal?: AbortSignal;
  }>) => Promise<MachinePluginInvocationLogReadResult>;
  executeSettingsAdministrationAction?: PluginsSettingsCommandDeps['executeSettingsAdministrationAction'];
  marketplaceIndexService?: Pick<ReturnType<typeof createMarketplaceIndexService>, 'querySources'>;
}>;

type PluginsCommandRuntime = Readonly<{
  signal?: AbortSignal;
}>;

const defaultPluginsCommandDeps: PluginsCommandDeps = {
  isInteractiveTerminal,
  requestDevelopmentChange: async (request, options) => await requestPluginDevelopmentChange(request, {}, options),
  runPackedPluginTest: runPackedPluginTestOwner,
};

function usage(): string {
  return renderHelpPage({
    title: 'happier plugins',
    subtitle: 'Plugin discovery, local authoring, and machine-local installs',
    usage: [
      { label: 'happier plugins list [--json]', description: 'List installed plugins and their descriptors' },
      { label: 'happier plugins show <pluginId> [--json]', description: 'Show one installed plugin in detail' },
      { label: 'happier plugins actions <pluginId> [--json]', description: 'List invocable actions and tools declared by one installed plugin' },
      { label: 'happier plugins install <path|archive|package> [--kind path|archive|npm] [--selector <version>] [--integrity <sha256-SRI>] [--dev --trust] [--dry-run] [--json]', description: 'Review, trust, and install through the active daemon' },
      { label: 'happier plugins rollback <pluginId> [--json]', description: 'Restore the retained prior plugin version through the active daemon' },
      { label: 'happier plugins enable|disable <pluginId> [--json]', description: 'Change plugin admission through the active daemon' },
      { label: 'happier plugins uninstall <pluginId> [--delete-data --yes] [--json]', description: 'Remove a local installed plugin; preserve its data unless --delete-data --yes is supplied' },
      { label: 'happier plugins create <name> [--id <plugin.id>] [--name <display name>] [--ui hostedWeb|reactNative] [--json]', description: 'Create a minimal TypeScript plugin, optionally with a wired UI surface, ready for the normal development loop' },
      { label: 'happier plugins dev [path] [--sdk-registry <origin>] [--json]', description: 'Watch a source plugin and submit captured edit batches to the daemon-owned development cycle' },
      { label: 'happier plugins dev install <path> [--sdk-registry <origin>] [--json]', description: 'Repair or refresh a stale or wiped author root; the watch loop already materializes it' },
      { label: 'happier plugins dev typecheck|build|test <path> [--json]', description: 'Run one managed focused development check' },
      { label: 'happier plugins test [path] [--packed] [--with-plugin <root-or-archive>]… [--sdk-registry <origin>] [--json]', description: 'Run unit tests or pack, install, and exercise the plugin through a disposable daemon' },
      { label: 'happier plugins pack <path> [--out <archive.tgz>] [--sdk-registry <origin>] [--json]', description: 'Validate and package a local plugin into an installable archive' },
      { label: 'happier plugins doctor [path] [--json]', description: 'Evaluate and diagnose a code-defined plugin author module' },
      { label: 'happier plugins doctor --installed [<pluginId>] [--json]', description: 'Inspect installed immutable plugin generations for missing, escaped, non-regular, drifted, or unloadable files' },
      { label: 'happier plugins reload [developmentPluginId] [--json]', description: 'Reapply the development source registered for this directory, or one explicit plugin id' },
      { label: 'happier plugins change status|approve|reject <pendingChangeId> [--json]', description: 'Rejoin or explicitly decide a daemon-lifetime pending plugin change by its issued id' },
      { label: 'happier plugins logs <pluginId> [--machine <id>] [--generation <id>] [--correlation <id>] [--cursor <byteOffset>] [--limit <1-500>] [--follow] [--json]', description: 'Read canonical structured logs from one exact current daemon' },
      { label: 'happier plugins settings list <pluginId> --scope <account|daemon> [--machine <id>] [--json]', description: 'List declared Plugin Settings from one exact Account or daemon scope' },
      { label: 'happier plugins settings secret status|bind|unbind|delete <pluginId> <localId> [--scope <account|daemon>] [--machine <id>]', description: 'Read or mutate declared Plugin secret custody without accepting raw secret material; daemon custody requires one exact machine' },
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

type PluginInstallSourceKind = 'path' | 'archive' | 'npm';

function parseInstallFlags(args: readonly string[]): Readonly<{
  dryRun: boolean;
  sourceKind: PluginInstallSourceKind | null;
  selector: string | null;
  integrity: string | null;
  dev: boolean;
  trust: boolean;
  sdkRegistryOrigin: string | null;
}> {
  const rawKind = readFlagValue(args, '--kind');
  if (rawKind !== null && rawKind !== 'path' && rawKind !== 'archive' && rawKind !== 'npm') {
    throw new Error(`Unknown plugin source kind: ${rawKind}`);
  }
  return {
    dryRun: args.includes('--dry-run'),
    sourceKind: rawKind,
    selector: readFlagValue(args, '--selector'),
    integrity: readFlagValue(args, '--integrity'),
    dev: args.includes('--dev'),
    trust: args.includes('--trust'),
    sdkRegistryOrigin: normalizePluginSdkRegistryOrigin(readFlagValue(args, '--sdk-registry')),
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

function readMarketplaceSourceReference(args: readonly string[], startIndex: number): string | null {
  const positional = readCommandPositionals(args, { startIndex });
  return positional[0] ?? null;
}

function readMarketplaceSelection(args: readonly string[], startIndex: number): Readonly<{
  sourceRef: string | null;
  pluginId: string | null;
}> {
  const positional = readCommandPositionals(args, { startIndex });
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
  const positional = readCommandPositionals(args, {
    startIndex: 3,
    valueFlags: ['--title', '--description', '--origin', '--registry-profile'],
  });
  const origin = readFlagValue(args, '--origin');
  const registryProfileId = readFlagValue(args, '--registry-profile');
  if (origin !== null && origin !== 'user') {
    throw new Error(`Unknown marketplace source origin: ${origin}`);
  }
  if (registryProfileId !== null && args.includes('--no-registry-profile')) {
    throw new Error('Choose either --registry-profile or --no-registry-profile');
  }
  return {
    sourceUrl: positional[0] ?? null,
    title: readFlagValue(args, '--title'),
    description: readFlagValue(args, '--description'),
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

function formatMarketplaceContributionSummary(entry: Pick<MarketplaceIndexItemV1, 'summary'>): string {
  return entry.summary.contributions.length > 0
    ? entry.summary.contributions.join(', ')
    : 'none';
}

function readContributionIdentityDisplayValue(
  contribution: PluginCatalogEntryIntrospectionSnapshot['contributions']['contributions'][number]['contribution'],
): string {
  if (contribution.kind === 'localId') return contribution.localId;
  if (contribution.kind === 'locale') return contribution.locale;
  return contribution.domainId;
}

function formatInstalledContributionSummary(entry: PluginCatalogEntryIntrospectionSnapshot): string {
  const counts = new Map<string, number>();
  for (const contribution of entry.contributions.contributions) {
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

function printHumanList(entries: readonly PluginCatalogEntryIntrospectionSnapshot[]): void {
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
      out.line(`  ${fail('Diagnostics:')} ${entry.diagnostics.map(readPluginDiagnosticDisplayMessage).join('; ')}`);
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

function printHumanShow(entry: PluginCatalogEntryIntrospectionSnapshot): void {
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
  for (const contribution of entry.contributions.contributions) {
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
      out.line(`${fail('•')} ${readPluginDiagnosticDisplayMessage(diagnostic)}`);
    }
  }
  console.log(out.render());
}

function printHumanMarketplaceList(params: Readonly<{
  title: string;
  sourceUrl: string;
  entries: readonly MarketplaceIndexItemV1[];
  diagnostics: readonly { message: string }[];
}>): void {
  const out = createOutputBuilder();
  out.line(sectionTitle(params.title));
  out.line(`${dim('Source:')} ${params.sourceUrl}`);
  if (params.entries.length === 0) {
    out.line(neutral('(no marketplace entries)'));
  }
  for (const entry of params.entries) {
    const installable = marketplaceInstallUnavailableReason(entry) === null ? ok('installable') : neutral('descriptor-only');
    out.line(`${entry.display.title} ${dim(entry.pluginId)} ${dim(`(${entry.source.kind})`)} ${installable}`);
    out.line(`  ${dim('Version:')} ${entry.distribution.version}`);
    out.line(`  ${dim('Contributions:')} ${formatMarketplaceContributionSummary(entry)}`);
  }
  for (const diagnostic of params.diagnostics) {
    out.line(`${fail('Diagnostics:')} ${diagnostic.message}`);
  }
  console.log(out.render());
}

function printHumanMarketplaceShow(params: Readonly<{
  title: string;
  sourceUrl: string;
  entry: MarketplaceIndexItemV1;
  diagnostics: readonly { message: string }[];
}>): void {
  const out = createOutputBuilder();
  out.line(sectionTitle(params.entry.display.title));
  out.line(`${dim('Marketplace:')} ${params.title}`);
  out.line(`${dim('Source:')} ${params.sourceUrl}`);
  out.line(`${dim('Plugin ID:')} ${params.entry.pluginId}`);
  out.line(`${dim('Version:')} ${params.entry.distribution.version}`);
  out.line(`${dim('Installable:')} ${marketplaceInstallUnavailableReason(params.entry) === null ? 'yes' : 'no'}`);
  out.line(`${dim('Entry Source:')} ${params.entry.source.kind} ${params.entry.source.sourceUrl}`);
  out.line(`${dim('Contributions:')} ${formatMarketplaceContributionSummary(params.entry)}`);
  for (const diagnostic of params.diagnostics) {
    out.line(`${fail('•')} ${diagnostic.message}`);
  }
  console.log(out.render());
}

async function runPluginsListCommand(args: readonly string[]): Promise<void> {
  const catalog = await readDaemonPluginCatalog();
  if (catalog.kind === 'unavailable') {
    await printPluginCatalogUnavailable(args, 'plugins_list', catalog.code);
    return;
  }
  const entries = catalog.plugins;
  const json = wantsJson(args);
  if (json) {
    await printJsonEnvelope({
      ok: true,
      kind: 'plugins_list',
      data: {
        plugins: entries.map((entry) => projectPluginCatalogEntrySnapshot(entry)),
      },
    });
    return;
  }

  printHumanList(entries.map((entry) => projectPluginCatalogEntrySnapshot(entry)));
}

async function runPluginsShowCommand(args: readonly string[]): Promise<void> {
  const pluginId = String(args[1] ?? '').trim();
  if (!pluginId || pluginId === 'help' || pluginId === '--help' || pluginId === '-h') {
    console.log(usage());
    return;
  }

  const catalog = await readDaemonPluginCatalog();
  if (catalog.kind === 'unavailable') {
    await printPluginCatalogUnavailable(args, 'plugins_show', catalog.code);
    return;
  }
  const entries = catalog.plugins;
  const entry = entries.find((candidate) => candidate.pluginId === pluginId);
  if (!entry) {
    throw new Error(`Unknown plugin id: ${pluginId}`);
  }

  if (wantsJson(args)) {
    await printJsonEnvelope({
      ok: true,
      kind: 'plugins_show',
      data: {
        plugin: projectPluginCatalogEntrySnapshot(entry),
      },
    });
    return;
  }

  printHumanShow(projectPluginCatalogEntrySnapshot(entry));
}

async function printPluginCatalogUnavailable(
  args: readonly string[],
  kind: 'plugins_list' | 'plugins_show',
  code: string,
): Promise<void> {
  const message = `The active daemon plugin catalog is unavailable (${code})`;
  if (wantsJson(args)) {
    await printJsonEnvelope({
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
      await printJsonEnvelope({
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
    await printJsonEnvelope({
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
    case 'sourceRootReviewRequired':
      return {
        code: 'source_root_review_required',
        message: `Source-root review is required for ${result.review.source.locator}.`,
        details: { pendingChangeId: result.pendingChangeId, review: result.review },
      };
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
    case 'dataRemovalPartial':
      return {
        code: 'plugin_data_removal_partial',
        message: 'Plugin data removal stopped after a partial daemon-owned change. Retrying the same confirmed command is safe.',
        details: {
          pluginId: result.pluginId,
          causeCode: result.causeCode,
          completed: result.completed,
          pending: result.pending,
        },
      };
  }
}

function pluginChangeReviewRejoinCommands(pendingChangeId: string): readonly string[] {
  return [
    `Review status: happier plugins change status ${pendingChangeId}`,
    `Approve after review: happier plugins change approve ${pendingChangeId}`,
    `Reject: happier plugins change reject ${pendingChangeId}`,
  ];
}

function describePendingPluginReviewForTerminal(
  pendingReview: PluginChangePendingReviewResult,
): readonly string[] {
  return [
    pendingReview.kind === 'sourceRootReviewRequired'
      ? `Source-root review remains pending for ${pendingReview.review.source.locator}.`
      : `Install and trust review remains pending for ${pendingReview.review.displayName}.`,
    ...pluginChangeReviewRejoinCommands(pendingReview.pendingChangeId),
  ];
}

async function reportPluginChangeFailure(
  args: readonly string[],
  outputKind: string,
  result: Exclude<UserPluginChangeResult, { kind: 'committed' }>,
): Promise<void> {
  const failure = describePluginChangeFailure(result);
  if (wantsJson(args)) {
    await printJsonEnvelope({
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
  const pendingChangeId = result.kind === 'sourceRootReviewRequired' || result.kind === 'reviewRequired'
    ? result.pendingChangeId
    : null;
  console.error(errorFrame('Error:', [
    failure.message,
    ...(pendingChangeId === null
      ? []
      : pluginChangeReviewRejoinCommands(pendingChangeId)),
  ]));
  process.exitCode = 1;
}

async function printPluginChangeStatus(
  args: readonly string[],
  pendingChangeId: string,
  status: UserPluginChangeStatusResult,
): Promise<void> {
  if (status.kind === 'daemonUnavailable') {
    const message = 'The daemon plugin-change service is unavailable; a restarted daemon may no longer retain this pending change.';
    if (wantsJson(args)) {
      await printJsonEnvelope({
        ok: false,
        kind: 'plugins_change_status',
        error: { code: 'daemon_unavailable', message },
      }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Error:', [message]));
    process.exitCode = 1;
    return;
  }
  if (wantsJson(args)) {
    await printJsonEnvelope({
      ok: true,
      kind: 'plugins_change_status',
      data: status,
    });
    return;
  }

  const out = createOutputBuilder();
  if (status.kind === 'sourceRootReviewRequired') {
    out.line(neutral(`Source-root review remains pending for ${status.review.source.locator}.`));
  } else if (status.kind === 'reviewRequired') {
    out.line(neutral(`Install and trust review remains pending for ${status.review.displayName}.`));
  } else if (status.kind === 'applying') {
    out.line(neutral(`Plugin change ${pendingChangeId} is still applying.`));
  } else if (status.kind === 'terminal') {
    out.line(status.result.kind === 'committed'
      ? ok(`Plugin change ${pendingChangeId} completed.`)
      : neutral(`Plugin change ${pendingChangeId} reached terminal state: ${status.result.kind}.`));
  } else {
    out.line(neutral(`Plugin change ${pendingChangeId} has expired.`));
  }
  console.log(out.render());
}

async function printPluginChangeDecisionResult(
  args: readonly string[],
  pendingChangeId: string,
  decision: 'approve' | 'reject',
  result: UserPluginChangeDecisionResult,
): Promise<void> {
  if (result.kind === 'committed') {
    if (wantsJson(args)) {
      await printJsonEnvelope({
        ok: true,
        kind: 'plugins_change_decision',
        data: { outcome: 'applied', pendingChangeId, decision, result },
      });
      return;
    }
    console.log(ok(`Plugin change ${pendingChangeId} completed.`));
    return;
  }

  if (result.kind === 'cancelled') {
    const outcome = decision === 'reject' ? 'rejected' : 'cancelled';
    if (wantsJson(args)) {
      await printJsonEnvelope({
        ok: true,
        kind: 'plugins_change_decision',
        data: { outcome, pendingChangeId, decision, result },
      });
      return;
    }
    console.log(neutral(`Plugin change ${pendingChangeId} was ${outcome}.`));
    return;
  }

  if (result.kind === 'terminal') {
    await printPluginChangeDecisionResult(args, pendingChangeId, decision, result.result);
    return;
  }

  if (result.kind === 'sourceRootReviewRequired' || result.kind === 'reviewRequired') {
    const failure = describePluginChangeFailure(result);
    if (wantsJson(args)) {
      await printJsonEnvelope({
        ok: false,
        kind: 'plugins_change_decision',
        error: {
          code: failure.code,
          message: failure.message,
          outcome: 'reviewRequired',
          ...(failure.details ?? {}),
        },
      }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Review required:', [
      failure.message,
      ...pluginChangeReviewRejoinCommands(result.pendingChangeId),
    ]));
    process.exitCode = 1;
    return;
  }

  if (result.kind === 'applying') {
    const message = `Plugin change ${pendingChangeId} is still applying.`;
    if (wantsJson(args)) {
      await printJsonEnvelope({
        ok: false,
        kind: 'plugins_change_decision',
        error: { code: 'applying', message, outcome: 'applying', pendingChangeId },
      }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Pending:', [message, `Review status: happier plugins change status ${pendingChangeId}`]));
    process.exitCode = 1;
    return;
  }

  if (result.kind === 'daemonUnavailable') {
    const message = 'The daemon plugin-change service is unavailable; a restarted daemon may no longer retain this pending change.';
    if (wantsJson(args)) {
      await printJsonEnvelope({
        ok: false,
        kind: 'plugins_change_decision',
        error: { code: 'daemon_unavailable', message, outcome: 'failed', pendingChangeId },
      }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Error:', [message]));
    process.exitCode = 1;
    return;
  }

  await reportPluginChangeFailure(args, 'plugins_change_decision', result);
}

/**
 * One unknown-nested-operation owner for every `plugins` dispatch level. A
 * missing or help operation is a help request and stays successful; an operation
 * the author actually typed and this surface does not implement is a structured
 * failure in both the JSON and human envelopes.
 */
async function reportUnknownPluginsSubcommand(
  args: readonly string[],
  kind: string,
  message: string,
): Promise<void> {
  if (wantsJson(args)) {
    await printJsonEnvelope({ ok: false, kind, error: { code: 'unknown_subcommand' } }, { exitCode: 1 });
    return;
  }
  console.error(errorFrame('Error:', [message]));
  console.log(usage());
  process.exitCode = 1;
}

async function runPluginsChangeCommand(
  args: readonly string[],
  deps: PluginsCommandDeps,
  runtime: PluginsCommandRuntime,
): Promise<void> {
  const changeSubcommand = String(args[1] ?? '').trim();
  if (!changeSubcommand || changeSubcommand === 'help' || changeSubcommand === '--help' || changeSubcommand === '-h') {
    console.log(usage());
    return;
  }
  if (changeSubcommand !== 'status' && changeSubcommand !== 'approve' && changeSubcommand !== 'reject') {
    await reportUnknownPluginsSubcommand(
      args,
      `plugins_change_${changeSubcommand}`,
      `Unknown plugins change subcommand: ${changeSubcommand}`,
    );
    return;
  }
  const pendingChangeId = readCommandPositionals(args, { startIndex: 2 })[0] ?? null;
  if (!pendingChangeId || pendingChangeId === 'help' || pendingChangeId === '--help' || pendingChangeId === '-h') {
    console.log(usage());
    return;
  }
  if (changeSubcommand === 'status') {
    const status = await (deps.readPluginChangeStatus ?? readUserPluginChangeStatus)({
      pendingChangeId,
      ...(runtime.signal ? { signal: runtime.signal } : {}),
    });
    await printPluginChangeStatus(args, pendingChangeId, status);
    return;
  }

  const result = await decideUserPluginChange({
    pendingChangeId,
    decision: changeSubcommand,
    ...(runtime.signal ? { signal: runtime.signal } : {}),
  });
  await printPluginChangeDecisionResult(args, pendingChangeId, changeSubcommand, result);
}

function readPluginLogsRequest(args: readonly string[]): Readonly<{
  pluginId: string;
  machineId?: string;
  generation?: string;
  correlationId?: string;
  cursor?: number;
  limit?: number;
}> | null {
  const pluginId = readCommandPositionals(args, {
    startIndex: 1,
    valueFlags: ['--machine', '--generation', '--correlation', '--cursor', '--limit'],
  })[0] ?? null;
  if (!pluginId || pluginId === 'help' || pluginId === '--help' || pluginId === '-h') return null;

  const readOptionalFlag = (flag: '--generation' | '--correlation'): string | undefined => {
    if (!hasFlagValue(args, flag)) return undefined;
    const value = readFlagValue(args, flag);
    if (!value) throw new Error(`${flag} requires a value`);
    return value;
  };
  const readBoundedIntegerFlag = (
    flag: '--cursor' | '--limit',
    minimum: number,
    maximum: number,
  ): number | undefined => {
    const inlineValues = args
      .filter((argument) => argument.startsWith(`${flag}=`))
      .map((argument) => argument.slice(flag.length + 1).trim());
    const separateCount = args.filter((argument) => argument === flag).length;
    if (inlineValues.length + separateCount > 1) {
      throw new Error(`${flag} may be specified only once`);
    }
    if (inlineValues.length + separateCount === 0) return undefined;
    const raw = inlineValues.length > 0
      ? inlineValues[0] ?? ''
      : readFlagValue(args, flag) ?? '';
    if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
      throw new Error(`${flag} must be an integer between ${minimum} and ${maximum}`);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${flag} must be an integer between ${minimum} and ${maximum}`);
    }
    return value;
  };
  const inlineMachineValues = args
    .filter((argument) => argument.startsWith('--machine='))
    .map((argument) => argument.slice('--machine='.length).trim());
  const separateMachineCount = args.filter((argument) => argument === '--machine').length;
  if (inlineMachineValues.length + separateMachineCount > 1) {
    throw new Error('--machine may be specified only once');
  }
  const machineId = inlineMachineValues.length > 0
    ? inlineMachineValues[0] ?? null
    : separateMachineCount === 1
      ? readFlagValue(args, '--machine')
      : null;
  if ((inlineMachineValues.length > 0 || separateMachineCount === 1) && !machineId) {
    throw new Error('--machine requires a value');
  }
  const generation = readOptionalFlag('--generation');
  const correlationId = readOptionalFlag('--correlation');
  const cursor = readBoundedIntegerFlag('--cursor', 0, Number.MAX_SAFE_INTEGER);
  const limit = readBoundedIntegerFlag('--limit', 1, 500);
  return {
    pluginId,
    ...(machineId ? { machineId } : {}),
    ...(generation ? { generation } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

async function printPluginLogsFailure(
  args: readonly string[],
  code: string,
  message: string,
  candidates?: readonly PluginInvocationLogMachineTarget[],
): Promise<void> {
  if (wantsJson(args)) {
    await printJsonEnvelope({
      ok: false,
      kind: 'plugins_logs',
      error: {
        code,
        message,
        ...(candidates ? { candidates } : {}),
      },
    }, { exitCode: 1 });
    return;
  }
  console.error(errorFrame('Error:', [
    message,
    ...(candidates?.map((candidate) => `${candidate.machineLabel} (${candidate.machineId}) on ${candidate.serverLabel}`) ?? []),
  ]));
  process.exitCode = 1;
}

function printPluginLogsTarget(target: PluginInvocationLogMachineTarget): void {
  console.log(neutral(`Server: ${target.serverLabel} (${target.serverIdentityId})`));
  console.log(neutral(`Machine: ${target.machineLabel} (${target.machineId})`));
}

async function printPluginLogsResult(
  args: readonly string[],
  target: PluginInvocationLogMachineTarget,
  result: MachinePluginInvocationLogReadResult,
): Promise<void> {
  if (result.kind === 'unavailable') {
    await printPluginLogsFailure(args, result.code, 'The selected daemon could not provide plugin logs.');
    return;
  }
  if (wantsJson(args)) {
    await printJsonEnvelope({ ok: true, kind: 'plugins_logs', data: { target, ...result } });
    return;
  }
  if (result.records.length === 0) {
    console.log(neutral('No matching plugin logs.'));
    return;
  }
  for (const record of result.records) {
    await writeJsonStdout(record);
  }
}

async function waitForPluginLogsPoll(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  if (!signal) {
    await delay(250);
    return true;
  }
  await new Promise<void>((resolve) => {
    const complete = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', complete);
      resolve();
    };
    const timer = setTimeout(complete, 250);
    signal.addEventListener('abort', complete, { once: true });
  });
  return !signal.aborted;
}

async function runPluginsLogsCommand(
  args: readonly string[],
  deps: PluginsCommandDeps,
  runtime: PluginsCommandRuntime,
): Promise<void> {
  const request = readPluginLogsRequest(args);
  if (!request) {
    console.log(usage());
    return;
  }
  if (runtime.signal?.aborted) return;
  const targetResolution = await (deps.resolvePluginInvocationLogTarget ?? resolvePluginInvocationLogTarget)({
    ...(request.machineId ? { requestedMachineId: request.machineId } : {}),
    ...(runtime.signal ? { signal: runtime.signal } : {}),
  });
  if (runtime.signal?.aborted) return;
  if (targetResolution.kind === 'selection_required') {
    await printPluginLogsFailure(
      args,
      'machine_selection_required',
      'Select one current machine with --machine <id> before reading plugin logs.',
      targetResolution.candidates,
    );
    return;
  }
  if (targetResolution.kind === 'unavailable') {
    await printPluginLogsFailure(args, targetResolution.code, targetResolution.message);
    return;
  }
  const target = targetResolution.target;
  const readLogs = deps.readPluginInvocationLogsOnMachine ?? readPluginInvocationLogsOnMachine;
  const { machineId: _machineId, cursor: requestedCursor, ...query } = request;
  if (!wantsJson(args)) printPluginLogsTarget(target);
  const follow = args.includes('--follow');
  let cursor = requestedCursor;
  let previousEmptyFollowPage: Readonly<{ cursor: number; hasMore: boolean }> | null = null;
  for (;;) {
    const result = await readLogs({
      target,
      request: {
        ...query,
        ...(cursor === undefined ? {} : { cursor }),
      },
      ...(runtime.signal ? { signal: runtime.signal } : {}),
    });
    const unchangedEmptyFollowPage = follow
      && result.kind === 'available'
      && result.records.length === 0
      && previousEmptyFollowPage !== null
      && previousEmptyFollowPage.cursor === result.cursor
      && previousEmptyFollowPage.hasMore === result.hasMore;
    if (!unchangedEmptyFollowPage) await printPluginLogsResult(args, target, result);
    previousEmptyFollowPage = result.kind === 'available' && result.records.length === 0
      ? { cursor: result.cursor, hasMore: result.hasMore }
      : null;
    if (result.kind === 'available' && result.hasMore && !follow && !wantsJson(args)) {
      console.log(neutral(`More log data is available. Continue with --cursor ${result.cursor}.`));
    }
    if (result.kind === 'unavailable' || !follow || runtime.signal?.aborted) return;

    const madeProgress = cursor !== result.cursor;
    cursor = result.cursor;
    if (result.hasMore && madeProgress) continue;
    if (!await waitForPluginLogsPoll(runtime.signal)) return;
  }
}

async function runPluginsInstallCommand(args: readonly string[], deps: PluginsCommandDeps): Promise<void> {
  const locator = String(args[1] ?? '').trim();
  if (!locator || locator === 'help' || locator === '--help' || locator === '-h') {
    console.log(usage());
    return;
  }

  const flags = parseInstallFlags(args.slice(2));
  // Preview the exact request the daemon will receive, including the
  // client-resolved source path.
  const request = resolvePluginChangeRequestClientPaths(
    await createPluginInstallRequest(locator, flags),
  );
  if (flags.dryRun) {
    if (wantsJson(args)) {
      await printJsonEnvelope({ ok: true, kind: 'plugins_install', data: { dryRun: true, request } });
      return;
    }
    console.log(`Dry run: would request ${request.kind} for ${locator}.`);
    return;
  }
  const approval = resolveUserPluginChangeApproval({
    interactive: (deps.isInteractiveTerminal ?? isInteractiveTerminal)(),
    json: wantsJson(args),
    explicitTrust: flags.trust,
  });
  const result = await requestUserPluginChange({ request, approval });

  if (result.kind !== 'committed') {
    await reportPluginChangeFailure(args, 'plugins_install', result);
    return;
  }
  const catalog = await readDaemonPluginCatalog();
  const entry = catalog.kind === 'available'
    ? catalog.plugins.find((candidate) => candidate.pluginId === result.pluginId) ?? null
    : null;

  if (wantsJson(args)) {
    await printJsonEnvelope({
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
    out.line(`  ${dim('Contributions:')} ${formatInstalledContributionSummary(projectPluginCatalogEntrySnapshot(entry))}`);
  }
  if (result.pendingSurfaces.length > 0) {
    out.line(neutral(`  Pending reconciliation: ${result.pendingSurfaces.join(', ')}`));
  }
  console.log(out.render());
}

function summarizePluginForCommand(entry: PluginCatalogEntry) {
  return projectPluginCatalogEntrySnapshot(entry);
}

async function runPluginsDestructiveUninstallCommand(
  args: readonly string[],
  rawPluginId: string,
): Promise<void> {
  if (!args.includes('--yes') && !args.includes('-y')) {
    const error = {
      code: 'confirmation_required',
      message: 'Destructive plugin data removal requires explicit --yes confirmation. The plugin remains installed and no data was changed.',
    };
    if (wantsJson(args)) {
      await printJsonEnvelope({ ok: false, kind: 'plugins_uninstall', error }, { exitCode: 1 });
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
      await printJsonEnvelope({ ok: false, kind: 'plugins_uninstall', error }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Error:', [error.message]));
    process.exitCode = 1;
    return;
  }
  const pluginId = parsedPluginId.data;
  const entry = await readInstalledPluginCatalogEntry({ pluginId });
  const result = await requestUserPluginChange({
    request: {
      kind: 'uninstallAndDeleteData',
      pluginId,
      actorEvidence: {
        kind: 'authenticatedLocalUser',
        interactionId: randomUUID(),
        occurredAtMs: Date.now(),
      },
    },
    approval: 'none',
  });
  if (result.kind !== 'committed') {
    await reportPluginChangeFailure(args, 'plugins_uninstall', result);
    return;
  }
  if (!result.dataRemoval) {
    const error = {
      code: 'plugin_data_removal_result_invalid',
      message: 'The daemon did not return a destructive data-removal result. Inspect installed state before retrying.',
    };
    if (wantsJson(args)) {
      await printJsonEnvelope({ ok: false, kind: 'plugins_uninstall', error }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Error:', [error.message]));
    process.exitCode = 1;
    return;
  }

  const data = {
    pluginId,
    alreadyUninstalled: result.dataRemoval.alreadyUninstalled,
    ...(entry ? { plugin: summarizePluginForCommand(entry) } : {}),
    removedData: {
      daemonStorage: result.dataRemoval.removedData.daemonStorage,
      secrets: result.dataRemoval.removedData.secrets,
    },
  };
  if (wantsJson(args)) {
    await printJsonEnvelope({ ok: true, kind: 'plugins_uninstall', data });
    return;
  }
  const out = createOutputBuilder();
  out.line(ok(`Removed plugin data for ${pluginId}.`));
  out.line(`  ${dim('Uninstall:')} ${result.dataRemoval.alreadyUninstalled ? 'already absent' : 'completed'}`);
  out.line(`  ${dim('Data:')} daemon-local and encrypted plugin-secret namespaces processed`);
  console.log(out.render());
}

async function runPluginsUninstallCommand(args: readonly string[]): Promise<void> {
  const pluginId = String(args[1] ?? '').trim();
  if (!pluginId || pluginId === 'help' || pluginId === '--help' || pluginId === '-h') {
    console.log(usage());
    return;
  }

  if (args.includes('--delete-data')) {
    await runPluginsDestructiveUninstallCommand(args, pluginId);
    return;
  }

  const entry = await readInstalledPluginCatalogEntry({ pluginId });
  const result = await requestUserPluginChange({
    request: { kind: 'uninstall', pluginId },
    approval: 'none',
  });
  if (result.kind !== 'committed') {
    await reportPluginChangeFailure(args, 'plugins_uninstall', result);
    return;
  }

  if (wantsJson(args)) {
    await printJsonEnvelope({
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
    await reportPluginChangeFailure(args, outputKind, result);
    return;
  }
  if (wantsJson(args)) {
    await printJsonEnvelope({
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
    await reportPluginChangeFailure(args, 'plugins_rollback', result);
    return;
  }

  if (wantsJson(args)) {
    await printJsonEnvelope({
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

export function formatPluginCreateNextCommands(
  targetDir: string,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  if (platform === 'win32') {
    const args = ['happier', 'plugins', 'dev', targetDir];
    return [
      `PowerShell: ${buildPowerShellCommand(args)}`,
      `cmd.exe: ${buildWindowsCmdCommand(args)}`,
    ];
  }
  return [`cd ${buildPosixShellCommand([targetDir])} && happier plugins dev`];
}

async function runPluginsCreateCommand(args: readonly string[]): Promise<void> {
  // The public SDK build packet owns the exact SDK/UI/toolchain bindings for a
  // generated package. Accepting a caller-selected SDK version here would make
  // `plugins create`, the RPC entry point, and the package metadata disagree.
  // Reject the retired escape hatch rather than silently dropping it.
  if (hasFlagValue(args, '--sdk-version')) {
    const message = '--sdk-version is no longer supported; plugins create uses the published SDK toolchain compatibility packet.';
    if (wantsJson(args)) {
      await printJsonEnvelope({
        ok: false,
        kind: 'plugins_create',
        error: { code: 'invalid_option', message },
      }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Error:', [message]));
    process.exitCode = 1;
    return;
  }
  const targetDir = readCommandPositionals(args, {
    startIndex: 1,
    valueFlags: ['--id', '--name', '--ui'],
  })[0] ?? null;
  if (!targetDir || targetDir === 'help' || targetDir === '--help' || targetDir === '-h') {
    console.log(usage());
    return;
  }
  const { slug, displayName } = normalizePluginCreateName(targetDir);
  const uiValue = readFlagValue(args, '--ui');
  const ui = uiValue?.startsWith('--') ? null : uiValue;
  if (hasFlagValue(args, '--ui') && ui === null) {
    const message = `--ui requires one of: ${PluginScaffoldUiModeSchema.options.join(', ')}`;
    if (wantsJson(args)) {
      await printJsonEnvelope({
        ok: false,
        kind: 'plugins_create',
        error: { code: 'invalid_option', message },
      }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Error:', [message]));
    process.exitCode = 1;
    return;
  }
  const result = await scaffoldLocalPlugin({
    targetDir,
    pluginId: readFlagValue(args, '--id') ?? `local.${slug}`,
    displayName: readFlagValue(args, '--name') ?? displayName,
    ...(ui ? { ui: ui as PluginScaffoldUiMode } : {}),
  });

  if (!result.ok) {
    if (wantsJson(args)) {
      await printJsonEnvelope({
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
    await printJsonEnvelope({
      ok: true,
      kind: 'plugins_create',
      data: {
        plugin: { pluginId: result.pluginId, title: result.title, version: result.version },
        scaffold: {
          targetDir: result.targetDir,
          packageJsonPath: result.packageJsonPath,
          sourceEntryPath: result.sourceEntryPath,
          ...(result.uiEntryPath ? { uiEntryPath: result.uiEntryPath } : {}),
        },
      },
    });
    return;
  }

  const out = createOutputBuilder();
  out.line(ok(`Created ${result.title}.`));
  out.line(`  ${dim('Directory:')} ${result.targetDir}`);
  out.line(`  ${dim('Plugin ID:')} ${result.pluginId}`);
  out.line(`  ${dim('Source entry:')} ${result.sourceEntryPath}`);
  if (result.uiEntryPath) out.line(`  ${dim('UI entry:')} ${result.uiEntryPath}`);
  const nextCommands = formatPluginCreateNextCommands(result.targetDir);
  out.line(`  ${dim('Next:')} ${nextCommands[0]}`);
  for (const nextCommand of nextCommands.slice(1)) out.line(`        ${nextCommand}`);
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

function projectDaemonDevelopmentFailureStage(
  diagnostics: readonly Readonly<{ code: string; message: string }>[],
): PluginAuthoringStageReport['stage'] {
  if (diagnostics.some((diagnostic) => diagnostic.code === 'plugin_dev_ui_build_failed')) {
    return 'built';
  }
  if (diagnostics.some((diagnostic) => diagnostic.code === 'plugin_dev_dependency_preparation_failed')) {
    return 'source_validated';
  }
  return 'admitted';
}

async function runPluginsDevCommand(
  args: readonly string[],
  deps: PluginsCommandDeps,
  runtime: PluginsCommandRuntime,
): Promise<void> {
  const operation = String(args[1] ?? '').trim();
  if (isPluginAuthorOperation(operation)) {
    await runPluginsDevToolchainCommand(args, deps, operation);
    return;
  }
  const requestedPath = readCommandPositionals(args, {
    startIndex: 1,
    valueFlags: ['--sdk-registry'],
  })[0] ?? '.';
  if (requestedPath === 'help' || requestedPath === '--help' || requestedPath === '-h') {
    console.log(usage());
    return;
  }
  if (!deps.requestDevelopmentChange) {
    const message = 'Plugin development daemon integration is not available in this build.';
    if (wantsJson(args)) {
      await printJsonEnvelope({
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
    sdkRegistryOrigin = normalizePluginSdkRegistryOrigin(readFlagValue(args, '--sdk-registry'));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Plugin SDK registry is invalid.';
    if (wantsJson(args)) {
      await printJsonEnvelope({
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
    const stage = pluginAuthoringStageFailure({
      stage: 'source_validated',
      diagnostics: sourceInspection.diagnostics,
    });
    if (wantsJson(args)) {
      await printJsonEnvelope({
        ok: false,
        kind: 'plugins_dev',
        error: { code: 'plugin_dev_source_invalid', stage: stage.stage, diagnostics: stage.diagnostics },
      }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Plugin source diagnostics:', [
      ...sourceInspection.diagnostics.map((entry) => entry.message),
      ...describePluginAuthoringStageReport(stage),
    ]));
    process.exitCode = 1;
    return;
  }

  // Cold start prepares the author root exactly once, and only when nothing has
  // materialized it yet: the author edits this directory, so its editor and
  // compiler resolution must not depend on a separate command. A root whose
  // declared SDK already resolves is left alone rather than paying a full
  // install on every watch start — refreshing a stale one is
  // `plugins dev install` — and a literal one-file source has no package
  // root to prepare at all.
  if (
    sourceInspection.sourceKind === 'packageRoot'
    && !(await isPluginAuthorRootMaterialized(sourceInspection.sourceRootPath))
  ) {
    const dependencyPreparation = await (deps.runPluginAuthorToolchain ?? runPluginAuthorToolchain)({
      operation: 'install',
      projectRoot: sourceInspection.sourceRootPath,
      ...(sdkRegistryOrigin ? { sdkRegistryOrigin } : {}),
      ...(runtime.signal ? { signal: runtime.signal } : {}),
    });
    if (runtime.signal?.aborted) return;
    if (!dependencyPreparation.ok) {
      if (wantsJson(args)) {
        await printJsonEnvelope({
          ok: false,
          kind: 'plugins_dev',
          error: {
            code: 'plugin_dev_dependency_install_failed',
            diagnostics: dependencyPreparation.diagnostics,
          },
        }, { exitCode: 1 });
        return;
      }
      console.error(errorFrame('Error:', dependencyPreparation.diagnostics.map((entry) => entry.message)));
      process.exitCode = 1;
      return;
    }
  }

  const observerProjectRoot = sourceInspection.request.projectRoot;

  // The last generation this session is KNOWN to have made current. It is the
  // only honest basis for a "previous generation retained" claim; before the
  // first admission the CLI simply does not know whether one exists.
  let lastProjectedGeneration: string | undefined;

  const reportDevChangeStage = async (
    stage: PluginAuthoringStageReport,
    context: Readonly<{
      projectRoot: string;
      observedFiles: number;
      cycle?: Readonly<{
        id: string;
        changedPathCount: number | null;
        dependencyInputChanged: boolean;
        dependencyInputChangeUnknown: boolean;
        durations: Readonly<{ submissionMs?: number }>;
      }>;
      pendingReview?: PluginChangePendingReviewResult;
    }>,
  ): Promise<void> => {
    if (wantsJson(args)) {
      if (!stage.ok) {
        await printJsonEnvelope({
          ok: false,
          kind: 'plugins_dev_change',
          error: {
            code: stage.diagnostics[0]?.code ?? 'plugin_dev_candidate_rejected',
            stage: stage.stage,
            diagnostics: stage.diagnostics,
            ...(stage.retainedGeneration ? { retainedGeneration: stage.retainedGeneration } : {}),
            ...(context.cycle ? { cycle: context.cycle } : {}),
            ...(context.pendingReview ? { pendingReview: context.pendingReview } : {}),
          },
        }, { exitCode: 0 });
        return;
      }
      await printJsonEnvelope({
        ok: true,
        kind: 'plugins_dev_change',
        data: {
          ...context,
          stage: stage.stage,
          ...(stage.generation ? { generation: stage.generation } : {}),
        },
      });
      return;
    }
    if (!stage.ok) {
      console.error(errorFrame(
        stage.stage === 'source_validated'
          ? 'Plugin source diagnostics:'
          : stage.stage === 'built'
            ? 'Plugin UI build diagnostics:'
            : 'Plugin candidate diagnostics:',
        [
          ...describePluginAuthoringStageReport(stage),
          ...(context.pendingReview ? describePendingPluginReviewForTerminal(context.pendingReview) : []),
        ],
      ));
      return;
    }
    const out = createOutputBuilder();
    out.line(ok(`Development candidate accepted from ${context.projectRoot}.`));
    for (const line of describePluginAuthoringStageReport(stage)) out.line(`  ${line}`);
    console.log(out.render());
  };

  let nextCycleNumber = 0;
  const developmentApproval = resolveUserPluginChangeApproval({
    interactive: (deps.isInteractiveTerminal ?? isInteractiveTerminal)(),
    json: wantsJson(args),
  });

  const observer = await (deps.startPluginDevelopmentSourceObserver ?? startPluginDevelopmentSourceObserver)({
    projectRoot: observerProjectRoot,
    ...(sdkRegistryOrigin ? { sdkRegistryOrigin } : {}),
    onObservation: async (observation) => {
      if (!observation.ok) {
        await reportDevChangeStage(
          pluginAuthoringStageFailure({
            stage: 'source_validated',
            diagnostics: observation.diagnostics,
            ...(lastProjectedGeneration ? { retainedGeneration: lastProjectedGeneration } : {}),
          }),
          { projectRoot: observerProjectRoot, observedFiles: 0 },
        );
        return 'retained';
      }

      const cycle = await runPluginDevelopmentCycle<DevelopmentChangeResult>({
        observation,
        submit: async (request, options) => await deps.requestDevelopmentChange!(request, {
          ...(options?.signal ? { signal: options.signal } : {}),
          ...(developmentApproval === 'none' ? { approval: developmentApproval } : {}),
        }),
        ...(runtime.signal ? { signal: runtime.signal } : {}),
      });
      if (cycle.kind === 'cancelled') return 'retained';

      const context = {
        projectRoot: observation.request.projectRoot,
        observedFiles: observation.observedRelativePaths.length,
        cycle: {
          id: `dev-${++nextCycleNumber}`,
          changedPathCount: cycle.changedPathCount,
          dependencyInputChanged: cycle.dependencyInputChanged,
          dependencyInputChangeUnknown: cycle.dependencyInputChangeUnknown,
          durations: cycle.durations,
        },
      };
      if (cycle.kind === 'submissionFailed') {
        await reportDevChangeStage(
          pluginAuthoringStageFailure({
            stage: 'admitted',
            diagnostics: cycle.diagnostics,
            ...(lastProjectedGeneration ? { retainedGeneration: lastProjectedGeneration } : {}),
          }),
          context,
        );
        return 'retained';
      }

      const response = cycle.submission;

      if (response.generation) {
        const stage = projectPluginAuthoringAdmission({
          desiredGeneration: response.generation.desired,
          appliedGeneration: response.generation.applied,
          pendingSurfaces: response.generation.pendingSurfaces,
        });
        if (stage.stage === 'projected' && response.generation.applied) {
          lastProjectedGeneration = response.generation.applied;
        }
        await reportDevChangeStage(stage, context);
        return response.ok ? 'adopted' : 'retained';
      }
      if (!response.ok) {
        const diagnostics = response.diagnostics ?? [{
          code: 'plugin_dev_candidate_rejected',
          message: 'The daemon rejected the development candidate.',
        }];
        await reportDevChangeStage(
          pluginAuthoringStageFailure({
            stage: projectDaemonDevelopmentFailureStage(diagnostics),
            diagnostics,
            ...(lastProjectedGeneration ? { retainedGeneration: lastProjectedGeneration } : {}),
          }),
          { ...context, ...(response.pendingReview ? { pendingReview: response.pendingReview } : {}) },
        );
        return 'retained';
      }
      // A committed change with no generation identity: the daemon accepted the
      // candidate but exposed nothing to project beyond admission.
      await reportDevChangeStage(pluginAuthoringStageReached('admitted'), context);
      return 'adopted';
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

async function runPluginsDevToolchainCommand(
  args: readonly string[],
  deps: PluginsCommandDeps,
  operation: PluginAuthorToolchainOperation,
): Promise<void> {
  const projectRoot = readCommandPositionals(args, {
    startIndex: 2,
    valueFlags: ['--sdk-registry'],
  })[0] ?? null;
  if (!projectRoot) {
    console.log(usage());
    return;
  }

  await runPluginToolchainCommand({
    args,
    deps,
    operation,
    projectRoot,
    kind: `plugins_dev_${operation}`,
    ...(operation === 'install' ? { sdkRegistryOrigin: readFlagValue(args, '--sdk-registry') } : {}),
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
      await printJsonEnvelope({
        ok: false,
        kind: params.kind,
        error: {
          code: 'plugin_author_failed',
          diagnostics: result.diagnostics,
        },
      }, { exitCode: 1 });
      return;
    }
    await printJsonEnvelope({
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
    console.error(errorFrame('Error:', result.diagnostics.flatMap((diagnostic) => [
      diagnostic.message,
      ...(diagnostic.source
        ? [`  at ${formatPluginDiagnosticSourceLocation(diagnostic.source)}`]
        : []),
    ])));
    process.exitCode = 1;
    return;
  }
  console.log(ok(`Plugin development ${result.operation} completed for ${result.projectRoot}.`));
}

async function runPluginsTestCommand(
  args: readonly string[],
  deps: PluginsCommandDeps,
): Promise<void> {
  const projectRoot = readCommandPositionals(args, {
    startIndex: 1,
    valueFlags: ['--sdk-registry', '--with-plugin'],
  })[0] ?? '.';
  if (projectRoot === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    return;
  }
  if (hasFlagValue(args, '--with-plugin') && !args.includes('--packed')) {
    const message = '--with-plugin is only valid with --packed';
    if (wantsJson(args)) {
      await printJsonEnvelope({
        ok: false,
        kind: 'plugins_test',
        error: {
          code: 'plugin_test_invalid_input',
          message,
        },
      }, { exitCode: 1 });
    } else {
      console.error(errorFrame('Error:', [message]));
      process.exitCode = 1;
    }
    return;
  }
  if (args.includes('--packed')) {
    const sdkRegistryOrigin = readFlagValue(args, '--sdk-registry');
    let prerequisiteLocators: readonly string[];
    try {
      prerequisiteLocators = readRepeatedFlagValues(args, '--with-plugin', {
        valueName: '<root-or-archive> value',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (wantsJson(args)) {
        await printJsonEnvelope({
          ok: false,
          kind: 'plugins_test',
          error: {
            code: 'plugin_test_invalid_input',
            message,
          },
        }, { exitCode: 1 });
      } else {
        console.error(errorFrame('Error:', [message]));
        process.exitCode = 1;
      }
      return;
    }
    const result = await (deps.runPackedPluginTest ?? runPackedPluginTestOwner)({
      projectRoot,
      ...(prerequisiteLocators.length > 0 ? { prerequisiteLocators } : {}),
      ...(sdkRegistryOrigin ? { sdkRegistryOrigin } : {}),
    });
    // The packed lane is the only CLI producer of `package_validated`: it proves
    // the pack/install closure. It stops there — it never claims a loaded or
    // rendered surface.
    const stage = result.ok
      ? pluginAuthoringStageReached('package_validated')
      : pluginAuthoringStageFailure({ stage: 'package_validated', diagnostics: result.diagnostics });
    if (wantsJson(args)) {
      if (!result.ok) {
        await printJsonEnvelope({
          ok: false,
          kind: 'plugins_test',
          error: {
            code: 'plugin_test_packed_failed',
            stage: stage.stage,
            diagnostics: result.diagnostics,
          },
        }, { exitCode: 1 });
        return;
      }
      await printJsonEnvelope({
        ok: true,
        kind: 'plugins_test',
        data: {
          mode: result.mode,
          stage: stage.stage,
          projectRoot: result.projectRoot,
          // Compatibility fields are projections of the target. Prerequisites
          // retain install evidence, while contributors carry only canonical
          // target-admission evidence from the disposable daemon.
          pluginId: result.pluginId,
          archiveDigest: result.archiveDigest,
          target: result.target,
          prerequisites: result.prerequisites,
          contributors: result.contributors,
          initialInvocation: result.initialInvocation,
          invocation: result.invocation,
          daemon: result.daemon,
        },
      });
      return;
    }
    if (!result.ok) {
      console.error(errorFrame('Error:', result.diagnostics.map(describePackedPluginTestDiagnostic)));
      process.exitCode = 1;
      return;
    }
    printHumanPackedPluginTestResult(result);
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

function printHumanPackedPluginTestParticipant(
  out: ReturnType<typeof createOutputBuilder>,
  label: 'Target' | 'Prerequisite' | 'Contributor',
  participant: Extract<PackedPluginTestResult, { ok: true }>['target'],
): void {
  out.line(`${dim(`${label}:`)} ${participant.plugin.id}@${participant.plugin.version}`);
  out.line(`  ${dim('Source:')} ${participant.source.kind} ${participant.source.locator}`);
  out.line(`  ${dim('Package identity:')} ${(participant.plugin.packageIdentity.name ?? 'unpublished')}@${participant.plugin.packageIdentity.version}`);
  out.line(`  ${dim('Archive digest:')} ${participant.archive.digest ?? 'unavailable'}`);
  out.line(`  ${dim('Archive integrity:')} ${participant.archive.integrity ?? 'unavailable'}`);
  out.line(`  ${dim('Install & trust:')} ${participant.admission.decision}; desired ${participant.admission.desiredGeneration}; applied ${participant.admission.appliedGeneration}`);
}

function printHumanPackedPluginTestContributor(
  out: ReturnType<typeof createOutputBuilder>,
  contributor: Extract<PackedPluginTestResult, { ok: true }>['contributors'][number],
): void {
  printHumanPackedPluginTestParticipant(out, 'Contributor', contributor);
  for (const admission of contributor.targetedAdmissions) {
    out.line(`  ${dim('Targeted admission:')} ${admission.target.pluginId}@${admission.target.immutableGenerationId}; point ${admission.target.pointId}; protocol ${admission.protocol.id}@${admission.protocol.version}; contributor ${admission.contributor.contributionId}@${admission.contributor.immutableGenerationId}`);
  }
}

/**
 * A packed run packs and installs every `--with-plugin` companion before the
 * target, so an unattributed failure leaves the author bisecting their own
 * command line. The subject names the exact requested input; `index` is
 * rendered one-based to match how the flags were typed.
 */
function describePackedPluginTestDiagnostic(diagnostic: PackedPluginTestDiagnostic): string {
  const subject = diagnostic.subject;
  if (subject === undefined) return diagnostic.message;
  return subject.role === 'target'
    ? `target ${subject.locator}: ${diagnostic.message}`
    : `--with-plugin #${subject.index + 1} ${subject.locator}: ${diagnostic.message}`;
}

function printHumanPackedPluginTestResult(
  result: Extract<PackedPluginTestResult, { ok: true }>,
): void {
  const out = createOutputBuilder();
  out.line(ok(
    result.invocation
      ? `Packed test passed; invoked ${result.invocation.actionId}.`
      : 'Packed test passed; activated through the disposable daemon.',
  ));
  printHumanPackedPluginTestParticipant(out, 'Target', result.target);
  for (const prerequisite of result.prerequisites) {
    printHumanPackedPluginTestParticipant(out, 'Prerequisite', prerequisite);
  }
  for (const contributor of result.contributors) {
    printHumanPackedPluginTestContributor(out, contributor);
  }
  console.log(out.render());
}

async function runPluginsPackCommand(args: readonly string[]): Promise<void> {
  const locator = readCommandPositionals(args, {
    startIndex: 1,
    valueFlags: ['--out', '--sdk-registry'],
  })[0] ?? null;
  if (!locator || locator === 'help' || locator === '--help' || locator === '-h') {
    console.log(usage());
    return;
  }

  const sdkRegistryOrigin = readFlagValue(args, '--sdk-registry');
  const result = await packLocalPlugin({
    locator,
    outPath: readFlagValue(args, '--out'),
    ...(sdkRegistryOrigin
      ? { sdkRegistryOrigin }
      : {}),
  });

  if (wantsJson(args)) {
    if (!result.ok) {
      await printJsonEnvelope(
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

    await printJsonEnvelope({
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
  console.log(out.render());
}

function renderInstalledGenerationReport(report: InstalledPluginGenerationReport): readonly string[] {
  const lines: string[] = [];
  const header = `${report.pluginId}@${report.immutableGenerationId}`;
  if (report.diagnostics.length === 0) {
    lines.push(`${ok('healthy')} ${header} ${dim(`(${report.inspectedFileCount} files)`)}`);
    return lines;
  }
  lines.push(`${fail('unhealthy')} ${header} ${dim(`(${report.inspectedFileCount} files)`)}`);
  for (const diagnostic of report.diagnostics) {
    lines.push(`  ${diagnostic.relativePath ? `${diagnostic.relativePath}: ` : ''}${diagnostic.message}`);
  }
  if (report.repair === 'reinstall') {
    lines.push(`  ${dim('Repair:')} reinstall this plugin with ${cmd(`happier plugins install <source>`)}, or restore the retained prior version with ${cmd(`happier plugins rollback ${report.pluginId}`)}.`);
  }
  return lines;
}

async function runPluginsInstalledDoctorCommand(
  args: readonly string[],
  deps: PluginsCommandDeps,
): Promise<void> {
  const requestedPluginId = readCommandPositionals(args, { startIndex: 1 })[0];
  const result = await (deps.diagnoseInstalledPluginGenerations ?? diagnoseInstalledPluginGenerations)({
    paths: resolvePluginStorePaths({ happyHomeDir: configuration.happyHomeDir }),
    ...(requestedPluginId ? { pluginId: requestedPluginId } : {}),
  });

  if (wantsJson(args)) {
    if (result.ok) {
      await printJsonEnvelope({
        ok: true,
        kind: 'plugins_doctor_installed',
        data: { plugins: result.plugins },
      });
      return;
    }
    await printJsonEnvelope({
      ok: false,
      kind: 'plugins_doctor_installed',
      error: {
        code: result.unknownPluginId
          ? 'plugin_installed_generation_absent'
          : 'plugin_installed_generation_unhealthy',
        ...(result.unknownPluginId ? { pluginId: result.unknownPluginId } : {}),
        plugins: result.plugins,
      },
    }, { exitCode: 1 });
    return;
  }

  if (result.unknownPluginId) {
    console.error(errorFrame('Error:', [
      `No installed plugin generation is committed for '${result.unknownPluginId}'.`,
    ]));
    process.exitCode = 1;
    return;
  }

  const out = createOutputBuilder();
  out.line(sectionTitle('Installed plugin generations'));
  if (result.plugins.length === 0) {
    out.line(neutral('(no installed plugin generations)'));
  }
  for (const report of result.plugins) {
    for (const line of renderInstalledGenerationReport(report)) out.line(line);
  }
  if (result.ok) {
    console.log(out.render());
    return;
  }
  console.error(out.render());
  process.exitCode = 1;
}

async function runPluginsDoctorCommand(
  args: readonly string[],
  deps: PluginsCommandDeps,
): Promise<void> {
  if (hasFlag(args, '--installed')) {
    await runPluginsInstalledDoctorCommand(args, deps);
    return;
  }
  const locator = readCommandPositionals(args, { startIndex: 1 })[0] ?? process.cwd();
  const result = await (deps.runPluginAuthorDoctor ?? runPluginAuthorDoctor)({ locator });
  if (wantsJson(args)) {
    if (!result.ok) {
      await printJsonEnvelope({
        ok: false,
        kind: 'plugins_doctor',
        error: {
          code: 'plugin_author_doctor_failed',
          diagnostics: result.diagnostics,
        },
      }, { exitCode: 1 });
      return;
    }
    await printJsonEnvelope({
      ok: true,
      kind: 'plugins_doctor',
      data: {
        pluginId: result.pluginId,
        version: result.version,
        entryPath: result.entryPath,
        evaluationMs: result.evaluationMs,
        diagnostics: result.diagnostics,
      },
    });
    return;
  }
  if (!result.ok) {
    console.error(errorFrame('Plugin doctor failed:', result.diagnostics.flatMap((entry) => [
      entry.message,
      ...(entry.location
        ? [`  at ${formatPluginDiagnosticSourceLocation(entry.location)}`]
        : []),
    ])));
    process.exitCode = 1;
    return;
  }
  const out = createOutputBuilder();
  out.line(ok(`Plugin ${result.pluginId}@${result.version} evaluated in ${result.evaluationMs}ms.`));
  for (const entry of result.diagnostics) {
    out.line(neutral(entry.message));
    if (entry.location) {
      out.line(neutral(`  at ${formatPluginDiagnosticSourceLocation(entry.location)}`));
    }
  }
  console.log(out.render());
}

type DevelopmentPluginReloadTarget =
  | Readonly<{ ok: true; pluginId: string; sourceRootPath: string }>
  | Readonly<{ ok: false; code: string; message: string }>;

async function resolveDevelopmentPluginReloadTarget(
  explicitPluginId: string | null,
): Promise<DevelopmentPluginReloadTarget> {
  if (explicitPluginId) {
    const entry = await readInstalledPluginCatalogEntry({ pluginId: explicitPluginId });
    if (!entry || entry.source.kind !== 'path' || entry.source.devWatch !== true) {
      return {
        ok: false,
        code: entry ? 'development_source_required' : 'plugin_not_found',
        message: entry
          ? 'Explicit reload is supported only for development path plugins; use install/update with --dev or use rollback for this plugin.'
          : `Unknown installed plugin id: ${explicitPluginId}`,
      };
    }
    return { ok: true, pluginId: entry.pluginId, sourceRootPath: entry.source.locator };
  }

  const currentDirectory = await realpath(process.cwd());
  const developmentEntries = (await readInstalledPluginCatalog()).filter((entry) => (
    entry.source.kind === 'path' && entry.source.devWatch === true
  ));
  const matches = (await Promise.all(developmentEntries.map(async (entry) => {
    try {
      const sourceRootPath = await realpath(entry.source.locator);
      return isCanonicalAbsolutePathInsideRoot(sourceRootPath, currentDirectory)
        ? { pluginId: entry.pluginId, sourceRootPath }
        : null;
    } catch {
      return null;
    }
  }))).filter((entry): entry is Readonly<{ pluginId: string; sourceRootPath: string }> => entry !== null);
  if (matches.length === 1) {
    const match = matches[0]!;
    return { ok: true, ...match };
  }
  if (matches.length === 0) {
    return {
      ok: false,
      code: 'development_plugin_not_found_in_current_directory',
      message: `No registered development plugin contains ${currentDirectory}. Run happier plugins install . --dev, or reload an explicit development plugin id.`,
    };
  }
  return {
    ok: false,
    code: 'development_plugin_ambiguous_in_current_directory',
    message: `Multiple registered development plugins contain ${currentDirectory}: ${matches.map((entry) => entry.pluginId).sort().join(', ')}. Run happier plugins reload <developmentPluginId>.`,
  };
}

async function runPluginsReloadCommand(args: readonly string[], deps: PluginsCommandDeps): Promise<void> {
  const explicitPluginId = readCommandPositionals(args, { startIndex: 1 })[0] ?? null;
  if (explicitPluginId === 'help' || explicitPluginId === '--help' || explicitPluginId === '-h') {
    console.log(usage());
    return;
  }

  const target = await resolveDevelopmentPluginReloadTarget(explicitPluginId);
  if (!target.ok) {
    if (wantsJson(args)) {
      await printJsonEnvelope({ ok: false, kind: 'plugins_reload', error: { code: target.code, message: target.message } }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Error:', [target.message]));
    process.exitCode = 1;
    return;
  }

  const sourceInspection = await (deps.inspectPluginDevelopmentSource ?? inspectPluginDevelopmentSource)({
    projectRoot: target.sourceRootPath,
  });
  if (!sourceInspection.ok) {
    const failure = sourceInspection.diagnostics[0] ?? {
      code: 'plugin_dev_source_invalid',
      message: 'The development source is no longer valid.',
    };
    if (wantsJson(args)) {
      await printJsonEnvelope({
        ok: false,
        kind: 'plugins_reload',
        error: { code: failure.code, message: failure.message, diagnostics: sourceInspection.diagnostics },
      }, { exitCode: 1 });
    } else {
      console.error(errorFrame('Plugin source diagnostics:', sourceInspection.diagnostics.map((entry) => entry.message)));
      process.exitCode = 1;
    }
    return;
  }

  const cycle = await runPluginDevelopmentCycle<UserPluginChangeResult>({
    observation: Object.freeze({
      ...sourceInspection,
      request: Object.freeze({
        ...sourceInspection.request,
        pluginId: target.pluginId,
        projectRoot: target.sourceRootPath,
      }),
    }),
    submit: async (request, options) => await requestUserPluginChange({
      request: {
        kind: 'development',
        ...(request.pluginId ? { pluginId: request.pluginId } : {}),
        sourceRootPath: request.projectRoot,
        ...(request.changedPaths ? { changedPaths: request.changedPaths } : {}),
        ...(request.sdkRegistryOrigin ? { sdkRegistryOrigin: request.sdkRegistryOrigin } : {}),
      },
      approval: resolveUserPluginChangeApproval({
        interactive: (deps.isInteractiveTerminal ?? isInteractiveTerminal)(),
        json: wantsJson(args),
      }),
      ...(options?.signal ? { signal: options.signal } : {}),
    }),
  });
  if (cycle.kind !== 'submitted') {
    if (cycle.kind === 'cancelled') return;
    const failure = cycle.diagnostics[0] ?? {
      code: 'plugin_dev_candidate_rejected',
      message: 'The development candidate was not submitted.',
    };
    if (wantsJson(args)) {
      await printJsonEnvelope({
        ok: false,
        kind: 'plugins_reload',
        error: { code: failure.code, message: failure.message, diagnostics: cycle.diagnostics },
      }, { exitCode: 1 });
    } else {
      console.error(errorFrame('Plugin development diagnostics:', cycle.diagnostics.map((entry) => entry.message)));
      process.exitCode = 1;
    }
    return;
  }

  const result = cycle.submission;
  if (result.kind !== 'committed') {
    await reportPluginChangeFailure(args, 'plugins_reload', result);
    return;
  }

  if (wantsJson(args)) {
    await printJsonEnvelope({
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

async function runPluginsMarketplaceListCommand(
  args: readonly string[],
  deps: PluginsCommandDeps,
): Promise<void> {
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
      await printJsonEnvelope(
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

  const result = await queryAllMarketplaceSourceItems(source, deps.marketplaceIndexService);
  if (wantsJson(args)) {
    await printJsonEnvelope({
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
    entries: result.items,
    diagnostics: result.diagnostics,
  });
}

async function runPluginsMarketplaceShowCommand(
  args: readonly string[],
  deps: PluginsCommandDeps,
): Promise<void> {
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
      await printJsonEnvelope(
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

  const result = await queryAllMarketplaceSourceItems(source, deps.marketplaceIndexService);
  const indexEntry = result.items.find((entry) => entry.pluginId === pluginId) ?? null;
  if (wantsJson(args)) {
    if (!indexEntry) {
      await printJsonEnvelope(
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

    await printJsonEnvelope({
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
        plugin: projectMarketplaceIndexItemForCliOutput(indexEntry),
      },
    });
    return;
  }

  if (!indexEntry) {
    console.error(errorFrame('Error:', [`Unknown marketplace plugin id: ${pluginId}`]));
    process.exitCode = 1;
    return;
  }

  printHumanMarketplaceShow({
    title: source.title,
    sourceUrl: source.sourceUrl,
    entry: indexEntry,
    diagnostics: result.diagnostics,
  });
}

async function reportMarketplaceInstallUnavailable(args: readonly string[], message: string): Promise<void> {
  if (wantsJson(args)) {
    await printJsonEnvelope(
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
    await reportMarketplaceInstallUnavailable(args, 'No enabled marketplace source is configured for this Install and trust action.');
    return;
  }

  const exactInstall = await requestExactMarketplaceInstall({
    happyHomeDir: configuration.happyHomeDir,
    sourceId: source.id,
    pluginId,
    approval: resolveUserPluginChangeApproval({
      interactive: (_deps.isInteractiveTerminal ?? isInteractiveTerminal)(),
      json: wantsJson(args),
    }),
  }, {
    marketplaceIndexService: _deps.marketplaceIndexService,
  });
  if (!exactInstall.ok) {
    await reportMarketplaceInstallUnavailable(args, exactInstall.message);
    return;
  }
  const { listing, change } = exactInstall;
  if (change.kind !== 'committed') {
    await reportPluginChangeFailure(args, 'plugins_marketplace_install', change);
    return;
  }

  if (wantsJson(args)) {
    await printJsonEnvelope({
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
    await printJsonEnvelope({
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
    await printJsonEnvelope({
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
      await printJsonEnvelope(
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
      await printJsonEnvelope(
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
    await printJsonEnvelope({
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
      await printJsonEnvelope(
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
    await printJsonEnvelope({
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
    await runPluginsUninstallCommand(args);
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

  if (subcommand === 'change') {
    await runPluginsChangeCommand(args, deps, runtime);
    return;
  }

  if (subcommand === 'logs') {
    await runPluginsLogsCommand(args, deps, runtime);
    return;
  }

  if (subcommand === 'settings') {
    await handlePluginsSettingsCommand(args.slice(1), {
      ...(deps.executeSettingsAdministrationAction
        ? { executeSettingsAdministrationAction: deps.executeSettingsAdministrationAction }
        : {}),
      ...(deps.resolvePluginInvocationLogTarget
        ? { resolvePluginInvocationLogTarget: deps.resolvePluginInvocationLogTarget }
        : {}),
    }, runtime);
    return;
  }

  if (subcommand === 'test') {
    await runPluginsTestCommand(args, deps);
    return;
  }

  if (subcommand === 'pack') {
    await runPluginsPackCommand(args);
    return;
  }

  if (subcommand === 'doctor') {
    await runPluginsDoctorCommand(args, deps);
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
      write: async (value) => {
        if (wantsJson(args)) {
          await printJsonEnvelope({ ok: true, kind: 'plugins_registry', data: value });
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

      await reportUnknownPluginsSubcommand(
        args,
        `plugins_marketplace_sources_${marketplaceSourcesSubcommand}`,
        `Unknown plugins marketplace sources subcommand: ${marketplaceSourcesSubcommand}`,
      );
      return;
    }

    if (marketplaceSubcommand === 'list') {
      await runPluginsMarketplaceListCommand(args, deps);
      return;
    }

    if (marketplaceSubcommand === 'show') {
      await runPluginsMarketplaceShowCommand(args, deps);
      return;
    }

    if (marketplaceSubcommand === 'install') {
      await runPluginsMarketplaceInstallCommand(args, deps);
      return;
    }

    await reportUnknownPluginsSubcommand(
      args,
      `plugins_marketplace_${marketplaceSubcommand}`,
      `Unknown plugins marketplace subcommand: ${marketplaceSubcommand}`,
    );
    return;
  }

  await reportUnknownPluginsSubcommand(
    args,
    `plugins_${subcommand}`,
    `Unknown plugins subcommand: ${subcommand}`,
  );
}

export async function handlePluginsCliCommand(context: CommandContext): Promise<void> {
  try {
    await handlePluginsCommand(context.args.slice(1), defaultPluginsCommandDeps, { signal: context.signal });
  } catch (error) {
    const args = context.args.slice(1);
    if (wantsJson(args)) {
      const subcommand = String(args[0] ?? '').trim();
      const kind = subcommand ? `plugins_${subcommand}` : 'plugins_unknown';
      await printJsonEnvelope(
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
