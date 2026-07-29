import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  AgentSessionRuntimeEventV1,
  UsageAnalyticsBreakdownEntry,
  UsageAnalyticsQueryResponse,
  UsageEventIngestRequest,
  UsageObservationContext,
} from '@happier-dev/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestAuth } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import { repoRootDir } from '../../src/testkit/paths';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createSession } from '../../src/testkit/sessions';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { waitFor } from '../../src/testkit/timing';
import { writeUsageEvent } from '../../src/testkit/usageAnalytics';

type UsageQueryWithContext = UsageAnalyticsQueryResponse & {
  totals: UsageAnalyticsQueryResponse['totals'] & { context?: UsageObservationContext };
  breakdowns?: UsageAnalyticsQueryResponse['breakdowns'] & {
    provider?: Array<UsageAnalyticsBreakdownEntry & { context?: UsageObservationContext }>;
    model?: Array<UsageAnalyticsBreakdownEntry & { context?: UsageObservationContext }>;
    session?: Array<UsageAnalyticsBreakdownEntry & {
      latestContextUsedTokens?: number;
      latestContextWindowTokens?: number;
    }>;
  };
};

type NativeUsageEvent = Extract<AgentSessionRuntimeEventV1, { kind: 'usage-observed' }>;
type NativeMappedUsageObservation = Readonly<{
  provider: string;
  source: string;
  scope: UsageEventIngestRequest['scope'];
  key: string | null;
  modelId: string | null;
  tokens: UsageEventIngestRequest['tokens'] | null;
  cost: UsageEventIngestRequest['cost'] | null;
  contextUsedTokens: number | null;
  contextWindowTokens: number | null;
  contextSnapshot?: NonNullable<NativeUsageEvent['context']>;
}>;
type NativeSessionHarnessRuntime = Readonly<{
  send(): Promise<Readonly<{ status: 'admitted' }>>;
  watch(listener: (event: AgentSessionRuntimeEventV1) => void): Readonly<{ dispose(): void }>;
  dispose(): void;
}>;
type NativeUsageSinkInput = Readonly<{
  observedAt: number;
  observation: NativeMappedUsageObservation;
  turnId: string | null;
  externalKey: string;
}>;
type AdaptNativeAgentSessionRuntimeToV1 = (
  session: NativeSessionHarnessRuntime,
  expectedSessionId: string,
  disposeRuntimeScope?: () => void | Promise<void>,
  expectedProviderSessionId?: string,
  usagePublisher?: Readonly<{
    provider: string;
    publish(input: NativeUsageSinkInput): void | Promise<void>;
  }>,
) => Readonly<{
  events: Readonly<{
    subscribe(handler: (event: unknown) => void): () => void;
  }>;
}>;
type CreateUsageObservationPublisher = (params: Readonly<{
  token: string;
  apiServerUrl: string;
  emitLegacyUsageReport(report: unknown): void;
  postJson(input: Readonly<{
    serverUrl: string;
    token: string;
    path: string;
    body: unknown;
  }>): Promise<Readonly<{ ok: true }>>;
}>) => Readonly<{
  publish(input: Readonly<{
    sessionId: string;
    observedAt?: number;
    observation: NativeMappedUsageObservation;
    turnId?: string | null;
    externalKey?: string | null;
  }>): Promise<void>;
}>;

async function loadNativeUsagePipelineOwners(): Promise<Readonly<{
  adaptNativeAgentSessionRuntimeToV1: AdaptNativeAgentSessionRuntimeToV1;
  createUsageObservationPublisher: CreateUsageObservationPublisher;
}>> {
  const cliSource = (path: string) => pathToFileURL(join(repoRootDir(), 'apps/cli/src', path)).href;
  const nativeModule = await import(cliSource('agent/runtime/registry/engineRegistry/nativeAgentSession.ts')) as Readonly<{
    adaptNativeAgentSessionRuntimeToV1: AdaptNativeAgentSessionRuntimeToV1;
  }>;
  const usageModule = await import(cliSource('usage/createUsageObservationPublisher.ts')) as Readonly<{
    createUsageObservationPublisher: CreateUsageObservationPublisher;
  }>;
  return {
    adaptNativeAgentSessionRuntimeToV1: nativeModule.adaptNativeAgentSessionRuntimeToV1,
    createUsageObservationPublisher: usageModule.createUsageObservationPublisher,
  };
}

