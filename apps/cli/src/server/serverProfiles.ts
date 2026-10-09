import { readSettings, readStoredCredentialsForServerId, updateSettings, type Settings } from '@/persistence';
import { deriveServerIdFromName, deriveServerIdFromUrl, sanitizeServerIdForFilesystem } from '@/server/serverId';
import { isLocalishServerUrl } from '@/server/serverUrlClassification';
import { createServerUrlComparableKey } from '@happier-dev/protocol/server/urls/serverUrlComparableKey';
import { HomeApplicationOriginV1Schema, HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { resolveHappyHomeDirFromEnvironment } from '@happier-dev/cli-common/agents';
import { observeServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { resolveAuthenticatedExactHomeConnectionDescriptorObservation } from '@/auth/terminalAuthEnrollmentClient';

function normalizeServerUrlForEnvId(url: string): string {
  return String(url ?? '').trim().replace(/\/+$/, '');
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

function copyServerScopedEntry<T>(map: Record<string, T> | undefined, sourceId: string, targetId: string): Record<string, T> | undefined {
  return map && Object.prototype.hasOwnProperty.call(map, sourceId) ? { ...map, [targetId]: map[sourceId] } : map;
}

function hasServerScopedState(settings: Settings, serverId: string): boolean {
  return [settings.machineIdByServerId, settings.machineIdByServerIdByAccountId,
    settings.machineReplacementCandidatesByServerIdByAccountId, settings.lastTokenSubByServerId,
    settings.machineIdConfirmedByServerByServerId, settings.lastChangesCursorByServerIdByAccountId]
    .some((map) => map && Object.prototype.hasOwnProperty.call(map, serverId));
}

function copyMissingServerScopedState(current: Settings, sourceId: string, targetId: string): Settings {
  return {
    ...current,
    machineIdByServerId: copyServerScopedEntry(current.machineIdByServerId, sourceId, targetId),
    machineIdByServerIdByAccountId: copyServerScopedEntry(current.machineIdByServerIdByAccountId, sourceId, targetId),
    machineReplacementCandidatesByServerIdByAccountId: copyServerScopedEntry(current.machineReplacementCandidatesByServerIdByAccountId, sourceId, targetId),
    lastTokenSubByServerId: copyServerScopedEntry(current.lastTokenSubByServerId, sourceId, targetId),
    machineIdConfirmedByServerByServerId: copyServerScopedEntry(current.machineIdConfirmedByServerByServerId, sourceId, targetId),
    lastChangesCursorByServerIdByAccountId: copyServerScopedEntry(current.lastChangesCursorByServerIdByAccountId, sourceId, targetId),
  };
}

async function maybeAdoptDerivedServerProfileState(params: Readonly<{
  targetServerId: string;
  serverUrl: string;
  localServerUrl?: string;
  hasObservedHomeIdentity?: boolean;
}>): Promise<void> {
  // This is only the released env/profile-id compatibility migration. Once a
  // Home identity is observed, URL equality has no credential-transfer power.
  if (params.hasObservedHomeIdentity) return;
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
    .flatMap((value) => [deriveServerIdFromUrl(value), deriveLegacyEnvServerIdFromUrl(value)])
    .filter((value) => value !== params.targetServerId);

  for (const candidateId of candidates) {
    const sourceKeyPath = join(serversDir, candidateId, 'access.key');
    if (!existsSync(sourceKeyPath)) continue;
    try {
      await updateSettings(async (current) => {
        if (hasServerScopedState(current, params.targetServerId)) return current;
        await mkdir(targetDir, { recursive: true, mode: 0o700 });
        await copyFile(sourceKeyPath, targetKeyPath);
        await chmod(targetKeyPath, 0o600).catch(() => {});
        return copyMissingServerScopedState(current, candidateId, params.targetServerId);
      });
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
  homeConnectionDescriptor?: HomeConnectionDescriptorV1;
  homeConnectionDescriptorAuthority?: 'advisory' | 'exact';
}>;

export type RemoveServerProfileResult = Readonly<{
  removed: ServerProfile;
  active: ServerProfile;
}>;

export type ServerProfileIdentityConflict = Readonly<{
  homeServerIdentityId: string;
  profileIds: readonly string[];
}>;

export class ServerProfileIdentityConflictError extends Error {
  readonly name = 'ServerProfileIdentityConflictError';
  readonly code = 'duplicate_identity' as const;

  constructor(
    readonly homeServerIdentityId: string,
    readonly profileIds: readonly string[],
  ) {
    super(`Multiple Home profiles claim identity ${homeServerIdentityId}: ${profileIds.join(', ')}`);
  }
}

export class ServerProfileIdentityMismatchError extends Error {
  readonly name = 'ServerProfileIdentityMismatchError';
  readonly code = 'identity_mismatch' as const;

  constructor(message: string) {
    super(message);
  }
}

export class ServerProfileDescriptorInvalidError extends Error {
  readonly name = 'ServerProfileDescriptorInvalidError';
  readonly code = 'invalid_home_descriptor' as const;

  constructor(readonly profileId: string) {
    super(`Server profile ${profileId || '<unknown>'} has an invalid Home connection descriptor`);
  }
}

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
  const homeConnectionDescriptorResult = HomeConnectionDescriptorV1Schema.safeParse(value.homeConnectionDescriptor);
  const homeConnectionDescriptorAuthority = value.homeConnectionDescriptorAuthority === 'advisory'
    ? 'advisory'
    : homeConnectionDescriptorResult.success ? 'exact' : undefined;
  if (
    Object.prototype.hasOwnProperty.call(value, 'homeConnectionDescriptor')
    && !homeConnectionDescriptorResult.success
  ) {
    throw new ServerProfileDescriptorInvalidError(idRaw);
  }

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
    ...(homeConnectionDescriptorResult.success
      ? {
          homeConnectionDescriptor: homeConnectionDescriptorResult.data,
          homeConnectionDescriptorAuthority,
        }
      : {}),
  };
}

function requireProfileProjection(value: unknown, id: string): ServerProfile {
  const profile = coerceProfile(value);
  if (!profile) throw new Error(`Server profile is invalid: ${id}`);
  return profile;
}

function assertValidStoredHomeDescriptors(servers: Record<string, any>): void {
  for (const value of Object.values(servers)) {
    coerceProfile(value);
  }
}

function findProfileIdByIdentifier(servers: Record<string, any>, identifierRaw: string): string | null {
  assertValidStoredHomeDescriptors(servers);
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
  const identityMatches = findProfilesByHomeServerIdentityId(servers, identifier);
  if (identityMatches.length > 1) {
    throw new ServerProfileIdentityConflictError(identifier, identityMatches.map(([id]) => id).sort());
  }
  if (identityMatches[0]) return identityMatches[0][0];
  return findProfileIdByComparableUrl(servers, identifier);
}

function findProfilesByHomeServerIdentityId(
  servers: Record<string, any>,
  homeServerIdentityId: string,
): Array<readonly [string, ServerProfile]> {
  return Object.entries(servers).flatMap(([id, value]) => {
    const profile = coerceProfile(value);
    return profile?.homeConnectionDescriptor?.homeServerIdentityId === homeServerIdentityId
      ? [[id, profile] as const]
      : [];
  });
}

/** Exact Home target admission, without treating profile names or URLs as authority. */
export async function isServerProfileHomeIdentity(profileId: string, homeServerIdentityId: string): Promise<boolean> {
  // Preserve the existing local-profile target contract for in-process callers.
  if (profileId === homeServerIdentityId) return profileId.length > 0;
  try {
    const settings = await readSettings();
    const servers = settings.servers ?? {};
    const profile = coerceProfile(servers[profileId]);
    return profile?.id === profileId
      && profile.homeConnectionDescriptorAuthority === 'exact'
      && profile.homeConnectionDescriptor?.homeServerIdentityId === homeServerIdentityId
      && findProfilesByHomeServerIdentityId(servers, homeServerIdentityId).length === 1
      && findProfileIdByIdentifier(servers, homeServerIdentityId) === profileId;
  } catch {
    return false;
  }
}

function findProfileIdByComparableUrl(
  servers: Record<string, any>,
  serverUrlRaw: string,
  options: Readonly<{ identityFreeOnly?: boolean }> = {},
): string | null {
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
    if (options.identityFreeOnly && profile.homeConnectionDescriptor) continue;
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
  options: Readonly<{ identityFreeOnly?: boolean }> = {},
): string | null {
  const localMatches: string[] = [];
  for (const [id, value] of Object.entries(servers)) {
    const profile = coerceProfile(value);
    if (!profile) continue;
    if (options.identityFreeOnly && profile.homeConnectionDescriptor) continue;
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
  assertValidStoredHomeDescriptors(servers);
  const active = coerceProfile((servers as any)[activeId]) ?? coerceProfile((servers as any).cloud);
  if (!active) {
    throw new Error(`Active server profile not found: ${activeId}`);
  }
  return active;
}

export async function useServerProfile(idRaw: string): Promise<ServerProfile> {
  const identifier = asStringId(idRaw);
  const now = Date.now();
  let selectedProfile!: ServerProfile;
  await updateSettings((current: any) => {
    const servers = current?.servers && typeof current.servers === 'object' ? current.servers : {};
    assertValidStoredHomeDescriptors(servers);
    const resolvedId = findProfileIdByIdentifier(servers as any, identifier);
    if (!resolvedId) {
      throw new Error(`Server profile not found: ${identifier}`);
    }
    const existing = (servers as any)[resolvedId];
    if (!existing) {
      throw new Error(`Server profile not found: ${resolvedId}`);
    }
    const nextProfile = { ...existing, lastUsedAt: now, updatedAt: now };
    selectedProfile = requireProfileProjection(nextProfile, resolvedId);
    return {
      ...current,
      activeServerId: resolvedId,
      servers: {
        ...servers,
        [resolvedId]: nextProfile,
      },
    };
  });

  await maybeAdoptDerivedServerProfileState({
    targetServerId: selectedProfile.id,
    serverUrl: selectedProfile.serverUrl,
    ...(selectedProfile.localServerUrl ? { localServerUrl: selectedProfile.localServerUrl } : {}),
    hasObservedHomeIdentity: Boolean(selectedProfile.homeConnectionDescriptor?.homeServerIdentityId),
  }).catch(() => undefined);
  return selectedProfile;
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
  let createdProfile!: ServerProfile;

  await updateSettings((current: any) => {
    const servers = current?.servers && typeof current.servers === 'object' ? current.servers : {};
    assertValidStoredHomeDescriptors(servers);
    const idCollision = coerceProfile((servers as any)[id]);
    if (
      idCollision
      && (
        idCollision.homeConnectionDescriptor !== undefined
        || String((servers as any)[id]?.serverUrl ?? '').trim() !== serverUrl
      )
    ) {
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
      ...(existing?.homeConnectionDescriptor
        ? { homeConnectionDescriptor: existing.homeConnectionDescriptor }
        : {}),
    };
    createdProfile = requireProfileProjection(next, id);
    return {
      ...current,
      activeServerId: shouldUse ? id : current?.activeServerId,
      servers: { ...servers, [id]: next },
    };
  });

  if (shouldUse) {
    await maybeAdoptDerivedServerProfileState({
      targetServerId: id,
      serverUrl,
      ...(localServerUrl ? { localServerUrl } : {}),
    }).catch(() => undefined);
  }

  return createdProfile;
}

/**
 * Persists the exact authenticated Home-published descriptor on the active CLI
 * profile. The profile remains the daemon's only descriptor owner; callers do
 * not reconstruct endpoint facts or replace canonical profile metadata.
 */
export async function reconcileActiveServerProfileHomeConnectionDescriptor(
  descriptorInput: HomeConnectionDescriptorV1,
): Promise<Readonly<{
  profile: ServerProfile;
  outcome: 'updated' | 'unchanged' | 'stale';
}>> {
  const active = await getActiveServerProfile();
  return await adoptServerProfileHomeConnectionDescriptor({
    descriptor: descriptorInput,
    expectedProfileId: active.id,
    observation: 'exact',
  });
}

/**
 * Identity-first, non-credential-moving Home adoption. The local profile id is
 * immutable; descriptor routes may advance only on the one identity owner.
 */
export async function adoptServerProfileHomeConnectionDescriptor(opts: Readonly<{
  descriptor: HomeConnectionDescriptorV1;
  expectedProfileId?: string;
  suggestedName?: string;
  webappUrl?: string;
  observation: 'advisory' | 'exact';
  use?: boolean;
}>): Promise<Readonly<{
  profile: ServerProfile;
  outcome: 'updated' | 'unchanged' | 'stale';
}>> {
  const incoming = HomeConnectionDescriptorV1Schema.parse(opts.descriptor);
  const expectedProfileId = opts.expectedProfileId ? asStringId(opts.expectedProfileId) : null;
  let resolvedId = '';
  let outcome: 'updated' | 'unchanged' | 'stale' = 'unchanged';
  let adoptedProfile!: ServerProfile;

  await updateSettings((current: any) => {
    const servers = current?.servers && typeof current.servers === 'object' ? current.servers : {};
    assertValidStoredHomeDescriptors(servers);
    const identityMatches = findProfilesByHomeServerIdentityId(servers, incoming.homeServerIdentityId);
    if (identityMatches.length > 1) {
      throw new ServerProfileIdentityConflictError(
        incoming.homeServerIdentityId,
        identityMatches.map(([id]) => id).sort(),
      );
    }

    const identityMatchId = identityMatches[0]?.[0] ?? null;
    if (expectedProfileId && identityMatchId && expectedProfileId !== identityMatchId) {
      throw new ServerProfileIdentityMismatchError(
        `Observed Home identity belongs to profile ${identityMatchId}, not ${expectedProfileId}`,
      );
    }
    const expectedRaw = expectedProfileId ? servers[expectedProfileId] : null;
    const expected = expectedRaw ? coerceProfile(expectedRaw) : null;
    if (expectedProfileId && !expected) {
      throw new Error(`Server profile not found: ${expectedProfileId}`);
    }
    const expectedIdentity = expected?.homeConnectionDescriptor?.homeServerIdentityId;
    if (expectedIdentity && expectedIdentity !== incoming.homeServerIdentityId) {
      throw new ServerProfileIdentityMismatchError(
        `Profile ${expectedProfileId} belongs to Home ${expectedIdentity}, not ${incoming.homeServerIdentityId}`,
      );
    }

    resolvedId = identityMatchId ?? expectedProfileId ?? '';
    if (!resolvedId) {
      const requestedName = String(opts.suggestedName ?? '').trim() || new URL(incoming.canonicalServerUrl).hostname;
      const baseId = deriveServerIdFromName(requestedName) || deriveServerIdFromUrl(incoming.canonicalServerUrl);
      resolvedId = baseId;
      let suffix = 2;
      while (servers[resolvedId]) {
        resolvedId = `${baseId}-${suffix}`;
        suffix += 1;
      }
    }

    const rawExisting = servers[resolvedId];
    const existing = rawExisting ? coerceProfile(rawExisting) : null;
    const previous = existing?.homeConnectionDescriptor;
    const previousAuthority = existing?.homeConnectionDescriptorAuthority ?? (previous ? 'exact' : undefined);
    const descriptor = incoming;
    if (opts.observation === 'advisory' && previousAuthority === 'exact') {
      outcome = 'stale';
      adoptedProfile = requireProfileProjection(rawExisting, resolvedId);
      return current;
    }
    const promotesAdvisory = opts.observation === 'exact' && previousAuthority === 'advisory';
    if (!promotesAdvisory && previous && previous.revision > descriptor.revision) {
      outcome = 'stale';
      adoptedProfile = requireProfileProjection(rawExisting, resolvedId);
      return current;
    }
    if (!promotesAdvisory && previous && previous.revision === descriptor.revision) {
      if (!isDeepStrictEqual(previous, descriptor)) {
        throw new Error('Home descriptor conflicts with the persisted profile revision');
      }
      adoptedProfile = requireProfileProjection(rawExisting, resolvedId);
      return current;
    }

    const now = Date.now();
    const name = existing?.name || String(opts.suggestedName ?? '').trim() || new URL(descriptor.canonicalServerUrl).hostname;
    const webappUrl = String(opts.webappUrl ?? existing?.webappUrl ?? '').trim()
      || new URL(descriptor.canonicalServerUrl).origin;
    outcome = 'updated';
    const nextProfile = {
      ...(rawExisting && typeof rawExisting === 'object' ? rawExisting : {}),
      id: resolvedId,
      name,
      serverUrl: descriptor.canonicalServerUrl,
      ...(existing?.localServerUrl ? { localServerUrl: existing.localServerUrl } : {}),
      webappUrl,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: opts.use === true ? now : (existing?.lastUsedAt ?? 0),
      homeConnectionDescriptor: descriptor,
      homeConnectionDescriptorAuthority: opts.observation,
    };
    adoptedProfile = requireProfileProjection(nextProfile, resolvedId);
    return {
      ...current,
      activeServerId: opts.use === true ? resolvedId : current?.activeServerId,
      servers: {
        ...servers,
        [resolvedId]: nextProfile,
      },
    };
  });

  return { profile: adoptedProfile, outcome };
}

export async function findServerProfileIdentityConflicts(): Promise<ServerProfileIdentityConflict[]> {
  const profiles = await listServerProfiles();
  const byIdentity = new Map<string, string[]>();
  for (const profile of profiles) {
    const identity = profile.homeConnectionDescriptor?.homeServerIdentityId;
    if (!identity) continue;
    const ids = byIdentity.get(identity) ?? [];
    ids.push(profile.id);
    byIdentity.set(identity, ids);
  }
  return [...byIdentity.entries()]
    .filter(([, profileIds]) => profileIds.length > 1)
    .map(([homeServerIdentityId, profileIds]) => ({ homeServerIdentityId, profileIds: profileIds.sort() }))
    .sort((left, right) => left.homeServerIdentityId.localeCompare(right.homeServerIdentityId));
}

export async function setActiveServerProfileHomeConnectionDescriptor(
  descriptorInput: HomeConnectionDescriptorV1,
): Promise<ServerProfile> {
  return (await reconcileActiveServerProfileHomeConnectionDescriptor(descriptorInput)).profile;
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
  let upsertedProfile: ServerProfile | null = null;
  await updateSettings((current: any) => {
    const servers = current?.servers && typeof current.servers === 'object' ? current.servers : {};
    assertValidStoredHomeDescriptors(servers);
    const matchedId = findProfileIdByComparableUrl(servers, serverUrl, { identityFreeOnly: true })
      ?? (localServerUrl
        ? findProfileIdByLocalUrlAndWebapp(servers, localServerUrl, webappUrl, { identityFreeOnly: true })
        : null);
    if (!matchedId) {
      return current;
    }

    const existing = coerceProfile((servers as any)[matchedId]);
    if (!existing) {
      return current;
    }

    resolvedId = matchedId;
    const nextProfile = {
      ...existing,
      name: name || existing.name,
      serverUrl,
      // Omission preserves an existing split URL. Supplying a local URL
      // equal to the canonical URL explicitly collapses that split.
      ...(opts.localServerUrl !== undefined
        ? {
            localServerUrl: localServerUrl && localServerUrl !== serverUrl
              ? localServerUrl
              : undefined,
          }
        : {}),
      webappUrl,
      updatedAt: now,
      lastUsedAt: shouldUse ? now : existing.lastUsedAt,
    };
    upsertedProfile = requireProfileProjection(nextProfile, matchedId);
    return {
      ...current,
      activeServerId: shouldUse ? matchedId : current?.activeServerId,
      servers: {
        ...servers,
        [matchedId]: nextProfile,
      },
    };
  });

  if (!resolvedId) {
    return await addServerProfile(opts);
  }

  if (shouldUse) {
    await maybeAdoptDerivedServerProfileState({
      targetServerId: resolvedId,
      serverUrl,
      ...(localServerUrl ? { localServerUrl } : {}),
      hasObservedHomeIdentity: false,
    }).catch(() => undefined);
  }

  return upsertedProfile!;
}

/**
 * Updates the endpoints of one known profile without selecting, copying, or migrating any
 * other profile-scoped state. Stack orchestration uses this when a stack-owned runtime port
 * changes between starts.
 */
export async function setServerProfileEndpointsById(opts: Readonly<{
  id: string;
  name?: string;
  serverUrl: string;
  localServerUrl?: string;
  webappUrl: string;
  use?: boolean;
}>): Promise<ServerProfile> {
  const id = asStringId(opts.id);
  if (sanitizeServerIdForFilesystem(id, '') !== id) {
    throw new Error(`Invalid server profile id: ${id}`);
  }

  const serverUrl = String(opts.serverUrl ?? '').trim();
  const localServerUrl = String(opts.localServerUrl ?? '').trim();
  const webappUrl = String(opts.webappUrl ?? '').trim();
  const requestedName = String(opts.name ?? '').trim();
  const shouldUse = opts.use === true;
  const before = await readSettings();
  const previous = before.servers?.[id] ? requireProfileProjection(before.servers[id], id) : null;
  const previousDescriptor = previous?.homeConnectionDescriptor;
  // A URL change cannot rewrite Home authority. Refresh the published routes
  // through the requested carrier, retaining the profile's established identity.
  // Compare against the descriptor itself: a prior launcher may already have
  // updated the ordinary URLs while leaving the descriptor on the old port.
  if (previousDescriptor && previousDescriptor.canonicalServerUrl !== serverUrl) {
    const probeUrl = HomeApplicationOriginV1Schema.parse(
      (opts.localServerUrl !== undefined ? localServerUrl : previous?.localServerUrl) || serverUrl,
    );
    const credentials = await readStoredCredentialsForServerId(id);
    if (!credentials?.token) throw new Error('Home endpoint refresh requires the profile credential');
    const snapshot = await observeServerFeaturesSnapshot({ serverUrl: probeUrl, token: credentials.token });
    const observation = resolveAuthenticatedExactHomeConnectionDescriptorObservation({
      snapshot, expectedHomeServerIdentityId: previousDescriptor.homeServerIdentityId,
    });
    if (observation.kind !== 'available') {
      throw new Error('Home endpoint refresh requires a matching authenticated descriptor');
    }
    const adopted = await adoptServerProfileHomeConnectionDescriptor({
      descriptor: observation.descriptor, expectedProfileId: id, observation: 'exact',
    });
    if (adopted.outcome === 'stale') {
      throw new Error('Home endpoint refresh was rejected by descriptor revision admission');
    }
  }
  const now = Date.now();
  let updatedProfile!: ServerProfile;

  await updateSettings((current: any) => {
    const servers = current?.servers && typeof current.servers === 'object' ? current.servers : {};
    assertValidStoredHomeDescriptors(servers);
    const rawExisting = servers[id] && typeof servers[id] === 'object' ? servers[id] : {};
    const existing = coerceProfile(rawExisting);
    const name = existing?.name || requestedName || id;
    const createdAt = existing?.createdAt || now;
    const next = {
      ...rawExisting,
      id,
      name,
      serverUrl,
      ...(opts.localServerUrl !== undefined
        ? { localServerUrl: localServerUrl && localServerUrl !== serverUrl ? localServerUrl : undefined }
        : {}),
      webappUrl,
      createdAt,
      updatedAt: now,
      lastUsedAt: shouldUse ? now : (existing?.lastUsedAt ?? 0),
    };
    updatedProfile = requireProfileProjection(next, id);
    return {
      ...current,
      activeServerId: shouldUse ? id : current?.activeServerId,
      servers: { ...servers, [id]: next },
    };
  });

  return updatedProfile;
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

  let removedProfile!: ServerProfile;
  let activeProfileAfterRemoval!: ServerProfile;
  await updateSettings((current: any) => {
    const servers = current?.servers && typeof current.servers === 'object' ? current.servers : {};
    assertValidStoredHomeDescriptors(servers);
    const existing = (servers as any)[resolvedId];
    if (!existing) {
      throw new Error(`Server profile not found: ${resolvedId}`);
    }
    removedProfile = requireProfileProjection(existing, resolvedId);

    const { [resolvedId]: _removed, ...rest } = servers as any;
    const nextActive = resolvedId === current?.activeServerId ? 'cloud' : current?.activeServerId;
    if (nextActive === resolvedId) {
      throw new Error(`Refusing to keep ${resolvedId} as active after removal`);
    }
    if (nextActive && !(nextActive in rest)) {
      // Safety: if active server disappears (corrupt settings), fall back.
      (rest as any).cloud = (rest as any).cloud ?? (servers as any).cloud;
      activeProfileAfterRemoval = requireProfileProjection((rest as any).cloud, 'cloud');
      return { ...current, activeServerId: 'cloud', servers: rest };
    }
    const returnedActiveId = nextActive || 'cloud';
    activeProfileAfterRemoval = requireProfileProjection((rest as any)[returnedActiveId], returnedActiveId);
    return { ...current, activeServerId: nextActive, servers: rest };
  });

  return { removed: removedProfile, active: activeProfileAfterRemoval };
}
