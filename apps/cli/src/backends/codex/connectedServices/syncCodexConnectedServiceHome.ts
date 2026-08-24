import { mkdir, mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import {
  resolveConnectedServicesProviderStateSharingPolicyV1,
  type AccountSettings,
  type ConnectedServicesProviderStateSharingPolicyV1,
} from '@happier-dev/protocol';

import { codexConnectedServiceStateSharingDescriptor } from '@/backends/codex/connectedServices/codexConnectedServiceStateSharingDescriptor';
import { resolveConfiguredCodexHome } from '@/backends/codex/utils/resolveConfiguredCodexHome';
import { ConnectedServiceSharedStateLinkUnavailableError } from '@/daemon/connectedServices/stateSharing/createSharedStateLink';
import { withConnectedServiceStateSharingDestinationLock } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingLock';
import {
  readConnectedServiceStateSharingManifest,
  removeLegacyConnectedServiceStateSharingManifest,
  writeConnectedServiceStateSharingManifest,
} from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';
import { applyConnectedServiceStateSharingDescriptor } from '@/daemon/connectedServices/stateSharing/applyConnectedServiceStateSharingDescriptor';
import {
  importConnectedServiceSessionFiles,
  type ConnectedServiceSessionFileImportDetail,
} from '@/daemon/connectedServices/stateSharing/importConnectedServiceSessionFiles';

import { resolveConfiguredCodexSqliteHome } from './codexStateFileNames';

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
    const match = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(candidate);
    if (match) return match[1];
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

async function backfillPreviousCodexNonSessionState(params: Readonly<{
  previousCodexHome?: string | null;
  sourceCodexHome: string;
}>): Promise<void> {
  if (!params.previousCodexHome) return;
  await importConnectedServiceSessionFiles({
    roots: [{
      sourceRoot: params.previousCodexHome,
      destinationRoot: params.sourceCodexHome,
      includeDirectory: (relativePath) =>
        relativePath === 'memories' || relativePath.startsWith('memories/'),
      includeFile: (relativePath) =>
        relativePath.startsWith('memories/')
        || CODEX_SHARED_STATE_FILE_ENTRIES.some((entryName) => entryName === relativePath),
    }],
  });
}

async function withCodexSharedStatePreflightSource<T>(params: Readonly<{
  enabled: boolean;
  sourceCodexHome: string;
  run: (preflightSourceCodexHome: string | null) => Promise<T>;
}>): Promise<T> {
  if (!params.enabled) return await params.run(null);
  await mkdir(params.sourceCodexHome, { recursive: true });
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
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<SyncCodexConnectedServiceHomeResult> {
  return await withConnectedServiceStateSharingDestinationLock(params.destinationCodexHome, async () => {
    const settings = resolveCodexHomeSharingSettings(params.accountSettings ?? null);
    const processEnv = params.processEnv ?? process.env;
    const sourceSqliteHome = resolve(resolveConfiguredCodexSqliteHome(processEnv));
    const sourceCodexHome = resolveSourceCodexHome({
      destinationCodexHome: params.destinationCodexHome,
      processEnv,
    });
    if (!sourceCodexHome) {
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
        stateEntryNames,
        prepareSharedStateSource: preflightSourceCodexHome ? async () => {
          await backfillPreviousCodexNonSessionState({
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
            includeFile: (relativePath: string) => relativePath.toLowerCase().endsWith('.jsonl'),
          })))
          : [],
        resolveVendorResumeIdFromImportedFile: resolveVendorResumeIdFromImportedRollout,
        providerLabel: 'Codex',
      }),
    });

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
