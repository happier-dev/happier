import { lstat, mkdir, readdir, realpath, rename, rm, stat, symlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  resolveConnectedServicesProviderStateSharingPolicyV1,
  type AccountSettings,
  type ConnectedServicesProviderStateSharingPolicyV1,
} from '@happier-dev/protocol';

import { resolveConfiguredClaudeConfigDir } from '@/backends/claude/utils/resolveConfiguredClaudeConfigDir';
import { applyConnectedServiceStateSharingDescriptor } from '@/daemon/connectedServices/stateSharing/applyConnectedServiceStateSharingDescriptor';
import { moveConnectedServiceHomeEntryAside } from '@/daemon/connectedServices/stateSharing/connectedServiceHomeEntrySync';
import { withConnectedServiceStateSharingDestinationLock } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingLock';
import {
  readConnectedServiceStateSharingManifest,
  type ConnectedServiceStateSharingManifestV1,
  type ConnectedServiceStateSharingSessionFileMappingV1,
  writeConnectedServiceStateSharingManifest,
} from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';
import type { ConnectedServicesMaterializationDiagnostic } from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import type {
  ConnectedServiceSessionFileImportDetail,
  ConnectedServiceSessionFileImportRoot,
} from '@/daemon/connectedServices/stateSharing/importConnectedServiceSessionFiles';
import { importConnectedServiceSessionFiles } from '@/daemon/connectedServices/stateSharing/importConnectedServiceSessionFiles';

import { claudeConnectedServiceStateSharingDescriptor } from './claudeConnectedServiceStateSharingDescriptor';
import { materializeClaudeWorkspaceTrust } from './materializeClaudeWorkspaceTrust';
import { applyClaudeSessionRetentionSettings, readClaudeSessionRetentionPolicy } from '../settings/claudeSessionRetentionSettings';

const CLAUDE_CREDENTIAL_HOME_ENTRIES = Object.freeze([
  '.claude.json',
  '.credentials.json',
  'credentials.json',
  'auth.json',
  'accounts',
] as const);

type ClaudeStateMode = 'shared' | 'isolated';

export type SyncClaudeConnectedServiceHomeResult = Readonly<{
  providerId: 'claude';
  requestedStateMode: ClaudeStateMode;
  effectiveStateMode: ClaudeStateMode;
  diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];
}>;

export function resolveClaudeHomeSharingSettings(
  settingsLike: AccountSettings | Readonly<Record<string, unknown>> | null | undefined,
): ConnectedServicesProviderStateSharingPolicyV1 {
  return resolveConnectedServicesProviderStateSharingPolicyV1(
    settingsLike?.connectedServicesProviderStateSharingSettingsV1,
    'claude',
  );
}

function resolveVendorResumeIdFromImportedClaudeSession(
  detail: ConnectedServiceSessionFileImportDetail,
): string | null {
  for (const path of [detail.relativePath, detail.sourcePath, detail.destinationPath]) {
    const fileName = basename(path);
    if (!fileName.toLowerCase().endsWith('.jsonl')) continue;
    const candidate = fileName.replace(/\.jsonl$/i, '').trim();
    if (!candidate || candidate.includes('/') || candidate.includes('\\')) continue;
    // Rule-A safety: a conflict-suffixed import (`<id>.happier-import-<hash>.jsonl`) is NOT a file
    // Claude's `--resume <id>` will ever read. Mapping it would let `canResumeFromMaterializedState`
    // validate a path the vendor cannot resume from, so only canonical-named destinations map.
    if (basename(detail.destinationPath).toLowerCase() !== `${candidate.toLowerCase()}.jsonl`) return null;
    return candidate;
  }
  return null;
}

