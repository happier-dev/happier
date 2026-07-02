import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { afterEach, describe, expect, it } from 'vitest';

import { createTestAuth } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import { registerMachineIdentity } from '../../src/testkit/machineIdentity';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { createSession } from '../../src/testkit/sessions';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { fetchSessionSystemRecordsPage, upsertSessionSystemRecord } from '../../src/testkit/sessionSystemRecords';
import { sleep, waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

const LOAD_WINDOW_MS = 10_000;
const READ_INTERVAL_MS = 100;
const READ_P95_LIMIT_MS = 500;
const READ_P99_LIMIT_MS = 1_500;
const WRITER_CONCURRENCY = 6;
const MIXED_LOAD_WINDOW_MS = 6_000;
const MIXED_READ_P95_LIMIT_MS = 1_000;
const MIXED_READ_P99_LIMIT_MS = 2_500;

type TimedStatus = Readonly<{
  status: number;
  elapsedMs: number;
  error: string | null;
}>;

function percentile(values: readonly number[], percentileRank: number): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileRank / 100) * sorted.length) - 1));
  return sorted[index] ?? Number.POSITIVE_INFINITY;
}

async function timedRequest(params: Readonly<{
  url: string;
  token: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs?: number;
}>): Promise<TimedStatus> {
  const startedAt = performance.now();
  try {
    const response = await fetchJson<unknown>(params.url, {
      method: params.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${params.token}`,
        ...(params.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(params.body === undefined ? {} : { body: JSON.stringify(params.body) }),
      timeoutMs: params.timeoutMs ?? 5_000,
    });
    return { status: response.status, elapsedMs: performance.now() - startedAt, error: null };
  } catch (error) {
    return {
      status: 0,
      elapsedMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function timedAction(action: () => Promise<unknown>, timeoutMs = 5_000): Promise<TimedStatus> {
  const startedAt = performance.now();
  let timer: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      action(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed action exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { status: 200, elapsedMs: performance.now() - startedAt, error: null };
  } catch (error) {
    return {
      status: 0,
      elapsedMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function readServerLogs(server: StartedServer): string {
  const stdout = readFileSync(server.proc.stdoutPath, 'utf8');
  const stderr = readFileSync(server.proc.stderrPath, 'utf8');
  return `${stdout}\n${stderr}`;
}

function assertHealthyPressureResults(params: Readonly<{
  readResults: readonly TimedStatus[];
  writeResults: readonly TimedStatus[];
  minReads: number;
  readP95LimitMs: number;
  readP99LimitMs: number;
}>): void {
  const readLatencies = params.readResults.filter((result) => result.status === 200).map((result) => result.elapsedMs);
  const p95 = percentile(readLatencies, 95);
  const p99 = percentile(readLatencies, 99);
  const failedReads = params.readResults.filter((result) => result.status !== 200);
  const serverErrors = [...params.readResults, ...params.writeResults].filter((result) => result.status >= 500);
  const requestErrors = [...params.readResults, ...params.writeResults].filter((result) => result.status === 0);

  expect(params.readResults.length).toBeGreaterThanOrEqual(params.minReads);
  expect(failedReads).toEqual([]);
  expect(serverErrors).toEqual([]);
  expect(requestErrors).toEqual([]);
  expect(p95).toBeLessThan(params.readP95LimitMs);
  expect(p99).toBeLessThan(params.readP99LimitMs);
}

describe('core e2e: server-light SQLite contention responsiveness', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop().catch(() => {});
    server = null;
  });

  it('keeps session reads responsive during concurrent session and machine writes', async () => {
    const testDir = run.testDir('server-light-sqlite-contention');
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_API_RATE_LIMITS_ENABLED: '0',
      },
    });
    const auth = await createTestAuth(server.baseUrl);

    await Promise.all([
      ...Array.from({ length: 12 }, async () => {
        await createSession(server!.baseUrl, auth.token);
      }),
      ...Array.from({ length: 4 }, async (_, index) => {
        const registration = await registerMachineIdentity({
          baseUrl: server!.baseUrl,
          token: auth.token,
          machineId: `sqlite-contention-seed-${index}`,
          metadata: `seed-${index}`,
        });
        expect(registration.status).toBe(200);
      }),
    ]);

    const deadline = performance.now() + LOAD_WINDOW_MS;
    const readResults: TimedStatus[] = [];
    const writeResults: TimedStatus[] = [];

    const readLoop = async () => {
      while (performance.now() < deadline) {
        readResults.push(await timedRequest({
          url: `${server!.baseUrl}/v2/sessions?limit=25`,
          token: auth.token,
          timeoutMs: 5_000,
        }));
        await new Promise((resolve) => setTimeout(resolve, READ_INTERVAL_MS));
      }
    };

    const writerLoop = async (workerIndex: number) => {
      let iteration = 0;
      while (performance.now() < deadline) {
        const machineId = `sqlite-contention-machine-${workerIndex}-${iteration % 3}`;
        writeResults.push(await timedRequest({
          url: `${server!.baseUrl}/v1/machines`,
          token: auth.token,
          method: 'POST',
          body: {
            id: machineId,
            metadata: `worker=${workerIndex};iteration=${iteration};nonce=${randomUUID()}`,
          },
          timeoutMs: 5_000,
        }));

        if (iteration % 2 === 0) {
          try {
            await createSession(server!.baseUrl, auth.token);
            writeResults.push({ status: 200, elapsedMs: 0, error: null });
          } catch (error) {
            writeResults.push({
              status: 0,
              elapsedMs: 0,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        iteration += 1;
      }
    };

    await Promise.all([
      readLoop(),
      ...Array.from({ length: WRITER_CONCURRENCY }, async (_, index) => {
        await writerLoop(index);
      }),
    ]);

    const readLatencies = readResults.filter((result) => result.status === 200).map((result) => result.elapsedMs);
    const p95 = percentile(readLatencies, 95);
    const p99 = percentile(readLatencies, 99);
    const failedReads = readResults.filter((result) => result.status !== 200);
    const serverErrors = [...readResults, ...writeResults].filter((result) => result.status >= 500);
    const requestErrors = [...readResults, ...writeResults].filter((result) => result.status === 0);

    expect(readResults.length).toBeGreaterThanOrEqual(20);
    expect(failedReads).toEqual([]);
    expect(serverErrors).toEqual([]);
    expect(requestErrors).toEqual([]);
    expect(p95).toBeLessThan(READ_P95_LIMIT_MS);
    expect(p99).toBeLessThan(READ_P99_LIMIT_MS);

    const logs = readServerLogs(server);
    expect(logs).not.toMatch(/P1008|P2028|P2024|Socket timeout|database is locked/i);

    const health = await timedRequest({
      url: `${server.baseUrl}/health`,
      token: auth.token,
      timeoutMs: 2_000,
    });
    expect(health.status).toBe(200);
  }, 240_000);

  it('keeps mixed daemon hot-path reads responsive while socket usage reports repeat', async () => {
    const testDir = run.testDir('server-light-sqlite-mixed-hot-paths');
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_API_RATE_LIMITS_ENABLED: '0',
        HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: '1',
        HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: '1',
      },
    });
    const auth = await createTestAuth(server.baseUrl);
    const sessions = await Promise.all(Array.from({ length: 8 }, async () => createSession(server!.baseUrl, auth.token)));
    const sessionIds = sessions.map((session) => session.sessionId);
    const machineId = 'sqlite-mixed-hot-path-machine';
    const machineRegistration = await registerMachineIdentity({
      baseUrl: server.baseUrl,
      token: auth.token,
      machineId,
      metadata: 'sqlite mixed hot path seed',
    });
    expect(machineRegistration.status).toBe(200);

    await Promise.all(sessionIds.slice(0, 4).map(async (sessionId, index) => {
      await upsertSessionSystemRecord({
        baseUrl: server!.baseUrl,
        token: auth.token,
        sessionId,
        namespace: 'memory',
        kind: 'summary_shard.v1',
        localId: `memory:summary_shard:v1:${index}`,
        content: { t: 'encrypted', c: Buffer.from(`summary-${index}`, 'utf8').toString('base64') },
      });
    }));

    const quotaSeed = await timedRequest({
      url: `${server.baseUrl}/v2/connect/openai-codex/profiles/work/quotas`,
      token: auth.token,
      method: 'POST',
      body: {
        sealed: { format: 'account_scoped_v1', ciphertext: 'quota-ciphertext' },
        metadata: { fetchedAt: Date.now(), staleAfterMs: 60_000, status: 'ok' },
      },
      timeoutMs: 10_000,
    });
    expect(quotaSeed.status).toBe(200);

    const socket = createUserScopedSocketCollector(server.baseUrl, auth.token);
    socket.connect();
    await waitFor(() => socket.isConnected(), { timeoutMs: 20_000 });

    const deadline = performance.now() + MIXED_LOAD_WINDOW_MS;
    const readResults: TimedStatus[] = [];
    const writeResults: TimedStatus[] = [];
    const readUrls = [
      () => `${server!.baseUrl}/v2/sessions?limit=50`,
      (index: number) => `${server!.baseUrl}/v2/sessions/${sessionIds[index % sessionIds.length]}`,
      (index: number) => `${server!.baseUrl}/v1/access-keys/${sessionIds[index % sessionIds.length]}/${machineId}`,
      () => `${server!.baseUrl}/v1/account/encryption`,
      () => `${server!.baseUrl}/v2/connect/openai-codex/profiles/work/quotas`,
      () => `${server!.baseUrl}/health`,
    ] as const;

    const readLoop = async (workerIndex: number) => {
      let iteration = 0;
      while (performance.now() < deadline) {
        const urlBuilder = readUrls[(workerIndex + iteration) % readUrls.length];
        readResults.push(await timedRequest({
          url: urlBuilder(iteration),
          token: auth.token,
          timeoutMs: 5_000,
        }));

        if (iteration % 3 === 0) {
          readResults.push(await timedAction(async () => {
            await fetchSessionSystemRecordsPage({
              baseUrl: server!.baseUrl,
              token: auth.token,
              sessionId: sessionIds[iteration % 4]!,
              namespace: 'memory',
              kind: 'summary_shard.v1',
              limit: 10,
            });
          }, 5_000));
        }

        iteration += 1;
        await sleep(35);
      }
    };

    const usageReportLoop = async () => {
      let iteration = 0;
      while (performance.now() < deadline) {
        const sessionId = sessionIds[iteration % sessionIds.length]!;
        writeResults.push(await timedAction(async () => {
          const ack = await socket.emitWithAck<any>('usage-report', {
            key: `mixed-hot-path-${iteration % 4}`,
            sessionId,
            tokens: { total: 100, prompt: 40, completion: 60 },
            cost: { total: 0.02 },
          }, 5_000);
          if (ack?.success !== true) {
            throw new Error(`Unexpected usage-report ack: ${JSON.stringify(ack)}`);
          }
        }, 5_500));
        iteration += 1;
        await sleep(25);
      }
    };

    try {
      await Promise.all([
        usageReportLoop(),
        ...Array.from({ length: 4 }, async (_, index) => readLoop(index)),
      ]);
    } finally {
      socket.close();
    }

    assertHealthyPressureResults({
      readResults,
      writeResults,
      minReads: 40,
      readP95LimitMs: MIXED_READ_P95_LIMIT_MS,
      readP99LimitMs: MIXED_READ_P99_LIMIT_MS,
    });

    const logs = readServerLogs(server);
    expect(logs).not.toMatch(/P1008|P2028|P2024|Socket timeout|database is locked/i);
  }, 240_000);
});
