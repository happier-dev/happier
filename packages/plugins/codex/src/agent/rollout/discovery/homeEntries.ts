import { lstat, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  expandHomePath,
  isCanonicalAbsolutePathInsideRoot,
  resolveHomeDirFromEnvironment,
  resolveConfiguredNativeHomePath,
  resolveVerifiedNativeHomePath,
  listConnectedServiceNativeHomes,
} from '@happier-dev/plugin-sdk/fs';
import { CODEX_NATIVE_HOME, CODEX_CONNECTED_SERVICE_HOME_DIRECTORY_NAME } from '../../nativeHome.js';

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
  return resolveConfiguredNativeHomePath(CODEX_NATIVE_HOME, env);
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
    : normalizeHomePath(join(resolveHomeDirFromEnvironment(), CODEX_NATIVE_HOME.defaultRelativePath));
}

function buildConnectedServiceHomesRoot(activeServerDir: string): string {
  return join(activeServerDir, 'daemon', 'connected-services', 'homes');
}

function buildConnectedServiceCodexHome(activeServerDir: string, connectedServiceId: string, connectedServiceProfileId: string): string {
  return join(buildConnectedServiceHomesRoot(activeServerDir), connectedServiceId, connectedServiceProfileId, 'codex', CODEX_CONNECTED_SERVICE_HOME_DIRECTORY_NAME);
}

function buildConnectedServiceGroupCodexHome(activeServerDir: string, connectedServiceId: string, connectedServiceGroupId: string): string {
  return join(buildConnectedServiceHomesRoot(activeServerDir), connectedServiceId, '__groups', connectedServiceGroupId, 'codex', CODEX_CONNECTED_SERVICE_HOME_DIRECTORY_NAME);
}

/**
 * The single admission decision for "which directory is this connected-service
 * Codex home?", shared by the exact profile/group requests and the enumerated
 * scan so no candidate can be admitted on a weaker rule.
 *
 * A name inside the connected-services namespace proves nothing about custody:
 * a symlink -- or a Windows junction, which `realpath` resolves identically --
 * at ANY ancestor makes the lexically in-namespace
 * `<homes>/<service>/<profile>/codex/codex-home` resolve to bytes elsewhere on
 * the machine, and both `stat` and `readdir` follow it silently. So the
 * connected-services homes root is the PHYSICAL authority: containment is
 * decided between the candidate's realpath and the root's realpath. Resolving
 * both sides the same way also keeps a deliberately relocated (symlinked) root
 * supported.
 *
 * The boundary stops AT the home. Shared-state mode intentionally symlinks
 * entries INSIDE a materialized home (`sessions`, `archived_sessions`,
 * `history.jsonl`, ...) at the user's real Codex home, so pushing this check
 * down into the rollout, transcript, handoff or observation readers would
 * delete that capability instead of protecting custody.
 */
async function resolveVerifiedCodexHomePath(params: Readonly<{
  homesRoot: string;
  expectedPath: string;
  exactHomePath?: string | null;
}> & CodexExternalSessionInvocationBounds): Promise<string | null> {
  return resolveVerifiedNativeHomePath({
    ...params,
    throwIfStopped: () => throwIfCodexExternalSessionInvocationStopped(params),
  });
}

/**
 * The external-session host resolves a connected account profile through the
 * catalog's materialized-home hook before calling the Codex leaf. Once that
 * admission has stamped the exact home, this leaf only verifies that the
 * target remains a real directory. It uses the physical path only for file
 * access and preserves the admitted source path as the returned identity; it
 * deliberately does not reconstruct a daemon root from the source path and
 * become a second custody owner.
 */