async function removeClaudeCredentialEntries(
  targetDir: string,
  opts?: Readonly<{ preserveNativeAuthFiles?: boolean }>,
): Promise<void> {
  for (const entry of CLAUDE_CREDENTIAL_HOME_ENTRIES) {
    // The native-auth owner reconciles these target-owned files separately. Configuration
    // refresh must neither delete them nor import their counterparts from the source home.
    if (opts?.preserveNativeAuthFiles === true && (entry === '.credentials.json' || entry === '.claude.json')) continue;
    await rm(join(targetDir, entry), { recursive: true, force: true });
  }
}

function normalizeVendorResumeId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\')) return null;
  return trimmed;
}

function normalizeImportRelativePath(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).join('/');
}

function isSafeImportRelativePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.startsWith('\\')) return false;
  return !path.split('/').includes('..');
}

function resolveClaudeProjectsRootForSessionFile(path: string): string | null {
  let current = dirname(path);
  while (true) {
    if (basename(current) === 'projects') return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function pathExistsAsRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

async function readFileMtimeMs(path: string): Promise<number | null> {
  try {
    const fileStat = await stat(path);
    return fileStat.isFile() ? fileStat.mtimeMs : null;
  } catch {
    return null;
  }
}

type ClaudeCandidateSessionImportPlan = Readonly<{
  importRoot: ConnectedServiceSessionFileImportRoot;
  vendorResumeId: string;
  candidateSourcePath: string;
  canonicalDestinationPath: string;
  destinationDir: string;
}>;

async function resolveCandidatePersistedClaudeSessionImportPlan(params: Readonly<{
  candidatePersistedSessionFile?: string | null;
  vendorResumeId?: string | null;
  destinationProjectsRoot: string;
}>): Promise<ClaudeCandidateSessionImportPlan | null> {
  const vendorResumeId = normalizeVendorResumeId(params.vendorResumeId);
  const candidate = typeof params.candidatePersistedSessionFile === 'string'
    ? params.candidatePersistedSessionFile.trim()
    : '';
  if (!vendorResumeId || !candidate) return null;
  if (!isAbsolute(candidate)) return null;
  if (basename(candidate).toLowerCase() !== `${vendorResumeId.toLowerCase()}.jsonl`) return null;
  if (!await pathExistsAsRegularFile(candidate)) return null;
  const sourceRoot = resolveClaudeProjectsRootForSessionFile(candidate);
  if (!sourceRoot) return null;
  const relativePath = normalizeImportRelativePath(relative(sourceRoot, candidate));
  if (!isSafeImportRelativePath(relativePath)) return null;
  const canonicalDestinationPath = join(params.destinationProjectsRoot, ...relativePath.split('/'));
  return {
    importRoot: {
      sourceRoot,
      destinationRoot: params.destinationProjectsRoot,
      includeFile: (candidateRelativePath) =>
        normalizeImportRelativePath(candidateRelativePath) === relativePath,
    },
    vendorResumeId,
    candidateSourcePath: candidate,
    canonicalDestinationPath,
    destinationDir: dirname(canonicalDestinationPath),
  };
}

/**
 * Newest-content-wins reconciliation for `<id>.happier-import-<hash>.jsonl` conflict copies
 * (INC-5): a conflict copy newer than the canonical `<id>.jsonl` is promoted over it (it is the
 * most complete transcript for an append-only vendor jsonl); a stale conflict copy is removed so
 * a Rule-A probe can never validate a divergent file Claude's `--resume <id>` will not read.
 */
async function reconcileClaudeConflictedSessionImports(params: Readonly<{
  destinationDir: string;
  vendorResumeId: string;
  canonicalDestinationPath: string;
}>): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(params.destinationDir);
  } catch {
    return;
  }
  const conflictPrefix = `${params.vendorResumeId.toLowerCase()}.happier-import-`;
  for (const entryName of entries) {
    const lowerName = entryName.toLowerCase();
    if (!lowerName.startsWith(conflictPrefix) || !lowerName.endsWith('.jsonl')) continue;
    const conflictPath = join(params.destinationDir, entryName);
    const conflictMtimeMs = await readFileMtimeMs(conflictPath);
    if (conflictMtimeMs === null) continue;
    const canonicalMtimeMs = await readFileMtimeMs(params.canonicalDestinationPath);
    if (canonicalMtimeMs === null || conflictMtimeMs > canonicalMtimeMs) {
      try {
        await rename(conflictPath, params.canonicalDestinationPath);
      } catch {
        // Keep the conflict copy when promotion fails; the canonical file still wins mappings.
      }
      continue;
    }
    await rm(conflictPath, { force: true });
  }
}

