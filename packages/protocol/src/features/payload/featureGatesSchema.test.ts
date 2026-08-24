import { describe, expect, it } from 'vitest';

import { readServerEnabledBit } from '../serverEnabledBit.js';
import { FeaturesResponseSchema } from './featuresResponseSchema.js';

describe('FeatureGatesSchema', () => {
  it('preserves pets companion and sync gates', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        pets: {
          companion: { enabled: true },
          sync: { enabled: true },
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'pets.companion')).toBe(true);
    expect(readServerEnabledBit(parsed, 'pets.sync')).toBe(true);
  });

  it('preserves channel bridge gates', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        channelBridges: {
          enabled: true,
          telegram: { enabled: true },
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'channelBridges')).toBe(true);
    expect(readServerEnabledBit(parsed, 'channelBridges.telegram')).toBe(true);
  });

  it('preserves generated session media gates separately from attachment upload gates', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        attachments: {
          uploads: { enabled: true },
        },
        session: {
          media: {
            generated: { enabled: true },
          },
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'attachments.uploads')).toBe(true);
    expect(readServerEnabledBit(parsed, 'session.media.generated')).toBe(true);
  });

  it('preserves session folder gates under sessions', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        sessions: {
          enabled: true,
          folders: { enabled: true },
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'sessions.folders')).toBe(true);
  });

  it('preserves connected service account group gates and usage-limit recovery gates', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        connectedServices: {
          enabled: true,
          accountGroups: { enabled: true },
          accountFallback: { enabled: true },
        },
        sessions: {
          enabled: true,
          usageLimitRecovery: { enabled: true },
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'connectedServices.accountGroups')).toBe(true);
    expect(readServerEnabledBit(parsed, 'connectedServices.accountFallback')).toBe(true);
    expect(readServerEnabledBit(parsed, 'sessions.usageLimitRecovery')).toBe(true);
  });

  it('defaults missing usage-limit and account-group gates to disabled', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {},
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'sessions.usageLimitRecovery')).toBe(false);
    expect(readServerEnabledBit(parsed, 'connectedServices.accountGroups')).toBe(false);
    expect(readServerEnabledBit(parsed, 'connectedServices.accountFallback')).toBe(false);
    expect(readServerEnabledBit(parsed, 'sessions.drafts')).toBe(false);
  });

  it('preserves synchronized draft support under sessions', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: { sessions: { enabled: true, drafts: { enabled: true } } },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'sessions.drafts')).toBe(true);
  });

  it('preserves pending delivery-state support separately from the basic pending queue gate', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        sharing: {
          pendingQueueV2: { enabled: true },
          pendingDeliveryState: { enabled: true },
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'sharing.pendingQueueV2')).toBe(true);
    expect(readServerEnabledBit(parsed, 'sharing.pendingDeliveryState')).toBe(true);
  });

  it('defaults pending delivery-state support disabled when old servers omit it', () => {
    const parsed = FeaturesResponseSchema.parse({
      features: {
        sharing: {
          pendingQueueV2: { enabled: true },
        },
      },
      capabilities: {},
    });

    expect(readServerEnabledBit(parsed, 'sharing.pendingQueueV2')).toBe(true);
    expect(readServerEnabledBit(parsed, 'sharing.pendingDeliveryState')).toBe(false);
  });
});
