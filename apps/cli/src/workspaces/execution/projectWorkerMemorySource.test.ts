import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createMachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '@/daemon/vitals/history/minuteHistoryStore';
import type { MachineVitalsReader } from '@/daemon/vitals/readers/types';

import { createProjectWorkerAdmission, type ProjectWorkerAdmissionRequest } from './projectWorkerAdmission';
import { createProjectWorkerMemorySource } from './projectWorkerMemorySource';

describe('project worker memory admission through the vitals sampler', () => {
  const initialTime = Date.UTC(2026, 9, 10);
  let directory: string;
  let availableBytes = 100;
  let reads = 0;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(initialTime);
    directory = await mkdtemp(join(tmpdir(), 'happier-worker-memory-'));
    availableBytes = 100;
    reads = 0;
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  });

  async function setup() {
    // The OS reader is the system boundary; sampler, memory source and admission are real.
    const readers: MachineVitalsReader = { read: async (input) => {
      reads += 1;
      return {
        state: 'reporting',
        host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: initialTime - 100_000 },
        sample: {
          v: 1, sampledAt: input.sampledAt, intervalMs: input.intervalMs, cpu: { reported: false, reason: 'unavailable' },
          memory: { reported: true, totalBytes: 100, availableBytes, usedBytes: 100 - availableBytes, pressure: { level: 'calm', source: 'events' } },
          disk: { reported: false, reason: 'unavailable' }, network: { reported: false, reason: 'unavailable' },
        },
        minuteCounters: { monotonicMs: input.monotonicMs, cpu: null, network: null },
      };
    } };
    const historyStore = await createMinuteHistoryStore({ directory, nowMs: () => Date.now() });
    let admission: ReturnType<typeof createProjectWorkerAdmission> | null = null;
    const sampler = createMachineVitalsSampler({ readers, historyStore, monotonicMs: () => Date.now() - initialTime,
      onTick: () => { void admission?.notifyChanged(); } });
    const source = createProjectWorkerMemorySource(() => sampler);
    admission = createProjectWorkerAdmission({ machineId: 'machine', admissionDrain: createDaemonAdmissionDrain(),
      readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: null }, metadataVersion: 1, source: 'stored' }),
      ...source });
    await sampler.start();
    const advance = async (ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 1_000) {
        await vi.advanceTimersByTimeAsync(Math.min(1_000, ms - elapsed));
        await sampler.start();
        await vi.advanceTimersByTimeAsync(0);
      }
      await vi.advanceTimersByTimeAsync(0);
    };
    const started: string[] = [];
    const finishers: Array<() => void> = [];
    const queueWorker = (operationId: string, signal: AbortSignal) => {
      const request: ProjectWorkerAdmissionRequest = { operationId, workspaceRefId: 'worker-copy', signal,
        memoryDemand: { bytes: 50 } as ProjectWorkerAdmissionRequest['memoryDemand'],
        accept: () => {},
        run: async () => {
          started.push(operationId);
          await new Promise<void>(resolve => finishers.push(resolve));
          return { kind: 'process_settled', result: { ok: true, result: {} } };
        } };
      return admission!.execute(request);
    };
    return { sampler, advance, started, finishers, queueWorker };
  }

  it('does not admit on an old reading, samples at the live cadence while queued, and returns to the minute cadence once admitted', async () => {
    const { sampler, advance, started, finishers, queueWorker } = await setup();
    try {
      await advance(30_000);
      expect(reads).toBe(1);
      // The host filled up after the last minute reading; that reading still says 100 free.
      availableBytes = 10;
      const result = queueWorker('worker', new AbortController().signal);
      await advance(0);
      expect(reads).toBe(2);
      expect(started).toEqual([]);
      await advance(2_000);
      expect(reads).toBe(3);
      expect(started).toEqual([]);
      availableBytes = 80;
      await advance(2_000);
      expect(started).toEqual(['worker']);
      const admittedReads = reads;
      // One settling read at the viewer interval, then nothing until the next minute boundary.
      await advance(2_000);
      expect(reads).toBe(admittedReads + 1);
      const settledReads = reads;
      await advance(20_000);
      expect(reads).toBe(settledReads);
      finishers[0]();
      await result;
    } finally { await sampler.stop(); }
  });

  it('releases the live cadence when a queued worker is cancelled', async () => {
    const { sampler, advance, started, queueWorker } = await setup();
    try {
      await advance(30_000);
      availableBytes = 10;
      const controller = new AbortController();
      const result = queueWorker('worker', controller.signal);
      await advance(4_000);
      const queuedReads = reads;
      expect(queuedReads).toBe(4);
      controller.abort();
      await expect(result).resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
      await advance(2_000);
      const settledReads = reads;
      expect(settledReads).toBe(queuedReads + 1);
      await advance(20_000);
      expect(reads).toBe(settledReads);
      expect(started).toEqual([]);
    } finally { await sampler.stop(); }
  });
});
