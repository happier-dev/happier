import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { stringify, type TomlTable, type TomlValue } from 'smol-toml';

import {
  resolveConnectedServicesProviderStateSharingPolicyV1,
  type AccountSettings,
  type ConnectedServicesProviderStateSharingPolicyV1,
} from '@happier-dev/protocol';

import { codexConnectedServiceStateSharingDescriptor } from '@/backends/codex/connectedServices/codexConnectedServiceStateSharingDescriptor';
import { resolveConfiguredCodexHome } from '@/backends/codex/utils/resolveConfiguredCodexHome';
import { isCodexRolloutFilePath, isMatchingCodexRolloutFileName, normalizeCodexVendorResumeId, parseCodexRolloutFilename } from '@/backends/codex/utils/codexSessionFiles';
import { resolveConnectedServiceHomesDir } from '@/daemon/connectedServices/homes/resolveConnectedServiceHomeDir';
import { isConnectedServiceStateRootWithin } from '@/daemon/connectedServices/materialize/resolveConnectedServicePreviousStateRoot';
import { ConnectedServiceSharedStateLinkUnavailableError } from '@/daemon/connectedServices/stateSharing/createSharedStateLink';
import { withConnectedServiceStateSharingLocks } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingLock';
import {
  readConnectedServiceStateSharingManifest,
  removeLegacyConnectedServiceStateSharingManifest,
  writeConnectedServiceStateSharingManifest,
} from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';
import { applyConnectedServiceStateSharingDescriptor, parseConnectedServiceTomlConfig } from '@/daemon/connectedServices/stateSharing/applyConnectedServiceStateSharingDescriptor';
import {
  importConnectedServiceSessionFiles,
  type ConnectedServiceSessionFileImportDetail,
} from '@/daemon/connectedServices/stateSharing/importConnectedServiceSessionFiles';
import { logger } from '@/ui/logger';

import { resolveConfiguredCodexSqliteHome } from './codexStateFileNames';
import { isCodexFixedJsonlStateFile, reconcileCodexSharedJsonlState } from './reconcileCodexSharedJsonlState';

const CODEX_IMPORTABLE_SESSION_HOME_ENTRIES = Object.freeze([
  'sessions',
  'archived_sessions',
] as const);

const CODEX_SHARED_STATE_DIRECTORY_ENTRIES = Object.freeze([
  'sessions',
  'archived_sessions',
  'memories',
] as const);

const CODEX_SHARED_STATE_FILE_ENTRIES = Object.freeze([
  'session_index.jsonl',
  'history.jsonl',
] as const);

type CodexStateMode = 'shared' | 'isolated';

// Codex keys local hook decisions by the defining file; plugin keys use stable plugin IDs.
const CODEX_HOOK_CONFIG_ENTRIES = ['hooks.json', 'config.toml'] as const;

export type CodexConnectedServiceStateSharingDiagnostic = Readonly<{
  code: 'state_symlink_unavailable';
  providerId: 'codex';
  requestedStateMode: 'shared';
  effectiveStateMode: 'isolated';
  entryName: string;
  reason: 'symlink_unavailable';
  fsCode?: string;
}>;

export type SyncCodexConnectedServiceHomeResult = Readonly<{
  providerId: 'codex';
  requestedStateMode: CodexStateMode;
  effectiveStateMode: CodexStateMode;
  diagnostics: readonly CodexConnectedServiceStateSharingDiagnostic[];
  targetSqliteHome: string;
}>;

function resolveCodexHomeSharingSettings(
  settingsLike: AccountSettings | Readonly<Record<string, unknown>> | null | undefined,
): ConnectedServicesProviderStateSharingPolicyV1 {
  return resolveConnectedServicesProviderStateSharingPolicyV1(
    settingsLike?.connectedServicesProviderStateSharingSettingsV1,
    'codex',
  );
}

function dedupeEntries(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

function asTomlTable(value: TomlValue | undefined): TomlTable | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as TomlTable : null;
}

