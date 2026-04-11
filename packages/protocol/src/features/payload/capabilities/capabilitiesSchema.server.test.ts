import { describe, expect, it } from 'vitest';

import { CapabilitiesSchema } from './capabilitiesSchema.js';

describe('CapabilitiesSchema (server capabilities)', () => {
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
