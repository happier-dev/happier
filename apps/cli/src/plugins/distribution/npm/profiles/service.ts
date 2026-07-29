import {
  DaemonNpmRegistryProfileMutationRequestV1Schema,
  DaemonNpmRegistryProfileMutationResponseV1Schema,
  DaemonNpmRegistryProfileSnapshotV1Schema,
  type DaemonNpmRegistryProfileMutationRequestV1,
  type DaemonNpmRegistryProfileMutationResponseV1,
  type DaemonNpmRegistryProfileSnapshotV1,
} from '@happier-dev/protocol/rpc';
import { createHash, randomUUID } from 'node:crypto';

import {
  createNpmRegistryProfileStore,
  NpmRegistryProfileStoreError,
  type NpmRegistryProfileFile,
  type PersistedNpmRegistryProfile,
} from '@/plugins/store/npmRegistries/store';
import { NPM_REGISTRY_AUTHORITY_LOCK_NAME, withPluginStoreLock } from '@/plugins/store/lock';

import { NpmRegistryHttpError } from '../httpsClient';
import { normalizeNpmArtifactRequest } from '../normalize';
import type {
  NormalizeNpmArtifactRequestInput,
  NormalizedNpmArtifactRequest,
  NpmRegistryProfile,
} from '../types';
import { createNpmRegistryCredentialStore } from './credentials';

type ProbeResult = Readonly<{ status: 'available' | 'authentication_failed' | 'offline' }>;
type MutationErrorCode = Extract<DaemonNpmRegistryProfileMutationResponseV1, { status: 'error' }>['code'];

export class NpmRegistryProfileOperationError extends Error {
  readonly code: 'authentication_failed' | 'authentication_required' | 'source_changed';

  constructor(code: NpmRegistryProfileOperationError['code']) {
    super(code);
    this.name = 'NpmRegistryProfileOperationError';
    this.code = code;
  }
}

function rpcError(code: MutationErrorCode, options?: Readonly<{
  retryable?: boolean;
  currentRevision?: number;
}>): Extract<DaemonNpmRegistryProfileMutationResponseV1, { status: 'error' }> {
  return {
    status: 'error',
    code,
    retryable: options?.retryable ?? false,
    ...(options?.currentRevision === undefined ? {} : { currentRevision: options.currentRevision }),
  };
}

function mutationFingerprint(request: DaemonNpmRegistryProfileMutationRequestV1): string {
  const intent = request.action === 'login'
    ? { action: request.action, profileId: request.profileId, credentialKind: request.credential.kind }
    : request;
  return createHash('sha256').update(JSON.stringify(intent), 'utf8').digest('hex');
}

function credentialSecretRef(profileId: string, mutationId: string): string {
  const identity = createHash('sha256')
    .update(profileId, 'utf8')
    .update('\0', 'utf8')
    .update(mutationId, 'utf8')
    .digest('hex');
  return `credential-${identity}`;
}

function sourceAuthorityEquals(
  left: PersistedNpmRegistryProfile,
  right: PersistedNpmRegistryProfile,
): boolean {
  if (
    left.profileId !== right.profileId
    || left.origin !== right.origin
    || left.useAsDefault !== right.useAsDefault
    || left.allowPrivateNetwork !== right.allowPrivateNetwork
    || left.credentialSecretRef !== right.credentialSecretRef
    || left.credentialRevision !== right.credentialRevision
    || left.scopes.length !== right.scopes.length
  ) {
    return false;
  }
  const leftScopes = [...left.scopes].sort();
  const rightScopes = [...right.scopes].sort();
  return leftScopes.every((scope, index) => scope === rightScopes[index]);
}

function replacePause(
  current: NpmRegistryProfileFile,
  origin: string,
  reason: NpmRegistryProfileFile['pausedSources'][number]['reason'] | null,
  now: number,
): NpmRegistryProfileFile['pausedSources'] {
  const retained = current.pausedSources.filter((entry) => entry.origin !== origin);
  return reason ? [...retained, { origin, reason, updatedAtMs: now }] : retained;
}

function assertDeterministicProfiles(profiles: readonly PersistedNpmRegistryProfile[]): void {
  const origins = new Set<string>();
  const scopes = new Set<string>();
  let defaultCount = 0;
  for (const profile of profiles) {
    if (origins.has(profile.origin)) throw new Error('profile_conflict');
    origins.add(profile.origin);
    if (profile.useAsDefault) defaultCount += 1;
    for (const scope of profile.scopes) {
      if (scopes.has(scope)) throw new Error('profile_conflict');
      scopes.add(scope);
    }
  }
  if (defaultCount > 1) throw new Error('profile_conflict');
}

