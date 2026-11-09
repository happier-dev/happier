import { describe, expect, it, vi } from 'vitest';

import { acquireHomeCarrierByPolicy } from '../homeEnrollment/homeCarrierPolicy.js';

import {
  HomeTargetResolutionError,
  assertResolvedHomeTargetIdentity,
  parseHomeTargetInput,
  parseResolvedHomeTarget,
  resolveHomeTarget,
  type SavedHomeTargetProfile,
} from './homeTarget.js';

const descriptor = {
  v: 1 as const,
  homeServerIdentityId: 'srv_home_target_1',
  canonicalServerUrl: 'https://home.example.test',
  revision: 3,
  endpoints: [
    { kind: 'https' as const, url: 'https://route.example.test' },
    { kind: 'iroh' as const, endpointId: 'a'.repeat(64), relayUrls: ['https://relay.example.test/'] },
  ],
};

describe('Home target input and resolution', () => {
  it('normalizes descriptor authority without preselecting the Iroh-first carrier', async () => {
    const result = await resolveHomeTarget({
      input: parseHomeTargetInput({
        kind: 'descriptor',
        descriptor,
        authority: 'current_connection',
      }),
      readSavedProfile: async () => null,
    });

    expect(result).toMatchObject({
      homeServerIdentityId: 'srv_home_target_1',
      canonicalAuthUrl: 'https://home.example.test',
      preferredTransport: 'iroh',
      authority: 'current_connection',
      credentialDestination: {
        homeServerIdentityId: 'srv_home_target_1',
        applicationEndpointUrls: ['https://route.example.test'],
        irohEndpointIds: ['a'.repeat(64)],
      },
    });
    expect(result).not.toHaveProperty('selectedTransport');

    const acquireIroh = vi.fn(async () => ({
      homeServerIdentityId: descriptor.homeServerIdentityId,
      endpointId: 'a'.repeat(64),
      status: 'ready' as const,
      value: null,
      release: async () => undefined,
    }));
    await expect(acquireHomeCarrierByPolicy({
      descriptor: result.descriptor!,
      preferredTransport: result.preferredTransport,
      acquireIroh,
      classifyFailure: () => ({ fallbackAllowed: false }),
    })).resolves.toMatchObject({ kind: 'iroh' });
    expect(acquireIroh).toHaveBeenCalledOnce();
  });

  it('fails closed on unknown authority-bearing fields and URL-only identity claims', () => {
    expect(() => parseHomeTargetInput({
      kind: 'descriptor',
      descriptor,
      authority: 'current_connection',
      carrierEpoch: 2,
    })).toThrow(HomeTargetResolutionError);
    expect(() => parseHomeTargetInput({
      kind: 'https_url',
      url: 'https://home.example.test',
      homeServerIdentityId: 'srv_forged',
    })).toThrow(HomeTargetResolutionError);
  });

  it('reads an old saved profile without inventing an observed identity', async () => {
    const oldProfile: SavedHomeTargetProfile = {
      id: 'old-home',
      serverUrl: 'https://old.example.test',
      webappUrl: 'https://app.old.example.test',
    };
    const result = await resolveHomeTarget({
      input: { kind: 'saved_profile', profileRef: 'old-home' },
      readSavedProfile: async () => oldProfile,
    });

    expect(result).toMatchObject({
      profileId: 'old-home',
      homeServerIdentityId: null,
      descriptor: null,
      canonicalAuthUrl: 'https://old.example.test',
      preferredTransport: 'https',
      authority: 'saved_profile',
      credentialDestination: null,
    });
    expect(result).not.toHaveProperty('selectedTransport');
  });

  it('keeps a local development web app URL separate from the Home authentication origin policy', async () => {
    const result = await resolveHomeTarget({
      input: { kind: 'saved_profile', profileRef: 'local-stack' },
      readSavedProfile: async () => ({
        id: 'local-stack',
        serverUrl: 'http://127.0.0.1:53288',
        webappUrl: 'http://192.168.5.15:19364',
      }),
    });

    expect(result).toMatchObject({
      canonicalAuthUrl: 'http://127.0.0.1:53288',
      applicationUrl: 'http://127.0.0.1:53288',
      webappUrl: 'http://192.168.5.15:19364',
    });
  });

  it('uses one typed identity mismatch check for every consumer', async () => {
    const target = await resolveHomeTarget({
      input: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      readSavedProfile: async () => null,
    });

    expect(() => assertResolvedHomeTargetIdentity(target, 'srv_home_target_1')).not.toThrow();
    expect(() => assertResolvedHomeTargetIdentity(target, 'srv_other_home')).toThrowError(
      expect.objectContaining({ code: 'identity_mismatch' }),
    );
  });

  it('rejects impossible authority and descriptor projection combinations', async () => {
    const descriptorTarget = await resolveHomeTarget({
      input: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      readSavedProfile: async () => null,
    });
    const manualTarget = await resolveHomeTarget({
      input: { kind: 'https_url', url: 'https://manual.example.test' },
      readSavedProfile: async () => null,
    });

    expect(() => parseResolvedHomeTarget({ ...manualTarget, selectedTransport: 'https' }))
      .toThrowError(expect.objectContaining({ code: 'invalid_target' }));
    expect(() => parseResolvedHomeTarget({ ...manualTarget, preferredTransport: 'iroh' }))
      .toThrowError(expect.objectContaining({ code: 'invalid_target' }));
    expect(() => parseResolvedHomeTarget({ ...manualTarget, authority: 'current_connection' }))
      .toThrowError(expect.objectContaining({ code: 'invalid_target' }));
    expect(() => parseResolvedHomeTarget({ ...descriptorTarget, authority: 'manual_url' }))
      .toThrowError(expect.objectContaining({ code: 'invalid_target' }));
    expect(() => parseResolvedHomeTarget({ ...descriptorTarget, preferredTransport: 'https' }))
      .toThrowError(expect.objectContaining({ code: 'invalid_target' }));
    expect(manualTarget).toMatchObject({
      descriptor: null,
      applicationUrl: 'https://manual.example.test',
      preferredTransport: 'https',
      authority: 'manual_url',
    });
    expect(manualTarget).not.toHaveProperty('selectedTransport');
  });

  it('strictly parses an identity-free legacy saved profile projection', async () => {
    const target = await resolveHomeTarget({
      input: { kind: 'saved_profile', profileRef: 'legacy-home' },
      readSavedProfile: async () => ({
        id: 'legacy-home',
        serverUrl: 'https://legacy.example.test',
        webappUrl: 'https://legacy.example.test',
      }),
    });

    expect(parseResolvedHomeTarget(target)).toEqual(target);
  });
});
