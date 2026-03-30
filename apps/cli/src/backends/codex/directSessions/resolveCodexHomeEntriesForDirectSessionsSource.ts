import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { DirectSessionsSource } from '@happier-dev/protocol';

export type CodexDirectSessionHomeEntry = Readonly<{
  codexHome: string;
  source: DirectSessionsSource;
}>;

function isSafeConnectedServiceId(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(raw.trim());
}

function isSafeConnectedServiceProfileId(raw: unknown): raw is string {
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

function normalizeHomePath(raw: string): string {
  return resolve(raw.trim());
}

function buildConnectedServiceCodexHome(activeServerDir: string, connectedServiceId: string, connectedServiceProfileId: string): string {
  return join(activeServerDir, 'daemon', 'connected-services', 'homes', connectedServiceId, connectedServiceProfileId, 'codex', 'codex-home');
}

async function resolveVerifiedCodexHomePath(expectedPath: string, exactHomePath: string | null): Promise<string | null> {
  const targetPath = exactHomePath ?? expectedPath;
  try {
    const linkStats = await lstat(targetPath);
    if (linkStats.isSymbolicLink()) {
      return null;
    }
    const real = await realpath(targetPath);
    const expectedReal = await realpath(expectedPath).catch(() => null);
    if (!expectedReal || real !== expectedReal) {
      return null;
    }
    const stats = await stat(real);
    return stats.isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export function inferCodexDirectSessionsSourceFromHome(params: Readonly<{
  codexHome?: string | null;
  activeServerDir?: string | null;
}>): DirectSessionsSource {
  const codexHome = typeof params.codexHome === 'string' && params.codexHome.trim().length > 0
    ? normalizeHomePath(params.codexHome)
    : normalizeHomePath(join(homedir(), '.codex'));
  const activeServerDir = typeof params.activeServerDir === 'string' && params.activeServerDir.trim().length > 0
    ? resolve(params.activeServerDir.trim())
    : null;

  if (activeServerDir) {
    const homesRoot = join(activeServerDir, 'daemon', 'connected-services', 'homes');
    const relativeParts = codexHome.startsWith(`${homesRoot}/`) || codexHome.startsWith(`${homesRoot}\\`)
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
  }

  return {
    kind: 'codexHome',
    home: 'user',
    homePath: codexHome,
  };
}

export async function resolveCodexHomeEntriesForDirectSessionsSource(params: Readonly<{
  source: DirectSessionsSource;
  activeServerDir: string;
  env: NodeJS.ProcessEnv;
}>): Promise<CodexDirectSessionHomeEntry[]> {
  if (params.source.kind !== 'codexHome') return [];

  if (params.source.home === 'user') {
    const codexHome = typeof params.source.homePath === 'string' && params.source.homePath.trim().length > 0
      ? normalizeHomePath(params.source.homePath)
      : typeof params.env.CODEX_HOME === 'string' && params.env.CODEX_HOME.trim().length > 0
        ? normalizeHomePath(params.env.CODEX_HOME)
        : normalizeHomePath(join(homedir(), '.codex'));
    return [{ codexHome, source: { kind: 'codexHome', home: 'user', homePath: codexHome } }];
  }

  const connectedServiceId = normalizeConnectedServiceId(params.source.connectedServiceId);
  if (!connectedServiceId) return [];

  const connectedServiceProfileId = normalizeConnectedServiceProfileId(params.source.connectedServiceProfileId);
  const exactHomePath = typeof params.source.homePath === 'string' && params.source.homePath.trim().length > 0
    ? normalizeHomePath(params.source.homePath)
    : null;

  if (connectedServiceProfileId) {
    const codexHome = buildConnectedServiceCodexHome(params.activeServerDir, connectedServiceId, connectedServiceProfileId);
    const verifiedHome = await resolveVerifiedCodexHomePath(codexHome, exactHomePath);
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

  if (exactHomePath) {
    const inferred = inferCodexDirectSessionsSourceFromHome({ codexHome: exactHomePath, activeServerDir: params.activeServerDir });
    if (inferred.kind !== 'codexHome' || inferred.home !== 'connectedService') {
      return [];
    }
    const inferredProfileId = normalizeConnectedServiceProfileId(inferred.connectedServiceProfileId);
    if (inferred.connectedServiceId !== connectedServiceId || !inferredProfileId) {
      return [];
    }
    const expectedPath = buildConnectedServiceCodexHome(params.activeServerDir, connectedServiceId, inferredProfileId);
    const verifiedHome = await resolveVerifiedCodexHomePath(expectedPath, exactHomePath);
    if (!verifiedHome) {
      return [];
    }
    return [{
      codexHome: verifiedHome,
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId,
        connectedServiceProfileId: inferredProfileId,
        homePath: verifiedHome,
      },
    }];
  }

  const entries: CodexDirectSessionHomeEntry[] = [];
  const base = join(params.activeServerDir, 'daemon', 'connected-services', 'homes', connectedServiceId);
  let profiles: Dirent[];
  try {
    profiles = await readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of profiles) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const profileId = normalizeConnectedServiceProfileId(entry.name);
    if (!profileId) continue;
    const codexHome = buildConnectedServiceCodexHome(params.activeServerDir, connectedServiceId, profileId);
    try {
      const s = await stat(codexHome);
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
      // ignore missing
    }
  }

  return entries;
}