function event(params: Readonly<{
  sessionId: string;
  observedAt: number;
  agentId: string;
  source: string;
  scope: UsageEventIngestRequest['scope'];
  externalKey: string;
  total: number;
  context?: UsageObservationContext;
}>): UsageEventIngestRequest {
  return {
    sessionId: params.sessionId,
    observedAt: params.observedAt,
    agentId: params.agentId,
    backendMode: `${params.agentId}:test`,
    modelId: `${params.agentId}-model`,
    projectKey: 'usage-pipeline',
    workspaceId: 'usage-pipeline',
    machineId: null,
    source: params.source,
    scope: params.scope,
    externalKey: params.externalKey,
    turnId: params.externalKey,
    isCumulative: params.scope !== 'turn_delta',
    tokens: {
      input: params.total,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: params.total,
    },
    cost: {
      reportedUsd: params.total / 100,
      estimatedUsd: params.total / 200,
      currency: 'USD',
      costSource: 'provider_reported',
      billingContext: 'api_usage',
    },
    ...(params.context ? { context: params.context } : {}),
  };
}

async function queryUsage(params: Readonly<{
  server: StartedServer;
  token: string;
  sessionId: string;
  timeZoneOffsetMinutes: number;
  agentIds?: string[];
  modelIds?: string[];
}>): Promise<UsageQueryWithContext> {
  const response = await fetchJson<UsageQueryWithContext>(`${params.server.baseUrl}/v2/usage/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      granularity: 'day',
      timeZoneOffsetMinutes: params.timeZoneOffsetMinutes,
      costMode: 'reported',
      includeSeries: true,
      filters: {
        sessionIds: [params.sessionId],
        ...(params.agentIds ? { agentIds: params.agentIds } : {}),
        ...(params.modelIds ? { modelIds: params.modelIds } : {}),
      },
      breakdowns: ['agent', 'model', 'session'],
    }),
    timeoutMs: 15_000,
  });
  expect(response.status).toBe(200);
  return response.data;
}

describe('usage pipeline e2e', () => {
  let testDir: string | null = null;
  let server: StartedServer | null = null;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'happier-usage-pipeline-'));
    server = await startServerLight({ testDir, dbProvider: 'sqlite' });
  }, 180_000);

  afterAll(async () => {
    await server?.stop().catch(() => undefined);
    if (testDir) await rm(testDir, { recursive: true, force: true });
  });

  it('resolves mixed scopes, timezone buckets, context, provider breakdowns, and legacy dedupe', async () => {
    const startedServer = server;
    if (!startedServer) throw new Error('missing server');
    const auth = await createTestAuth(startedServer.baseUrl);
    const { sessionId } = await createSession(startedServer.baseUrl, auth.token);
    const now = Date.now();
    const utcBoundary = Date.UTC(2026, 6, 1, 23, 30);

    const providerAEvents = [
      event({ sessionId, observedAt: now - 6_000, agentId: 'provider-a', source: 'provider-a-native', scope: 'turn_delta', externalKey: 'a-delta-1', total: 10 }),
      event({ sessionId, observedAt: now - 5_000, agentId: 'provider-a', source: 'provider-a-native', scope: 'turn_delta', externalKey: 'a-delta-2', total: 20 }),
      event({ sessionId, observedAt: now - 4_000, agentId: 'provider-a', source: 'provider-a-native', scope: 'turn_delta', externalKey: 'a-delta-3', total: 30 }),
      event({ sessionId, observedAt: now - 3_000, agentId: 'provider-a', source: 'provider-a-native', scope: 'session_cumulative', externalKey: 'a-cumulative-1', total: 40 }),
      event({ sessionId, observedAt: now - 2_000, agentId: 'provider-a', source: 'provider-a-native', scope: 'session_cumulative', externalKey: 'a-cumulative-2', total: 70 }),
      event({
        sessionId,
        observedAt: now - 1_000,
        agentId: 'provider-a',
        source: 'provider-a-native',
        scope: 'session_final',
        externalKey: 'a-final-1',
        total: 90,
        context: { usedTokens: 45, windowTokens: 100 },
      }),
    ];
    const providerBEvents = [
      event({ sessionId, observedAt: utcBoundary, agentId: 'provider-b', source: 'provider-b-native', scope: 'turn_delta', externalKey: 'b-delta-1', total: 7 }),
      event({ sessionId, observedAt: utcBoundary + 60 * 60 * 1_000, agentId: 'provider-b', source: 'provider-b-native', scope: 'turn_delta', externalKey: 'b-delta-2', total: 8 }),
    ];
    for (const request of [...providerAEvents, ...providerBEvents]) {
      await writeUsageEvent({ baseUrl: startedServer.baseUrl, token: auth.token, request });
    }

    const socket = createUserScopedSocketCollector(startedServer.baseUrl, auth.token);
    try {
      socket.connect();
      await waitFor(() => socket.isConnected(), { timeoutMs: 20_000 });
      const ack = await socket.emitWithAck<{ success?: boolean }>('usage-report', {
        key: 'provider-c-legacy',
        sessionId,
        tokens: { total: 999 },
        cost: { total: 9.99 },
      });
      expect(ack.success).toBe(true);
    } finally {
      socket.close();
    }

    const utc = await queryUsage({ server: startedServer, token: auth.token, sessionId, timeZoneOffsetMinutes: 0 });
    const providerBUtc = await queryUsage({
      server: startedServer,
      token: auth.token,
      sessionId,
      timeZoneOffsetMinutes: 0,
      agentIds: ['provider-b'],
    });
    const providerBPlusTwo = await queryUsage({
      server: startedServer,
      token: auth.token,
      sessionId,
      timeZoneOffsetMinutes: 120,
      agentIds: ['provider-b'],
    });

    expect(utc.totals.tokens.total).toBe(105);
    expect(utc.totals.eventCount).toBe(8);
    expect(utc.totals.context).toEqual({ usedTokens: 45, windowTokens: 100 });
    expect(utc.breakdowns?.agent?.map((row) => [row.key, row.tokens.total])).toEqual([
      ['provider-a', 90],
      ['provider-b', 15],
    ]);
    expect(utc.breakdowns?.agent?.[0]?.context).toEqual({ usedTokens: 45, windowTokens: 100 });
    expect(utc.breakdowns?.session?.[0]).toMatchObject({
      key: sessionId,
      latestContextUsedTokens: 45,
      latestContextWindowTokens: 100,
    });

    expect(providerBUtc.series?.map((bucket) => bucket.tokens.total)).toEqual([7, 8]);
    expect(providerBPlusTwo.series?.map((bucket) => bucket.tokens.total)).toEqual([15]);
    expect(utc.series?.reduce((sum, bucket) => sum + bucket.tokens.total, 0)).toBe(105);
    expect(providerBUtc.series?.reduce((sum, bucket) => sum + bucket.tokens.total, 0)).toBe(15);
    expect(providerBPlusTwo.series?.reduce((sum, bucket) => sum + bucket.tokens.total, 0)).toBe(15);
    expect(providerBUtc.series?.map((bucket) => bucket.bucketStartMs)).not.toEqual(
      providerBPlusTwo.series?.map((bucket) => bucket.bucketStartMs),
    );
  }, 180_000);

  it('preserves rich native Agent usage through canonical ingest, precedence, and replay dedupe', async () => {
    const startedServer = server;
    if (!startedServer) throw new Error('missing server');
    const auth = await createTestAuth(startedServer.baseUrl);
    const { sessionId } = await createSession(startedServer.baseUrl, auth.token);
    const now = Date.now();
    const {
      adaptNativeAgentSessionRuntimeToV1,
      createUsageObservationPublisher,
    } = await loadNativeUsagePipelineOwners();
    const capturedRequests: UsageEventIngestRequest[] = [];
    const pendingPublishes: Promise<void>[] = [];
    const mappedObservations: Array<Readonly<{
      observedAt: number;
      turnId: string | null;
      externalKey: string;
      observation: NativeMappedUsageObservation;
    }>> = [];

    const createPublisher = () => createUsageObservationPublisher({
      token: auth.token,
      apiServerUrl: startedServer.baseUrl,
      emitLegacyUsageReport: () => undefined,
      postJson: async ({ serverUrl, token, path, body }) => {
        const request = body as UsageEventIngestRequest;
        capturedRequests.push(request);
        const response = await fetchJson(`${serverUrl}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
          timeoutMs: 15_000,
        });
        expect(response.status).toBe(200);
        return { ok: true } as const;
      },
    });

    const createNativeHarness = () => {
      const listeners = new Set<(event: AgentSessionRuntimeEventV1) => void>();
      const session: NativeSessionHarnessRuntime = {
        async send() {
          return { status: 'admitted' };
        },
        watch(listener) {
          listeners.add(listener);
          return { dispose: () => listeners.delete(listener) };
        },
        dispose: () => undefined,
      };
      return {
        session,
        emit(event: AgentSessionRuntimeEventV1) {
          for (const listener of listeners) listener(event);
        },
      };
    };

    const bindNativeBridge = (harness: ReturnType<typeof createNativeHarness>) => {
      const publisher = createPublisher();
      const runtime = adaptNativeAgentSessionRuntimeToV1(
        harness.session,
        sessionId,
        undefined,
        undefined,
        {
          provider: 'native-agent',
          async publish(input) {
            mappedObservations.push(input);
            const pendingPublish = publisher.publish({
              sessionId,
              observedAt: input.observedAt,
              observation: input.observation,
              turnId: input.turnId,
              externalKey: input.externalKey,
            });
            pendingPublishes.push(pendingPublish);
            await pendingPublish;
          },
        },
      );
      runtime.events.subscribe(() => undefined);
      return runtime;
    };

    const richFinal = {
      sequence: 8,
      sessionId,
      emittedAtMs: now - 2_000,
      kind: 'usage-observed',
      observationId: 'native-final-1',
      turnId: 'turn-final',
      source: 'native-rich',
      scope: 'session_final',
      modelId: 'model-a',
      tokens: {
        input: 30,
        output: 20,
        reasoning: 10,
        cacheRead: 5,
        cacheWrite: 5,
        total: 70,
      },
      cost: {
        reportedUsd: 7,
        estimatedUsd: 8,
        invoiceUsd: 9,
        effectiveUsd: 7,
        currency: 'USD',
        costSource: 'provider_reported',
        billingContext: 'api_usage',
        breakdown: { inputUsd: 3, outputUsd: 4 },
      },
      context: {
        v: 1,
        modelId: 'model-a',
        usedTokens: 60,
        windowTokens: 100,
        totalProcessedTokens: 70,
        baselineTokens: 10,
        isAutoCompactEnabled: true,
        categories: [{ key: 'prompt', label: 'Prompt', tokens: 60 }],
        observedAtMs: now - 2_000,
        source: 'provider_turn',
      },
    } as const satisfies AgentSessionRuntimeEventV1;

    const first = createNativeHarness();
    bindNativeBridge(first);
    for (const nativeEvent of [
      {
        sequence: 1,
        sessionId,
        emittedAtMs: now - 5_000,
        kind: 'turn-start',
        turnId: 'turn-delta',
        startedBy: 'provider',
      },
      {
        sequence: 2,
        sessionId,
        emittedAtMs: now - 4_000,
        kind: 'usage-observed',
        observationId: 'native-delta-1',
        turnId: 'turn-delta',
        source: 'native-rich',
        scope: 'turn_delta',
        modelId: 'model-a',
        tokens: { input: 4, output: 3, reasoning: 1, cacheRead: 1, cacheWrite: 1, total: 10 },
        cost: {
          reportedUsd: 0,
          estimatedUsd: 0,
          currency: 'USD',
          costSource: 'provider_reported',
          billingContext: 'api_usage',
        },
      },
      {
        sequence: 3,
        sessionId,
        emittedAtMs: now - 3_500,
        kind: 'turn-complete',
        turnId: 'turn-delta',
      },
      {
        sequence: 4,
        sessionId,
        emittedAtMs: now - 3_400,
        kind: 'turn-start',
        turnId: 'turn-cumulative',
        startedBy: 'provider',
      },
      {
        sequence: 5,
        sessionId,
        emittedAtMs: now - 3_000,
        kind: 'usage-observed',
        observationId: 'native-cumulative-1',
        turnId: 'turn-cumulative',
        source: 'native-rich',
        scope: 'session_cumulative',
        modelId: 'model-a',
        tokens: { input: 20, output: 15, reasoning: 5, cacheRead: 5, cacheWrite: 5, total: 50 },
        cost: {
          reportedUsd: 0,
          estimatedUsd: 0,
          currency: 'USD',
          costSource: 'provider_reported',
          billingContext: 'api_usage',
        },
      },
      {
        sequence: 6,
        sessionId,
        emittedAtMs: now - 2_800,
        kind: 'turn-complete',
        turnId: 'turn-cumulative',
      },
      {
        sequence: 7,
        sessionId,
        emittedAtMs: now - 2_500,
        kind: 'turn-start',
        turnId: 'turn-final',
        startedBy: 'provider',
      },
      richFinal,
      {
        sequence: 9,
        sessionId,
        emittedAtMs: now - 1_500,
        kind: 'turn-complete',
        turnId: 'turn-final',
      },
      {
        sequence: 10,
        sessionId,
        emittedAtMs: now - 1_000,
        kind: 'turn-start',
        turnId: 'turn-b',
        startedBy: 'provider',
      },
      {
        sequence: 11,
        sessionId,
        emittedAtMs: now - 500,
        kind: 'usage-observed',
        observationId: 'native-model-b-delta-1',
        turnId: 'turn-b',
        source: 'native-rich',
        scope: 'turn_delta',
        modelId: 'model-b',
        tokens: { input: 3, output: 2, reasoning: 1, cacheRead: 1, cacheWrite: 0, total: 7 },
        cost: {
          reportedUsd: 0,
          estimatedUsd: 0,
          currency: 'USD',
          costSource: 'provider_reported',
          billingContext: 'api_usage',
        },
      },
      {
        sequence: 12,
        sessionId,
        emittedAtMs: now,
        kind: 'turn-complete',
        turnId: 'turn-b',
      },
    ] as const satisfies readonly AgentSessionRuntimeEventV1[]) {
      first.emit(nativeEvent);
    }

    const replay = createNativeHarness();
    bindNativeBridge(replay);
    replay.emit({
      sequence: 1,
      sessionId,
      emittedAtMs: now - 2_500,
      kind: 'turn-start',
      turnId: 'turn-final',
      startedBy: 'provider',
    });
    replay.emit({ ...richFinal, sequence: 2 });
    replay.emit({
      sequence: 3,
      sessionId,
      emittedAtMs: now - 1_500,
      kind: 'turn-complete',
      turnId: 'turn-final',
    });

    await waitFor(() => mappedObservations.length === 5, { timeoutMs: 20_000 });
    await Promise.all(pendingPublishes);
    await waitFor(() => capturedRequests.length === 5, { timeoutMs: 20_000 });
    const mappedFinal = mappedObservations.find((entry) => entry.externalKey === 'native-final-1');
    expect(mappedFinal).toEqual({
      observedAt: now - 2_000,
      turnId: 'turn-final',
      externalKey: 'native-final-1',
      observation: {
        provider: 'native-agent',
        source: 'native-rich',
        scope: 'session_final',
        key: null,
        modelId: 'model-a',
        tokens: richFinal.tokens,
        cost: richFinal.cost,
        contextUsedTokens: 60,
        contextWindowTokens: 100,
        contextSnapshot: richFinal.context,
      },
    });
    expect(capturedRequests.filter((request) => request.externalKey === 'native-final-1')).toHaveLength(2);
    expect(capturedRequests.find((request) => request.externalKey === 'native-final-1')).toMatchObject({
      turnId: 'turn-final',
      modelId: 'model-a',
      tokens: richFinal.tokens,
      cost: richFinal.cost,
      context: { usedTokens: 60, windowTokens: 100 },
    });

    const query = await queryUsage({
      server: startedServer,
      token: auth.token,
      sessionId,
      timeZoneOffsetMinutes: 0,
      agentIds: ['native-agent'],
    });
    const modelBQuery = await queryUsage({
      server: startedServer,
      token: auth.token,
      sessionId,
      timeZoneOffsetMinutes: 0,
      agentIds: ['native-agent'],
      modelIds: ['model-b'],
    });
    expect(query.totals.eventCount).toBe(4);
    expect(query.totals.tokens).toEqual({
      input: 30,
      output: 20,
      reasoning: 10,
      cacheRead: 5,
      cacheWrite: 5,
      total: 70,
    });
    expect(query.totals.cost).toMatchObject({
      reportedUsd: 7,
      estimatedUsd: 8,
      invoiceUsd: 9,
      effectiveUsd: 7,
      currency: 'USD',
      breakdown: { inputUsd: 3, outputUsd: 4 },
    });
    expect(query.totals.context).toEqual({ usedTokens: 60, windowTokens: 100 });
    expect(query.breakdowns?.model?.map((row) => [row.key, row.tokens.total])).toEqual([
      ['model-a', 70],
    ]);
    expect(modelBQuery.totals.tokens.total).toBe(7);
  }, 180_000);
});
