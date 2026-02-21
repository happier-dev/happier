import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type CliAccessKey =
  | Readonly<{
      token: string;
      secret: string;
    }>
  | Readonly<{
      token: string;
      encryption: Readonly<{
        publicKey: string;
        machineKey: string;
      }>;
    }>;

function parseAccessKey(raw: string): CliAccessKey | null {
  try {
    const parsed = JSON.parse(raw) as {
      token?: unknown;
      secret?: unknown;
      encryption?: unknown;
    } | null;
    const token = typeof parsed?.token === 'string' ? parsed.token.trim() : '';
    if (!token) return null;

    const secret = typeof parsed?.secret === 'string' ? parsed.secret.trim() : '';
    if (secret) return { token, secret };

    if (parsed?.encryption && typeof parsed.encryption === 'object') {
      const enc = parsed.encryption as Record<string, unknown>;
      const publicKey = typeof enc.publicKey === 'string' ? enc.publicKey.trim() : '';
      const machineKey = typeof enc.machineKey === 'string' ? enc.machineKey.trim() : '';
      if (publicKey && machineKey) {
        return { token, encryption: { publicKey, machineKey } };
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function readAccessKeyFromPath(path: string): Promise<CliAccessKey | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return parseAccessKey(raw);
  } catch {
    return null;
  }
}

async function resolveActiveServerIdFromSettings(happyHomeDir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(happyHomeDir, 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw) as { schemaVersion?: number; activeServerId?: unknown } | null;
    if (!parsed || typeof parsed.schemaVersion !== 'number') return null;
    if (parsed.schemaVersion < 5) return null;
    if (typeof parsed.activeServerId !== 'string' || !parsed.activeServerId) return null;
    return parsed.activeServerId;
  } catch {
    return null;
  }
}

function perServerAccessKeyPath(happyHomeDir: string, serverId: string): string {
  return join(happyHomeDir, 'servers', serverId, 'access.key');
}

async function listPerServerAccessKeyCandidates(happyHomeDir: string): Promise<Array<{ path: string; mtimeMs: number }>> {
  const serversDir = join(happyHomeDir, 'servers');
  try {
    const entries = await readdir(serversDir, { withFileTypes: true });
    const candidates: Array<{ path: string; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidatePath = join(serversDir, entry.name, 'access.key');
      try {
        const s = await stat(candidatePath);
        candidates.push({ path: candidatePath, mtimeMs: s.mtimeMs });
      } catch {
        // ignore missing / unreadable
      }
    }
    return candidates;
  } catch {
    return [];
  }
}

export async function readCliAccessKey(happyHomeDir: string): Promise<CliAccessKey | null> {
  const activeServerId = await resolveActiveServerIdFromSettings(happyHomeDir);
  const candidates: string[] = [];
  if (activeServerId) candidates.push(perServerAccessKeyPath(happyHomeDir, activeServerId));
  candidates.push(join(happyHomeDir, 'access.key'));

  for (const candidate of candidates) {
    const key = await readAccessKeyFromPath(candidate);
    if (key) return key;
  }

  // Fallback: find the newest per-server access key (settings.json may be stale/mismatched during e2e).
  const perServerKeys = await listPerServerAccessKeyCandidates(happyHomeDir);
  if (perServerKeys.length === 0) return null;
  perServerKeys.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of perServerKeys) {
    const key = await readAccessKeyFromPath(candidate.path);
    if (key) return key;
  }

  return null;
}
