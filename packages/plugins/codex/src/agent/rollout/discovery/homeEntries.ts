import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  expandHomePath,
  isCanonicalAbsolutePathInsideRoot,
  resolveHomeDirFromEnvironment,
} from '@happier-dev/plugin-sdk/fs';
import { readTrimmedString as readEnvString } from '@happier-dev/plugin-sdk';

import {
  throwIfCodexExternalSessionInvocationStopped,
  type CodexExternalSessionInvocationBounds,
} from '../../surfaces/sessions/external/invocationBounds.js';
import type { CodexExternalSessionSource } from '../../surfaces/sessions/external/models.js';

export type CodexExternalSessionHomeEntry = Readonly<{
  codexHome: string;
  source: CodexExternalSessionSource;
}>;

function isSafeConnectedServiceId(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(raw.trim());
}

function isSafeConnectedServiceProfileId(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(raw.trim());
}

function isSafeConnectedServiceGroupId(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(raw.trim());
}

function normalizeConnectedServiceId(raw: unknown): string | null {
  if (!isSafeConnectedServiceId(raw)) return null;
  return raw.trim();
}

function normalizeConnectedServiceProfileId(raw: unknown): string | null {
  if (!isSafeConnectedServiceProfileId(raw)) return null;
  return raw.trim();
}

function normalizeConnectedServiceGroupId(raw: unknown): string | null {
  if (!isSafeConnectedServiceGroupId(raw)) return null;
  return raw.trim();
}

function normalizeHomePath(raw: string): string {
  return resolve(raw.trim());
}

function expandHomeDirPath(value: string, env: Readonly<Record<string, string | undefined>>): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return resolve(expandHomePath(trimmed, resolveHomeDirFromEnvironment(env)));
}

export function resolveConfiguredCodexHomePath(env: Readonly<Record<string, string | undefined>>): string {
  const override = readEnvString(env.CODEX_HOME);
  return override ? expandHomeDirPath(override, env) : resolve(resolveHomeDirFromEnvironment(env), '.codex');
}

/**
 * The canonical form of a requested Codex home, produced the same way as the
 * configured home so the host admission boundary compares like with like.
 */
export function canonicalizeCodexHomePath(
  raw: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return expandHomeDirPath(raw, env);
}

export function resolveDefaultCodexHomePath(codexHome?: string | null): string {
  return typeof codexHome === 'string' && codexHome.trim().length > 0
    ? normalizeHomePath(codexHome)
    : normalizeHomePath(join(resolveHomeDirFromEnvironment(), '.codex'));
}

function buildConnectedServiceCodexHome(activeServerDir: string, connectedServiceId: string, connectedServiceProfileId: string): string {
  return join(activeServerDir, 'daemon', 'connected-services', 'homes', connectedServiceId, connectedServiceProfileId, 'codex', 'codex-home');
}

function buildConnectedServiceGroupCodexHome(activeServerDir: string, connectedServiceId: string, connectedServiceGroupId: string): string {
  return join(activeServerDir, 'daemon', 'connected-services', 'homes', connectedServiceId, '__groups', connectedServiceGroupId, 'codex', 'codex-home');
}

async function resolveVerifiedCodexHomePath(
  expectedPath: string,
  exactHomePath: string | null,
  bounds: CodexExternalSessionInvocationBounds,
): Promise<string | null> {
  throwIfCodexExternalSessionInvocationStopped(bounds);
  const targetPath = exactHomePath ?? expectedPath;
  try {
    const linkStats = await lstat(targetPath);
    throwIfCodexExternalSessionInvocationStopped(bounds);
    if (linkStats.isSymbolicLink()) {
      return null;
    }
    const real = await realpath(targetPath);
    throwIfCodexExternalSessionInvocationStopped(bounds);
    const expectedReal = await realpath(expectedPath).catch(() => null);
    throwIfCodexExternalSessionInvocationStopped(bounds);
    if (!expectedReal || real !== expectedReal) {
      return null;
    }
    const stats = await stat(real);
    throwIfCodexExternalSessionInvocationStopped(bounds);
    return stats.isDirectory() ? real : null;
  } catch {
    throwIfCodexExternalSessionInvocationStopped(bounds);
    return null;
  }
}