async function readCodexProfileHookState(effectiveCodexHome: string): Promise<TomlTable> {
  const configPath = join(effectiveCodexHome, 'config.toml');
  try {
    // Only preferences owned by this profile may survive replacement. A linked
    // native config does not establish a profile-owned hook trust decision.
    if (!(await lstat(configPath)).isFile()) return {};
    const content = await readFile(configPath, 'utf8');
    let config: TomlTable;
    try {
      config = parseConnectedServiceTomlConfig(content, configPath);
    } catch (error) {
      logger.infoFile('[Codex] Rebuilding malformed profile config from native config or defaults', error);
      return {};
    }
    const states = asTomlTable(asTomlTable(config.hooks)?.state);
    const ownState: TomlTable = {};
    for (const [key, value] of Object.entries(states ?? {})) {
      if (!CODEX_HOOK_CONFIG_ENTRIES.some((entry) => key.startsWith(`${join(effectiveCodexHome, entry)}:`))) continue;
      const state = asTomlTable(value);
      if (!state) continue;
      const fields: TomlTable = {};
      if (typeof state.trusted_hash === 'string') fields.trusted_hash = state.trusted_hash;
      if (typeof state.enabled === 'boolean') fields.enabled = state.enabled;
      if (Object.keys(fields).length > 0) ownState[key] = fields;
    }
    return ownState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
    throw error;
  }
}

function mergeCodexHookState(content: string, ownState: TomlTable, sourceHome: string, effectiveHome: string): string {
  const config = parseConnectedServiceTomlConfig(content, join(sourceHome, 'config.toml'));
  const hooks = asTomlTable(config.hooks);
  const sourceState = asTomlTable(hooks?.state);
  if (!sourceState && Object.keys(ownState).length === 0) return content;
  const rebasedState = Object.fromEntries(Object.entries(sourceState ?? {}).map(([key, value]) => {
    for (const entry of CODEX_HOOK_CONFIG_ENTRIES) {
      const prefix = `${join(sourceHome, entry)}:`;
      if (key.startsWith(prefix)) return [`${join(effectiveHome, entry)}:${key.slice(prefix.length)}`, value];
    }
    return [key, value];
  }));
  config.hooks = { ...hooks, state: { ...rebasedState, ...ownState } };
  // Retain native trust hashes verbatim. Codex remains the authority that
  // compares them with the current hook definition and marks changes untrusted.
  return stringify(config);
}

async function resolveCodexConfigEntryNames(sourceCodexHome: string): Promise<readonly string[]> {
  const names: string[] = [];
  for (const descriptorEntry of codexConnectedServiceStateSharingDescriptor.config.entries) {
    if (descriptorEntry.path !== 'skills') {
      names.push(descriptorEntry.path);
      continue;
    }
    const skillsPath = join(sourceCodexHome, 'skills');
    let childNames: string[];
    try {
      childNames = await readdir(skillsPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === 'ENOENT') continue;
      throw error;
    }
    for (const childName of childNames) {
      names.push(join('skills', childName));
    }
  }
  return dedupeEntries(names);
}

function toStateSymlinkUnavailableDiagnostic(
  error: ConnectedServiceSharedStateLinkUnavailableError,
): CodexConnectedServiceStateSharingDiagnostic {
  return {
    code: 'state_symlink_unavailable',
    providerId: 'codex',
    requestedStateMode: 'shared',
    effectiveStateMode: 'isolated',
    entryName: error.entryName,
    reason: 'symlink_unavailable',
    ...(error.fsCode ? { fsCode: error.fsCode } : {}),
  };
}

function resolveSourceCodexHome(params: Readonly<{
  destinationCodexHome: string;
  processEnv: NodeJS.ProcessEnv;
}>): string | null {
  const sourceCodexHome = resolve(resolveConfiguredCodexHome(params.processEnv));
  if (sourceCodexHome === resolve(params.destinationCodexHome)) return null;
  return sourceCodexHome;
}

function resolveVendorResumeIdFromImportedRollout(
  detail: ConnectedServiceSessionFileImportDetail,
): string | null {
  const candidates = [basename(detail.sourcePath), basename(detail.destinationPath), detail.relativePath];
  for (const candidate of candidates) {
    const threadId = parseCodexRolloutFilename(candidate)?.threadId;
    if (threadId) return threadId;
  }
  return null;
}

async function ensureNativeCodexSharedStateStore(sourceCodexHome: string): Promise<void> {
  await mkdir(sourceCodexHome, { recursive: true });
  await Promise.all(CODEX_SHARED_STATE_DIRECTORY_ENTRIES.map(async (entryName) => {
    await mkdir(join(sourceCodexHome, entryName), { recursive: true });
  }));
  await Promise.all(CODEX_SHARED_STATE_FILE_ENTRIES.map(async (entryName) => {
    const handle = await open(join(sourceCodexHome, entryName), 'a');
    await handle.close();
  }));
}

