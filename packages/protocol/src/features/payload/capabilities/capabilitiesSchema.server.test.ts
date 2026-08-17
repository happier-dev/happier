import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CapabilitiesSchema } from './capabilitiesSchema.js';

describe('CapabilitiesSchema (server capabilities)', () => {
  it('keeps Collection deployment limits in one optional closed top-level capability family', () => {
    const limits = {
      maxRowEncodedBytes: 262_144,
      maxBatchBytes: 1_048_576,
      maxBatchRows: 64,
      maxAccountRows: 10_000,
      maxAccountBytes: 16_777_216,
    };

    expect(CapabilitiesSchema.parse({}).pluginDataCollections).toBeUndefined();
    expect(CapabilitiesSchema.parse({ pluginDataCollections: limits }).pluginDataCollections)
      .toEqual(limits);
    expect(CapabilitiesSchema.safeParse({
      pluginDataCollections: { ...limits, unexpected: true },
    }).success).toBe(false);

    // The prospective predecessor has a root-open reader. It must discard the
    // new family rather than treating it as a strict child-field extension.
    const OldCapabilitiesSchema = z.object({
      server: z.object({
        canonicalServerUrl: z.string().trim().min(1).optional(),
        webappUrl: z.string().trim().min(1).optional(),
      }).strict().optional().default({}),
    });
    expect(OldCapabilitiesSchema.parse({ pluginDataCollections: limits })).toEqual({ server: {} });
  });

  it('parses server identity capabilities outside the strict server capability object', () => {
    const parsed = CapabilitiesSchema.parse({
      server: {
        canonicalServerUrl: 'https://stack.example.test',
      },
      serverIdentity: {
        serverIdentityId: 'srv_identity_123',
      },
    });

    expect(parsed.server.canonicalServerUrl).toBe('https://stack.example.test');
    expect(parsed.serverIdentity.serverIdentityId).toBe('srv_identity_123');
  });

  it('defaults missing server identity capabilities for older servers', () => {
    const parsed = CapabilitiesSchema.parse({});

    expect(parsed.serverIdentity.serverIdentityId).toBeNull();
  });

  it('normalizes unsafe server identity capabilities to null', () => {
    const parsed = CapabilitiesSchema.parse({
      serverIdentity: {
        serverIdentityId: 'relay.example.test',
      },
    });

    expect(parsed.serverIdentity.serverIdentityId).toBeNull();
  });

  it('keeps new server identity payloads parseable for old strict server capability shapes', () => {
    const OldCapabilitiesSchema = z.object({
      server: z.object({
        canonicalServerUrl: z.string().trim().min(1).optional(),
        webappUrl: z.string().trim().min(1).optional(),
      }).strict().optional().default({}),
    });

    const parsed = OldCapabilitiesSchema.parse({
      server: {
        canonicalServerUrl: 'https://stack.example.test',
      },
      serverIdentity: {
        serverIdentityId: 'srv_identity_123',
      },
    });

    expect(parsed).toEqual({
      server: {
        canonicalServerUrl: 'https://stack.example.test',
      },
    });
  });

  it('parses tunnel limits under machine capabilities without treating them as gates', () => {
    const parsed = CapabilitiesSchema.parse({
      machines: {
        tunnel: {
          directPeer: {
            allowedPorts: [3000, 5173],
            maxIdleMs: 30_000,
            maxDurationMs: 300_000,
          },
          serverRouted: {
            maxBytes: 4096,
            maxActiveTunnelsPerSocket: 2,
            maxFrameBytes: 1024,
            supportedEncodings: ['json_base64_v1', 'binary_frame_v2'],
            preferredEncoding: 'binary_frame_v2',
            allowV1Fallback: true,
            maxBinaryHeaderBytes: 512,
            maxRawPayloadBytes: 2048,
            maxFramedMessageBytes: 4096,
            substreams: {
              maxConcurrentSubstreams: 8,
              maxTotalSubstreams: 64,
              maxBytesPerSubstream: 8192,
              maxAggregateBytes: 16_384,
              maxSubstreamIdleMs: 5000,
              maxSessionIdleMs: 10_000,
            },
            maxIdleMs: 10_000,
            maxDurationMs: 60_000,
            disabledReason: 'relay_disabled_by_server_policy',
          },
        },
      },
    });

    expect(parsed.machines.tunnel.directPeer.allowedPorts).toEqual([3000, 5173]);
    expect(parsed.machines.tunnel.serverRouted).toMatchObject({
      maxBytes: 4096,
      maxActiveTunnelsPerSocket: 2,
      maxFrameBytes: 1024,
      preferredEncoding: 'binary_frame_v2',
      maxBinaryHeaderBytes: 512,
      maxRawPayloadBytes: 2048,
      maxFramedMessageBytes: 4096,
      disabledReason: 'relay_disabled_by_server_policy',
    });
    expect(parsed.machines.tunnel.serverRouted.supportedEncodings).toEqual([
      'json_base64_v1',
      'binary_frame_v2',
    ]);
    expect(parsed.machines.tunnel.serverRouted.substreams).toMatchObject({
      maxConcurrentSubstreams: 8,
      maxTotalSubstreams: 64,
      maxBytesPerSubstream: 8192,
      maxAggregateBytes: 16_384,
    });
  });

  it('parses peer mediation grant signing keys from machine capabilities', () => {
    const parsed = CapabilitiesSchema.parse({
      machines: {
        peerMediation: {
          grantSigningKeys: [
            {
              keyId: 'route-grant-key-1',
              publicKey: 'AbCdEf012_-',
              expiresAt: 1_900_000_000_000,
            },
          ],
        },
      },
    });

    expect(parsed.machines.peerMediation.grantSigningKeys).toEqual([
      {
        keyId: 'route-grant-key-1',
        publicKey: 'AbCdEf012_-',
        expiresAt: 1_900_000_000_000,
      },
    ]);
  });

  it('parses live-stream relay caps and diagnostics from machine capabilities', () => {
    const parsed = CapabilitiesSchema.parse({
      machines: {
        liveStream: {
          serverRouted: {
            caps: {
              maxBitrateBps: 64_000,
              maxFramesPerSecond: 12,
              maxFrameBytes: 32_000,
              maxDurationMs: 60_000,
              maxTotalBytes: 128_000,
              maxConcurrentStreamsPerAccount: 2,
              maxConcurrentStreamsPerSocket: 1,
              maxConcurrentStreamsPerMachine: 1,
            },
            disabledReason: null,
          },
        },
      },
    });

    expect(parsed.machines.liveStream.serverRouted.caps).toMatchObject({
      maxBitrateBps: 64_000,
      maxFramesPerSecond: 12,
      maxFrameBytes: 32_000,
      maxDurationMs: 60_000,
      maxTotalBytes: 128_000,
    });
    expect(parsed.machines.liveStream.serverRouted.disabledReason).toBeNull();
  });

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
          supportedMediaTypes: ['image/webp', 'image/png'],
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
      supportedMediaTypes: ['image/webp', 'image/png'],
      encryptedCustomPetSyncPolicy: 'disabled',
    });
  });

  it('defaults pet companion ids and conservative custom-pet sync policy', () => {
    const parsed = CapabilitiesSchema.parse({});

    expect(parsed.pets.companion.builtInPetIds).toEqual(['blink']);
    expect(parsed.pets.sync.supportedMediaTypes).toEqual(['image/webp', 'image/png']);
    expect(parsed.pets.sync.encryptedCustomPetSyncPolicy).toBe('disabled');
    expect(parsed.pets.sync.maxCanonicalPackageBytes).toBe(parsed.pets.limits.maxCanonicalPackageBytes);
  });

  it('parses session message role capabilities while preserving session state capabilities', () => {
    const parsed = CapabilitiesSchema.parse({
      session: {
        state: {
          identity: {
            runtimeDescriptor: {
              supported: true,
              happierToProvider: { supported: true, transport: 'runtime-hook' },
            },
          },
        },
        messages: {
          role: true,
        },
      },
    });

    expect(parsed.session.messages.role).toBe(true);
    expect(parsed.session.state.identity?.runtimeDescriptor?.supported).toBe(true);
  });

  it('defaults session message role capabilities to unsupported', () => {
    const parsed = CapabilitiesSchema.parse({});

    expect(parsed.session.messages.role).toBe(false);
    expect(parsed.session.state).toEqual({});
  });

  it('parses independently advertised session protocol capabilities', () => {
    const parsed = CapabilitiesSchema.parse({
      session: {
        runtimeActivity: { protocolVersion: 2 },
        pendingInput: { protocolVersion: 1 },
        publisherAuthority: { protocolVersion: 1 },
        externalImport: { publicationFenceVersion: 3 },
      },
    });

    expect(parsed.session).toMatchObject({
      runtimeActivity: { protocolVersion: 2 },
      pendingInput: { protocolVersion: 1 },
      publisherAuthority: { protocolVersion: 1 },
      externalImport: { publicationFenceVersion: 3 },
    });
  });

  it('keeps usage analytics capability optional so newer clients remain compatible with older servers', () => {
    const parsed = CapabilitiesSchema.parse({
      server: {
        canonicalServerUrl: 'https://stack.example.test',
      },
    });

    expect(parsed.server.canonicalServerUrl).toBe('https://stack.example.test');
    expect(parsed.server.usageAnalytics).toBeUndefined();
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
          usageEvents: { mode: 'keep_forever' },
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
      usageEvents: { mode: 'keep_forever' },
    });
  });

  it('keeps retention capabilities backward-compatible when usageEvents is absent', () => {
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
      accountChanges: { mode: 'delete_older_than', days: 30 },
    });
    expect(parsed.server.retention?.usageEvents).toBeUndefined();
  });

  it('parses usage analytics capabilities when provided', () => {
    const parsed = CapabilitiesSchema.parse({
      server: {
        usageAnalytics: {
          version: 1,
          eventsIngest: { path: '/v2/usage-events' },
          query: { path: '/v2/usage/query' },
          legacy: {
            usageReportsPath: '/v2/usage-reports',
            usageQueryPath: '/v1/usage/query',
          },
        },
      },
    });

    expect(parsed.server.usageAnalytics).toMatchObject({
      version: 1,
      query: { path: '/v2/usage/query' },
    });
  });

  it('accepts additive usage analytics capabilities alongside existing server capabilities', () => {
    const parsed = CapabilitiesSchema.parse({
      server: {
        canonicalServerUrl: 'https://stack.example.test',
        usageAnalytics: {
          version: 1,
          eventsIngest: { path: '/v2/usage-events' },
          query: { path: '/v2/usage/query' },
          legacy: {
            usageReportsPath: '/v2/usage-reports',
            usageQueryPath: '/v1/usage/query',
          },
        },
      },
    });

    expect(parsed.server).toMatchObject({
      canonicalServerUrl: 'https://stack.example.test',
      usageAnalytics: {
        legacy: {
          usageReportsPath: '/v2/usage-reports',
        },
      },
    });
  });
});
