import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createNpmRegistryProfileService } from './service';
import { createNpmRegistryCredentialStore } from './credentials';
import { NpmRegistryHttpError } from '../httpsClient';

describe('npm registry profile service', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  async function makeService(probe?: NonNullable<Parameters<typeof createNpmRegistryProfileService>[0]>['probe']) {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-npm-profile-service-'));
    roots.push(happyHomeDir);
    return {
      happyHomeDir,
      service: createNpmRegistryProfileService({ happyHomeDir, now: () => 100, ...(probe ? { probe } : {}) }),
    };
  }

  const addRequest = {
    action: 'add' as const,
    machineId: 'machine-1',
    expectedRevision: 0,
    mutationId: 'mutation-add-acme',
    profileId: 'registry_acme',
    profile: {
      displayName: 'Acme', origin: 'https://registry.acme.test', scopes: ['@acme'],
      useAsDefault: false, allowPrivateNetwork: true,
    },
  };

  it('adds and logs in without exposing or persisting credential material in profile state', async () => {
    const { happyHomeDir, service } = await makeService();
    const added = await service.mutate(addRequest);
    expect(added).toMatchObject({ status: 'success', snapshot: { revision: 1 } });

    const loggedIn = await service.mutate({
      action: 'login', machineId: 'machine-1', profileId: 'registry_acme', expectedRevision: 1,
      mutationId: 'mutation-login-acme', credential: { kind: 'bearer_token', secret: 'boundary-secret' },
    });
    expect(loggedIn).toMatchObject({
      status: 'success',
      snapshot: { profiles: [{ profileId: 'registry_acme', hasCredentials: true, authenticationState: 'configured' }] },
    });
    expect(JSON.stringify(loggedIn)).not.toContain('boundary-secret');

    const stateRaw = await readFile(join(happyHomeDir, 'plugins', 'plugins', 'state', 'npm-registry-profiles.v1.json'), 'utf8');
    expect(stateRaw).not.toContain('boundary-secret');
    expect(stateRaw).not.toContain('Bearer');
  });

  it('does not overwrite a credential when a login mutation id is replayed with different input', async () => {
    const { service } = await makeService();
    await service.mutate(addRequest);
    const login = {
      action: 'login' as const, machineId: 'machine-1', profileId: 'registry_acme', expectedRevision: 1,
      mutationId: 'mutation-login-idempotent', credential: { kind: 'bearer_token' as const, secret: 'first-secret' },
    };
    await service.mutate(login);
    const replay = await service.mutate({ ...login, credential: { ...login.credential, secret: 'different-secret' } });
    expect(replay).toMatchObject({ status: 'success', snapshot: { revision: 2 } });
    const seen = await service.withAuthorization('registry_acme', async ({ authorizationHeader }) => authorizationHeader);
    expect(seen).toBe('Bearer first-secret');
  });

  it('accepts protocol-maximum profile and mutation identifiers without exceeding internal reference bounds', async () => {
    const { service } = await makeService();
    const profileId = `r${'a'.repeat(127)}`;
    await expect(service.mutate({
      ...addRequest,
      profileId,
      mutationId: 'mutation-add-maximum-id',
    })).resolves.toMatchObject({ status: 'success' });

    await expect(service.mutate({
      action: 'login',
      machineId: 'machine-1',
      profileId,
      expectedRevision: 1,
      mutationId: `m${'b'.repeat(127)}`,
      credential: { kind: 'bearer_token', secret: 'boundary-secret' },
    })).resolves.toMatchObject({
      status: 'success',
      snapshot: { profiles: [{ profileId, hasCredentials: true }] },
    });
  });

  it('accepts the maximum bounded scope inventory without overflowing its idempotency receipt', async () => {
    const { service } = await makeService();
    const scopes = Array.from({ length: 64 }, (_, index) => (
      `@s${String(index).padStart(2, '0')}${'x'.repeat(209)}`
    ));
    await expect(service.mutate({
      ...addRequest,
      mutationId: 'mutation-add-maximum-scopes',
      profile: { ...addRequest.profile, scopes },
    })).resolves.toMatchObject({
      status: 'success',
      snapshot: { profiles: [{ scopes }] },
    });
  });

  it('reconciles encrypted credential records that are not referenced by a committed profile', async () => {
    const { happyHomeDir, service } = await makeService();
    const credentials = createNpmRegistryCredentialStore({ happyHomeDir });
    await credentials.set('credential-orphaned-before-profile-commit', 'Bearer boundary-secret');
    await expect(credentials.has('credential-orphaned-before-profile-commit')).resolves.toBe(true);

    await service.snapshot();

    await expect(credentials.has('credential-orphaned-before-profile-commit')).resolves.toBe(false);
  });

  it('rejects ambiguous origins, scopes, defaults, and stale revisions without partial changes', async () => {
    const { service } = await makeService();
    await service.mutate(addRequest);
    const conflicts: Array<readonly [string, typeof addRequest.profile]> = [
      ['mutation-origin', { displayName: 'Same origin', origin: 'https://registry.acme.test', scopes: ['@other'], useAsDefault: false, allowPrivateNetwork: false }],
      ['mutation-scope', { displayName: 'Same scope', origin: 'https://other.test', scopes: ['@acme'], useAsDefault: false, allowPrivateNetwork: false }],
    ];
    for (const [mutationId, profile] of conflicts) {
      await expect(service.mutate({
        action: 'add', machineId: 'machine-1', expectedRevision: 1, mutationId,
        profileId: mutationId, profile,
      })).resolves.toMatchObject({ status: 'error', code: 'profile_conflict' });
    }

    await expect(service.mutate({
      action: 'logout', machineId: 'machine-1', expectedRevision: 0,
      mutationId: 'mutation-stale-logout', profileId: 'registry_acme',
    })).resolves.toMatchObject({ status: 'error', code: 'revision_conflict', currentRevision: 1 });
    await expect(service.snapshot()).resolves.toMatchObject({ revision: 1, profiles: [{ profileId: 'registry_acme' }] });
  });

  it('classifies authentication and offline checks and pauses only the affected origin', async () => {
    let result: 'available' | 'authentication_failed' | 'offline' = 'authentication_failed';
    const seenHeaders: Array<string | undefined> = [];
    const { service } = await makeService(async ({ authorizationHeader }) => {
      seenHeaders.push(authorizationHeader);
      return { status: result };
    });
    await service.mutate(addRequest);
    await service.mutate({
      action: 'login', machineId: 'machine-1', profileId: 'registry_acme', expectedRevision: 1,
      mutationId: 'mutation-login-acme', credential: { kind: 'bearer_token', secret: 'boundary-secret' },
    });
    expect(await service.mutate({
      action: 'test', machineId: 'machine-1', profileId: 'registry_acme', expectedRevision: 2,
      mutationId: 'mutation-test-auth',
    })).toMatchObject({
      status: 'error', code: 'authentication_failed',
    });
    expect(seenHeaders).toEqual(['Bearer boundary-secret']);
    expect(await service.snapshot()).toMatchObject({
      profiles: [{ availability: 'sign_in_required' }],
      pausedSources: [{ origin: 'https://registry.acme.test', reason: 'authentication_failed' }],
    });

    result = 'offline';
    expect(await service.mutate({
      action: 'test', machineId: 'machine-1', profileId: 'registry_acme', expectedRevision: 3,
      mutationId: 'mutation-test-offline',
    })).toMatchObject({ status: 'error', code: 'offline', retryable: true });

    result = 'available';
    expect(await service.mutate({
      action: 'test', machineId: 'machine-1', profileId: 'registry_acme', expectedRevision: 4,
      mutationId: 'mutation-test-recover',
    })).toMatchObject({ status: 'success', snapshot: { profiles: [{ availability: 'available' }], pausedSources: [] } });
  });

  it('logout and removal preserve source pause state without disabling installed plugins', async () => {
    const { service } = await makeService();
    await service.mutate(addRequest);
    await service.mutate({
      action: 'login', machineId: 'machine-1', profileId: 'registry_acme', expectedRevision: 1,
      mutationId: 'mutation-login-acme', credential: { kind: 'bearer_token', secret: 'boundary-secret' },
    });
    const logout = await service.mutate({
      action: 'logout', machineId: 'machine-1', profileId: 'registry_acme', expectedRevision: 2,
      mutationId: 'mutation-logout-acme',
    });
    expect(logout).toMatchObject({
      status: 'success',
      snapshot: { profiles: [{ hasCredentials: false }], pausedSources: [{ reason: 'credentials_missing' }] },
    });
    const removed = await service.mutate({
      action: 'remove', machineId: 'machine-1', profileId: 'registry_acme', expectedRevision: 3,
      mutationId: 'mutation-remove-acme',
    });
    expect(removed).toMatchObject({
      status: 'success', snapshot: { profiles: [], pausedSources: [{ reason: 'profile_removed' }] },
    });
    expect(JSON.stringify(removed)).not.toContain('enabled');
    expect(JSON.stringify(removed)).not.toContain('trusted');
  });

  it('replays a completed removal idempotently after the profile no longer exists', async () => {
    const { service } = await makeService();
    await service.mutate(addRequest);
    const request = {
      action: 'remove' as const,
      machineId: 'machine-1',
      profileId: 'registry_acme',
      expectedRevision: 1,
      mutationId: 'mutation-remove-idempotent',
    };
    const removed = await service.mutate(request);
    expect(removed).toMatchObject({ status: 'success', snapshot: { revision: 2, profiles: [] } });
    await expect(service.mutate(request)).resolves.toEqual(removed);
  });

  it('clears a stale removed-source pause when the same origin is configured again', async () => {
    const { service } = await makeService();
    await service.mutate(addRequest);
    await service.mutate({
      action: 'remove', machineId: 'machine-1', profileId: 'registry_acme', expectedRevision: 1,
      mutationId: 'mutation-remove-before-readd',
    });
    const readded = await service.mutate({
      ...addRequest, expectedRevision: 2, mutationId: 'mutation-readd-acme', profileId: 'registry_acme_readded',
    });
    expect(readded).toMatchObject({ status: 'success', snapshot: { pausedSources: [] } });
  });

  it('does not carry credentials across a registry-origin change', async () => {
    const { service } = await makeService();
    await service.mutate(addRequest);
    await service.mutate({
      action: 'login', machineId: 'machine-1', profileId: 'registry_acme', expectedRevision: 1,
      mutationId: 'mutation-login-before-origin-change', credential: { kind: 'bearer_token', secret: 'acme-only-secret' },
    });
    const updated = await service.mutate({
      action: 'update', machineId: 'machine-1', profileId: 'registry_acme', expectedRevision: 2,
      mutationId: 'mutation-change-origin', profile: {
        ...addRequest.profile, origin: 'https://registry.new-acme.test',
      },
    });
    expect(updated).toMatchObject({
      status: 'success', snapshot: { profiles: [{ origin: 'https://registry.new-acme.test', hasCredentials: false }] },
    });
    await expect(service.withAuthorization('registry_acme', async ({ authorizationHeader }) => authorizationHeader))
      .resolves.toBeUndefined();
  });

  it('materializes authorization only inside the selected outbound operation and retries once after credential rotation', async () => {
    const { service } = await makeService();
    await service.mutate(addRequest);
    await service.mutate({
      action: 'login', machineId: 'machine-1', profileId: 'registry_acme', expectedRevision: 1,
      mutationId: 'mutation-login-first', credential: { kind: 'bearer_token', secret: 'first-secret' },
    });
    const seen: string[] = [];
    const result = await service.runArtifactRequest({ packageName: '@acme/plugin', selector: 'latest' }, async (access) => {
      seen.push(access.authorizationHeader ?? 'none');
      expect(access.allowPrivateNetwork).toBe(true);
      if (seen.length === 1) {
        await service.mutate({
          action: 'login', machineId: 'machine-1', profileId: 'registry_acme', expectedRevision: 2,
          mutationId: 'mutation-login-rotated', credential: { kind: 'bearer_token', secret: 'rotated-secret' },
        });
        throw new NpmRegistryHttpError(401);
      }
      return access.request.registryOrigin;
    });
    expect(result).toBe('https://registry.acme.test');
    expect(seen).toEqual(['Bearer first-secret', 'Bearer rotated-secret']);
  });

  it('fences a removed source while an outbound operation is in flight', async () => {
    const { service } = await makeService();
    await service.mutate(addRequest);
    await expect(service.runArtifactRequest({ packageName: '@acme/plugin' }, async () => {
      await service.mutate({
        action: 'remove', machineId: 'machine-1', profileId: 'registry_acme', expectedRevision: 1,
        mutationId: 'mutation-remove-during-fetch',
      });
      return 'downloaded';
    })).rejects.toMatchObject({ code: 'source_changed' });
  });

  it('fences an in-flight request when its selected profile policy changes', async () => {
    const { service } = await makeService();
    await service.mutate(addRequest);
    await expect(service.runArtifactRequest({ packageName: '@acme/plugin' }, async () => {
      await service.mutate({
        action: 'update',
        machineId: 'machine-1',
        profileId: 'registry_acme',
        expectedRevision: 1,
        mutationId: 'mutation-change-network-policy-during-fetch',
        profile: { ...addRequest.profile, allowPrivateNetwork: false },
      });
      return 'downloaded';
    })).rejects.toMatchObject({ code: 'source_changed' });
  });

  it('marks only the selected source paused after an authentication failure without a rotated credential', async () => {
    const { service } = await makeService();
    await service.mutate(addRequest);
    await service.mutate({
      action: 'login', machineId: 'machine-1', profileId: 'registry_acme', expectedRevision: 1,
      mutationId: 'mutation-login-auth-failure', credential: { kind: 'bearer_token', secret: 'expired-secret' },
    });
    await expect(service.runArtifactRequest({ packageName: '@acme/plugin' }, async () => {
      throw new NpmRegistryHttpError(401);
    })).rejects.toMatchObject({ code: 'authentication_failed' });
    await expect(service.snapshot()).resolves.toMatchObject({
      profiles: [{ profileId: 'registry_acme', availability: 'sign_in_required' }],
      pausedSources: [{ origin: 'https://registry.acme.test', reason: 'authentication_failed' }],
    });

    let futureCalls = 0;
    await expect(service.runArtifactRequest({
      packageName: '@acme/plugin',
      explicitProfileId: 'registry_acme',
    }, async () => {
      futureCalls += 1;
      return 'downloaded';
    })).rejects.toMatchObject({ code: 'authentication_required' });
    expect(futureCalls).toBe(0);
  });

  it('revokes future exact profile resolution before download after logout or removal', async () => {
    const { service } = await makeService();
    await service.mutate(addRequest);
    await service.mutate({
      action: 'login', machineId: 'machine-1', profileId: 'registry_acme', expectedRevision: 1,
      mutationId: 'mutation-login-before-revoke', credential: { kind: 'bearer_token', secret: 'boundary-secret' },
    });
    await service.mutate({
      action: 'logout', machineId: 'machine-1', profileId: 'registry_acme', expectedRevision: 2,
      mutationId: 'mutation-logout-before-fetch',
    });
    let calls = 0;
    await expect(service.runArtifactRequest({
      packageName: '@acme/plugin', explicitProfileId: 'registry_acme',
    }, async () => {
      calls += 1;
      return 'downloaded';
    })).rejects.toMatchObject({ code: 'authentication_required' });

    await service.mutate({
      action: 'remove', machineId: 'machine-1', profileId: 'registry_acme', expectedRevision: 3,
      mutationId: 'mutation-remove-before-fetch',
    });
    await expect(service.runArtifactRequest({
      packageName: '@acme/plugin', explicitProfileId: 'registry_acme',
    }, async () => {
      calls += 1;
      return 'downloaded';
    })).rejects.toThrow(/unknown npm registry profile/i);
    expect(calls).toBe(0);
  });

  it('retries a rotated credential at most once and pauses the new revision if it also fails authentication', async () => {
    const { service } = await makeService();
    await service.mutate(addRequest);
    await service.mutate({
      action: 'login', machineId: 'machine-1', profileId: 'registry_acme', expectedRevision: 1,
      mutationId: 'mutation-login-retry-first', credential: { kind: 'bearer_token', secret: 'first-secret' },
    });
    let calls = 0;
    await expect(service.runArtifactRequest({ packageName: '@acme/plugin' }, async () => {
      calls += 1;
      if (calls === 1) {
        await service.mutate({
          action: 'login', machineId: 'machine-1', profileId: 'registry_acme', expectedRevision: 2,
          mutationId: 'mutation-login-retry-second', credential: { kind: 'bearer_token', secret: 'second-secret' },
        });
      }
      throw new NpmRegistryHttpError(401);
    })).rejects.toMatchObject({ code: 'authentication_failed' });
    expect(calls).toBe(2);
    await expect(service.snapshot()).resolves.toMatchObject({
      profiles: [{ availability: 'sign_in_required' }],
      pausedSources: [{ reason: 'authentication_failed' }],
    });
  });
});
