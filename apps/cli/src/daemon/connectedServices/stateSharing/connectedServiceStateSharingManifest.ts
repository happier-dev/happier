import { readFile, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

export type ConnectedServiceStateSharingMode = 'shared' | 'isolated';

export type ConnectedServiceStateSharingSessionFileMappingV1 = Readonly<{
  vendorResumeId: string;
  sourcePath: string | null;
  destinationPath: string;
  importedAtMs: number;
  verifiedAtMs: number | null;
}>;

export type ConnectedServiceStateSharingManifestV1 = Readonly<{
  v: 1;
  requestedStateMode: ConnectedServiceStateSharingMode;
  effectiveStateMode: ConnectedServiceStateSharingMode;
  lastSyncAtMs: number;
  configEntries: readonly string[];
  stateEntries: readonly string[];
  sessionFileMappings: readonly ConnectedServiceStateSharingSessionFileMappingV1[];
  diagnostics: readonly string[];
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

const DEFAULT_MANIFEST_NAME = '.happier-state-sharing.json';
const LEGACY_CODEX_MANIFEST_NAME = '.happier-codex-home-sharing.json';

export function isSafeConnectedServiceStateSharingEntry(entry: unknown): entry is string {
  if (typeof entry !== 'string' || entry.trim().length === 0 || isAbsolute(entry)) return false;
  const parts = entry.trim().split(/[\\/]+/).filter((part) => part.length > 0 && part !== '.');
  return parts.length > 0 && !parts.includes('..');
}

function parseManifest(value: unknown): ConnectedServiceStateSharingManifestV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY_MANIFEST;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return EMPTY_MANIFEST;
  return {
    v: 1,
    requestedStateMode: parseStateMode(record.requestedStateMode),
    effectiveStateMode: parseStateMode(record.effectiveStateMode),
    lastSyncAtMs: parseNonNegativeInteger(record.lastSyncAtMs, 0),
    configEntries: Array.isArray(record.configEntries)
      ? record.configEntries.filter(isSafeConnectedServiceStateSharingEntry)
      : [],
    stateEntries: Array.isArray(record.stateEntries)
      ? record.stateEntries.filter(isSafeConnectedServiceStateSharingEntry)
      : [],
    sessionFileMappings: parseSessionFileMappings(record.sessionFileMappings),
    diagnostics: parseDiagnostics(record.diagnostics),
  };
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
  } catch {
    return null;
  }
}

export async function readConnectedServiceStateSharingManifest(
  destinationHome: string,
  manifestName?: string,
): Promise<ConnectedServiceStateSharingManifestV1> {
  const primary = await tryReadParsedManifest(resolveManifestPath(destinationHome, manifestName));
  if (primary) return primary;
  if (manifestName) return EMPTY_MANIFEST;
  const legacy = await tryReadParsedManifest(resolveManifestPath(destinationHome, LEGACY_CODEX_MANIFEST_NAME));
  if (legacy) return legacy;
  return EMPTY_MANIFEST;
}

export async function removeLegacyConnectedServiceStateSharingManifest(destinationHome: string): Promise<void> {
  await rm(resolveManifestPath(destinationHome, LEGACY_CODEX_MANIFEST_NAME), { force: true });
}

export async function writeConnectedServiceStateSharingManifest(
  destinationHome: string,
  manifest: ConnectedServiceStateSharingManifestV1,
  manifestName?: string,
): Promise<void> {
  const normalized = parseManifest(manifest);
  await writeJsonAtomic(resolveManifestPath(destinationHome, manifestName), normalized);
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
