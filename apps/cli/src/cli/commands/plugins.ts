import { renderPluginHelp } from './pluginsHelp';
import { realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { cmd, createOutputBuilder, dim, errorFrame, fail, neutral, ok, renderHelpPage, sectionTitle } from '@happier-dev/cli-common/output';
import {
  buildPosixShellCommand,
  buildPowerShellCommand,
  buildWindowsCmdCommand,
} from '@happier-dev/agents/process/shellCommand';

import type { CommandContext } from '@/cli/commandRegistry';
import { findCompiledActionCliCommand, listCompiledActionCliCommands } from '@/cli/actions/compiledCommands';
import { runCompiledActionCliCommand, type ActionCliExecutionDeps } from '@/cli/actions/executeCommand';
import {
  hasFlag,
  hasFlagValue,
  readCommandPositionals,
  readFlagValue,
  readRepeatedFlagValues,
} from '@/cli/commands/shared/argvFlags';
import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { resolveInvokerName } from '@/cli/runtime/resolveInvokerName';
import { configuration } from '@/configuration';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { readInstalledPluginCatalog, readInstalledPluginCatalogEntry, type PluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import {
  projectPluginCatalogEntrySnapshot,
  type PluginCatalogEntryIntrospectionSnapshot,
} from '@/plugins/projection/introspection/catalogSnapshot';
import { readPluginDiagnosticDisplayMessage } from '@/plugins/projection/introspection/project';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createNpmRegistryProfileService } from '@/plugins/distribution/npm/profiles/service';
import { createNpmRegistryProfileProbe } from '@/plugins/distribution/npm/profiles/probe';
import { isInteractiveTerminal, promptSecretInput } from '@/terminal/prompts/promptInput';
import { handlePluginsRegistryCommand, type PluginsRegistryCommandDeps } from './pluginsRegistry';
import {
  handlePluginsSettingsCommand,
  pluginSettingsHelpRows,
  type PluginsSettingsCommandDeps,
} from './pluginsSettings';
import { controlDaemonPluginDevelopment, listDaemonPluginChanges, readDaemonPluginCatalog } from '@/daemon/controlClient';
import type { DaemonPluginDevelopmentStatus } from '@/plugins/daemon/developmentRoots';
import type { PluginPendingChangeEntry } from '@/plugins/daemon/changeContract';
import { ensureDaemonRunningForSessionCommand } from '@/daemon/ensureDaemon';
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
  pluginAuthoringStageFailure,
  pluginAuthoringStageReached,
} from '@/plugins/authoring/lifecycleStage';
import { formatPluginDiagnosticSourceLocation } from '@/plugins/validation/diagnostics/sourceLocation';
import {
  runPackedPluginTest as runPackedPluginTestOwner,
  type PackedPluginTestDiagnostic,
  type PackedPluginTestResult,
} from '@/plugins/authoring/packedTest';
import { runPluginAuthorDoctor } from '@/plugins/authoring/doctor';
import {
  diagnoseInstalledPluginGenerations,
  type InstalledPluginGenerationReport,
} from '@/plugins/store/registry/installedGenerationDiagnosis';
import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';
import {
  readUserPluginChangeStatus,
  type UserPluginChangeStatusResult,
} from '@/plugins/daemon/changeClient';
import type { PluginChangePendingReviewResult } from '@happier-dev/protocol/marketplace/internal';
import { PluginScaffoldTemplateSchema, PluginScaffoldUiModeSchema } from '@happier-dev/protocol/actions/actionSpecs';
import type { PluginScaffoldUiMode } from '@happier-dev/protocol';

type PluginsCommandDeps = Readonly<{
  actionExecutionDeps?: Partial<ActionCliExecutionDeps>;
  ensureDaemon?: () => Promise<void>;
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
  controlPluginDevelopment?: typeof controlDaemonPluginDevelopment;
  readPluginChangeStatus?: typeof readUserPluginChangeStatus;
  resolvePluginInvocationLogTarget?: (params: Readonly<{
    requestedMachineId?: string;
    signal?: AbortSignal;
  }>) => Promise<PluginInvocationLogTargetResolution>;
  readPluginInvocationLogsOnMachine?: (params: Readonly<{
    target: PluginInvocationLogMachineTarget;
    request: PluginInvocationLogQuery;
    waitForChanges?: true;
    signal?: AbortSignal;
  }>) => Promise<MachinePluginInvocationLogReadResult>;
  pluginSettings?: PluginsSettingsCommandDeps;
}>;

