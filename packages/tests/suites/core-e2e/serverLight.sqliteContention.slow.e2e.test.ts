import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { afterAll, describe, expect, it } from 'vitest';

import { createTestAuth } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import { registerMachineIdentity } from '../../src/testkit/machineIdentity';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { createSession } from '../../src/testkit/sessions';

const run = createRunDirs({ runLabel: 'core' });

const LOAD_WINDOW_MS = 10_000;
const READ_INTERVAL_MS = 100;
const READ_P95_LIMIT_MS = 500;
const READ_P99_LIMIT_MS = 1_500;
const WRITER_CONCURRENCY = 6;

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

function readServerLogs(server: StartedServer): string {
  const stdout = readFileSync(server.proc.stdoutPath, 'utf8');
  const stderr = readFileSync(server.proc.stderrPath, 'utf8');
  return `${stdout}\n${stderr}`;
}

describe('core e2e: server-light SQLite contention responsiveness', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
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
});