async function backfillCodexNonSessionState(params: Readonly<{
  destinationCodexHome: string;
  previousCodexHome?: string | null;
  sourceCodexHome: string;
}>): Promise<void> {
  for (const stateSourceHome of dedupeEntries([
    resolve(params.destinationCodexHome),
    ...(params.previousCodexHome ? [resolve(params.previousCodexHome)] : []),
  ])) {
    await importConnectedServiceSessionFiles({
      roots: [{
        sourceRoot: stateSourceHome,
        destinationRoot: params.sourceCodexHome,
        includeDirectory: (relativePath) =>
          relativePath === 'memories' || relativePath.startsWith('memories/'),
        includeFile: (relativePath) =>
          relativePath.startsWith('memories/'),
      }],
    });
    await reconcileCodexSharedJsonlState({
      previousCodexHome: stateSourceHome,
      sourceCodexHome: params.sourceCodexHome,
    });
  }
}

async function withCodexSharedStatePreflightSource<T>(params: Readonly<{
  enabled: boolean;
  sourceCodexHome: string;
  run: (preflightSourceCodexHome: string | null) => Promise<T>;
}>): Promise<T> {
  if (!params.enabled) return await params.run(null);
  await mkdir(params.sourceCodexHome, { recursive: true });
  // Shared preparation holds the source-home lock for this whole callback. A prior invocation
  // cannot still own a scratch directory here, so remove interrupted preflights before ours exists.
  for (const entry of await readdir(params.sourceCodexHome, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('.happier-state-preflight-')) {
      await rm(join(params.sourceCodexHome, entry.name), { recursive: true, force: true });
    }
  }
  const preflightSourceCodexHome = await mkdtemp(join(params.sourceCodexHome, '.happier-state-preflight-'));
  try {
    await Promise.all(CODEX_SHARED_STATE_DIRECTORY_ENTRIES.map(async (entryName) => {
      await mkdir(join(preflightSourceCodexHome, entryName), { recursive: true });
    }));
    await Promise.all(CODEX_SHARED_STATE_FILE_ENTRIES.map(async (entryName) => {
      const handle = await open(join(preflightSourceCodexHome, entryName), 'w');
      await handle.close();
    }));
    return await params.run(preflightSourceCodexHome);
  } finally {
    await rm(preflightSourceCodexHome, { recursive: true, force: true });
  }
}