type PluginsCommandRuntime = Readonly<{
  signal?: AbortSignal;
}>;

const defaultPluginsCommandDeps: PluginsCommandDeps = {
  isInteractiveTerminal,
  ensureDaemon: ensureDaemonRunningForSessionCommand,
  controlPluginDevelopment: controlDaemonPluginDevelopment,
  runPackedPluginTest: runPackedPluginTestOwner,
};

function usage(): string { return renderPluginHelp(PluginScaffoldUiModeSchema.options); }

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
  return Object.freeze(actions.sort((left, right) => (
    left.actionId.localeCompare(right.actionId)
  )));
}

function printHumanList(
  entries: readonly PluginCatalogEntryIntrospectionSnapshot[],
  pendingChanges: readonly PluginPendingChangeEntry[],
): void {
  const out = createOutputBuilder();
  if (entries.length === 0) {
    out.line(neutral('(no plugins installed)'));
  } else {
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
  }
  if (pendingChanges.length > 0) {
    out.blank();
    out.line(sectionTitle('Pending changes'));
    for (const change of pendingChanges) {
      if (change.kind === 'applying') {
        out.line(`${change.pendingChangeId} ${neutral('applying')}`);
      } else if (change.reviewKind === 'projectTrust') {
        out.line(`${change.pendingChangeId} ${neutral('project trust')} ${dim(change.review.source.locator)}`);
      } else {
        out.line(`${change.pendingChangeId} ${neutral('install and trust')} ${change.review.displayName} ${dim(change.review.pluginId)}`);
      }
    }
  }
  console.log(out.render());
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

async function runPluginsListCommand(args: readonly string[]): Promise<void> {
  const [catalog, pendingChanges] = await Promise.all([
    readDaemonPluginCatalog(),
    listDaemonPluginChanges(),
  ]);
  if (catalog.kind === 'unavailable') {
    await printPluginCatalogUnavailable(args, 'plugins_list', catalog.code);
    return;
  }
  if (pendingChanges.kind === 'unavailable') {
    await printPluginCatalogUnavailable(args, 'plugins_list', pendingChanges.code);
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
        pendingChanges: pendingChanges.changes,
      },
    });
    return;
  }

  printHumanList(entries.map((entry) => projectPluginCatalogEntrySnapshot(entry)), pendingChanges.changes);
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

function pluginChangeReviewRejoinCommands(pendingChangeId: string): readonly string[] {
  const pluginCommand = `${resolveInvokerName() ?? 'happier'} plugins`;
  return [
    `Review status: ${pluginCommand} change status ${pendingChangeId}`,
    'Decide the associated approval request in the Happier Inbox.',
  ];
}

