import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';
import {
  ServerUsageAnalyticsCapabilitiesSchema,
  UsageAnalyticsBreakdownDimensionSchema,
  UsageAnalyticsQueryRequestSchema,
  UsageAnalyticsQueryResponseSchema,
  UsageEventIngestRequestSchema,
} from './usageAnalyticsContracts.js';

describe('usageAnalyticsContracts', () => {
  it('accepts latest context fields on session breakdown rows', () => {
    const response = UsageAnalyticsQueryResponseSchema.parse({
      v: 1,
      totals: {
        eventCount: 1,
        tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
        cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
      },
      breakdowns: {
        session: [{
          key: 'session-1',
          eventCount: 1,
          tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
          cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
          latestContextUsedTokens: 42_000,
          latestContextWindowTokens: 400_000,
        }],
      },
    });

    expect(response.breakdowns?.session?.[0]).toMatchObject({
      latestContextUsedTokens: 42_000,
      latestContextWindowTokens: 400_000,
    });
  });

  it('exports usage analytics contracts from the protocol root for additive mixed-version adoption', () => {
    expect(typeof (protocol as any).UsageEventIngestRequestSchema).toBe('object');
    expect(typeof (protocol as any).UsageAnalyticsQueryRequestSchema).toBe('object');
    expect(typeof (protocol as any).UsageAnalyticsQueryResponseSchema).toBe('object');
    expect(typeof (protocol as any).ServerUsageAnalyticsCapabilitiesSchema).toBe('object');
  });

  it('parses usage event ingest requests with additive usage dimensions', () => {
    const parsed = UsageEventIngestRequestSchema.parse({
      sessionId: 'session-1',
      observedAt: 1_714_000_000_000,
      agentId: 'claude',
      backendMode: 'remote',
      modelId: 'claude-sonnet-4-6',
      projectKey: 'project:abc',
      workspaceId: 'workspace-1',
      machineId: 'machine-1',
      source: 'claude_sdk',
      scope: 'session_final',
      externalKey: 'vendor-event-1',
      turnId: 'turn-1',
      isCumulative: false,
      tokens: {
        input: 10,
        output: 5,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 15,
      },
      cost: {
        reportedUsd: 0.12,
        estimatedUsd: 0,
        invoiceUsd: 0.09,
        billingContext: 'api_usage',
        costSource: 'provider_reported',
        currency: 'USD',
      },
      context: {
        usedTokens: 15,
        windowTokens: 200_000,
      },
    });

    expect(parsed.agentId).toBe('claude');
    expect(parsed.tokens.total).toBe(15);
    expect(parsed.cost.reportedUsd).toBe(0.12);
    expect(parsed.cost.invoiceUsd).toBe(0.09);
  });

  it('parses additive usage analytics query requests and responses', () => {
    const request = UsageAnalyticsQueryRequestSchema.parse({
      dateRange: {
        startMs: 1_714_000_000_000,
        endMs: 1_714_086_400_000,
      },
      granularity: 'day',
      costMode: 'reported',
      breakdowns: ['agent', 'model'],
      filters: {
        sessionIds: ['session-1'],
        agentIds: ['claude'],
      },
      includeSeries: true,
      includeInsights: true,
      includeActivity: true,
      includeLeaders: true,
      includeModelTimeline: true,
      includeMessageStats: true,
      activityResolution: 'both',
      topLimit: 10,
    });

    expect(request.breakdowns).toEqual([
      UsageAnalyticsBreakdownDimensionSchema.enum.agent,
      UsageAnalyticsBreakdownDimensionSchema.enum.model,
    ]);

    const response = UsageAnalyticsQueryResponseSchema.parse({
      v: 1,
      totals: {
        eventCount: 2,
        tokens: {
          input: 10,
          output: 5,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 15,
        },
        cost: {
          reportedUsd: 0.12,
          estimatedUsd: 0,
          invoiceUsd: 0.09,
          currency: 'USD',
        },
      },
      series: [
        {
          bucketStartMs: 1_714_000_000_000,
          bucketEndMs: 1_714_086_400_000,
          eventCount: 2,
          tokens: {
            input: 10,
            output: 5,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 15,
          },
          cost: {
            reportedUsd: 0.12,
            estimatedUsd: 0,
            invoiceUsd: 0.09,
            currency: 'USD',
          },
        },
      ],
      breakdowns: {
        agent: [
          {
            key: 'claude',
            label: 'Claude',
            eventCount: 2,
            tokens: {
              input: 10,
              output: 5,
              reasoning: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 15,
            },
            cost: {
              reportedUsd: 0.12,
              estimatedUsd: 0,
              invoiceUsd: 0.09,
              currency: 'USD',
            },
          },
        ],
      },
      insights: {
        activeDays: 1,
        longestStreakDays: 1,
        sessionsUsed: 1,
        messagesUsed: 1,
        modelsTried: 1,
        favoriteModel: {
          key: 'claude-sonnet-4-6',
          label: 'Claude Sonnet 4.6',
        },
        favoriteModelChangeCount: 0,
        busiestMonth: {
          key: '2024-04',
          label: 'Apr 2024',
        },
        busiestDay: {
          key: '2024-04-25',
          label: 'Thu',
        },
        busiestHour: {
          key: '13',
          label: '1 PM',
        },
      },
      activity: {
        calendarDays: [
          {
            date: '2024-04-25',
            eventCount: 2,
          },
        ],
        weekdayHourBuckets: [
          {
            weekday: 4,
            hour: 13,
            eventCount: 2,
          },
        ],
      },
      leaders: {
        agents: [
          {
            key: 'claude',
            label: 'Claude',
            eventCount: 2,
            tokens: {
              input: 10,
              output: 5,
              reasoning: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 15,
            },
            cost: {
              reportedUsd: 0.12,
              estimatedUsd: 0,
              invoiceUsd: 0.09,
              currency: 'USD',
            },
          },
        ],
        models: [
          {
            key: 'claude-sonnet-4-6',
            label: 'Claude Sonnet 4.6',
            eventCount: 2,
            tokens: {
              input: 10,
              output: 5,
              reasoning: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 15,
            },
            cost: {
              reportedUsd: 0.12,
              estimatedUsd: 0,
              invoiceUsd: 0.09,
              currency: 'USD',
            },
          },
        ],
        sessions: [
          {
            key: 'session-1',
            label: 'Session 1',
            eventCount: 2,
            tokens: {
              input: 10,
              output: 5,
              reasoning: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 15,
            },
            cost: {
              reportedUsd: 0.12,
              estimatedUsd: 0,
              invoiceUsd: 0.09,
              currency: 'USD',
            },
          },
        ],
        projects: [],
        workspaces: [],
        engines: [
          {
            key: 'claude:remote',
            label: 'Claude Remote',
            eventCount: 2,
            tokens: {
              input: 10,
              output: 5,
              reasoning: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 15,
            },
            cost: {
              reportedUsd: 0.12,
              estimatedUsd: 0,
              invoiceUsd: 0.09,
              currency: 'USD',
            },
          },
        ],
      },
      engineTimeline: [
        {
          bucketStartMs: 1_714_000_000_000,
          bucketEndMs: 1_714_086_400_000,
          leaders: [
            {
              key: 'claude:remote',
              label: 'Claude Remote',
              eventCount: 2,
              tokens: {
                input: 10,
                output: 5,
                reasoning: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 15,
              },
              cost: {
                reportedUsd: 0.12,
                estimatedUsd: 0,
                invoiceUsd: 0.09,
                currency: 'USD',
              },
            },
          ],
        },
      ],
      messageStats: {
        sessionCount: 1,
        messageCount: 1,
      },
      costPresentation: {
        mode: 'reported',
        effectiveUsd: 0.12,
        currency: 'USD',
        source: 'provider_reported',
      },
    });

    expect(response.v).toBe(1);
    expect(response.breakdowns?.agent?.[0]?.key).toBe('claude');
    expect(response.insights?.favoriteModel?.label).toBe('Claude Sonnet 4.6');
    expect(response.costPresentation?.mode).toBe('reported');
  });

  it('defaults usage analytics bucketing to UTC and bounds minutes-east offsets', () => {
    expect(UsageAnalyticsQueryRequestSchema.parse({}).timeZoneOffsetMinutes).toBe(0);
    expect(UsageAnalyticsQueryRequestSchema.parse({ timeZoneOffsetMinutes: 840 }).timeZoneOffsetMinutes).toBe(840);
    expect(UsageAnalyticsQueryRequestSchema.parse({ timeZoneOffsetMinutes: -840 }).timeZoneOffsetMinutes).toBe(-840);
    expect(() => UsageAnalyticsQueryRequestSchema.parse({ timeZoneOffsetMinutes: 841 })).toThrow();
    expect(() => UsageAnalyticsQueryRequestSchema.parse({ timeZoneOffsetMinutes: -841 })).toThrow();
  });

  it('keeps analytics query response fields optional so new clients can accept partial server payloads', () => {
    const response = UsageAnalyticsQueryResponseSchema.parse({
      v: 1,
      totals: {
        eventCount: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      cost: {
        reportedUsd: 0,
        estimatedUsd: 0,
        invoiceUsd: 0,
        currency: 'USD',
      },
      },
    });

    expect(response.series).toBeUndefined();
    expect(response.breakdowns).toBeUndefined();
  });

  it('parses usage analytics server capabilities', () => {
    const parsed = ServerUsageAnalyticsCapabilitiesSchema.parse({
      version: 1,
      eventsIngest: {
        path: '/v2/usage-events',
      },
      query: {
        path: '/v2/usage/query',
      },
      legacy: {
        usageReportsPath: '/v2/usage-reports',
        usageQueryPath: '/v1/usage/query',
      },
    });

    expect(parsed.version).toBe(1);
    expect(parsed.query.path).toBe('/v2/usage/query');
  });
});