function toResolverProfiles(profiles: readonly PersistedNpmRegistryProfile[]): readonly NpmRegistryProfile[] {
  return profiles.map((profile) => ({
    version: 1,
    id: profile.profileId,
    displayName: profile.displayName,
    origin: profile.origin,
    scopes: profile.scopes,
    useAsDefault: profile.useAsDefault,
    ...(profile.credentialSecretRef ? { credentialSecretRef: profile.credentialSecretRef } : {}),
    createdAtMs: profile.updatedAtMs,
    updatedAtMs: profile.updatedAtMs,
  }));
}

export function createNpmRegistryProfileService(params: Readonly<{
  happyHomeDir?: string;
  now?: () => number;
  probe?: (input: Readonly<{
    profile: PersistedNpmRegistryProfile;
    authorizationHeader?: string;
  }>) => Promise<ProbeResult>;
}> = {}): Readonly<{
  snapshot(): Promise<DaemonNpmRegistryProfileSnapshotV1>;
  mutate(raw: DaemonNpmRegistryProfileMutationRequestV1): Promise<DaemonNpmRegistryProfileMutationResponseV1>;
  withAuthorization<T>(profileId: string, use: (input: Readonly<{
    profile: PersistedNpmRegistryProfile;
    authorizationHeader?: string;
  }>) => Promise<T>): Promise<T>;
  runArtifactRequest<T>(
    input: Omit<NormalizeNpmArtifactRequestInput, 'profiles'>,
    operation: (access: Readonly<{
      request: NormalizedNpmArtifactRequest;
      authorizationHeader?: string;
      allowPrivateNetwork: boolean;
    }>) => Promise<T>,
  ): Promise<T>;
}> {
  const store = createNpmRegistryProfileStore({ happyHomeDir: params.happyHomeDir });
  const credentials = createNpmRegistryCredentialStore({ happyHomeDir: params.happyHomeDir });
  const now = params.now ?? Date.now;

  async function reconcileCredentialReferences(): Promise<void> {
    const file = await store.read();
    const referenced = new Set(file.profiles.flatMap((profile) => (
      profile.credentialSecretRef ? [profile.credentialSecretRef] : []
    )));
    const stored = await credentials.listRefs();
    await Promise.all(stored.filter((ref) => !referenced.has(ref)).map(async (ref) => {
      await credentials.delete(ref);
    }));
  }

  async function withAuthority<T>(fn: () => Promise<T>): Promise<T> {
    return await withPluginStoreLock({
      paths: store.paths,
      lockName: NPM_REGISTRY_AUTHORITY_LOCK_NAME,
      fn: async () => {
        await reconcileCredentialReferences();
        return await fn();
      },
    });
  }

  async function project(file: NpmRegistryProfileFile): Promise<DaemonNpmRegistryProfileSnapshotV1> {
    const profiles = await Promise.all(file.profiles.map(async (profile) => {
      const hasCredentials = profile.credentialSecretRef !== null && await credentials.has(profile.credentialSecretRef);
      return {
        profileId: profile.profileId,
        displayName: profile.displayName,
        origin: profile.origin,
        scopes: profile.scopes,
        useAsDefault: profile.useAsDefault,
        allowPrivateNetwork: profile.allowPrivateNetwork,
        hasCredentials,
        authenticationState: hasCredentials ? 'configured' as const : 'missing' as const,
        availability: profile.credentialSecretRef !== null && !hasCredentials ? 'sign_in_required' as const : profile.availability,
        lastSuccessfulCheckAtMs: profile.lastSuccessfulCheckAtMs,
        updatedAtMs: profile.updatedAtMs,
      };
    }));
    return DaemonNpmRegistryProfileSnapshotV1Schema.parse({
      protocolVersion: 1,
      revision: file.revision,
      profiles,
      pausedSources: file.pausedSources,
    });
  }

  async function snapshot(): Promise<DaemonNpmRegistryProfileSnapshotV1> {
    return await withAuthority(async () => await project(await store.read()));
  }

  async function applyStoreMutation(
    request: DaemonNpmRegistryProfileMutationRequestV1,
    apply: (current: NpmRegistryProfileFile) => NpmRegistryProfileFile,
  ): Promise<NpmRegistryProfileFile | Extract<DaemonNpmRegistryProfileMutationResponseV1, { status: 'error' }>> {
    try {
      return await store.mutate({
        expectedRevision: request.expectedRevision,
        mutationId: request.mutationId,
        fingerprint: mutationFingerprint(request),
        apply,
      });
    } catch (error) {
      if (error instanceof NpmRegistryProfileStoreError && error.code === 'revision_conflict') {
        return rpcError('revision_conflict', { currentRevision: error.currentRevision });
      }
      if (error instanceof NpmRegistryProfileStoreError && error.code === 'mutation_conflict') {
        return rpcError('invalid_request', { currentRevision: error.currentRevision });
      }
      if ((error as Error | null)?.message === 'profile_conflict') return rpcError('profile_conflict');
      return rpcError('unavailable', { retryable: true });
    }
  }

  async function mutateParsed(
    request: DaemonNpmRegistryProfileMutationRequestV1,
  ): Promise<DaemonNpmRegistryProfileMutationResponseV1> {
    if (request.action === 'add' || request.action === 'update') {
      const priorProfile = request.action === 'update'
        ? (await store.read()).profiles.find((entry) => entry.profileId === request.profileId) ?? null
        : null;
      const result = await applyStoreMutation(request, (current) => {
        const existing = current.profiles.find((entry) => entry.profileId === request.profileId) ?? null;
        if ((request.action === 'add' && existing) || (request.action === 'update' && !existing)) throw new Error('profile_conflict');
        const originChanged = existing !== null && existing.origin !== request.profile.origin;
        const nextProfile: PersistedNpmRegistryProfile = {
          profileId: request.profileId,
          ...request.profile,
          credentialSecretRef: originChanged ? null : existing?.credentialSecretRef ?? null,
          credentialRevision: originChanged ? (existing?.credentialRevision ?? 0) + 1 : existing?.credentialRevision ?? 0,
          availability: originChanged ? 'sign_in_required' : existing?.availability ?? 'unknown',
          lastSuccessfulCheckAtMs: originChanged ? null : existing?.lastSuccessfulCheckAtMs ?? null,
          updatedAtMs: now(),
        };
        const profiles = existing
          ? current.profiles.map((entry) => entry.profileId === request.profileId ? nextProfile : entry)
          : [...current.profiles, nextProfile];
        assertDeterministicProfiles(profiles);
        const withoutNewOriginPause = current.pausedSources.filter((entry) => entry.origin !== nextProfile.origin);
        return {
          ...current,
          profiles,
          pausedSources: existing && existing.origin !== nextProfile.origin
            ? [
                ...withoutNewOriginPause.filter((entry) => entry.origin !== existing.origin),
                { origin: existing.origin, reason: 'profile_removed' as const, updatedAtMs: now() },
              ]
            : withoutNewOriginPause,
        };
      });
      if ('status' in result) return result;
      if (priorProfile?.credentialSecretRef && priorProfile.origin !== request.profile.origin) {
        await credentials.delete(priorProfile.credentialSecretRef).catch(() => undefined);
      }
      return { status: 'success', snapshot: await project(result) };
    }

    const before = await store.read();
    const priorMutation = before.mutations.find((entry) => entry.mutationId === request.mutationId);
    if (priorMutation) {
      return priorMutation.fingerprint === mutationFingerprint(request)
        ? { status: 'success', snapshot: await project(before) }
        : rpcError('invalid_request', { currentRevision: before.revision });
    }
    const profile = before.profiles.find((entry) => entry.profileId === request.profileId) ?? null;
    if (!profile) return rpcError('not_found', { currentRevision: before.revision });

    if (request.action === 'login') {
      const secretRef = credentialSecretRef(request.profileId, request.mutationId);
      await credentials.set(secretRef, `Bearer ${request.credential.secret}`);
      const result = await applyStoreMutation(request, (current) => {
        const currentProfile = current.profiles.find((entry) => entry.profileId === request.profileId);
        if (!currentProfile) throw new Error('profile_conflict');
        return {
          ...current,
          profiles: current.profiles.map((entry) => entry.profileId === request.profileId ? {
            ...entry,
            credentialSecretRef: secretRef,
            credentialRevision: entry.credentialRevision + 1,
            availability: 'unknown',
            updatedAtMs: now(),
          } : entry),
          pausedSources: replacePause(current, currentProfile.origin, null, now()),
        };
      });
      if ('status' in result) {
        await credentials.delete(secretRef).catch(() => undefined);
        return result;
      }
      if (profile.credentialSecretRef && profile.credentialSecretRef !== secretRef) {
        await credentials.delete(profile.credentialSecretRef).catch(() => undefined);
      }
      return { status: 'success', snapshot: await project(result) };
    }

    if (request.action === 'logout' || request.action === 'remove') {
      const priorRef = profile.credentialSecretRef;
      const result = await applyStoreMutation(request, (current) => {
        const currentProfile = current.profiles.find((entry) => entry.profileId === request.profileId);
        if (!currentProfile) throw new Error('profile_conflict');
        return {
          ...current,
          profiles: request.action === 'remove'
            ? current.profiles.filter((entry) => entry.profileId !== request.profileId)
            : current.profiles.map((entry) => entry.profileId === request.profileId ? {
              ...entry,
              credentialSecretRef: null,
              credentialRevision: entry.credentialRevision + 1,
              availability: 'sign_in_required',
              updatedAtMs: now(),
            } : entry),
          pausedSources: replacePause(
            current,
            currentProfile.origin,
            request.action === 'remove' ? 'profile_removed' : 'credentials_missing',
            now(),
          ),
        };
      });
      if ('status' in result) return result;
      if (priorRef) await credentials.delete(priorRef).catch(() => undefined);
      return { status: 'success', snapshot: await project(result) };
    }

    if (!params.probe) return rpcError('unavailable', { retryable: true });
    let authorizationHeader: string | undefined;
    if (profile.credentialSecretRef) {
      authorizationHeader = await credentials.get(profile.credentialSecretRef) ?? undefined;
      if (!authorizationHeader) return rpcError('authentication_required');
    }
    let probe: ProbeResult;
    try {
      probe = await params.probe({ profile, ...(authorizationHeader ? { authorizationHeader } : {}) });
    } catch {
      probe = { status: 'offline' };
    }
    const result = await applyStoreMutation(request, (current) => ({
      ...current,
      profiles: current.profiles.map((entry) => entry.profileId === request.profileId ? {
        ...entry,
        availability: probe.status === 'authentication_failed' ? 'sign_in_required' : probe.status,
        lastSuccessfulCheckAtMs: probe.status === 'available' ? now() : entry.lastSuccessfulCheckAtMs,
        updatedAtMs: now(),
      } : entry),
      pausedSources: replacePause(
        current,
        profile.origin,
        probe.status === 'available' ? null : probe.status,
        now(),
      ),
    }));
    if ('status' in result) return result;
    if (probe.status === 'authentication_failed') return rpcError('authentication_failed', { currentRevision: result.revision });
    if (probe.status === 'offline') return rpcError('offline', { retryable: true, currentRevision: result.revision });
    return { status: 'success', snapshot: await project(result) };
  }

  async function mutate(raw: DaemonNpmRegistryProfileMutationRequestV1): Promise<DaemonNpmRegistryProfileMutationResponseV1> {
    const parsed = DaemonNpmRegistryProfileMutationRequestV1Schema.safeParse(raw);
    if (!parsed.success) return rpcError('invalid_request');
    return parsed.data.action === 'test'
      ? await mutateParsed(parsed.data)
      : await withAuthority(async () => await mutateParsed(parsed.data));
  }

  async function withAuthorization<T>(profileId: string, use: (input: Readonly<{
    profile: PersistedNpmRegistryProfile;
    authorizationHeader?: string;
  }>) => Promise<T>): Promise<T> {
    const access = await withAuthority(async () => {
      const file = await store.read();
      const profile = file.profiles.find((entry) => entry.profileId === profileId);
      if (!profile) throw new Error('npm_registry_profile_not_found');
      const authorizationHeader = profile.credentialSecretRef
        ? await credentials.get(profile.credentialSecretRef) ?? undefined
        : undefined;
      if (profile.credentialSecretRef && !authorizationHeader) throw new Error('npm_registry_authentication_required');
      return { profile, ...(authorizationHeader ? { authorizationHeader } : {}) };
    });
    return await use(access);
  }

  async function resolveArtifactAccess(input: Omit<NormalizeNpmArtifactRequestInput, 'profiles'>): Promise<Readonly<{
    request: NormalizedNpmArtifactRequest;
    profile: PersistedNpmRegistryProfile | null;
    authorizationHeader?: string;
  }>> {
    const file = await store.read();
    const request = normalizeNpmArtifactRequest({ ...input, profiles: toResolverProfiles(file.profiles) });
    const profileId = request.selection.profileId;
    const profile = profileId ? file.profiles.find((entry) => entry.profileId === profileId) ?? null : null;
    const paused = profile ? file.pausedSources.find((entry) => entry.origin === profile.origin) ?? null : null;
    if (profile && (
      profile.availability === 'sign_in_required'
      || paused?.reason === 'authentication_failed'
      || paused?.reason === 'credentials_missing'
      || paused?.reason === 'profile_removed'
    )) {
      throw new NpmRegistryProfileOperationError('authentication_required');
    }
    const authorizationHeader = profile?.credentialSecretRef
      ? await credentials.get(profile.credentialSecretRef) ?? undefined
      : undefined;
    if (profile?.credentialSecretRef && !authorizationHeader) {
      throw new NpmRegistryProfileOperationError('authentication_required');
    }
    return {
      request,
      profile,
      ...(authorizationHeader ? { authorizationHeader } : {}),
    };
  }

  async function assertSourceUnchanged(profile: PersistedNpmRegistryProfile | null): Promise<void> {
    if (!profile) return;
    await withAuthority(async () => {
      const current = (await store.read()).profiles.find((entry) => entry.profileId === profile.profileId);
      if (!current || !sourceAuthorityEquals(current, profile)) {
        throw new NpmRegistryProfileOperationError('source_changed');
      }
    });
  }

  async function recordAuthenticationFailure(profile: PersistedNpmRegistryProfile): Promise<void> {
    await withAuthority(async () => {
      const current = await store.read();
      const currentProfile = current.profiles.find((entry) => entry.profileId === profile.profileId);
      if (!currentProfile || !sourceAuthorityEquals(currentProfile, profile)) return;
      await store.mutate({
        expectedRevision: current.revision,
        mutationId: `registry-auth-failure-${randomUUID()}`,
        fingerprint: createHash('sha256')
          .update(JSON.stringify({ profileId: profile.profileId, credentialRevision: profile.credentialRevision }), 'utf8')
          .digest('hex'),
        apply: (latest) => ({
          ...latest,
          profiles: latest.profiles.map((entry) => entry.profileId === profile.profileId ? {
            ...entry,
            availability: 'sign_in_required',
            updatedAtMs: now(),
          } : entry),
          pausedSources: replacePause(latest, profile.origin, 'authentication_failed', now()),
        }),
      }).catch((error) => {
        if (!(error instanceof NpmRegistryProfileStoreError && error.code === 'revision_conflict')) throw error;
      });
    });
  }

  async function runArtifactRequest<T>(
    input: Omit<NormalizeNpmArtifactRequestInput, 'profiles'>,
    operation: (access: Readonly<{
      request: NormalizedNpmArtifactRequest;
      authorizationHeader?: string;
      allowPrivateNetwork: boolean;
    }>) => Promise<T>,
  ): Promise<T> {
    let access = await withAuthority(async () => await resolveArtifactAccess(input));
    try {
      const result = await operation({
        request: access.request,
        allowPrivateNetwork: access.profile?.allowPrivateNetwork === true,
        ...(access.authorizationHeader ? { authorizationHeader: access.authorizationHeader } : {}),
      });
      await assertSourceUnchanged(access.profile);
      return result;
    } catch (error) {
      if (!(error instanceof NpmRegistryHttpError) || error.code !== 'authentication_failed' || !access.profile) throw error;

      const refreshed = await withAuthority(async () => await resolveArtifactAccess(input));
      if (refreshed.profile?.profileId !== access.profile.profileId || refreshed.profile.origin !== access.profile.origin) {
        throw new NpmRegistryProfileOperationError('source_changed');
      }
      const credentialRotated = refreshed.profile?.profileId === access.profile.profileId
        && refreshed.profile.origin === access.profile.origin
        && refreshed.profile.credentialRevision > access.profile.credentialRevision;
      if (!credentialRotated) {
        await recordAuthenticationFailure(access.profile);
        throw new NpmRegistryProfileOperationError('authentication_failed');
      }

      access = refreshed;
      let result: T;
      try {
        result = await operation({
          request: access.request,
          allowPrivateNetwork: access.profile?.allowPrivateNetwork === true,
          ...(access.authorizationHeader ? { authorizationHeader: access.authorizationHeader } : {}),
        });
      } catch (retryError) {
        if (retryError instanceof NpmRegistryHttpError && retryError.code === 'authentication_failed' && access.profile) {
          await recordAuthenticationFailure(access.profile);
          throw new NpmRegistryProfileOperationError('authentication_failed');
        }
        throw retryError;
      }
      await assertSourceUnchanged(access.profile);
      return result;
    }
  }

  return Object.freeze({ snapshot, mutate, withAuthorization, runArtifactRequest });
}