function describePendingPluginReviewForTerminal(
  pendingReview: PluginChangePendingReviewResult,
): readonly string[] {
  return [
    pendingReview.reviewKind === 'projectTrust'
      ? `Project trust review remains pending for ${pendingReview.review.source.locator}.`
      : `Install and trust review remains pending for ${pendingReview.review.displayName}.`,
    ...pluginChangeReviewRejoinCommands(pendingReview.pendingChangeId),
  ];
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
  if (status.kind === 'reviewRequired') {
    out.line(neutral(status.reviewKind === 'projectTrust'
      ? `Project trust review remains pending for ${status.review.source.locator}.`
      : `Install and trust review remains pending for ${status.review.displayName}.`));
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
  if (changeSubcommand !== 'status') {
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
  const status = await (deps.readPluginChangeStatus ?? readUserPluginChangeStatus)({
    pendingChangeId,
    ...(runtime.signal ? { signal: runtime.signal } : {}),
  });
  await printPluginChangeStatus(args, pendingChangeId, status);
}

function readPluginLogsRequest(args: readonly string[]): Readonly<{
  pluginId: string;
  machineId?: string;
  occurrenceId?: string;
  correlationId?: string;
  cursor?: number;
  limit?: number;
}> | null {
  if (args.some((argument) => argument === '--generation' || argument.startsWith('--generation='))) {
    throw new Error('Unknown option: --generation; use --occurrence');
  }
  const pluginId = readCommandPositionals(args, {
    startIndex: 1,
    valueFlags: ['--machine', '--occurrence', '--correlation', '--cursor', '--limit'],
  })[0] ?? null;
  if (!pluginId || pluginId === 'help' || pluginId === '--help' || pluginId === '-h') return null;

  const readOptionalFlag = (flag: '--occurrence' | '--correlation'): string | undefined => {
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
  const occurrenceId = readOptionalFlag('--occurrence');
  const correlationId = readOptionalFlag('--correlation');
  const cursor = readBoundedIntegerFlag('--cursor', 0, Number.MAX_SAFE_INTEGER);
  const limit = readBoundedIntegerFlag('--limit', 1, 500);
  return {
    pluginId,
    ...(machineId ? { machineId } : {}),
    ...(occurrenceId ? { occurrenceId } : {}),
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
  if (result.cursorReset) console.log(neutral('The active daemon log changed; continuing from its beginning.'));
  if (result.records.length === 0) {
    console.log(neutral('No matching plugin logs.'));
    return;
  }
  for (const record of result.records) {
    await writeJsonStdout(record);
  }
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
  let logId: string | undefined;
  let waitForChanges = false;
  let previousEmptyFollowPage: Readonly<{ cursor: number; hasMore: boolean }> | null = null;
  for (;;) {
    let result: MachinePluginInvocationLogReadResult;
    try {
      result = await readLogs({
        target,
        request: {
          ...query,
          ...(cursor === undefined ? {} : { cursor }),
          ...(logId === undefined ? {} : { logId }),
        },
        ...(waitForChanges ? { waitForChanges: true } : {}),
        ...(runtime.signal ? { signal: runtime.signal } : {}),
      });
    } catch (error) {
      if (runtime.signal?.aborted) return;
      throw error;
    }
    const unchangedEmptyFollowPage = follow
      && result.kind === 'available'
      && result.records.length === 0
      && !result.cursorReset
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
    logId = result.logId;
    waitForChanges = !(result.hasMore && madeProgress);
  }
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
  invokerName: string = resolveInvokerName() ?? 'happier',
): readonly string[] {
  const invoker = invokerName.trim() || 'happier';
  if (platform === 'win32') {
    const args = [invoker, 'plugins', 'dev', targetDir];
    return [
      `PowerShell: ${buildPowerShellCommand(args)}`,
      `cmd.exe: ${buildWindowsCmdCommand(args)}`,
    ];
  }
  return [`cd ${buildPosixShellCommand([targetDir])} && ${invoker} plugins dev`];
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
    valueFlags: ['--id', '--name', '--ui', '--template'],
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
  const templateValue = readFlagValue(args, '--template');
  const template = templateValue?.startsWith('--') ? null : templateValue;
  if (hasFlagValue(args, '--template') && template === null) {
    const message = `--template requires one of: ${PluginScaffoldTemplateSchema.options.join(', ')}`;
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
  const parsedTemplate = template ? PluginScaffoldTemplateSchema.safeParse(template) : null;
  if (parsedTemplate && !parsedTemplate.success) {
    const message = `--template requires one of: ${PluginScaffoldTemplateSchema.options.join(', ')}`;
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
    invokerName: resolveInvokerName() ?? 'happier',
    ...(ui ? { ui: ui as PluginScaffoldUiMode } : {}),
    ...(parsedTemplate?.success ? { template: parsedTemplate.data } : {}),
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

function printPluginDevelopmentStatus(status: DaemonPluginDevelopmentStatus): void {
  const out = createOutputBuilder();
  out.line(sectionTitle('Plugin development'));
  if (status.roots.length === 0 && status.plugins.length === 0) {
    out.line(neutral('No development roots are registered.'));
    console.log(out.render());
    return;
  }
  for (const root of status.roots) {
    const trust = root.trusted ? ok('trusted') : neutral('not trusted');
    const persistence = root.persisted ? dim('remembered') : dim('process-local');
    out.line(`${root.rootPath} ${trust} ${persistence}`);
  }
  for (const plugin of status.plugins) {
    out.line(`${plugin.pluginId ?? plugin.sourceRootPath} ${neutral(plugin.phase)}`);
    out.line(`  ${dim('Source:')} ${plugin.sourceRootPath}`);
    if (plugin.occurrenceId) out.line(`  ${dim('Occurrence:')} ${plugin.occurrenceId}`);
    if (plugin.uiArtifactDigest) out.line(`  ${dim('UI digest:')} ${plugin.uiArtifactDigest}`);
    if (plugin.diagnostic) {
      out.line(`  ${dim('Diagnostic:')} ${plugin.diagnostic.message ?? plugin.diagnostic.code}`);
    }
  }
  console.log(out.render());
}

async function runPluginsStatusCommand(
  args: readonly string[],
  deps: PluginsCommandDeps,
  runtime: PluginsCommandRuntime,
): Promise<void> {
  await (deps.ensureDaemon ?? ensureDaemonRunningForSessionCommand)();
  const result = await (deps.controlPluginDevelopment ?? controlDaemonPluginDevelopment)(
    { kind: 'status' },
    runtime.signal ? { signal: runtime.signal } : {},
  );
  if (result.kind === 'failed') {
    if (wantsJson(args)) {
      await printJsonEnvelope({
        ok: false,
        kind: 'plugins_status',
        error: { code: result.code, message: result.message },
      }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Error:', [result.message]));
    process.exitCode = 1;
    return;
  }
  if (wantsJson(args)) {
    await printJsonEnvelope({ ok: true, kind: 'plugins_status', data: result.status });
    return;
  }
  printPluginDevelopmentStatus(result.status);
}

function isPluginAuthorOperation(value: string): value is PluginAuthorToolchainOperation {
  return value === 'install' || value === 'typecheck' || value === 'build' || value === 'test';
}

async function runPluginsDevCommand(
  args: readonly string[],
  deps: PluginsCommandDeps,
  runtime: PluginsCommandRuntime,
): Promise<void> {
  const operation = String(args[1] ?? '').trim();
  if (operation === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    return;
  }
  if (operation === 'unregister') {
    const requestedPath = readCommandPositionals(args, { startIndex: 2 })[0];
    if (!requestedPath) {
      const message = 'Plugin development unregister requires an exact source path.';
      if (wantsJson(args)) {
        await printJsonEnvelope({
          ok: false,
          kind: 'plugins_dev_unregister',
          error: { code: 'plugin_author_invalid_input', message },
        }, { exitCode: 1 });
        return;
      }
      console.error(errorFrame('Error:', [message]));
      process.exitCode = 1;
      return;
    }
    await (deps.ensureDaemon ?? ensureDaemonRunningForSessionCommand)();
    const result = await (deps.controlPluginDevelopment ?? controlDaemonPluginDevelopment)({
      kind: 'unregisterExplicit',
      rootPath: requestedPath,
    }, runtime.signal ? { signal: runtime.signal } : {});
    if (result.kind === 'failed') {
      if (wantsJson(args)) {
        await printJsonEnvelope({
          ok: false,
          kind: 'plugins_dev_unregister',
          error: { code: result.code, message: result.message },
        }, { exitCode: 1 });
        return;
      }
      console.error(errorFrame('Error:', [result.message]));
      process.exitCode = 1;
      return;
    }
    if (wantsJson(args)) {
      await printJsonEnvelope({
        ok: true,
        kind: 'plugins_dev_unregister',
        data: { rootPath: requestedPath, status: result.status },
      });
    } else {
      printPluginDevelopmentStatus(result.status);
    }
    return;
  }
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

  let sdkRegistryOrigin: string | null;
  try {
    sdkRegistryOrigin = normalizePluginSdkRegistryOrigin(readFlagValue(args, '--sdk-registry'));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Plugin SDK registry is invalid.';
    if (wantsJson(args)) {
      await printJsonEnvelope({
        ok: false,
        kind: 'plugins_dev',
        error: { code: 'plugin_author_invalid_input', message },
      }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Error:', [message]));
    process.exitCode = 1;
    return;
  }

  const control = deps.controlPluginDevelopment ?? controlDaemonPluginDevelopment;
  await (deps.ensureDaemon ?? ensureDaemonRunningForSessionCommand)();
  const result = await control({
    kind: 'registerExplicit',
    rootPath: requestedPath,
    ...(sdkRegistryOrigin ? { sdkRegistryOrigin } : {}),
  }, runtime.signal ? { signal: runtime.signal } : {});
  if (result.kind === 'failed') {
    if (result.code === 'plugin_dev_reviewRequired') {
      // Rejoin the daemon-retained candidate through the ordinary install
      // Action, which owns the approval Artifact and its decision lifecycle.
      await handlePluginsCommand([
        'install', requestedPath, '--dev',
        ...(sdkRegistryOrigin ? ['--sdk-registry', sdkRegistryOrigin] : []),
        ...(wantsJson(args) ? ['--json'] : []),
      ], deps, runtime);
      return;
    }
    if (wantsJson(args)) {
      await printJsonEnvelope({
        ok: false,
        kind: 'plugins_dev',
        error: { code: result.code, message: result.message },
      }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Error:', [result.message]));
    process.exitCode = 1;
    return;
  }

  if (wantsJson(args)) {
    await printJsonEnvelope({
      ok: true,
      kind: 'plugins_dev',
      data: { rootPath: requestedPath, status: result.status },
    });
  } else {
    printPluginDevelopmentStatus(result.status);
  }
  await waitForPluginDevStop(runtime.signal);
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
    out.line(`  ${dim('Targeted admission:')} ${admission.target.pluginId}@${admission.target.occurrenceId}; point ${admission.target.pointId}; protocol ${admission.protocol.id}@${admission.protocol.version}; contributor ${admission.contributor.contributionId}@${admission.contributor.occurrenceId}`);
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
    const pluginCommand = `${resolveInvokerName() ?? 'happier'} plugins`;
    lines.push(`  ${dim('Repair:')} reinstall this plugin with ${cmd(`${pluginCommand} install <source>`)}, or restore the retained prior version with ${cmd(`${pluginCommand} rollback ${report.pluginId}`)}.`);
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
      message: `No registered development plugin contains ${currentDirectory}. Run ${resolveInvokerName() ?? 'happier'} plugins install . --dev, or reload an explicit development plugin id.`,
    };
  }
  return {
    ok: false,
    code: 'development_plugin_ambiguous_in_current_directory',
    message: `Multiple registered development plugins contain ${currentDirectory}: ${matches.map((entry) => entry.pluginId).sort().join(', ')}. Run ${resolveInvokerName() ?? 'happier'} plugins reload <developmentPluginId>.`,
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

  await (deps.ensureDaemon ?? ensureDaemonRunningForSessionCommand)();
  const result = await (deps.controlPluginDevelopment ?? controlDaemonPluginDevelopment)({
    kind: 'reload',
    rootPath: target.sourceRootPath,
  });
  if (result.kind === 'failed') {
    if (wantsJson(args)) {
      await printJsonEnvelope({
        ok: false,
        kind: 'plugins_reload',
        error: { code: result.code, message: result.message },
      }, { exitCode: 1 });
      return;
    }
    console.error(errorFrame('Error:', [result.message]));
    process.exitCode = 1;
    return;
  }

  if (wantsJson(args)) {
    await printJsonEnvelope({
      ok: true,
      kind: 'plugins_reload',
      data: { pluginId: target.pluginId, sourceRootPath: target.sourceRootPath, status: result.status },
    });
    return;
  }
  console.log(ok(`Reload requested for ${target.pluginId}.`));
}
export async function handlePluginsCommand(
  args: string[],
  deps: PluginsCommandDeps = defaultPluginsCommandDeps,
  runtime: PluginsCommandRuntime = {},
): Promise<void> {
  const actionOwnedMutation = ['install', 'update', 'uninstall', 'enable', 'disable', 'rollback', 'trust', 'update-policy'].includes(args[0] ?? '')
    || (args[0] === 'marketplace' && args[1] === 'install');
  if (actionOwnedMutation) {
    const argv = ['plugins', ...args];
    const command = findCompiledActionCliCommand(argv, listCompiledActionCliCommands());
    if (!command) throw new Error('Plugin mutation Action command is unavailable.');
    await runCompiledActionCliCommand({ command, argv,
      ...(deps.actionExecutionDeps ? { deps: deps.actionExecutionDeps } : {}),
      ...(runtime.signal ? { signal: runtime.signal } : {}) });
    return;
  }
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


  if (subcommand === 'create') {
    await runPluginsCreateCommand(args);
    return;
  }

  if (subcommand === 'dev') {
    await runPluginsDevCommand(args, deps, runtime);
    return;
  }

  if (subcommand === 'status') {
    await runPluginsStatusCommand(args, deps, runtime);
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
      ...(deps.pluginSettings ?? {}),
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