export function inferCodexExternalSessionsSourceFromHome(params: Readonly<{
  codexHome?: string | null;
  activeServerDir?: string | null;
}>): CodexExternalSessionSource {
  const codexHome = resolveDefaultCodexHomePath(params.codexHome);
  const activeServerDir = typeof params.activeServerDir === 'string' && params.activeServerDir.trim().length > 0
    ? resolve(params.activeServerDir.trim())
    : null;

  if (activeServerDir) {
    const homesRoot = join(activeServerDir, 'daemon', 'connected-services', 'homes');
    const relativeParts = isCanonicalAbsolutePathInsideRoot(homesRoot, codexHome)
      ? codexHome.slice(homesRoot.length + 1).split(/[/\\]+/)
      : null;
    if (relativeParts && relativeParts.length === 4 && relativeParts[2] === 'codex' && relativeParts[3] === 'codex-home') {
      const [rawConnectedServiceId, rawConnectedServiceProfileId] = relativeParts;
      const connectedServiceId = normalizeConnectedServiceId(rawConnectedServiceId);
      const connectedServiceProfileId = normalizeConnectedServiceProfileId(rawConnectedServiceProfileId);
      if (connectedServiceId && connectedServiceProfileId) {
        return {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId,
          connectedServiceProfileId,
          homePath: codexHome,
        };
      }
    }
    if (
      relativeParts
      && relativeParts.length === 5
      && relativeParts[1] === '__groups'
      && relativeParts[3] === 'codex'
      && relativeParts[4] === 'codex-home'
    ) {
      const [rawConnectedServiceId, , rawConnectedServiceGroupId] = relativeParts;
      const connectedServiceId = normalizeConnectedServiceId(rawConnectedServiceId);
      const connectedServiceGroupId = normalizeConnectedServiceGroupId(rawConnectedServiceGroupId);
      if (connectedServiceId && connectedServiceGroupId) {
        return {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId,
          connectedServiceGroupId,
          homePath: codexHome,
        };
      }
    }
  }

  return {
    kind: 'codexHome',
    home: 'user',
    homePath: codexHome,
  };
}

