import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it, beforeAll, afterAll } from 'vitest';

import { createTestAuth } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import { createSession } from '../../src/testkit/sessions';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { writeUsageEvent } from '../../src/testkit/usageAnalytics';
import type { UsageAnalyticsQueryResponse } from '@happier-dev/protocol';

describe('usage query session drilldown', () => {
  let testDir: string | null = null;
  let server: StartedServer | null = null;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'happier-usage-query-'));
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
    });
  }, 180_000);

  afterAll(async () => {
    await server?.stop().catch(() => undefined);
    if (testDir) {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('returns session-scoped aggregates and premium sections when filtering by sessionIds', async () => {
    const startedServer = server;
    if (!startedServer) throw new Error('missing server');

    const auth = await createTestAuth(startedServer.baseUrl);
    const sessionA = await createSession(startedServer.baseUrl, auth.token);
    const sessionB = await createSession(startedServer.baseUrl, auth.token);
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    await writeUsageEvent({
      baseUrl: startedServer.baseUrl,
      token: auth.token,
      request: {
        sessionId: sessionA.sessionId,
        observedAt: now - day,
        agentId: 'anthropic',
        backendMode: 'claude:remote',
        modelId: 'claude-3.7-sonnet',
        projectKey: 'project-a',
        workspaceId: 'workspace-a',
        source: 'claude_sdk',
        scope: 'turn_delta',
        externalKey: 'drilldown-a-1',
        turnId: 'turn-1',
        isCumulative: false,
        tokens: { input: 6, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 },
        cost: { reportedUsd: 1, estimatedUsd: 0.8, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
      },
    });
    await writeUsageEvent({
      baseUrl: startedServer.baseUrl,
      token: auth.token,
      request: {
        sessionId: sessionA.sessionId,
        observedAt: now,
        agentId: 'anthropic',
        backendMode: 'claude:remote',
        modelId: 'claude-4-sonnet',
        projectKey: 'project-a',
        workspaceId: 'workspace-a',
        source: 'claude_sdk',
        scope: 'turn_delta',
        externalKey: 'drilldown-a-2',
        turnId: 'turn-2',
        isCumulative: false,
        tokens: { input: 8, output: 6, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 14 },
        cost: { reportedUsd: 2, estimatedUsd: 1.5, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
      },
    });
    await writeUsageEvent({
      baseUrl: startedServer.baseUrl,
      token: auth.token,
      request: {
        sessionId: sessionB.sessionId,
        observedAt: now,
        agentId: 'openai',
        backendMode: 'codex:app-server',
        modelId: 'gpt-5-codex',
        projectKey: 'project-b',
        workspaceId: 'workspace-b',
        source: 'codex_app_server',
        scope: 'turn_delta',
        externalKey: 'drilldown-b-1',
        turnId: 'turn-1',
        isCumulative: false,
        tokens: { input: 18, output: 12, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 30 },
        cost: { reportedUsd: 3, estimatedUsd: 2.4, currency: 'USD', costSource: 'pricing_estimate', billingContext: 'api_usage' },
      },
    });

    const scoped = await fetchJson<UsageAnalyticsQueryResponse>(`${startedServer.baseUrl}/v2/usage/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        granularity: 'day',
        costMode: 'reported',
        includeSeries: true,
        includeInsights: true,
        includeActivity: true,
        includeLeaders: true,
        includeModelTimeline: true,
        includeMessageStats: true,
        activityResolution: 'both',
        topLimit: 20,
        filters: {
          sessionIds: [sessionA.sessionId],
        },
        breakdowns: ['agent', 'model', 'session', 'project', 'workspace', 'backendMode', 'source'],
      }),
      timeoutMs: 15_000,
    });

    expect(scoped.status).toBe(200);
    expect(scoped.data.totals.eventCount).toBe(2);
    expect(scoped.data.totals.tokens.total).toBe(24);
    expect(scoped.data.costPresentation?.mode).toBe('reported');
    expect(scoped.data.activity?.calendarDays).toHaveLength(2);
    expect(scoped.data.insights?.activeDays).toBe(2);
    expect(scoped.data.insights?.sessionsUsed).toBe(1);
    expect(scoped.data.leaders?.sessions?.[0]?.key).toBe(sessionA.sessionId);
    expect(scoped.data.breakdowns?.session?.[0]?.key).toBe(sessionA.sessionId);
    expect(scoped.data.breakdowns?.agent?.[0]?.key).toBe('anthropic');
    expect(scoped.data.breakdowns?.model?.[0]?.key).toBe('claude-4-sonnet');

    const allUsage = await fetchJson<UsageAnalyticsQueryResponse>(`${startedServer.baseUrl}/v2/usage/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        granularity: 'day',
        costMode: 'reported',
        includeSeries: true,
        includeInsights: true,
        includeActivity: true,
        includeLeaders: true,
        includeModelTimeline: true,
        includeMessageStats: true,
        activityResolution: 'both',
        topLimit: 20,
        breakdowns: ['agent', 'model', 'session', 'project', 'workspace', 'backendMode', 'source'],
      }),
      timeoutMs: 15_000,
    });

    expect(allUsage.status).toBe(200);
    expect(allUsage.data.totals.eventCount).toBe(3);
    expect(allUsage.data.totals.tokens.total).toBe(54);
    expect(allUsage.data.leaders?.sessions?.map((row) => row.key)).toEqual([sessionB.sessionId, sessionA.sessionId]);
  });
});