async function importClaudeCandidatePersistedSessionFile(params: Readonly<{
  candidatePersistedSessionFile?: string | null;
  vendorResumeId?: string | null;
  destinationProjectsRoot: string;
}>): Promise<readonly ConnectedServiceStateSharingSessionFileMappingV1[]> {
  const plan = await resolveCandidatePersistedClaudeSessionImportPlan(params);
  if (!plan) return [];
  const canonicalMtimeMs = await readFileMtimeMs(plan.canonicalDestinationPath);
  const candidateMtimeMs = await readFileMtimeMs(plan.candidateSourcePath);
  // Import only when the candidate can win: importing an older divergent copy would only mint a
  // stale conflict file next to a newer canonical jsonl (INC-5).
  if (canonicalMtimeMs === null || (candidateMtimeMs !== null && candidateMtimeMs > canonicalMtimeMs)) {
    await importConnectedServiceSessionFiles({ roots: [plan.importRoot] });
  }
  await reconcileClaudeConflictedSessionImports({
    destinationDir: plan.destinationDir,
    vendorResumeId: plan.vendorResumeId,
    canonicalDestinationPath: plan.canonicalDestinationPath,
  });
  if (!await pathExistsAsRegularFile(plan.canonicalDestinationPath)) return [];
  return [{
    vendorResumeId: plan.vendorResumeId,
    sourcePath: plan.candidateSourcePath,
    destinationPath: plan.canonicalDestinationPath,
    importedAtMs: Date.now(),
    verifiedAtMs: null,
  }];
}

async function mergeClaudeSessionFileMappings(params: Readonly<{
  previousMappings: readonly ConnectedServiceStateSharingSessionFileMappingV1[];
  nextMappings: readonly ConnectedServiceStateSharingSessionFileMappingV1[];
}>): Promise<readonly ConnectedServiceStateSharingSessionFileMappingV1[]> {
  const merged = [...params.nextMappings];
  const seenVendorResumeIds = new Set(params.nextMappings.map((mapping) => mapping.vendorResumeId));
  for (const mapping of params.previousMappings) {
    if (seenVendorResumeIds.has(mapping.vendorResumeId)) continue;
    if (!await pathExistsAsRegularFile(mapping.destinationPath)) continue;
    if (basename(mapping.destinationPath).toLowerCase() !== `${mapping.vendorResumeId.toLowerCase()}.jsonl`) continue;
    seenVendorResumeIds.add(mapping.vendorResumeId);
    merged.push(mapping);
  }
  return merged;
}

function buildSelfSourceManifest(params: Readonly<{
  existingManifest: ConnectedServiceStateSharingManifestV1;
  requestedStateMode: ClaudeStateMode;
  effectiveStateMode: ClaudeStateMode;
  stateEntries: readonly string[];
  diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];
  sessionFileMappings: readonly ConnectedServiceStateSharingSessionFileMappingV1[];
}>): ConnectedServiceStateSharingManifestV1 {
  return {
    v: 1,
    requestedStateMode: params.requestedStateMode,
    effectiveStateMode: params.effectiveStateMode,
    lastSyncAtMs: Date.now(),
    configEntries: params.existingManifest.configEntries,
    stateEntries: params.stateEntries,
    sessionFileMappings: params.sessionFileMappings,
    diagnostics: params.diagnostics,
  };
}

type ClaudeProjectsEntryState = 'missing' | 'symlink' | 'directory' | 'other';