async function resolveAdmittedCodexHomePath(params: Readonly<{
  exactHomePath: string;
}> & CodexExternalSessionInvocationBounds): Promise<string | null> {
  throwIfCodexExternalSessionInvocationStopped(params);
  try {
    const linkStats = await lstat(params.exactHomePath);
    throwIfCodexExternalSessionInvocationStopped(params);
    if (linkStats.isSymbolicLink()) return null;
    const real = await realpath(params.exactHomePath);
    throwIfCodexExternalSessionInvocationStopped(params);
    const stats = await stat(real);
    throwIfCodexExternalSessionInvocationStopped(params);
    return stats.isDirectory() ? real : null;
  } catch {
    throwIfCodexExternalSessionInvocationStopped(params);
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
    const homesRoot = buildConnectedServiceHomesRoot(activeServerDir);
    const relativeParts = isCanonicalAbsolutePathInsideRoot(homesRoot, codexHome)
      ? codexHome.slice(homesRoot.length + 1).split(/[/\\]+/)
      : null;
    if (relativeParts && relativeParts.length === 4 && relativeParts[2] === 'codex' && relativeParts[3] === CODEX_CONNECTED_SERVICE_HOME_DIRECTORY_NAME) {
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
      && relativeParts[4] === CODEX_CONNECTED_SERVICE_HOME_DIRECTORY_NAME
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
  activeServerDir?: string;
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

  const activeServerDir = typeof params.activeServerDir === 'string'
    && params.activeServerDir.trim().length > 0
    ? params.activeServerDir.trim()
    : null;
  if (!activeServerDir) {
    if (!exactHomePath) return [];
    const admittedHome = await resolveAdmittedCodexHomePath({
      exactHomePath,
      signal: params.signal,
      deadlineAtMs: params.deadlineAtMs,
    });
    if (!admittedHome) return [];
    return [{
      codexHome: admittedHome,
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId,
        ...(connectedServiceProfileId
          ? { connectedServiceProfileId }
          : {}),
        ...(connectedServiceGroupId
          ? { connectedServiceGroupId }
          : {}),
        homePath: exactHomePath,
      },
    }];
  }

  const homesRoot = buildConnectedServiceHomesRoot(activeServerDir);

  if (connectedServiceProfileId) {
    const codexHome = buildConnectedServiceCodexHome(activeServerDir, connectedServiceId, connectedServiceProfileId);
    const verifiedHome = await resolveVerifiedCodexHomePath({ ...params, homesRoot, expectedPath: codexHome, exactHomePath });
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
    const codexHome = buildConnectedServiceGroupCodexHome(activeServerDir, connectedServiceId, connectedServiceGroupId);
    const verifiedHome = await resolveVerifiedCodexHomePath({ ...params, homesRoot, expectedPath: codexHome, exactHomePath });
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
    const inferred = inferCodexExternalSessionsSourceFromHome({ codexHome: exactHomePath, activeServerDir });
    if (inferred.kind !== 'codexHome' || inferred.home !== 'connectedService') {
      return [];
    }
    const inferredProfileId = normalizeConnectedServiceProfileId(inferred.connectedServiceProfileId);
    const inferredGroupId = normalizeConnectedServiceGroupId(inferred.connectedServiceGroupId);
    if (inferred.connectedServiceId !== connectedServiceId || (!inferredProfileId && !inferredGroupId)) {
      return [];
    }
    const expectedPath = inferredGroupId
      ? buildConnectedServiceGroupCodexHome(activeServerDir, connectedServiceId, inferredGroupId)
      : buildConnectedServiceCodexHome(activeServerDir, connectedServiceId, inferredProfileId as string);
    const verifiedHome = await resolveVerifiedCodexHomePath({ ...params, homesRoot, expectedPath, exactHomePath });
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

  const entries = await listConnectedServiceNativeHomes({
    activeServerDir,
    serviceId: connectedServiceId,
    agentId: 'codex',
    homeDirectoryName: CODEX_CONNECTED_SERVICE_HOME_DIRECTORY_NAME,
    throwIfStopped: () => throwIfCodexExternalSessionInvocationStopped(params),
  });
  return entries.map((entry) => ({
    codexHome: entry.homePath,
    source: {
      kind: 'codexHome',
      home: 'connectedService',
      connectedServiceId,
      ...(entry.profileId ? { connectedServiceProfileId: entry.profileId } : { connectedServiceGroupId: entry.groupId }),
      homePath: entry.homePath,
    },
  }));
}
