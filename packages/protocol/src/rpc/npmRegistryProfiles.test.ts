import { describe, expect, it } from 'vitest';

import {
  DaemonNpmRegistryProfileMutationRequestV1Schema,
  DaemonNpmRegistryProfileSnapshotV1Schema,
  RPC_METHODS,
} from './index.js';

describe('daemon npm registry profile RPC contract', () => {
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
    expect(DaemonNpmRegistryProfileMutationRequestV1Schema.parse({
      action: 'login',
      machineId: 'machine-1',
      profileId: 'registry_acme',
      expectedRevision: 3,
      mutationId: 'mutation-12345678',
      credential: { kind: 'bearer_token', secret: 'secret-value' },
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
