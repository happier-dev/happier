import { describe, expect, it } from 'vitest';

import { CapabilitiesSchema } from './capabilitiesSchema.js';

describe('CapabilitiesSchema (server capabilities)', () => {
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
