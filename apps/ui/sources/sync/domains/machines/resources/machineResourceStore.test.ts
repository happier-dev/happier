import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@happier-dev/protocol/rpcErrors';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { clearMachineRequestReachabilityForMachine } from '@/sync/domains/machines/reachability/machineReachability';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import type { MachineVitalsHistoryV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsHistoryV1';
import type {
  MachineVitalsSnapshotV1,
  MachineVitalsWatchResultV1,
} from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';
import {
  MachineResourceSummaryV1Schema,
  projectMachineResourceSummaryV1,
} from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import type {
  MachineResourceRpcResult,
  MachineVitalsWatchInput,
  MachineVitalsHistoryReadInput,
} from './machineRpc';
import {
  createMachineResourceStore,
  isMachineResourceStateStale,
} from './machineResourceStore';

const sample = (sampledAt: number): MachineVitalsSampleV1 => ({
  v: 1,
  sampledAt,
  intervalMs: 15_000,
  cpu: { reported: true, busyPct: 20 },
  memory: {
    reported: true,
    totalBytes: 100,
    availableBytes: 80,
    usedBytes: 20,
    pressure: { level: 'calm', source: 'psi' },
  },
  disk: { reported: true, volumes: [] },
  network: { reported: true, rxBps: 12, txBps: 3 },
});
const snapshot = (sampledAt = 60_000): MachineVitalsSnapshotV1 => ({
  state: 'reporting',
  sample: sample(sampledAt),
  series5m: {
    cpu: [{ t: sampledAt, y: 20 }],
    memory: [{ t: sampledAt, y: 80 }],
    networkRx: [{ t: sampledAt, y: 12 }],
    networkTx: [{ t: sampledAt, y: 3 }],
  },
});
const key = {
  serverId: 'home-a',
  machineId: 'machine-a',
  view: 'summary' as const,
};
type WatchAnswer = MachineResourceRpcResult<MachineVitalsWatchResultV1>;

function harness(nowMs: () => number = () => 60_000) {
  const watches: Array<{
    input: MachineVitalsWatchInput;
    answer: ReturnType<typeof createDeferred<WatchAnswer>>;
    dispatchedAt?: number;
  }> = [];
  const snapshotClient = vi.fn(
    async (): Promise<MachineResourceRpcResult<MachineVitalsSnapshotV1>> => ({
      ok: true,
      value: snapshot(),
    }),
  );
  const watchClient = vi.fn((input: MachineVitalsWatchInput) => {
    const answer = createDeferred<WatchAnswer>();
    watches.push({ input, answer });
    const watch = watches.at(-1)!;
    // Real RPC scope/encryption preparation is asynchronous before onDispatched fires.
    void Promise.resolve().then(() => {
      watch.dispatchedAt = Date.now();
      input.onDispatched?.();
    });
    input.signal?.addEventListener(
      'abort',
      () => answer.resolve({ ok: false, reason: 'request_failed' }),
      { once: true },
    );
    return answer.promise;
  });
  const historyClient = vi.fn(
    async (
      _input: MachineVitalsHistoryReadInput,
    ): Promise<MachineResourceRpcResult<MachineVitalsHistoryV1>> => ({
      ok: false,
      reason: 'request_failed',
    }),
  );
  return {
    store: createMachineResourceStore(
      { snapshotClient, watchClient, historyClient },
      nowMs,
    ),
    watches,
    snapshotClient,
    watchClient,
    historyClient,
  };
}

async function settle() {
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}