async function readClaudeProjectsEntryState(path: string): Promise<ClaudeProjectsEntryState> {
  try {
    const entryStat = await lstat(path);
    if (entryStat.isSymbolicLink()) return 'symlink';
    if (entryStat.isDirectory()) return 'directory';
    return 'other';
  } catch {
    return 'missing';
  }
}

function resolveAmbientClaudeStateSourceDir(params: Readonly<{
  ambientStateSourceDir?: string | null;
  sourceEnv: NodeJS.ProcessEnv;
}>): string {
  const explicit = typeof params.ambientStateSourceDir === 'string' ? params.ambientStateSourceDir.trim() : '';
  if (explicit) return explicit;
  const envWithoutOverrides = { ...params.sourceEnv };
  delete envWithoutOverrides.CLAUDE_CONFIG_DIR;
  delete envWithoutOverrides.HAPPIER_CLAUDE_CONFIG_DIR;
  return resolveConfiguredClaudeConfigDir({ env: envWithoutOverrides });
}

function buildSelfSourceSharedStateUnavailableDiagnostic(reason: string): ConnectedServicesMaterializationDiagnostic {
  return {
    code: 'claude_shared_state_link_unavailable',
    providerId: 'claude',
    severity: 'blocking',
    serviceId: 'claude-subscription',
    requestedStateMode: 'shared',
    effectiveStateMode: 'isolated',
    entryName: 'projects',
    reason,
  };
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

type SelfSourceProjectsReconciliation = Readonly<{
  effectiveStateMode: ClaudeStateMode;
  /** Physical root candidate session imports must land in when shared (the link source). */
  sharedProjectsRoot: string | null;
  stateEntries: readonly string[];
  diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];
}>;

/**
 * RD-MAT-2: a provenance-matched (self-source) home never re-ran the state-sharing descriptor, so
 * a sharing-policy toggle left the on-disk `projects` link/dir state diverged from the manifest in
 * BOTH directions (isolated dir behind a `shared` manifest; live shared link behind an `isolated`
 * manifest — a privacy regression). Reconcile the physical state with the CURRENT policy on every
 * materialization pass, preserving session files in both conversion directions.
 */
async function reconcileSelfSourceClaudeProjectsStateMode(params: Readonly<{
  targetDir: string;
  requestedStateMode: ClaudeStateMode;
  ambientStateSourceDir: string;
}>): Promise<SelfSourceProjectsReconciliation> {
  const targetProjectsRoot = join(params.targetDir, 'projects');
  const entryState = await readClaudeProjectsEntryState(targetProjectsRoot);

  if (params.requestedStateMode === 'isolated') {
    if (entryState === 'symlink') {
      await rm(targetProjectsRoot, { force: true });
    }
    await mkdir(targetProjectsRoot, { recursive: true }).catch(() => {});
    return {
      effectiveStateMode: 'isolated',
      sharedProjectsRoot: null,
      stateEntries: [],
      diagnostics: [],
    };
  }

  const ambientProjectsRoot = join(params.ambientStateSourceDir, 'projects');
  if (resolve(params.ambientStateSourceDir) === resolve(params.targetDir)) {
    return {
      effectiveStateMode: 'isolated',
      sharedProjectsRoot: null,
      stateEntries: [],
      diagnostics: [buildSelfSourceSharedStateUnavailableDiagnostic('shared_state_source_unavailable')],
    };
  }

  try {
    await mkdir(ambientProjectsRoot, { recursive: true });
    if (entryState === 'symlink') {
      const [linkedRealPath, ambientRealPath] = await Promise.all([
        realpathOrNull(targetProjectsRoot),
        realpathOrNull(ambientProjectsRoot),
      ]);
      if (linkedRealPath && ambientRealPath && linkedRealPath === ambientRealPath) {
        return {
          effectiveStateMode: 'shared',
          sharedProjectsRoot: ambientProjectsRoot,
          stateEntries: ['projects'],
          diagnostics: [],
        };
      }
      await rm(targetProjectsRoot, { force: true });
    } else if (entryState === 'directory') {
      // Preserve isolated-era sessions: backfill them into the shared store before linking.
      await importConnectedServiceSessionFiles({
        roots: [{
          sourceRoot: targetProjectsRoot,
          destinationRoot: ambientProjectsRoot,
          includeFile: (relativePath: string) => relativePath.toLowerCase().endsWith('.jsonl'),
        }],
      });
      await moveConnectedServiceHomeEntryAside(targetProjectsRoot);
    } else if (entryState === 'other') {
      await moveConnectedServiceHomeEntryAside(targetProjectsRoot);
    }
    await symlink(ambientProjectsRoot, targetProjectsRoot, process.platform === 'win32' ? 'junction' : 'dir');
    return {
      effectiveStateMode: 'shared',
      sharedProjectsRoot: ambientProjectsRoot,
      stateEntries: ['projects'],
      diagnostics: [],
    };
  } catch {
    return {
      effectiveStateMode: 'isolated',
      sharedProjectsRoot: null,
      stateEntries: [],
      diagnostics: [buildSelfSourceSharedStateUnavailableDiagnostic('shared_state_link_failed')],
    };
  }
}