export async function syncCodexConnectedServiceHome(params: Readonly<{
  destinationCodexHome: string;
  previousCodexHome?: string | null;
  activeServerDir?: string;
  vendorResumeId?: string | null;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<SyncCodexConnectedServiceHomeResult> {
  const settings = resolveCodexHomeSharingSettings(params.accountSettings ?? null);
  const processEnv = params.processEnv ?? process.env;
  const configuredSourceCodexHome = resolveSourceCodexHome({
    destinationCodexHome: params.destinationCodexHome,
    processEnv,
  });
  const sourceCodexHome = configuredSourceCodexHome ?? resolve(params.destinationCodexHome);
  const lockRoots = settings.stateMode === 'shared' && configuredSourceCodexHome
    ? [params.destinationCodexHome, sourceCodexHome]
    : [params.destinationCodexHome];
  return await withConnectedServiceStateSharingLocks(lockRoots, async () => {
    const sourceSqliteHome = resolve(resolveConfiguredCodexSqliteHome(processEnv));
    if (!configuredSourceCodexHome && settings.stateMode === 'shared') {
      return {
        providerId: 'codex',
        requestedStateMode: settings.stateMode,
        effectiveStateMode: settings.stateMode,
        diagnostics: [],
        targetSqliteHome: settings.stateMode === 'shared'
          ? sourceSqliteHome
          : params.destinationCodexHome,
      };
    }

    await mkdir(params.destinationCodexHome, { recursive: true });
    const manifest = await readConnectedServiceStateSharingManifest(params.destinationCodexHome);
    const hookState = settings.configMode === 'isolated'
      ? {}
      : await readCodexProfileHookState(params.destinationCodexHome);
    const configEntryNames = await resolveCodexConfigEntryNames(sourceCodexHome);
    const stateEntryNames = codexConnectedServiceStateSharingDescriptor.state.entries.map((entry) => entry.path);

    const applyResult = await withCodexSharedStatePreflightSource({
      enabled: settings.stateMode === 'shared',
      sourceCodexHome,
      run: async (preflightSourceCodexHome) => await applyConnectedServiceStateSharingDescriptor({
        descriptor: codexConnectedServiceStateSharingDescriptor,
        nativeSourceContext: {
          sourceRoot: sourceCodexHome,
          sourceEnv: processEnv as Record<string, string>,
        },
        target: {
          targetMaterializedRoot: params.destinationCodexHome,
          targetMaterializedEnv: {},
        },
        configMode: settings.configMode,
        requestedStateMode: settings.stateMode,
        effectiveStateMode: settings.stateMode,
        cwd: process.cwd(),
        existingManifest: manifest,
        configEntryNames,
        copyTransformByEntry: {
          'config.toml': (content) => mergeCodexHookState(content, hookState, sourceCodexHome,
            resolve(params.destinationCodexHome)),
        },
        stateEntryNames,
        prepareSharedStateSource: preflightSourceCodexHome ? async () => {
          await backfillCodexNonSessionState({
            destinationCodexHome: params.destinationCodexHome,
            previousCodexHome: params.previousCodexHome ?? null,
            sourceCodexHome,
          });
          await ensureNativeCodexSharedStateStore(sourceCodexHome);
        } : undefined,
        resolveStatePreflightSourceRoot: preflightSourceCodexHome
          ? () => preflightSourceCodexHome
          : undefined,
        resolveStateSourceRoot: () => sourceCodexHome,
        mapStateSymlinkUnavailableDiagnostic: (error) => toStateSymlinkUnavailableDiagnostic(error),
        sessionImportRoots: settings.stateMode === 'shared'
          ? dedupeEntries([
            resolve(params.destinationCodexHome),
            ...(params.previousCodexHome ? [resolve(params.previousCodexHome)] : []),
          ]).flatMap((sessionSourceHome) => CODEX_IMPORTABLE_SESSION_HOME_ENTRIES.map((entryName) => ({
            sourceRoot: join(sessionSourceHome, entryName),
            destinationRoot: join(sourceCodexHome, entryName),
            includeFile: isCodexRolloutFilePath,
          })))
          : [],
        resolveVendorResumeIdFromImportedFile: resolveVendorResumeIdFromImportedRollout,
        providerLabel: 'Codex',
      }),
    });

    if (settings.stateMode === 'isolated' && params.previousCodexHome
      && resolve(params.previousCodexHome) !== resolve(params.destinationCodexHome)) {
      let previousAccountHome: string | null = null;
      if (params.activeServerDir) {
        try {
          const [accountHomesRoot, previousRoot] = await Promise.all([
            realpath(resolveConnectedServiceHomesDir({ activeServerDir: params.activeServerDir })),
            realpath(params.previousCodexHome),
          ]);
          if (isConnectedServiceStateRootWithin(accountHomesRoot, previousRoot)) previousAccountHome = previousRoot;
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
        }
      }
      if (previousAccountHome) {
        const vendorResumeId = normalizeCodexVendorResumeId(params.vendorResumeId);
        if (vendorResumeId) {
          // Account-local history is not session carry-forward. Adopt only the requested
          // conversation through the same importer; archives, memories and fixed indexes stay local.
          await importConnectedServiceSessionFiles({ roots: [{
            sourceRoot: join(previousAccountHome, 'sessions'),
            destinationRoot: join(params.destinationCodexHome, 'sessions'),
            includeFile: path => isMatchingCodexRolloutFileName(basename(path), vendorResumeId),
          }] });
        }
      } else {
        const entries = codexConnectedServiceStateSharingDescriptor.state.entries.map((entry) => entry.path);
        // Legacy per-session homes belong to this resumed session, not another account. Canonical
        // preparation detaches borrowed state first; symlinked ambient state is never bulk-imported.
        await importConnectedServiceSessionFiles({ roots: [{
          sourceRoot: params.previousCodexHome, destinationRoot: params.destinationCodexHome,
          includeDirectory: (path) => entries.some((entry) => path === entry || path.startsWith(`${entry}/`) || entry.startsWith(`${path}/`)),
          includeFile: (path) => !isCodexFixedJsonlStateFile(path)
            && entries.some((entry) => path === entry || path.startsWith(`${entry}/`)),
        }] });
        await reconcileCodexSharedJsonlState({
          previousCodexHome: params.previousCodexHome,
          sourceCodexHome: params.destinationCodexHome,
          localStateOnly: true,
        });
      }
    }
    await writeConnectedServiceStateSharingManifest(params.destinationCodexHome, applyResult.manifest);
    await removeLegacyConnectedServiceStateSharingManifest(params.destinationCodexHome);

    return {
      providerId: 'codex',
      requestedStateMode: settings.stateMode,
      effectiveStateMode: applyResult.manifest.effectiveStateMode,
      diagnostics: applyResult.diagnostics as readonly CodexConnectedServiceStateSharingDiagnostic[],
      targetSqliteHome: applyResult.manifest.effectiveStateMode === 'shared'
        ? sourceSqliteHome
        : params.destinationCodexHome,
    };
  }, { providerId: 'codex' });
}