export async function homeEntries(params: Readonly<{
  source: CodexExternalSessionSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
}> & CodexExternalSessionInvocationBounds): Promise<CodexExternalSessionHomeEntry[]> {
  throwIfCodexExternalSessionInvocationStopped(params);
  if (params.source.kind !== 'codexHome') return [];

  if (params.source.home === 'user') {
    const codexHome = typeof params.source.homePath === 'string' && params.source.homePath.trim().length > 0
      ? normalizeHomePath(params.source.homePath)
      : resolveConfiguredCodexHomePath(params.env);
    return [{ codexHome, source: { kind: 'codexHome', home: 'user', homePath: codexHome } }];
  }

  const connectedServiceId = normalizeConnectedServiceId(params.source.connectedServiceId);
  if (!connectedServiceId) return [];

  const connectedServiceProfileId = normalizeConnectedServiceProfileId(params.source.connectedServiceProfileId);
  const connectedServiceGroupId = normalizeConnectedServiceGroupId(params.source.connectedServiceGroupId);
  const exactHomePath = typeof params.source.homePath === 'string' && params.source.homePath.trim().length > 0
    ? normalizeHomePath(params.source.homePath)
    : null;

  if (connectedServiceProfileId) {
    const codexHome = buildConnectedServiceCodexHome(params.activeServerDir, connectedServiceId, connectedServiceProfileId);
    const verifiedHome = await resolveVerifiedCodexHomePath(codexHome, exactHomePath, params);
    if (!verifiedHome) {
      return [];
    }
    return [{
      codexHome: verifiedHome,
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId,
        connectedServiceProfileId,
        homePath: verifiedHome,
      },
    }];
  }

  if (connectedServiceGroupId) {
    const codexHome = buildConnectedServiceGroupCodexHome(params.activeServerDir, connectedServiceId, connectedServiceGroupId);
    const verifiedHome = await resolveVerifiedCodexHomePath(codexHome, exactHomePath, params);
    if (!verifiedHome) {
      return [];
    }
    return [{
      codexHome: verifiedHome,
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId,
        connectedServiceGroupId,
        homePath: verifiedHome,
      },
    }];
  }

  if (exactHomePath) {
    const inferred = inferCodexExternalSessionsSourceFromHome({ codexHome: exactHomePath, activeServerDir: params.activeServerDir });
    if (inferred.kind !== 'codexHome' || inferred.home !== 'connectedService') {
      return [];
    }
    const inferredProfileId = normalizeConnectedServiceProfileId(inferred.connectedServiceProfileId);
    const inferredGroupId = normalizeConnectedServiceGroupId(inferred.connectedServiceGroupId);
    if (inferred.connectedServiceId !== connectedServiceId || (!inferredProfileId && !inferredGroupId)) {
      return [];
    }
    const expectedPath = inferredGroupId
      ? buildConnectedServiceGroupCodexHome(params.activeServerDir, connectedServiceId, inferredGroupId)
      : buildConnectedServiceCodexHome(params.activeServerDir, connectedServiceId, inferredProfileId as string);
    const verifiedHome = await resolveVerifiedCodexHomePath(expectedPath, exactHomePath, params);
    if (!verifiedHome) {
      return [];
    }
    return [{
      codexHome: verifiedHome,
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId,
        ...(inferredGroupId ? { connectedServiceGroupId: inferredGroupId } : { connectedServiceProfileId: inferredProfileId as string }),
        homePath: verifiedHome,
      },
    }];
  }

  const entries: CodexExternalSessionHomeEntry[] = [];
  const base = join(params.activeServerDir, 'daemon', 'connected-services', 'homes', connectedServiceId);
  let profiles: Dirent[];
  try {
    profiles = await readdir(base, { withFileTypes: true });
  } catch {
    throwIfCodexExternalSessionInvocationStopped(params);
    return [];
  }
  throwIfCodexExternalSessionInvocationStopped(params);

  for (const entry of profiles) {
    throwIfCodexExternalSessionInvocationStopped(params);
    if (entry.name === '__groups') continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const profileId = normalizeConnectedServiceProfileId(entry.name);
    if (!profileId) continue;
    const codexHome = buildConnectedServiceCodexHome(params.activeServerDir, connectedServiceId, profileId);
    try {
      const s = await stat(codexHome);
      throwIfCodexExternalSessionInvocationStopped(params);
      if (s.isDirectory()) {
        entries.push({
          codexHome,
          source: {
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId,
            connectedServiceProfileId: profileId,
            homePath: codexHome,
          },
        });
      }
    } catch {
      throwIfCodexExternalSessionInvocationStopped(params);
      // ignore missing
    }
  }

  const groupsBase = join(base, '__groups');
  let groups: Dirent[];
  try {
    groups = await readdir(groupsBase, { withFileTypes: true });
  } catch {
    throwIfCodexExternalSessionInvocationStopped(params);
    return entries;
  }
  throwIfCodexExternalSessionInvocationStopped(params);
  for (const entry of groups) {
    throwIfCodexExternalSessionInvocationStopped(params);
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const groupId = normalizeConnectedServiceGroupId(entry.name);
    if (!groupId) continue;
    const codexHome = buildConnectedServiceGroupCodexHome(params.activeServerDir, connectedServiceId, groupId);
    try {
      const s = await stat(codexHome);
      throwIfCodexExternalSessionInvocationStopped(params);
      if (s.isDirectory()) {
        entries.push({
          codexHome,
          source: {
            kind: 'codexHome',
            home: 'connectedService',
            connectedServiceId,
            connectedServiceGroupId: groupId,
            homePath: codexHome,
          },
        });
      }
    } catch {
      throwIfCodexExternalSessionInvocationStopped(params);
      // ignore missing
    }
  }

  return entries;
}
