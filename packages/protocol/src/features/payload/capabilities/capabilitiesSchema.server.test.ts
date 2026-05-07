import { describe, expect, it } from 'vitest';

import { BUILT_IN_PET_IDS_V1, PET_SYNC_SUPPORTED_MEDIA_TYPES_V1 } from '../../../pets/constants.js';
import { CapabilitiesSchema } from './capabilitiesSchema.js';

describe('CapabilitiesSchema (server capabilities)', () => {
  it('parses pet companion and sync capabilities when provided', () => {
    const parsed = CapabilitiesSchema.parse({
      pets: {
        companion: {
          builtInPetIds: ['blink', 'milo'],
        },
        limits: {
          maxManifestBytes: 4096,
          maxCanonicalSpritesheetBytes: 5000,
          maxCanonicalPackageBytes: 6000,
          maxPreCanonicalImportBytes: 7000,
          maxImportedPetsPerAccount: 2,
          maxImportedPetBytesPerAccount: 8000,
          maxImportedPetsPerDevice: 3,
          maxImportedPetBytesPerDevice: 9000,
        },
        sync: {
          maxManifestBytes: 4096,
          maxCanonicalSpritesheetBytes: 5000,
          maxCanonicalPackageBytes: 6000,
          maxPreCanonicalImportBytes: 7000,
          maxImportedPetsPerAccount: 2,
          maxImportedPetBytesPerAccount: 8000,
          maxImportedPetsPerDevice: 3,
          maxImportedPetBytesPerDevice: 9000,
          supportedMediaTypes: [...PET_SYNC_SUPPORTED_MEDIA_TYPES_V1],
          encryptedCustomPetSyncPolicy: 'disabled',
        },
      },
    });

    expect(parsed.pets.companion.builtInPetIds).toEqual(['blink', 'milo']);
    expect(parsed.pets.limits).toMatchObject({
      maxManifestBytes: 4096,
      maxCanonicalSpritesheetBytes: 5000,
      maxImportedPetsPerAccount: 2,
      maxImportedPetsPerDevice: 3,
    });
    expect(parsed.pets.sync).toMatchObject({
      maxManifestBytes: 4096,
      maxCanonicalSpritesheetBytes: 5000,
      maxImportedPetsPerAccount: 2,
      supportedMediaTypes: [...PET_SYNC_SUPPORTED_MEDIA_TYPES_V1],
      encryptedCustomPetSyncPolicy: 'disabled',
    });
  });

  it('defaults pet companion ids and conservative custom-pet sync policy', () => {
    const parsed = CapabilitiesSchema.parse({});

    expect(parsed.pets.companion.builtInPetIds).toEqual([...BUILT_IN_PET_IDS_V1]);
    expect(parsed.pets.sync.supportedMediaTypes).toEqual([...PET_SYNC_SUPPORTED_MEDIA_TYPES_V1]);
    expect(parsed.pets.sync.encryptedCustomPetSyncPolicy).toBe('disabled');
    expect(parsed.pets.sync.maxCanonicalPackageBytes).toBe(parsed.pets.limits.maxCanonicalPackageBytes);
  });

  it('preserves server url capabilities when provided', () => {
    const parsed = CapabilitiesSchema.parse({
      server: {
        canonicalServerUrl: 'https://stack.example.test',
        webappUrl: 'https://app.example.test',
      },
    });

    expect(parsed).toMatchObject({
      server: {
        canonicalServerUrl: 'https://stack.example.test',
        webappUrl: 'https://app.example.test',
      },
    });
  });

  it('parses server retention capabilities when provided', () => {
    const parsed = CapabilitiesSchema.parse({
      server: {
        retention: {
          policyVersion: 1,
          enabled: true,
          sessions: {
            mode: 'delete_inactive',
            inactivityDays: 30,
            requires: ['updatedAt', 'lastActiveAt'],
          },
          accountChanges: { mode: 'delete_older_than', days: 30 },
          voiceSessionLeases: { mode: 'keep_forever' },
          userFeedItems: { mode: 'delete_older_than', days: 90 },
          sessionShareAccessLogs: { mode: 'delete_older_than', days: 30 },
          publicShareAccessLogs: { mode: 'delete_older_than', days: 30 },
          terminalAuthRequests: { mode: 'delete_older_than', days: 7 },
          accountAuthRequests: { mode: 'delete_older_than', days: 7 },
          authPairingSessions: { mode: 'delete_older_than', days: 7 },
          repeatKeys: { mode: 'delete_older_than', days: 7 },
          globalLocks: { mode: 'delete_older_than', days: 7 },
          automationRuns: { mode: 'delete_older_than', days: 30 },
          automationRunEvents: { mode: 'delete_older_than', days: 30 },
        },
      },
    });

    expect(parsed.server.retention).toMatchObject({
      policyVersion: 1,
      enabled: true,
      sessions: {
        mode: 'delete_inactive',
        inactivityDays: 30,
        requires: ['updatedAt', 'lastActiveAt'],
      },
      accountChanges: { mode: 'delete_older_than', days: 30 },
      voiceSessionLeases: { mode: 'keep_forever' },
    });
  });
});
