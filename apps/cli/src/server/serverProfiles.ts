import { readSettings, updateSettings } from '@/persistence';
import { deriveServerIdFromName, sanitizeServerIdForFilesystem } from '@/server/serverId';
import { isLocalishServerUrl } from '@/server/serverUrlClassification';
import { createServerUrlComparableKey } from '@happier-dev/protocol';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveHappyHomeDirFromEnvironment } from '@happier-dev/cli-common/providers';

function normalizeServerUrlForEnvId(url: string): string {
  return String(url ?? '').trim().replace(/\/+$/, '');
}

function deriveEnvServerIdFromUrl(url: string): string {
  // Mirror `deriveServerIdFromUrl` in `apps/cli/src/configuration.ts` (for env-overridden servers).
  const raw = normalizeServerUrlForEnvId(url);
  if (!raw) return 'env_0';
  const value = (() => {
    try {
      const comparableKey = createServerUrlComparableKey(raw);
      return comparableKey || raw;
    } catch {
      return raw;
    }
  })();
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `env_${(h >>> 0).toString(16)}`;
}

function deriveLegacyEnvServerIdFromUrl(url: string): string {
  // Preview baseline (<4913c1e53) used the raw URL string (after trailing slash normalization) as the hash input.
  const raw = normalizeServerUrlForEnvId(url);
  if (!raw) return 'env_0';
  let h = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `env_${(h >>> 0).toString(16)}`;
}

async function maybeCopyAccessKeyFromDerivedUrlId(params: Readonly<{
  targetServerId: string;
  serverUrl: string;
  localServerUrl?: string;
}>): Promise<void> {
  const serversDir = join(resolveHappyHomeDirFromEnvironment(process.env), 'servers');
  const targetDir = join(serversDir, params.targetServerId);
  const targetKeyPath = join(targetDir, 'access.key');
  if (existsSync(targetKeyPath)) return;

  const candidates = [
    params.serverUrl,
    params.localServerUrl ?? '',
  ]
    .map((value) => normalizeServerUrlForEnvId(value))
    .filter(Boolean)
    .flatMap((value) => [deriveEnvServerIdFromUrl(value), deriveLegacyEnvServerIdFromUrl(value)])
    .filter((value) => value !== params.targetServerId);

  for (const candidateId of candidates) {
    const sourceKeyPath = join(serversDir, candidateId, 'access.key');
    if (!existsSync(sourceKeyPath)) continue;
    try {
      await mkdir(targetDir, { recursive: true, mode: 0o700 });
      await copyFile(sourceKeyPath, targetKeyPath);
      await chmod(targetKeyPath, 0o600).catch(() => {});
      return;
    } catch {
      // Best-effort migration; the normal auth/login flow can recreate this.
      return;
    }
  }
}

export type ServerProfile = Readonly<{
  id: string;
  name: string;
  serverUrl: string;
  localServerUrl?: string;
  webappUrl: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
}>;

export type RemoveServerProfileResult = Readonly<{
  removed: ServerProfile;
  active: ServerProfile;
}>;

function asStringId(raw: string): string {
  const id = String(raw ?? '').trim();
  if (!id) {
    throw new Error('Server profile id is required');
  }
  return id;
}

function coerceProfile(value: any): ServerProfile | null {
  if (!value || typeof value !== 'object') return null;
  const idRaw = typeof value.id === 'string' ? value.id.trim() : '';
  const id = sanitizeServerIdForFilesystem(idRaw, '');
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const serverUrlRaw = typeof value.serverUrl === 'string' ? value.serverUrl.trim() : '';
  const localServerUrlRaw = typeof (value as any).localServerUrl === 'string' ? String((value as any).localServerUrl).trim() : '';
  const legacyPublicServerUrlRaw = typeof (value as any).publicServerUrl === 'string' ? String((value as any).publicServerUrl).trim() : '';
  const webappUrl = typeof value.webappUrl === 'string' ? value.webappUrl.trim() : '';
  const createdAt = Number.isFinite(value.createdAt) ? Number(value.createdAt) : 0;
  const updatedAt = Number.isFinite(value.updatedAt) ? Number(value.updatedAt) : 0;
  const lastUsedAt = Number.isFinite(value.lastUsedAt) ? Number(value.lastUsedAt) : 0;

  const serverUrl =
    legacyPublicServerUrlRaw && legacyPublicServerUrlRaw !== serverUrlRaw
      ? legacyPublicServerUrlRaw
      : serverUrlRaw;

  const localServerUrl =
    localServerUrlRaw
      ? localServerUrlRaw
      : (legacyPublicServerUrlRaw && legacyPublicServerUrlRaw !== serverUrlRaw && isLocalishServerUrl(serverUrlRaw) ? serverUrlRaw : '');

  if (!id || !serverUrl || !webappUrl) return null;
  const displayName = id === 'cloud'
    ? 'Happier Cloud'
    : name;
  if (!displayName) return null;
  return {
    id,
    name: displayName,
    serverUrl,
    ...(localServerUrl ? { localServerUrl } : {}),
    webappUrl,
    createdAt,
    updatedAt,
    lastUsedAt,
  };
}

