import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CONNECTED_ACCOUNT_NATIVE_HOME_STATE_FILES, parseConnectedAccountNativeHomeState, type ConnectedAccountNativeHomeState } from '@happier-dev/plugin-sdk/fs';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

export type ConnectedServiceStateSharingMode = 'shared' | 'isolated';

export type ConnectedServiceStateSharingSessionFileMappingV1 = Readonly<{
  vendorResumeId: string;
  sourcePath: string | null;
  destinationPath: string;
  importedAtMs: number;
  verifiedAtMs: number | null;
}>;

/** Exact credential files produced for a Team delivery; native state remains home-owned. */
export type TeamCredentialNativeHomeDelivery = Readonly<{
  teamId?: string;
  resourceId: string;
  credentialPaths: readonly string[];
}>;

export type ConnectedServiceStateSharingManifestV1 = Readonly<{
  v: 1;
  requestedStateMode: ConnectedServiceStateSharingMode;
  effectiveStateMode: ConnectedServiceStateSharingMode;
  stateRootEnvironment?: ConnectedAccountNativeHomeState['stateRootEnvironment'];
  lastSyncAtMs: number;
  configEntries: readonly string[];
  stateEntries: readonly string[];
  /** Declared native state, including private entries not managed as shared links. */
  resumeStateEntries?: readonly string[];
  sessionFileMappings: readonly ConnectedServiceStateSharingSessionFileMappingV1[];
  diagnostics: readonly string[];
  teamCredentialDeliveries?: readonly TeamCredentialNativeHomeDelivery[];
}>;

const EMPTY_MANIFEST: ConnectedServiceStateSharingManifestV1 = Object.freeze({
  v: 1,
  requestedStateMode: 'isolated',
  effectiveStateMode: 'isolated',
  lastSyncAtMs: 0,
  configEntries: [],
  stateEntries: [],
  sessionFileMappings: [],
  diagnostics: [],
});

const DEFAULT_MANIFEST_NAME = CONNECTED_ACCOUNT_NATIVE_HOME_STATE_FILES.primary;
const LEGACY_CODEX_MANIFEST_NAME = CONNECTED_ACCOUNT_NATIVE_HOME_STATE_FILES.legacy;

export function isSafeConnectedServiceStateSharingEntry(entry: unknown): entry is string {
  if (typeof entry !== 'string' || entry.trim().length === 0 || isAbsolute(entry)) return false;
  const parts = entry.trim().split(/[\\/]+/).filter((part) => part.length > 0 && part !== '.');
  return parts.length > 0 && !parts.includes('..');
}

function parseManifest(value: unknown): ConnectedServiceStateSharingManifestV1 {
  const nativeHomeState = parseConnectedAccountNativeHomeState(value);
  const record = value as Record<string, unknown>;
  for (const key of ['stateEntries', 'resumeStateEntries']) {
    const entries = record[key];
    if (entries !== undefined && (
      !Array.isArray(entries) || !entries.every(isSafeConnectedServiceStateSharingEntry)
    )) throw new Error('connected_service_state_sharing_manifest_invalid');
  }
  return {
    v: 1,
    requestedStateMode: parseStateMode(record.requestedStateMode),
    ...nativeHomeState,
    lastSyncAtMs: parseNonNegativeInteger(record.lastSyncAtMs, 0),
    configEntries: Array.isArray(record.configEntries)
      ? record.configEntries.filter(isSafeConnectedServiceStateSharingEntry)
      : [],
    stateEntries: Array.isArray(record.stateEntries)
      ? record.stateEntries.filter(isSafeConnectedServiceStateSharingEntry)
      : [],
    ...(Array.isArray(record.resumeStateEntries)
      ? { resumeStateEntries: record.resumeStateEntries.filter(isSafeConnectedServiceStateSharingEntry) }
      : {}),
    sessionFileMappings: parseSessionFileMappings(record.sessionFileMappings),
    diagnostics: parseDiagnostics(record.diagnostics),
    ...(record.teamCredentialDeliveries === undefined ? {} : {
      teamCredentialDeliveries: parseTeamCredentialDeliveries(record.teamCredentialDeliveries),
    }),
  };
}

function parseTeamCredentialDeliveries(value: unknown): readonly TeamCredentialNativeHomeDelivery[] {
  if (!Array.isArray(value)) throw new Error('connected_service_state_sharing_manifest_invalid');
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('connected_service_state_sharing_manifest_invalid');
    const entry = item as Record<string, unknown>;
    if (typeof entry.resourceId !== 'string' || !entry.resourceId.trim()
      || entry.teamId !== undefined && (typeof entry.teamId !== 'string' || !entry.teamId.trim())
      || !Array.isArray(entry.credentialPaths) || !entry.credentialPaths.every(isSafeConnectedServiceStateSharingEntry)) {
      throw new Error('connected_service_state_sharing_manifest_invalid');
    }
    return { resourceId: entry.resourceId, ...(typeof entry.teamId === 'string' ? { teamId: entry.teamId } : {}),
      credentialPaths: entry.credentialPaths };
  });
}

function resolveManifestPath(destinationHome: string, manifestName = DEFAULT_MANIFEST_NAME): string {
  return join(destinationHome, manifestName);
}

function parseStateMode(value: unknown): ConnectedServiceStateSharingMode {
  return value === 'shared' ? 'shared' : 'isolated';
}

function parseNonNegativeInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function parseDiagnostics(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const diagnostics: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed) diagnostics.push(trimmed);
      continue;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
    if (reason) diagnostics.push(reason);
  }
  return diagnostics;
}

function parseSessionFileMappings(value: unknown): readonly ConnectedServiceStateSharingSessionFileMappingV1[] {
  if (!Array.isArray(value)) return [];
  const mappings: ConnectedServiceStateSharingSessionFileMappingV1[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.vendorResumeId !== 'string' || record.vendorResumeId.trim().length === 0) continue;
    if (typeof record.destinationPath !== 'string' || record.destinationPath.trim().length === 0) continue;
    mappings.push({
      vendorResumeId: record.vendorResumeId,
      sourcePath: typeof record.sourcePath === 'string' ? record.sourcePath : null,
      destinationPath: record.destinationPath,
      importedAtMs: parseNonNegativeInteger(record.importedAtMs, 0),
      verifiedAtMs: record.verifiedAtMs === null ? null : parseNonNegativeInteger(record.verifiedAtMs, 0),
    });
  }
  return mappings;
}

async function tryReadParsedManifest(path: string): Promise<ConnectedServiceStateSharingManifestV1 | null> {
  try {
    return parseManifest(JSON.parse(await readFile(path, 'utf8')));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

/** Presence is recognized by the same strict parser as every native-home reader. */
export async function readExistingConnectedServiceStateSharingManifest(
  destinationHome: string,
  manifestName?: string,
): Promise<ConnectedServiceStateSharingManifestV1 | null> {
  const primary = await tryReadParsedManifest(resolveManifestPath(destinationHome, manifestName));
  if (primary || manifestName) return primary;
  return await tryReadParsedManifest(resolveManifestPath(destinationHome, LEGACY_CODEX_MANIFEST_NAME));
}

export async function readConnectedServiceStateSharingManifest(
  destinationHome: string,
  manifestName?: string,
): Promise<ConnectedServiceStateSharingManifestV1> {
  return await readExistingConnectedServiceStateSharingManifest(destinationHome, manifestName) ?? EMPTY_MANIFEST;
}

/** Local resume data outlives process/Run custody; shared native-home links do not. */
export async function hasLocalConnectedServiceResumeState(homeRoot: string): Promise<boolean> {
  const manifest = await readConnectedServiceStateSharingManifest(homeRoot);
  // Predecessor isolated homes did not inventory their declared Codex state.
  // New homes derive that inventory from the Agent descriptor; isolation owns XDG state.
  const historicalEntries = manifest.resumeStateEntries === undefined
    ? ['sessions', 'archived_sessions', 'session_index.jsonl', 'history.jsonl', 'memories', 'projects']
    : [];
  const entries = new Set(['xdg/state', ...historicalEntries,
    ...manifest.stateEntries, ...(manifest.resumeStateEntries ?? [])]);
  const hasLocalFile = async (path: string): Promise<boolean> => {
    const entry = await lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw error;
    });
    if (!entry || entry.isSymbolicLink()) return false;
    if (entry.isFile()) return true;
    if (!entry.isDirectory()) return false;
    for (const child of await readdir(path)) {
      if (await hasLocalFile(join(path, child))) return true;
    }
    return false;
  };
  for (const entry of entries) {
    if (!isSafeConnectedServiceStateSharingEntry(entry)) continue;
    let path = homeRoot;
    let local = true;
    for (const segment of entry.split(/[\\/]+/).filter(segment => segment && segment !== '.')) {
      path = join(path, segment);
      const entryStat = await lstat(path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
        throw error;
      });
      if (!entryStat || entryStat.isSymbolicLink()) { local = false; break; }
    }
    if (local && await hasLocalFile(path)) return true;
  }
  return false;
}

export async function removeLegacyConnectedServiceStateSharingManifest(destinationHome: string): Promise<void> {
  await rm(resolveManifestPath(destinationHome, LEGACY_CODEX_MANIFEST_NAME), { force: true });
}

export async function writeConnectedServiceStateSharingManifest(
  destinationHome: string,
  manifest: ConnectedServiceStateSharingManifestV1,
  manifestName?: string,
  existingManifest?: ConnectedServiceStateSharingManifestV1,
): Promise<void> {
  const normalized = parseManifest(manifest);
  const path = resolveManifestPath(destinationHome, manifestName);
  const previous = existingManifest ?? await tryReadParsedManifest(path);
  // lastSyncAtMs is observation time, not a changed sharing fact.
  const unchanged = previous && isDeepStrictEqual(
    { ...previous, lastSyncAtMs: 0 }, { ...normalized, lastSyncAtMs: 0 },
  );
  const existing = unchanged ? await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }) : null;
  if (!existing?.isFile() || (process.platform !== 'win32' && (existing.mode & 0o077) !== 0)) {
    await writeJsonAtomic(path, normalized);
  }
  if (!manifestName || manifestName === DEFAULT_MANIFEST_NAME) {
    await rm(resolveManifestPath(destinationHome, LEGACY_CODEX_MANIFEST_NAME), { force: true });
  }
}

export async function removeConnectedServiceStateSharingManifestEntries(
  destinationHome: string,
  entryNames: readonly string[],
): Promise<void> {
  for (const entryName of entryNames) {
    if (!isSafeConnectedServiceStateSharingEntry(entryName)) continue;
    await rm(join(destinationHome, entryName), { recursive: true, force: true });
  }
}