export async function syncClaudeConnectedServiceHome(params: Readonly<{
  sourceEnv: NodeJS.ProcessEnv;
  targetDir: string;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  sessionDirectory?: string | null;
  preserveNativeAuthFiles?: boolean | undefined;
  sharingPolicyOverride?: ConnectedServicesProviderStateSharingPolicyV1 | null | undefined;
  vendorResumeId?: string | null | undefined;
  candidatePersistedSessionFile?: string | null | undefined;
  /**
   * Ambient native store root (`~/.claude`-equivalent) used to reconcile a self-source home's
   * `projects` link with the CURRENT sharing policy. Derived from the source env without
   * config-dir overrides when not provided.
   */
  ambientStateSourceDir?: string | null | undefined;
  destinationLockAlreadyHeld?: boolean | undefined;
}>): Promise<SyncClaudeConnectedServiceHomeResult> {
  const sync = async (): Promise<SyncClaudeConnectedServiceHomeResult> => {
    const settings = params.sharingPolicyOverride ?? resolveClaudeHomeSharingSettings(params.accountSettings ?? null);
    const sourceDir = resolveConfiguredClaudeConfigDir({ env: params.sourceEnv });
    await mkdir(params.targetDir, { recursive: true });

    const applyRetention = async (): Promise<void> => {
      const policy = readClaudeSessionRetentionPolicy(params.accountSettings);
      if (!policy) return;
      const result = await applyClaudeSessionRetentionSettings({
        configDir: params.targetDir,
        id: 'materialized',
        policy,
      });
      if (result.status === 'error') throw new Error(`Claude session retention could not be configured: ${result.reason}`);
    };

    const existingManifest = await readConnectedServiceStateSharingManifest(params.targetDir);

    if (resolve(sourceDir) === resolve(params.targetDir)) {
      const reconciliation = await reconcileSelfSourceClaudeProjectsStateMode({
        targetDir: params.targetDir,
        requestedStateMode: settings.stateMode,
        ambientStateSourceDir: resolveAmbientClaudeStateSourceDir({
          ambientStateSourceDir: params.ambientStateSourceDir ?? null,
          sourceEnv: params.sourceEnv,
        }),
      });
      const importedSessionFileMappings = reconciliation.effectiveStateMode === 'shared' && reconciliation.sharedProjectsRoot
        ? await importClaudeCandidatePersistedSessionFile({
            vendorResumeId: params.vendorResumeId ?? null,
            candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
            destinationProjectsRoot: reconciliation.sharedProjectsRoot,
          })
        : [];
      await writeConnectedServiceStateSharingManifest(
        params.targetDir,
        buildSelfSourceManifest({
          existingManifest,
          requestedStateMode: settings.stateMode,
          effectiveStateMode: reconciliation.effectiveStateMode,
          stateEntries: reconciliation.stateEntries,
          diagnostics: reconciliation.diagnostics,
          sessionFileMappings: await mergeClaudeSessionFileMappings({
            previousMappings: existingManifest.sessionFileMappings,
            nextMappings: importedSessionFileMappings,
          }),
        }),
      );
      await applyRetention();
      return {
        providerId: 'claude',
        requestedStateMode: settings.stateMode,
        effectiveStateMode: reconciliation.effectiveStateMode,
        diagnostics: reconciliation.diagnostics,
      };
    }

    const removeCredentialEntriesOptions = {
      preserveNativeAuthFiles: params.preserveNativeAuthFiles === true,
    };
    await removeClaudeCredentialEntries(params.targetDir, removeCredentialEntriesOptions);

    const sharedSourceProjectsRoot = join(sourceDir, 'projects');
    // Candidate import runs BEFORE the descriptor applies (import-then-link, F15/H4 ordering) and
    // through the conflict-reconciling importer so divergent copies converge on the canonical jsonl.
    const candidateSessionFileMappings = settings.stateMode === 'shared'
      ? await importClaudeCandidatePersistedSessionFile({
          vendorResumeId: params.vendorResumeId ?? null,
          candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
          destinationProjectsRoot: sharedSourceProjectsRoot,
        })
      : [];
    const importSessionRoots = settings.stateMode === 'shared'
        ? [
            {
              sourceRoot: join(params.targetDir, 'projects'),
              destinationRoot: sharedSourceProjectsRoot,
              includeFile: (relativePath: string) => relativePath.toLowerCase().endsWith('.jsonl'),
            },
          ]
        : [];
    const applyResult = await applyConnectedServiceStateSharingDescriptor({
      descriptor: claudeConnectedServiceStateSharingDescriptor,
      nativeSourceContext: {
        sourceRoot: sourceDir,
        sourceEnv: params.sourceEnv as Record<string, string>,
      },
      target: {
        targetMaterializedRoot: params.targetDir,
        targetMaterializedEnv: {
          CLAUDE_CONFIG_DIR: params.targetDir,
        },
      },
      configMode: settings.configMode,
      requestedStateMode: settings.stateMode,
      effectiveStateMode: settings.stateMode,
      cwd: params.sessionDirectory ?? process.cwd(),
      existingManifest,
      sessionImportRoots: importSessionRoots,
      resolveVendorResumeIdFromImportedFile: resolveVendorResumeIdFromImportedClaudeSession,
      providerLabel: 'Claude',
    });

    await removeClaudeCredentialEntries(params.targetDir, removeCredentialEntriesOptions);
    // No post-descriptor source→target session import is needed: in shared mode the descriptor has
    // already materialized `projects` from the shared store (symlink or hard-link fallback), and
    // its `block_continuity` degrade policy means a link failure throws instead of leaving a
    // degraded-shared home — so a source-store re-import would only re-walk the store onto itself.
    await materializeClaudeWorkspaceTrust({
      sourceEnv: params.sourceEnv,
      targetDir: params.targetDir,
      sessionDirectory: params.sessionDirectory ?? process.cwd(),
      preserveExistingOauthAccountProjection: params.preserveNativeAuthFiles === true,
    });
    await writeConnectedServiceStateSharingManifest(params.targetDir, {
      ...applyResult.manifest,
      sessionFileMappings: await mergeClaudeSessionFileMappings({
        previousMappings: candidateSessionFileMappings,
        nextMappings: applyResult.manifest.sessionFileMappings,
      }),
    });

    await applyRetention();

    return {
      providerId: 'claude',
      requestedStateMode: settings.stateMode,
      effectiveStateMode: applyResult.manifest.effectiveStateMode,
      diagnostics: applyResult.diagnostics,
    };
  };
  if (params.destinationLockAlreadyHeld === true) {
    return await sync();
  }
  return await withConnectedServiceStateSharingDestinationLock(params.targetDir, sync, { providerId: 'claude' });
}