function findProfileIdByIdentifier(servers: Record<string, any>, identifierRaw: string): string | null {
  const identifier = String(identifierRaw ?? '').trim();
  if (!identifier) return null;
  if (identifier in servers) return identifier;

  const lowered = identifier.toLowerCase();
  for (const [id, value] of Object.entries(servers)) {
    const profile = coerceProfile(value);
    if (!profile) continue;
    if (profile.id.toLowerCase() === lowered) return id;
    if (profile.name.toLowerCase() === lowered) return id;
  }
  return findProfileIdByComparableUrl(servers, identifier);
}

function findProfileIdByComparableUrl(servers: Record<string, any>, serverUrlRaw: string): string | null {
  const serverUrl = String(serverUrlRaw ?? '').trim();
  if (!serverUrl) return null;

  let comparableKey: string;
  try {
    comparableKey = createServerUrlComparableKey(serverUrl);
  } catch {
    return null;
  }

  for (const [id, value] of Object.entries(servers)) {
    const profile = coerceProfile(value);
    if (!profile) continue;
    try {
      if (createServerUrlComparableKey(profile.serverUrl) === comparableKey) {
        return id;
      }
      if (profile.localServerUrl && createServerUrlComparableKey(profile.localServerUrl) === comparableKey) {
        return id;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function urlsReferToSameServer(leftRaw: string, rightRaw: string): boolean {
  const left = String(leftRaw ?? '').trim();
  const right = String(rightRaw ?? '').trim();
  if (!left || !right) return false;
  try {
    if (createServerUrlComparableKey(left) === createServerUrlComparableKey(right)) return true;
  } catch {
    // Fall through to normalized string comparison.
  }
  return normalizeServerUrlForEnvId(left) === normalizeServerUrlForEnvId(right);
}

function findProfileIdByLocalUrlAndWebapp(
  servers: Record<string, any>,
  localServerUrlRaw: string,
  webappUrlRaw: string,
): string | null {
  const localMatches: string[] = [];
  for (const [id, value] of Object.entries(servers)) {
    const profile = coerceProfile(value);
    if (!profile) continue;
    if (
      urlsReferToSameServer(profile.serverUrl, localServerUrlRaw) ||
      (profile.localServerUrl ? urlsReferToSameServer(profile.localServerUrl, localServerUrlRaw) : false)
    ) {
      localMatches.push(id);
    }
  }

  if (localMatches.length === 0) return null;
  const webappMatch = localMatches.find((id) => {
    const profile = coerceProfile((servers as any)[id]);
    return profile ? urlsReferToSameServer(profile.webappUrl, webappUrlRaw) : false;
  });
  return webappMatch ?? localMatches[0] ?? null;
}

export async function listServerProfiles(): Promise<ServerProfile[]> {
  const settings: any = await readSettings();
  const servers = settings?.servers && typeof settings.servers === 'object' ? settings.servers : {};
  const list = Object.values(servers)
    .map((s) => coerceProfile(s))
    .filter(Boolean) as ServerProfile[];
  return list;
}

export async function getServerProfile(identifierRaw: string): Promise<ServerProfile> {
  const identifier = asStringId(identifierRaw);
  const settings: any = await readSettings();
  const servers = settings?.servers && typeof settings.servers === 'object' ? settings.servers : {};
  const resolvedId = findProfileIdByIdentifier(servers as any, identifier);
  if (!resolvedId) {
    throw new Error(`Server profile not found: ${identifier}`);
  }
  const profile = coerceProfile((servers as any)[resolvedId]);
  if (!profile) {
    throw new Error(`Server profile is invalid: ${resolvedId}`);
  }
  return profile;
}

export async function getActiveServerProfile(): Promise<ServerProfile> {
  const settings: any = await readSettings();
  const activeId = sanitizeServerIdForFilesystem(settings?.activeServerId ?? 'cloud', 'cloud');
  const servers = settings?.servers && typeof settings.servers === 'object' ? settings.servers : {};
  const active = coerceProfile((servers as any)[activeId]) ?? coerceProfile((servers as any).cloud);
  if (!active) {
    throw new Error(`Active server profile not found: ${activeId}`);
  }
  return active;
}

export async function useServerProfile(idRaw: string): Promise<ServerProfile> {
  const identifier = asStringId(idRaw);
  const now = Date.now();
  await updateSettings((current: any) => {
    const servers = current?.servers && typeof current.servers === 'object' ? current.servers : {};
    const resolvedId = findProfileIdByIdentifier(servers as any, identifier);
    if (!resolvedId) {
      throw new Error(`Server profile not found: ${identifier}`);
    }
    const existing = (servers as any)[resolvedId];
    if (!existing) {
      throw new Error(`Server profile not found: ${resolvedId}`);
    }
    return {
      ...current,
      activeServerId: resolvedId,
      servers: {
        ...servers,
        [resolvedId]: { ...existing, lastUsedAt: now, updatedAt: now },
      },
    };
  });

  const active = await getActiveServerProfile();
  await maybeCopyAccessKeyFromDerivedUrlId({
    targetServerId: active.id,
    serverUrl: active.serverUrl,
    ...(active.localServerUrl ? { localServerUrl: active.localServerUrl } : {}),
  });
  return active;
}

export async function addServerProfile(opts: Readonly<{
  name: string;
  serverUrl: string;
  localServerUrl?: string;
  webappUrl: string;
  use?: boolean;
}>): Promise<ServerProfile> {
  const name = String(opts.name ?? '').trim();
  let id = deriveServerIdFromName(name);
  if (id.toLowerCase() === 'cloud') {
    throw new Error('Cannot create a profile with reserved name "cloud"');
  }
  if (!id) {
    throw new Error('Failed to derive a safe server profile id');
  }
  const serverUrl = String(opts.serverUrl ?? '').trim();
  const localServerUrl = String(opts.localServerUrl ?? '').trim();
  const webappUrl = String(opts.webappUrl ?? '').trim();
  const shouldUse = opts.use === true;
  const now = Date.now();

  await updateSettings((current: any) => {
    const servers = current?.servers && typeof current.servers === 'object' ? current.servers : {};
    if ((servers as any)[id] && String((servers as any)[id]?.serverUrl ?? '').trim() !== serverUrl) {
      let attempt = 2;
      let nextId = `${id}-${attempt}`;
      while ((servers as any)[nextId]) {
        attempt += 1;
        nextId = `${id}-${attempt}`;
      }
      id = nextId;
    }
    const existing = (servers as any)[id];
    const createdAt = existing && Number.isFinite(existing.createdAt) ? Number(existing.createdAt) : now;
    const next = {
      id,
      name,
      serverUrl,
      ...(localServerUrl && localServerUrl !== serverUrl ? { localServerUrl } : {}),
      webappUrl,
      createdAt,
      updatedAt: now,
      lastUsedAt: shouldUse ? now : (existing && Number.isFinite(existing.lastUsedAt) ? Number(existing.lastUsedAt) : 0),
    };
    return {
      ...current,
      activeServerId: shouldUse ? id : current?.activeServerId,
      servers: { ...servers, [id]: next },
    };
  });

  if (shouldUse) {
    await maybeCopyAccessKeyFromDerivedUrlId({
      targetServerId: id,
      serverUrl,
      ...(localServerUrl ? { localServerUrl } : {}),
    });
  }

  if (shouldUse) {
    return await getActiveServerProfile();
  }
  const profiles = await listServerProfiles();
  const created = profiles.find((p) => p.id === id);
  if (!created) {
    throw new Error(`Failed to create server profile: ${id}`);
  }
  return created;
}

export async function upsertServerProfileByUrl(opts: Readonly<{
  name: string;
  serverUrl: string;
  localServerUrl?: string;
  webappUrl: string;
  use?: boolean;
}>): Promise<ServerProfile> {
  const name = String(opts.name ?? '').trim();
  const serverUrl = String(opts.serverUrl ?? '').trim();
  const localServerUrl = String(opts.localServerUrl ?? '').trim();
  const webappUrl = String(opts.webappUrl ?? '').trim();
  const shouldUse = opts.use === true;
  const now = Date.now();

  let resolvedId: string | null = null;
  await updateSettings((current: any) => {
    const servers = current?.servers && typeof current.servers === 'object' ? current.servers : {};
    const matchedId = findProfileIdByComparableUrl(servers, serverUrl)
      ?? (localServerUrl ? findProfileIdByLocalUrlAndWebapp(servers, localServerUrl, webappUrl) : null);
    if (!matchedId) {
      return current;
    }

    const existing = coerceProfile((servers as any)[matchedId]);
    if (!existing) {
      return current;
    }

    resolvedId = matchedId;
    return {
      ...current,
      activeServerId: shouldUse ? matchedId : current?.activeServerId,
      servers: {
        ...servers,
        [matchedId]: {
          ...existing,
          name: name || existing.name,
          serverUrl,
          ...(localServerUrl && localServerUrl !== serverUrl ? { localServerUrl } : {}),
          webappUrl,
          updatedAt: now,
          lastUsedAt: shouldUse ? now : existing.lastUsedAt,
        },
      },
    };
  });

  if (!resolvedId) {
    return await addServerProfile(opts);
  }

  if (shouldUse) {
    await maybeCopyAccessKeyFromDerivedUrlId({
      targetServerId: resolvedId,
      serverUrl,
      ...(localServerUrl ? { localServerUrl } : {}),
    });
  }

  if (shouldUse) {
    return await getActiveServerProfile();
  }
  return await getServerProfile(resolvedId);
}

export async function removeServerProfile(
  identifierRaw: string,
  opts: Readonly<{ force?: boolean }> = {},
): Promise<RemoveServerProfileResult> {
  const identifier = asStringId(identifierRaw);
  const force = opts.force === true;

  const before = await readSettings();
  const activeServerId = sanitizeServerIdForFilesystem((before as any)?.activeServerId ?? 'cloud', 'cloud');
  const servers = (before as any)?.servers && typeof (before as any).servers === 'object' ? (before as any).servers : {};
  const resolvedId = findProfileIdByIdentifier(servers, identifier);
  if (!resolvedId) {
    throw new Error(`Server profile not found: ${identifier}`);
  }
  if (resolvedId === 'cloud') {
    throw new Error('Cannot remove the Happier Cloud server profile');
  }

  if (resolvedId === activeServerId && !force) {
    throw new Error(`Cannot remove the active server profile (${resolvedId}). Use --force to switch back to cloud and remove it.`);
  }

  await updateSettings((current: any) => {
    const servers = current?.servers && typeof current.servers === 'object' ? current.servers : {};
    const existing = (servers as any)[resolvedId];
    if (!existing) {
      throw new Error(`Server profile not found: ${resolvedId}`);
    }

    const { [resolvedId]: _removed, ...rest } = servers as any;
    const nextActive = resolvedId === current?.activeServerId ? 'cloud' : current?.activeServerId;
    if (nextActive === resolvedId) {
      throw new Error(`Refusing to keep ${resolvedId} as active after removal`);
    }
    if (nextActive && !(nextActive in rest)) {
      // Safety: if active server disappears (corrupt settings), fall back.
      (rest as any).cloud = (rest as any).cloud ?? (servers as any).cloud;
      return { ...current, activeServerId: 'cloud', servers: rest };
    }
    return { ...current, activeServerId: nextActive, servers: rest };
  });

  const afterActive = await getActiveServerProfile();
  const removed = coerceProfile((servers as any)[resolvedId]);
  if (!removed) {
    throw new Error(`Failed to resolve removed profile: ${resolvedId}`);
  }
  return { removed, active: afterActive };
}
