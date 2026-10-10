import { describe, expect, it } from 'vitest';

import {
  DaemonNpmRegistryProfileMutationRequestV1Schema,
  DaemonNpmRegistryProfileSnapshotV1Schema,
  NpmRegistryOriginV1Schema,
  RPC_METHODS,
} from './index.js';

describe('daemon npm registry profile RPC contract', () => {
  it('normalizes valid registry origins before imposing URL representation assumptions', () => {
    const origin = `https://registry.example:${'0'.repeat(2_100)}443`;
    expect(new URL(origin).origin).toBe('https://registry.example');
    expect(NpmRegistryOriginV1Schema.parse(origin)).toBe('https://registry.example');
  });
  it('projects every registry profile, scope and paused source beyond the former count limits', () => {
    const scopes = Array.from({ length: 70 }, (_, index) => `@scope${index}`);
    const profiles = Array.from({ length: 70 }, (_, index) => ({
      profileId: `registry_${index}_${'a'.repeat(140)}`, displayName: `Registry ${index} ${'name'.repeat(200)}`, origin: `https://registry-${index}.example`,
      scopes, useAsDefault: false, allowPrivateNetwork: false, hasCredentials: false,
      authenticationState: 'missing', availability: 'unknown', lastSuccessfulCheckAtMs: null, updatedAtMs: 1,
    }));
    const pausedSources = Array.from({ length: 70 }, (_, index) => ({
      origin: `https://paused-${index}.example`, reason: 'offline', updatedAtMs: 1,
    }));
    expect(DaemonNpmRegistryProfileSnapshotV1Schema.parse({ protocolVersion: 1, revision: 1,
      profiles, pausedSources,
    })).toEqual({ protocolVersion: 1, revision: 1, profiles, pausedSources });
  });
  it('projects bounded secret-free profiles and paused source state', () => {
    const parsed = DaemonNpmRegistryProfileSnapshotV1Schema.parse({
      protocolVersion: 1,
      revision: 3,
      profiles: [{
        profileId: 'registry_acme',
        displayName: 'Acme registry',
        origin: 'https://registry.acme.test',
        scopes: ['@acme'],
        useAsDefault: false,
        allowPrivateNetwork: true,
        hasCredentials: true,
        authenticationState: 'configured',
        availability: 'available',
        lastSuccessfulCheckAtMs: 123,
        updatedAtMs: 123,
      }],
      pausedSources: [{
        origin: 'https://old.acme.test',
        reason: 'profile_removed',
        updatedAtMs: 122,
      }],
    });

    expect(parsed.profiles[0]).not.toHaveProperty('credentialSecretRef');
    expect(JSON.stringify(parsed)).not.toContain('token');
  });

  it('accepts credential input only on the login mutation and never accepts raw headers', () => {
    expect(DaemonNpmRegistryProfileMutationRequestV1Schema.safeParse({
      action: 'login', machineId: 'machine-1', profileId: 'registry_acme', expectedRevision: 3,
      mutationId: 'm', credential: { kind: 'bearer_token', secret: 'secret-value' },
    }).success).toBe(true);
    expect(DaemonNpmRegistryProfileMutationRequestV1Schema.parse({
      action: 'login',
      machineId: `machine-${'a'.repeat(300)}`,
      profileId: `registry_${'a'.repeat(140)}`,
      expectedRevision: 3,
      mutationId: `mutation-${'a'.repeat(140)}`,
      credential: { kind: 'bearer_token', secret: 'secret-value'.repeat(1_000) },
    })).toMatchObject({ action: 'login' });

    expect(DaemonNpmRegistryProfileMutationRequestV1Schema.safeParse({
      action: 'login',
      machineId: 'machine-1',
      profileId: 'registry_acme',
      expectedRevision: 3,
      mutationId: 'mutation-12345678',
      authorizationHeader: 'Bearer secret-value',
    }).success).toBe(false);

    expect(DaemonNpmRegistryProfileMutationRequestV1Schema.safeParse({
      action: 'login', machineId: 'machine-1', profileId: 'registry_acme', expectedRevision: 3,
      mutationId: '../credential-path', credential: { kind: 'bearer_token', secret: 'secret-value' },
    }).success).toBe(false);
  });

  it('reserves one snapshot and mutation method', () => {
    expect(RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_GET).toBe('daemon.plugins.npmRegistries.get');
    expect(RPC_METHODS.DAEMON_NPM_REGISTRY_PROFILES_MUTATE).toBe('daemon.plugins.npmRegistries.mutate');
  });
});
