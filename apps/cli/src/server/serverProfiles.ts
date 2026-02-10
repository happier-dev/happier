import { readSettings, updateSettings } from '@/persistence';
import { deriveServerIdFromName, sanitizeServerIdForFilesystem } from '@/server/serverId';

export type ServerProfile = Readonly<{
  id: string;
  name: string;
  serverUrl: string;
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
  const serverUrl = typeof value.serverUrl === 'string' ? value.serverUrl.trim() : '';
  const webappUrl = typeof value.webappUrl === 'string' ? value.webappUrl.trim() : '';
  const createdAt = Number.isFinite(value.createdAt) ? Number(value.createdAt) : 0;
  const updatedAt = Number.isFinite(value.updatedAt) ? Number(value.updatedAt) : 0;
  const lastUsedAt = Number.isFinite(value.lastUsedAt) ? Number(value.lastUsedAt) : 0;
  if (!id || !serverUrl || !webappUrl) return null;
  const displayName = id === 'cloud'
    ? 'Happier Cloud'
    : name;
  if (!displayName) return null;
  return { id, name: displayName, serverUrl, webappUrl, createdAt, updatedAt, lastUsedAt };
}

function findProfileIdByIdOrName(servers: Record<string, any>, identifierRaw: string): string | null {
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
  return null;
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
  const resolvedId = findProfileIdByIdOrName(servers as any, identifier);
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
    const resolvedId = findProfileIdByIdOrName(servers as any, identifier);
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
  return await getActiveServerProfile();
}

export async function addServerProfile(opts: Readonly<{
  name: string;
  serverUrl: string;
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
    return await getActiveServerProfile();
  }
  const profiles = await listServerProfiles();
  const created = profiles.find((p) => p.id === id);
  if (!created) {
    throw new Error(`Failed to create server profile: ${id}`);
  }
  return created;
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
  const resolvedId = findProfileIdByIdOrName(servers, identifier);
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