describe('machine resources subscription owner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rearms only for delivered samples and does no work for retained or withdrawn Machines', async () => {
    vi.useFakeTimers();
    const h = harness(() => Date.now());
    const retained = Array.from({ length: 128 }, (_, index) => ({ ...key, machineId: `machine-${index}` }));
    for (const input of retained) h.store.getState(input);
    const visible = retained.slice(0, 2);
    const releases = visible.flatMap(input => [h.store.demand(input), h.store.demand(input)]);
    try {
      await settle();
      expect(h.snapshotClient).toHaveBeenCalledTimes(2);
      expect(h.watchClient).toHaveBeenCalledTimes(2);
      // The daemon owns cadence. The client starts no timer to re-read or re-arm a parked watch.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.snapshotClient).toHaveBeenCalledTimes(2);
      expect(h.watchClient).toHaveBeenCalledTimes(2);
      for (const watch of h.watches.slice()) {
        watch.answer.resolve({ ok: true, value: { changed: true, samples: [sample(75_000)] } });
      }
      await settle();
      expect(h.watchClient).toHaveBeenCalledTimes(4);
      for (const release of releases) release();
      await settle();
      expect(h.watches.slice(-2).every(watch => watch.input.signal?.aborted)).toBe(true);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(h.snapshotClient).toHaveBeenCalledTimes(2);
      expect(h.watchClient).toHaveBeenCalledTimes(4);
    } finally { for (const release of releases) release(); h.store.reset(); }
  });


  it('reads a fresh sample on its Home reconnect without waiting for the held watch or looping on request success', async () => {
    const h = harness(() => 75_000);
    const release = h.store.demand(key);
    try {
      await settle();
      expect(h.watches).toHaveLength(1);
      h.snapshotClient.mockResolvedValue({ ok: true, value: snapshot(75_000) });
      publishHomeAccountChange('unrelated-home', undefined, { source: 'connected' });
      await settle();
      expect(h.snapshotClient).toHaveBeenCalledTimes(1);
      publishHomeAccountChange(key.serverId, undefined, { source: 'connected' });
      await settle();
      expect(h.store.getState(key).snapshot?.sample?.sampledAt).toBe(75_000);
      expect(h.snapshotClient).toHaveBeenCalledTimes(2);
      expect(h.watches).toHaveLength(1);
      clearMachineRequestReachabilityForMachine({ serverId: key.serverId, accountId: 'account-a' }, key.machineId);
      await settle();
      expect(h.snapshotClient).toHaveBeenCalledTimes(2);
      expect(h.watches).toHaveLength(1);
    } finally { release(); h.store.reset(); }
  });

  it('keeps cached summaries while one revalidation serves returning consumers', async () => {
    const h = harness();
    const first = h.store.demand(key);
    await settle();
    expect(h.store.getState(key).status).toBe('ready');
    const cached = h.store.getState(key).summary;
    first();
    const refresh = createDeferred<MachineResourceRpcResult<MachineVitalsSnapshotV1>>();
    h.snapshotClient.mockReturnValueOnce(refresh.promise);
    const second = h.store.demand(key);
    const sibling = h.store.demand(key);
    try {
      expect(h.store.getState(key).summary).toBe(cached);
      expect(h.store.isRefreshing(key)).toBe(true);
      expect(h.snapshotClient).toHaveBeenCalledTimes(2);
      refresh.resolve({ ok: true, value: snapshot(75_000) });
      await settle();
      expect(h.store.getState(key).status).toBe('ready');
      expect(h.store.isRefreshing(key)).toBe(false);
      expect(h.store.getState(key).summary?.sampledAt).toBe(75_000);
    } finally {
      refresh.resolve({ ok: true, value: snapshot(75_000) });
      second();
      sibling();
      h.store.reset();
    }
  });

  it('publishes live ticks without revisiting the retained hour of sample bodies', async () => {
    const h = harness(() => 3_720_000);
    const release = h.store.demand(key);
    await settle();
    h.watches[0]!.answer.resolve({ ok: true, value: { changed: true,
      samples: Array.from({ length: 1_799 }, (_, index) => ({ ...sample(62_000 + index * 2_000), intervalMs: 2_000 })),
    } });
    await settle();
    const held = h.store.getState(key);
    expect(held.samples).toHaveLength(1_800);
    let historicalBodyReads = 0;
    // Access instrumentation preserves the admitted sample's value. Old sample bodies
    // must not participate in a publication that only appends a new observation.
    for (const old of held.samples.slice(0, -1)) {
      const memory = old.memory;
      Object.defineProperty(old, 'memory', { enumerable: true, get: () => { historicalBodyReads++; return memory; } });
    }
    const start = performance.now();
    for (let index = 0; index < 30; index++) {
      h.watches.at(-1)!.answer.resolve({ ok: true, value: { changed: true,
        samples: [{ ...sample(3_660_000 + index * 2_000), intervalMs: 2_000 }],
      } });
      await settle();
    }
    const elapsedMs = performance.now() - start;
    console.info('FX87 retained-hour / 30 live publications', { elapsedMs, historicalBodyReads });
    const current = h.store.getState(key);
    expect(current.snapshot?.sample?.sampledAt).toBe(3_718_000);
    expect(current.samples[0]).toBe(held.samples[29]);
    expect(historicalBodyReads).toBe(0);
    const listener = vi.fn();
    const unobserve = h.store.observe(key, listener);
    h.snapshotClient.mockResolvedValueOnce({ ok: true, value: structuredClone(current.snapshot!) });
    await h.store.read(key);
    expect(h.store.getState(key)).toBe(current);
    expect(listener).not.toHaveBeenCalled();
    unobserve();
    release();
    h.store.reset();
  }, 120_000);

  it('retains unchanged history points and totals when a range answer changes one point', async () => {
    const h = harness();
    const input = { ...key, range: '1h' as const };
    const history: MachineVitalsHistoryV1 = { range: '1h', bucketMs: 60_000,
      points: [{ t: 60_000, cpu: 20, cpuMax: 20, mem: 20, memMax: 20, lvl: 'calm', swp: 0, rx: 1, tx: 2 },
        { t: 120_000, cpu: 20, cpuMax: 20, mem: 20, memMax: 20, lvl: 'calm', swp: 0, rx: 1, tx: 2 }],
      today: { rxBytes: 2, txBytes: 4 } };
    h.historyClient.mockResolvedValue({ ok: true, value: history });
    await h.store.readHistory(input);
    const before = h.store.getHistory(input);
    h.historyClient.mockResolvedValueOnce({ ok: true, value: { ...structuredClone(history),
      points: [structuredClone(history.points[0]!), { ...history.points[1]!, cpu: 30 }] } });
    await h.store.readHistory(input);
    const changed = h.store.getHistory(input);
    expect(changed.history?.points[1]?.cpu).toBe(30);
    expect(changed.history?.points[0]).toBe(before.history?.points[0]);
    expect(changed.history?.today).toBe(before.history?.today);
    h.store.reset();
  });

  it('retains twenty 15-second summary points while Overview keeps every live sample', async () => {
    const h = harness();
    const overview = { ...key, view: 'overview' as const };
    await h.store.read(key);
    const release = h.store.demand(overview);
    await settle();
    const live = Array.from({ length: 149 }, (_, index) => ({
      ...sample(62_000 + index * 2_000),
      intervalMs: 2_000,
    }));
    h.watches[0]!.answer.resolve({
      ok: true,
      value: { changed: true, samples: live },
    });
    await settle();
    const held = h.store.getState(overview);
    expect(held.samples).toHaveLength(150);
    expect(held.snapshot?.sample).toEqual(live.at(-1));
    expect(held.summary?.stepMs).toBe(15_000);
    expect(
      held.snapshot?.series5m.cpu.map((point) => Math.floor(point.t / 15_000)),
    ).toEqual(Array.from({ length: 20 }, (_, index) => index + 4));
    expect(h.store.getState(key).snapshot?.series5m).toEqual(
      held.snapshot?.series5m,
    );

    // The current figures still change between summary steps; the line does not.
    const next = {
      ...sample(359_000),
      intervalMs: 2_000,
      cpu: { reported: true as const, busyPct: 41 },
    };
    h.watches[1]!.answer.resolve({
      ok: true,
      value: { changed: true, samples: [next] },
    });
    await settle();
    const unchanged = h.store.getState(overview);
    expect(unchanged.snapshot?.sample).toEqual(next);
    expect(unchanged.samples).toHaveLength(151);
    expect(unchanged.summary?.cpu.busyPct).toBe(41);
    expect(unchanged.snapshot?.series5m).toBe(held.snapshot?.series5m);
    expect(unchanged.summary?.cpu.series).toBe(held.summary?.cpu.series);
    expect(unchanged.summary?.memory.series).toBe(held.summary?.memory.series);
    expect(unchanged.summary?.network.rxSeries).toBe(
      held.summary?.network.rxSeries,
    );
    release();
    h.store.reset();
  });

  it('normalizes dense snapshot series at the same owner and leaves missed steps and unreported metrics as gaps', async () => {
    const h = harness();
    const dense = snapshot(358_000);
    for (const metric of ['cpu', 'memory', 'networkRx', 'networkTx'] as const) {
      dense.series5m[metric] = Array.from({ length: 150 }, (_, index) => ({
        t: 60_000 + index * 2_000,
        y: index,
      }));
    }
    h.snapshotClient.mockResolvedValueOnce({ ok: true, value: dense });
    const release = h.store.demand(key);
    await settle();
    const seeded = h.store.getState(key).snapshot?.series5m;
    expect(seeded?.cpu).toHaveLength(20);
    const sameBucket = {
      ...dense,
      sample: { ...sample(359_000), intervalMs: 2_000 },
      series5m: { ...dense.series5m },
    };
    for (const metric of ['cpu', 'memory', 'networkRx', 'networkTx'] as const) {
      sameBucket.series5m[metric] = [
        ...dense.series5m[metric],
        { t: 359_000, y: 99 },
      ];
    }
    h.snapshotClient.mockResolvedValueOnce({ ok: true, value: sameBucket });
    await h.store.read(key);
    expect(h.store.getState(key).snapshot?.series5m).toBe(seeded);
    const missing = {
      ...sample(405_000),
      intervalMs: 2_000,
      cpu: { reported: false as const, reason: 'unavailable' as const },
    };
    h.watches[0]!.answer.resolve({
      ok: true,
      value: { changed: true, samples: [missing] },
    });
    await settle();
    const held = h.store.getState(key);
    expect(held.snapshot?.series5m.cpu).toHaveLength(20);
    expect(held.snapshot?.series5m.cpu.slice(-4)).toEqual([
      { t: 360_000, y: null },
      { t: 375_000, y: null },
      { t: 390_000, y: null },
      { t: 405_000, y: null },
    ]);
    expect(held.snapshot?.series5m.memory.slice(-4)).toEqual([
      { t: 360_000, y: null },
      { t: 375_000, y: null },
      { t: 390_000, y: null },
      { t: 405_000, y: 80 },
    ]);
    expect(held.summary?.cpu.busyPct).toBe(20);
    expect(held.snapshot?.sample?.cpu.reported).toBe(false);
    release();
    h.store.reset();
  });

  it('draws a minute-seeded line through its minute slots and breaks only where the machine declared a gap', async () => {
    const h = harness();
    const seeded = snapshot(345_000);
    // The daemon seeds the five-minute line from its minute records (a missing minute is an explicit null),
    // then its 15-second ring.
    seeded.series5m.cpu = [
      { t: 60_000, y: 10 },
      { t: 120_000, y: 12 },
      { t: 180_000, y: null },
      { t: 240_000, y: 14 },
      { t: 300_000, y: 16 },
      { t: 315_000, y: 17 },
      { t: 330_000, y: 18 },
      { t: 345_000, y: 19 },
    ];
    h.snapshotClient.mockResolvedValueOnce({ ok: true, value: seeded });
    const release = h.store.demand(key);
    await settle();
    const cpu = h.store.getState(key).snapshot?.series5m.cpu ?? [];
    expect(cpu.map((point) => point.y)).toEqual([
      10,
      10,
      10,
      10,
      12,
      12,
      12,
      12,
      null,
      null,
      null,
      null,
      14,
      14,
      14,
      14,
      16,
      17,
      18,
      19,
    ]);
    // Each slot keeps the time of the observation that covers it; nothing is invented between them.
    expect(cpu[1]).toEqual({ t: 60_000, y: 10 });

    // The tick slowing from the Overview's 2 s to the list's 15 s is a cadence change, not a skipped sample.
    const slower = { ...sample(372_000), intervalMs: 15_000 };
    h.watches[0]!.answer.resolve({ ok: true, value: { changed: true, samples: [{ ...sample(358_000), intervalMs: 2_000 }, slower] } });
    await settle();
    expect(h.store.getState(key).snapshot?.series5m.cpu.at(-1)).toEqual({ t: 372_000, y: 20 });
    expect(h.store.getState(key).snapshot?.series5m.cpu.some(point => point.y === null && point.t > 300_000)).toBe(false);
    release();
    h.store.reset();
  });

  it('keeps held samples, history and unavailable-method facts within their exact Home Account', async () => {
    const h = harness();
    const accountA = { ...key, expectedAccountId: 'account-a' };
    const accountB = { ...key, expectedAccountId: 'account-b' };
    await h.store.read(accountA);
    expect(h.store.getState(accountB).snapshot).toBeNull();
    expect(
      h.store.getState({ ...accountB, view: 'overview' }).snapshot,
    ).toBeNull();
    h.historyClient.mockResolvedValueOnce({
      ok: true,
      value: {
        range: '1h',
        bucketMs: 60_000,
        points: [],
        today: { rxBytes: 1, txBytes: 2 },
      },
    });
    await h.store.readHistory({ ...accountA, range: '1h' });
    expect(h.store.getHistory({ ...accountB, range: '1h' }).history).toBeNull();
    h.snapshotClient.mockResolvedValueOnce({
      ok: false,
      reason: 'older_happier',
    });
    await h.store.read(accountA);
    expect(h.store.getState(accountA).status).toBe('not_reported');
    expect(h.store.getState(accountB).status).toBe('loading');
    await h.store.read(accountB);
    expect(h.store.getState(accountB).status).toBe('ready');
    h.store.reset();
  });

  it('holds the last measured CPU across unreported samples without filling history gaps or another machine', async () => {
    const h = harness();
    const missing = snapshot(75_000);
    missing.sample!.cpu = { reported: false, reason: 'unavailable' };
    missing.series5m.cpu = [{ t: 75_000, y: null }];
    await h.store.read(key);
    h.snapshotClient.mockResolvedValueOnce({ ok: true, value: missing });
    await h.store.read(key);
    expect(h.store.getState(key).summary?.cpu.busyPct).toBe(20);
    expect(h.store.getState(key).snapshot?.sample?.cpu.reported).toBe(false);
    expect(h.store.getState(key).summary?.cpu.series.at(-1)?.y).toBeNull();
    h.snapshotClient.mockResolvedValueOnce({ ok: true, value: missing });
    await h.store.read({ ...key, machineId: 'never-measured' });
    expect(
      h.store.getState({ ...key, machineId: 'never-measured' }).summary?.cpu
        .busyPct,
    ).toBeNull();
    const recovered = snapshot(90_000);
    recovered.sample!.cpu = { reported: true, busyPct: 0 };
    h.snapshotClient.mockResolvedValueOnce({ ok: true, value: recovered });
    await h.store.read(key);
    expect(h.store.getState(key).summary?.cpu.busyPct).toBe(0);
    h.store.reset();
  });

  it('retains the typed read refusal for diagnosis and clears it after recovery', async () => {
    const h = harness();
    h.snapshotClient.mockResolvedValueOnce({
      ok: false,
      reason: 'request_failed',
      errorCode: 'action_disabled',
    });
    await h.store.read(key);
    expect(h.store.getState(key)).toMatchObject({
      status: 'error',
      errorCode: 'action_disabled',
    });
    await h.store.retry(key);
    expect(h.store.getState(key).status).toBe('ready');
    expect(h.store.getState(key)).not.toHaveProperty('errorCode');
    h.store.reset();
  });

  it('retries retained summary and history failures after reachability removed live demand', async () => {
    const h = harness();
    const historyKey = { ...key, range: '1h' as const };
    const history = {
      range: '1h' as const,
      bucketMs: 60_000,
      points: [],
      today: { rxBytes: 0, txBytes: 0 },
    };
    h.snapshotClient.mockResolvedValueOnce({
      ok: false,
      reason: 'request_failed',
    });
    await h.store.read(key);
    await h.store.readHistory(historyKey);
    expect(h.store.getState(key).status).toBe('error');
    expect(h.store.getHistory(historyKey).status).toBe('error');
    h.historyClient.mockResolvedValueOnce({ ok: true, value: history });
    await h.store.retry(key);
    await h.store.retryHistory(historyKey);
    expect(h.store.getState(key).status).toBe('ready');
    expect(h.store.getState(key).snapshot).toEqual(snapshot());
    expect(h.store.getHistory(historyKey)).toEqual({
      status: 'ready',
      history,
    });
    expect(h.watchClient).not.toHaveBeenCalled();
    h.store.reset();
  });

  it('shares concurrent reads and keeps equal summaries without live demand', async () => {
    const h = harness();
    await Promise.all([h.store.read(key), h.store.read(key)]);
    expect(h.snapshotClient).toHaveBeenCalledOnce();
    expect(h.watchClient).not.toHaveBeenCalled();
    expect(h.store.getState(key).snapshot).toEqual(snapshot());
    expect(h.store.getState(key).summary?.memory.availableBytes).toBe(80);
    expect(h.store.getState(key).summary?.memory.series).toEqual([
      { t: 60_000, y: 80 },
    ]);
    const warmed = h.store.getState(key);
    h.snapshotClient.mockResolvedValueOnce({
      ok: true,
      value: structuredClone(snapshot()),
    });
    await h.store.read(key);
    expect(h.store.getState(key).summary).toBe(warmed.summary);
    expect(h.store.getState(key).snapshot?.series5m).toBe(
      warmed.snapshot?.series5m,
    );
    h.store.reset();
  });

  it('lets an unopened offline Overview read the sample already held by its summary without another RPC', async () => {
    const h = harness();
    const overview = { ...key, view: 'overview' as const };
    const otherHome = { ...overview, serverId: 'home-b' };
    const updates = vi.fn();
    const release = h.store.observe(overview, updates);
    expect(h.store.getState(overview).snapshot).toBeNull();
    await h.store.read(key);
    expect(h.store.getState(overview).snapshot?.sample).toEqual(sample(60_000));
    expect(h.store.getState(otherHome).snapshot).toBeNull();
    expect(updates).toHaveBeenCalled();
    expect(h.snapshotClient).toHaveBeenCalledOnce();
    expect(h.watchClient).not.toHaveBeenCalled();
    h.snapshotClient.mockResolvedValueOnce({
      ok: false,
      reason: 'request_failed',
    });
    await h.store.read(overview);
    expect(h.store.getState(overview).snapshot?.sample).toEqual(sample(60_000));
    expect(h.store.getState(overview).status).toBe('error');
    release();
    h.store.reset();
  });

  it('projects only authoritative attention tones and selects its disk volume without a guessed default', () => {
    const source = snapshot();
    source.sample!.cpu = { reported: true, busyPct: 99 };
    source.sample!.memory = {
      reported: true,
      totalBytes: 100,
      availableBytes: 80,
      usedBytes: 20,
      pressure: { level: 'critical', source: 'psi' },
    };
    source.sample!.disk = {
      reported: true,
      volumes: [
        {
          id: 'root',
          label: 'Root',
          mount: '/',
          totalBytes: 100,
          availableBytes: 50,
        },
        {
          id: 'data',
          label: 'Data',
          mount: '/data',
          totalBytes: 100,
          availableBytes: 0,
        },
      ],
    };
    const calm = projectMachineResourceSummaryV1(source)!;
    expect(calm.cpu.tone).toBe('calm');
    expect(calm.memory.tone).toBe('calm');
    expect(calm.disk.availableBytes).toBeNull();
    source.sample!.disk.homeVolumeId = 'root';
    expect(projectMachineResourceSummaryV1(source)?.disk.availableBytes).toBe(
      50,
    );
    source.attention = {
      level: 'needs_you',
      reasons: [
        {
          key: 'disk:data',
          kind: 'disk_full',
          metric: 'disk',
          level: 'needs_you',
          since: 60_000,
          volumeId: 'data',
          volumeLabel: 'Data',
        },
      ],
    };
    const summary = projectMachineResourceSummaryV1(source)!;
    expect(summary.disk.volumeId).toBe('data');
    expect(summary.disk.availableBytes).toBe(0);
    expect(summary.disk.tone).toBe('crit');
    expect(summary.memory.availableBytes).toBe(80);
    expect(summary.seriesFrom).toBe(60_000);
    expect(MachineResourceSummaryV1Schema.safeParse(summary).success).toBe(
      true,
    );
  });

  it('shares one read and one watch per Home, machine and view, re-arms and preserves unchanged parts', async () => {
    const h = harness();
    const releaseA = h.store.demand(key);
    const releaseB = h.store.demand(key);
    await settle();
    expect(h.snapshotClient).toHaveBeenCalledOnce();
    expect(h.watches).toHaveLength(1);
    expect(h.watches[0].input.sinceSampledAt).toBe(60_000);
    const before = h.store.getState(key);
    h.watches[0].answer.resolve({
      ok: true,
      value: { changed: true, samples: [sample(75_000)] },
    });
    await settle();
    const after = h.store.getState(key);
    expect(after.snapshot?.sample?.sampledAt).toBe(75_000);
    expect(after.snapshot?.sample?.memory).toBe(
      before.snapshot?.sample?.memory,
    );
    expect(after.snapshot?.series5m.cpu[0]).toBe(
      before.snapshot?.series5m.cpu[0],
    );
    expect(after.summary?.memory.availableBytes).toBe(80);
    expect(after.summary?.memory.series.at(-1)?.y).toBe(80);
    expect(h.watches).toHaveLength(2);
    h.watches[1].answer.resolve({
      ok: true,
      value: { changed: true, samples: [structuredClone(sample(75_000))] },
    });
    await settle();
    expect(h.store.getState(key)).toBe(after);
    releaseA();
    expect(h.watches.at(-1)?.input.signal?.aborted).toBe(false);
    releaseB();
    expect(h.watches.at(-1)?.input.signal?.aborted).toBe(true);
    expect(h.store.getState(key)).toBe(after);
    h.store.reset();
  });

  it('rearms before slow synchronous subscribers see either view and cancels that watch when publication releases demand', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(60_000);
    const h = harness(Date.now);
    const overview = { ...key, view: 'overview' as const };
    const publications: Array<{ view: string; rearmed: boolean; at: number }> =
      [];
    const slowSubscriber = (view: typeof key.view | 'overview') => {
      if (
        h.store.getState({ ...key, view }).snapshot?.sample?.sampledAt !==
        120_000
      )
        return;
      publications.push({
        view,
        rearmed: h.watches.some(
          (watch) =>
            watch.input.sinceSampledAt === 120_000 &&
            watch.dispatchedAt !== undefined,
        ),
        at: Date.now(),
      });
      // Model FX79's 2.6 s synchronous publication/render work without a wall-clock sleep.
      vi.advanceTimersByTime(2_600);
    };
    await h.store.read(key);
    const releaseObserver = h.store.observe(key, () =>
      slowSubscriber('summary'),
    );
    const release = h.store.demand(overview, () => {
      slowSubscriber('overview');
      if (h.store.getState(overview).snapshot?.sample?.sampledAt === 120_000)
        release();
    });
    try {
      await settle();
      expect(h.watches).toHaveLength(1);
      vi.setSystemTime(120_000);
      h.watches[0].answer.resolve({
        ok: true,
        value: { changed: true, samples: [sample(120_000)] },
      });
      await settle();
      expect(publications.map((publication) => publication.view)).toContain(
        'summary',
      );
      expect(publications.map((publication) => publication.view)).toContain(
        'overview',
      );
      expect(publications.every((publication) => publication.rearmed)).toBe(
        true,
      );
      expect(h.watches).toHaveLength(2);
      expect(h.watches[1].input.signal?.aborted).toBe(true);
      expect(h.store.getState(overview).snapshot?.sample?.sampledAt).toBe(
        120_000,
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release();
      releaseObserver();
      h.store.reset();
    }
  });

  it('dispatches timeout recovery before a slow listener and keeps the reporting cursor without a timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(60_000);
    const h = harness(Date.now);
    const publications: boolean[] = [];
    const release = h.store.demand(key, () => {
      if (h.store.getState(key).status !== 'slow') return;
      publications.push(h.watches[1]?.dispatchedAt !== undefined);
      vi.advanceTimersByTime(2_600);
    });
    try {
      await settle();
      h.watches[0]!.answer.resolve({ ok: false, reason: 'request_failed', errorCode: MACHINE_RPC_TIMEOUT_ERROR_CODE });
      await settle();
      expect(publications).toEqual([true]);
      expect(h.watches).toHaveLength(2);
      expect(h.watches[1]!.input.sinceSampledAt).toBe(60_000);
      expect(h.watches[1]!.dispatchedAt).toBe(60_000);
      expect(vi.getTimerCount()).toBe(0);
      h.watches[1]!.answer.resolve({ ok: true, value: { changed: true, samples: [sample(75_000)] } });
      await settle();
      expect(h.store.getState(key)).toMatchObject({ status: 'ready', snapshot: { sample: { sampledAt: 75_000 } } });
    } finally { release(); h.store.reset(); }
  });

  it('publishes a successful reply to the sibling even when its next watch fails before dispatch', async () => {
    const h = harness();
    const overview = { ...key, view: 'overview' as const };
    await h.store.read(key);
    const release = h.store.demand(overview);
    try {
      await settle();
      // Scope/setup failure has no dispatch callback; normal failure recovery still applies.
      h.watchClient.mockImplementationOnce(async () => ({
        ok: false,
        reason: 'request_failed',
      }));
      h.watches[0].answer.resolve({
        ok: true,
        value: { changed: true, samples: [sample(75_000)] },
      });
      await settle();
      expect(h.store.getState(key).snapshot?.sample?.sampledAt).toBe(75_000);
      expect(h.store.getState(overview)).toMatchObject({
        status: 'slow',
        snapshot: { sample: { sampledAt: 75_000 } },
      });
    } finally {
      release();
      h.store.reset();
    }
  });

  it('keeps unrelated machines and views moving while a read is slow', async () => {
    const h = harness();
    const slow =
      createDeferred<MachineResourceRpcResult<MachineVitalsSnapshotV1>>();
    h.snapshotClient.mockImplementationOnce(() => slow.promise);
    const slowRead = h.store.read(key);
    const otherRead = h.store.read({ ...key, machineId: 'machine-b' });
    await otherRead;
    expect(h.store.getState({ ...key, machineId: 'machine-b' }).status).toBe(
      'ready',
    );
    slow.resolve({ ok: true, value: snapshot() });
    await slowRead;
    await h.store.read({ ...key, serverId: 'home-b' });
    await h.store.read({ ...key, view: 'overview' });
    expect(h.snapshotClient).toHaveBeenCalledTimes(4);
    h.store.reset();
  });

  it('does not replace a newer parked-watch sample with an older in-flight refresh', async () => {
    const h = harness();
    const release = h.store.demand(key);
    await settle();
    const slow =
      createDeferred<MachineResourceRpcResult<MachineVitalsSnapshotV1>>();
    h.snapshotClient.mockImplementationOnce(() => slow.promise);
    const refresh = h.store.read(key);
    h.watches[0].answer.resolve({
      ok: true,
      value: { changed: true, samples: [sample(90_000)] },
    });
    await settle();
    const watched = h.store.getState(key);
    slow.resolve({ ok: true, value: snapshot(75_000) });
    await refresh;
    expect(h.store.getState(key)).toBe(watched);
    expect(h.store.getState(key).summary?.sampledAt).toBe(90_000);
    release();
    h.store.reset();
  });

  it('appends raw one-hour live data and refreshes only demanded daemon history at the minute frontier', async () => {
    const h = harness();
    let rxBytes = 0;
    h.historyClient.mockImplementation(async (input) => ({
      ok: true,
      value: {
        range: input.range,
        bucketMs: 60_000,
        points: [],
        today: { rxBytes, txBytes: 0 },
      },
    }));
    const overviewKey = { ...key, view: 'overview' as const };
    const historyKey = { ...key, range: '24h' as const };
    const releaseHistory = h.store.demandHistory(historyKey);
    const release = h.store.demand(overviewKey);
    await settle();
    h.watches[0].answer.resolve({
      ok: true,
      value: { changed: true, samples: [sample(75_000)] },
    });
    await settle();
    expect(h.historyClient).toHaveBeenCalledOnce();
    rxBytes = 50;
    h.watches[1].answer.resolve({
      ok: true,
      value: { changed: true, samples: [sample(120_000)] },
    });
    await settle();
    expect(h.store.getHistory(historyKey).history?.today.rxBytes).toBe(50);
    expect(
      h.store.getState(overviewKey).samples.map((point) => point.sampledAt),
    ).toEqual([60_000, 75_000, 120_000]);
    expect(h.historyClient).toHaveBeenCalledTimes(2);
    releaseHistory();
    h.watches[2].answer.resolve({
      ok: true,
      value: { changed: true, samples: [sample(180_000)] },
    });
    await settle();
    expect(h.historyClient).toHaveBeenCalledTimes(2);
    release();
    h.store.reset();
  });

  it('remembers method-not-found across views and retry until daemon state changes', async () => {
    const h = harness();
    h.snapshotClient.mockResolvedValueOnce({
      ok: false,
      reason: 'older_happier',
    });
    await h.store.read(key);
    expect(h.store.getState(key).status).toBe('not_reported');
    const release = h.store.demand({ ...key, view: 'overview' });
    h.store.retry(key);
    await settle();
    expect(h.snapshotClient).toHaveBeenCalledOnce();
    expect(h.watchClient).not.toHaveBeenCalled();
    h.store.daemonStateChanged(key, 2);
    await settle();
    expect(h.store.getState({ ...key, view: 'overview' }).status).toBe('ready');
    release();
    h.store.reset();
  });

  it('discovers an upgraded daemon after a remembered unsupported answer', async () => {
    const h = harness();
    h.snapshotClient.mockResolvedValueOnce({
      ok: false,
      reason: 'older_happier',
    });
    await h.store.read({ ...key, daemonStateVersion: 1 });
    await h.store.read({ ...key, daemonStateVersion: 1 });
    expect(h.snapshotClient).toHaveBeenCalledOnce();
    h.store.daemonStateChanged(key, 2);
    await h.store.read({ ...key, daemonStateVersion: 2 });
    expect(h.store.getState(key).summary?.memory.availableBytes).toBe(80);
    expect(h.snapshotClient).toHaveBeenCalledTimes(2);
    expect(h.watchClient).not.toHaveBeenCalled();
    h.store.reset();
  });

  it('derives stale state at two missed sample intervals without a freshness timer', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.store.read(key);
    const state = h.store.getState(key);
    expect(isMachineResourceStateStale(state, 89_999)).toBe(false);
    expect(isMachineResourceStateStale(state, 90_000)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    h.store.reset();
  });

  it.each(['summary', 'overview'] as const)(
    'fresh %s answers replace sibling memory as a whole, retaining only independent extras',
    async (view) => {
      let now = 60_000;
      const h = harness(() => now);
      const source = { ...key, view };
      const sibling = {
        ...key,
        view: view === 'summary' ? ('overview' as const) : ('summary' as const),
      };
      const heldMemory = {
        ...sample(60_000).memory,
        reported: true as const,
        totalBytes: 100,
        availableBytes: 80,
        usedBytes: 20,
        pressure: { level: 'calm' as const, source: 'psi' as const },
        composition: [{ kind: 'apps' as const, bytes: 20 }],
      };
      const held = {
        ...snapshot(),
        sample: {
          ...sample(60_000),
          memory: heldMemory,
          thermal: { state: 'nominal' as const },
        },
      };
      h.snapshotClient.mockResolvedValueOnce({ ok: true, value: held });
      await h.store.read(sibling);
      h.snapshotClient.mockResolvedValueOnce({
        ok: true,
        value: {
          ...held,
          sample: { ...held.sample, thermal: { state: 'fair' as const } },
        },
      });
      const release = h.store.demand(source);
      await settle();
      now = 120_000;
      expect(isMachineResourceStateStale(h.store.getState(sibling), now)).toBe(
        true,
      );
      const incoming = sample(now);
      incoming.memory = { ...heldMemory, availableBytes: 70, usedBytes: 30 };
      delete incoming.memory.composition;
      h.watches[0]!.answer.resolve({
        ok: true,
        value: { changed: true, samples: [incoming] },
      });
      await settle();
      const fresh = h.store.getState(sibling);
      expect(fresh.snapshot?.sample?.sampledAt).toBe(now);
      expect(fresh.snapshot?.sample?.thermal).toEqual(held.sample.thermal);
      expect(fresh.snapshot?.sample?.memory).toEqual(incoming.memory);
      expect(fresh.snapshot?.sample?.memory).not.toHaveProperty('composition');
      expect(
        h.store.getState(source).snapshot?.sample?.thermal,
      ).toBeUndefined();
      expect(fresh.status).toBe('ready');
      expect(isMachineResourceStateStale(fresh, now)).toBe(false);
      expect(h.store.getState(sibling)).toBe(fresh);
      const otherHome = { ...sibling, serverId: 'home-b' };
      expect(h.store.getState(otherHome).snapshot).toBeNull();
      now = 135_000;
      h.snapshotClient.mockResolvedValueOnce({
        ok: true,
        value: snapshot(now),
      });
      await h.store.read(source);
      expect(h.store.getState(sibling).snapshot?.sample?.sampledAt).toBe(now);
      expect(h.store.getState(sibling).snapshot?.sample?.thermal).toEqual(
        held.sample.thermal,
      );
      release();
      h.store.reset();
    },
  );

  it('enriches a summary-seeded Overview and keeps the next measured composition paired with its total', async () => {
    const h = harness();
    const overview = { ...key, view: 'overview' as const };
    await h.store.read(overview);
    const release = h.store.demand(overview);
    await settle();
    h.snapshotClient.mockResolvedValueOnce({
      ok: true,
      value: snapshot(75_000),
    });
    await h.store.read(key);
    const detailed = sample(75_000);
    detailed.memory = {
      reported: true,
      totalBytes: 100,
      availableBytes: 80,
      usedBytes: 20,
      pressure: { level: 'calm', source: 'psi' },
      composition: [
        { kind: 'apps', bytes: 12 },
        { kind: 'kernel', bytes: 8 },
      ],
    };
    h.watches[0]!.answer.resolve({
      ok: true,
      value: { changed: true, samples: [detailed] },
    });
    await settle();
    expect(h.store.getState(overview).snapshot?.sample?.memory).toEqual(
      detailed.memory,
    );
    expect(
      h.store.getState(overview).snapshot?.series5m.cpu.map((point) => point.t),
    ).toEqual([60_000, 75_000]);
    const next = sample(90_000);
    next.memory = {
      ...detailed.memory,
      usedBytes: 30,
      availableBytes: 70,
      composition: [
        { kind: 'apps', bytes: 21 },
        { kind: 'kernel', bytes: 9 },
      ],
    };
    h.watches[1]!.answer.resolve({
      ok: true,
      value: { changed: true, samples: [next] },
    });
    await settle();
    expect(h.store.getState(overview).snapshot?.sample?.memory).toEqual(
      next.memory,
    );
    expect(h.store.getState(key).snapshot?.sample?.memory).toEqual(next.memory);
    release();
    h.store.reset();
  });

  it.each(['answer', 'throw'] as const)(
    'keeps the first watch %s slow, re-arms once and retires on the consecutive failure',
    async (failure) => {
      vi.useFakeTimers();
      const h = harness();
      const release = h.store.demand(key);
      await settle();
      const good = h.store.getState(key);
      if (failure === 'throw')
        h.watches[0]!.answer.reject(new Error('transport disconnected'));
      else
        h.watches[0]!.answer.resolve({
          ok: false,
          reason: 'request_failed',
          errorCode: 'request_timeout',
        });
      await settle();
      expect(h.store.getState(key)).toMatchObject({
        status: 'slow',
        snapshot: good.snapshot,
        summary: good.summary,
      });
      expect(h.watches).toHaveLength(2);
      h.store.setPublishedAttention(key, {
        level: 'look',
        reasons: [
          {
            key: 'disk:data',
            kind: 'disk_nearly_full',
            level: 'look',
            since: 1,
            metric: 'disk',
            volumeId: 'data',
            volumeLabel: 'Data',
          },
        ],
      });
      expect(h.store.getState(key).status).toBe('slow');
      if (failure === 'answer')
        expect(h.store.getState(key).errorCode).toBe('request_timeout');
      const attended = h.store.getState(key).summary;
      expect(attended?.memory).toBe(good.summary?.memory);
      h.watches[1]!.answer.resolve({ ok: false, reason: 'request_failed' });
      await settle();
      expect(h.store.getState(key).status).toBe('error');
      expect(h.store.getState(key).summary).toBe(attended);
      expect(h.watches).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
      release();
      h.store.reset();
    },
  );

  it.each([false, true])(
    'a successful watch answer resets consecutive failure state (changed=%s)',
    async (changed) => {
      const h = harness();
      const release = h.store.demand(key);
      await settle();
      h.watches[0]!.answer.resolve({ ok: false, reason: 'request_failed' });
      await settle();
      expect(h.store.getState(key).status).toBe('slow');
      h.watches[1]!.answer.resolve({
        ok: true,
        value: changed
          ? { changed: true, samples: [sample(75_000)] }
          : { changed: false },
      });
      await settle();
      expect(h.store.getState(key).status).toBe('ready');
      h.watches[2]!.answer.resolve({ ok: false, reason: 'request_failed' });
      await settle();
      expect(h.store.getState(key).status).toBe('slow');
      expect(h.watches).toHaveLength(4);
      release();
      h.store.reset();
    },
  );

  it('re-arms a retired watch when a reporting daemon republishes after restarting', async () => {
    const h = harness();
    h.store.daemonStateChanged(key, 1);
    const release = h.store.demand(key);
    await settle();
    h.watches[0]!.answer.resolve({ ok: false, reason: 'request_failed' });
    await settle();
    h.watches[1]!.answer.resolve({ ok: false, reason: 'request_failed' });
    await settle();
    expect(h.store.getState(key).status).toBe('error');
    h.snapshotClient.mockResolvedValueOnce({
      ok: true,
      value: snapshot(90_000),
    });
    h.store.daemonStateChanged(key, 2);
    await settle();
    expect(h.store.getState(key).status).toBe('ready');
    expect(h.store.getState(key).snapshot?.sample?.sampledAt).toBe(90_000);
    expect(h.watches).toHaveLength(3);
    h.store.daemonStateChanged(key, 2);
    await settle();
    expect(h.snapshotClient).toHaveBeenCalledTimes(2);
    release();
    h.store.reset();
  });

  it('recovers a failed sibling from an authorized answer at the same sample frontier without duplicating chart points', async () => {
    const h = harness();
    const overview = { ...key, view: 'overview' as const };
    await h.store.read(overview);
    h.snapshotClient.mockResolvedValueOnce({
      ok: false,
      reason: 'request_failed',
    });
    await h.store.read(overview);
    expect(h.store.getState(overview).status).toBe('error');
    await h.store.read(key);
    expect(h.store.getState(overview)).toMatchObject({
      status: 'ready',
      stale: false,
    });
    expect(h.store.getState(overview).snapshot?.series5m.cpu).toEqual([
      { t: 60_000, y: 20 },
    ]);
    h.snapshotClient.mockResolvedValueOnce({
      ok: false,
      reason: 'request_failed',
    });
    await h.store.read(overview);
    h.snapshotClient.mockResolvedValueOnce({
      ok: true,
      value: snapshot(59_000),
    });
    await h.store.read(key);
    expect(h.store.getState(overview).status).toBe('error');
    h.store.reset();
  });

  it('publishes an idle-watch stale transition once without changing cached metric data or starting a timer', async () => {
    vi.useFakeTimers();
    let now = 60_000;
    const h = harness(() => now);
    const rendered: boolean[] = [];
    let previous = h.store.getState(key);
    const release = h.store.demand(key, () => {
      const current = h.store.getState(key);
      if (current === previous) return;
      previous = current;
      rendered.push(isMachineResourceStateStale(current, now));
    });
    await settle();
    const good = h.store.getState(key);
    now = 90_000;
    h.watches[0].answer.resolve({ ok: true, value: { changed: false } });
    await settle();
    expect(rendered.at(-1)).toBe(true);
    const stale = h.store.getState(key);
    expect(stale.snapshot).toBe(good.snapshot);
    expect(stale.summary).toBe(good.summary);
    expect(stale.samples).toBe(good.samples);
    const notifications = rendered.length;
    now = 120_000;
    h.watches[1].answer.resolve({ ok: true, value: { changed: false } });
    await settle();
    expect(rendered).toHaveLength(notifications);
    expect(h.snapshotClient).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    release();
    h.store.reset();
  });

  it('keeps the last good report when the reader has no replacement sample', async () => {
    const h = harness();
    await h.store.read(key);
    const good = h.store.getState(key);
    h.snapshotClient.mockResolvedValueOnce({
      ok: true,
      value: {
        state: 'unavailable',
        reason: 'reader_failed',
        sample: null,
        series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] },
      },
    });
    await h.store.read(key);
    const unavailable = h.store.getState(key);
    expect(unavailable.snapshot?.state).toBe('unavailable');
    expect(unavailable.snapshot?.sample).toBe(good.snapshot?.sample);
    expect(unavailable.summary).toBe(good.summary);
    expect(unavailable.snapshot?.series5m).toBe(good.snapshot?.series5m);
    h.store.reset();
  });

  it('releases every watch and listener across twenty open-close cycles then resumes with one immediate read', async () => {
    const h = harness();
    const listener = vi.fn();
    for (let cycle = 0; cycle < 20; cycle++) {
      const release = h.store.demand(key, listener);
      await settle();
      release();
      await settle();
      expect(h.watches.every((watch) => watch.input.signal?.aborted)).toBe(
        true,
      );
      listener.mockClear();
      await settle();
      expect(listener).not.toHaveBeenCalled();
      expect(h.snapshotClient).toHaveBeenCalledTimes(cycle + 1);
    }
    const release = h.store.demand(key, listener);
    await settle();
    expect(h.snapshotClient).toHaveBeenCalledTimes(21);
    expect(h.watches).toHaveLength(21);
    release();
    h.store.reset();
  });
});
