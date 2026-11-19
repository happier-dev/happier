import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DoctorSnapshotResourceVitalsSchema, DoctorSnapshotSchema } from '@happier-dev/protocol/diagnostics/doctorSnapshot';
import { startDaemonControlServer } from './controlServer';
import { createDaemonEventLoopStallMonitor } from './diagnostics/daemonEventLoopStallMonitor';
import { createMinuteHistoryStore } from './vitals/history/minuteHistoryStore';
import { createMachineVitalsSampler } from './vitals/createMachineVitalsSampler';
import { createMachineResourceSummary } from './resources/machineResourceSummary';
import { buildDoctorSnapshotFromInventory } from '@/doctor/inv/snapshot';
import { clearCredentials, clearDaemonStateForTestTeardown, writeCredentialsTokenOnly, writeDaemonState } from '@/persistence';
import { readDoctorRuntimeInventory } from '@/doctor/inv/runtime';

afterEach(() => { vi.unstubAllEnvs(); });

it('reads canonical sampler/attention/self facts through authenticated Doctor wiring and the snapshot schema', async () => {
  vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '0');
  const directory = await mkdtemp(join(tmpdir(), 'happier-doctor-vitals-'));
  const history = await createMinuteHistoryStore({ directory });
  let reads = 0;
  const sampler = createMachineVitalsSampler({ historyStore: history, readers: {
    // Only the native OS reader is replaced; sampler, summary, control route and Doctor remain real.
    read: async input => {
      reads++;
      return { state: 'reporting', host: { logicalCores: 4, memoryTotalBytes: 1000, bootedAt: input.sampledAt - 1000 },
        minuteCounters: { monotonicMs: input.monotonicMs, cpu: null, network: null },
        sample: { v: 1, sampledAt: input.sampledAt, intervalMs: input.intervalMs,
          cpu: { reported: false, reason: 'unavailable' },
          memory: { reported: true, totalBytes: 1000, availableBytes: 0, usedBytes: 1000,
            pressure: { level: 'critical', source: 'events' } },
          disk: { reported: false, reason: 'unavailable' }, network: { reported: false, reason: 'unavailable' } } };
    },
  } });
  const summary = createMachineResourceSummary({ sampler, readNearlyFull: () => null, onError: error => { throw error; } });
  const monitor = createDaemonEventLoopStallMonitor({ getActiveRpcOperations: () => [], warn: () => {} });
  const server = await startDaemonControlServer({ getChildren: () => [], machineId: 'doctor-machine',
    stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
    requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'doctor-test-token',
    readDoctorResourceVitals: () => ({ sample: sampler.latest(), attention: summary.getSummary()?.attention ?? null,
      self: monitor.snapshot() }),
  });
  let serverStopped = false;
  try {
    await sampler.start();
    monitor.start();
    const url = `http://127.0.0.1:${server.port}/doctor/vitals`;
    expect((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
    const response = await fetch(url, { method: 'POST', body: '{}',
      headers: { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'doctor-test-token' } });
    expect(response.status).toBe(200);
    expect(reads).toBe(1);
    const facts = DoctorSnapshotResourceVitalsSchema.parse(await response.json());
    expect(facts).toMatchObject({ sample: sampler.latest(), attention: summary.getSummary()?.attention,
      self: { rssBytes: expect.any(Number), heapUsedBytes: expect.any(Number), heapTotalBytes: expect.any(Number),
        eventLoopBusyFraction: expect.any(Number), activeHandleCount: expect.any(Number) } });
    expect(facts.self.activeHandleCount).toBeGreaterThan(0);
    await sampler.stop();
    // The CLI harness owns a per-file Home; use real local-state and HTTP readers.
    writeDaemonState({ pid: process.pid, httpPort: server.port, controlToken: 'doctor-test-token',
      startedAt: Date.now(), startedWithCliVersion: 'test' });
    const inventory = await readDoctorRuntimeInventory();
    const snapshot = buildDoctorSnapshotFromInventory({ inventory });
    expect(DoctorSnapshotSchema.parse(snapshot).resourceVitals).toMatchObject({ sample: sampler.latest(),
      attention: summary.getSummary()?.attention, self: { rssBytes: expect.any(Number), heapUsedBytes: expect.any(Number) } });
    expect(DoctorSnapshotResourceVitalsSchema.safeParse({ ...inventory.resourceVitals, history: [] }).success).toBe(false);
    const payload = Buffer.from(JSON.stringify({ sub: 'obsolete-account', extras: {} })).toString('base64url');
    await writeCredentialsTokenOnly({ token: `hdr.${payload}.sig` });
    const signedOutInventory = await readDoctorRuntimeInventory();
    expect(signedOutInventory.credentials).toBeNull();
    expect(DoctorSnapshotSchema.parse(buildDoctorSnapshotFromInventory({
      inventory: signedOutInventory,
    })).resourceVitals?.sample).toEqual(facts.sample);
    await server.stop();
    serverStopped = true;
    const unavailableInventory = await readDoctorRuntimeInventory();
    const unavailable = DoctorSnapshotSchema.parse(buildDoctorSnapshotFromInventory({ inventory: unavailableInventory }));
    expect(unavailable.resourceVitals).toBeUndefined();
  } finally {
    if (!serverStopped) await server.stop();
    await clearDaemonStateForTestTeardown();
    await clearCredentials();
    monitor.stop();
    summary.stop();
    await sampler.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
