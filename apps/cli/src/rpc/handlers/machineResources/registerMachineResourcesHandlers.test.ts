import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { DaemonResourcesGetResponseSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerMachineResourcesHandlers } from './registerMachineResourcesHandlers';

type Handler = (data?: unknown) => Promise<unknown> | unknown;

const osMocks = vi.hoisted(() => ({
  totalmem: vi.fn(),
  freemem: vi.fn(),
  homedir: vi.fn(),
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    totalmem: osMocks.totalmem,
    freemem: osMocks.freemem,
    homedir: osMocks.homedir,
  };
});

const statfsMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    statfs: statfsMock,
  };
});

// Real-shaped `vm_stat` output (multi-line, padded columns, quoted counters).
// page size 16384; used = (active 200000 + wired 50000 + compressor 25000) * 16384 = 4_505_600_000.
const VM_STAT_FIXTURE = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                                1000.',
  'Pages active:                            200000.',
  'Pages inactive:                          300000.',
  'Pages speculative:                         5000.',
  'Pages throttled:                              0.',
  'Pages wired down:                         50000.',
  'Pages purgeable:                          10000.',
  '"Translation faults":                  999999999.',
  'Pages copy-on-write:                      123456.',
  'Pages stored in compressor:              240000.',
  'Pages occupied by compressor:             25000.',
  'Decompressions:                          1217041.',
  'Compressions:                            3904026.',
  'Pageins:                                 4404311.',
  'Pageouts:                                  29321.',
  '',
].join('\n');

// MemTotal 16_000_000 kB, MemAvailable 12_000_000 kB -> used = 4_000_000 * 1024 = 4_096_000_000.
const MEMINFO_FIXTURE = [
  'MemTotal:       16000000 kB',
  'MemFree:         9000000 kB',
  'MemAvailable:   12000000 kB',
  'Buffers:          200000 kB',
  'Cached:          2500000 kB',
  'SwapTotal:             0 kB',
  'HugePages_Total:       0',
  '',
].join('\n');

function createRegistrar(): { handlers: Map<string, Handler>; registrar: RpcHandlerRegistrar } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registrar: {
      registerHandler(method, handler) {
        handlers.set(method, handler as Handler);
      },
    },
  };
}

function createCpuTimesReader(samples: ReadonlyArray<{ idle: number; total: number }>) {
  const queue = [...samples];
  return () => {
    const next = queue.shift();
    if (!next) {
      throw new Error('no queued cpu times sample left');
    }
    return next;
  };
}

function getRegisteredResourcesHandler(handlers: Map<string, Handler>): Handler {
  const handler = handlers.get(RPC_METHODS.DAEMON_RESOURCES_GET);
  if (!handler) {
    throw new Error('expected machine resources handler to be registered');
  }
  return handler;
}

beforeEach(() => {
  osMocks.totalmem.mockReset().mockReturnValue(10_000);
  osMocks.freemem.mockReset().mockReturnValue(2_500);
  osMocks.homedir.mockReset().mockReturnValue('/fallback/home');
  statfsMock.mockReset().mockResolvedValue({ bsize: 1024, blocks: 2_000, bavail: 500 });
});

describe('registerMachineResourcesHandlers', () => {
  it('registers daemon.resources.get and samples cpu, memory (win32: total - free), and home-directory disk usage', async () => {
    const { handlers, registrar } = createRegistrar();

    registerMachineResourcesHandlers({
      rpcHandlerManager: registrar,
      deps: {
        homeDir: '/home/tester',
        cpuSampleDelayMs: 0,
        platform: 'win32',
        readCpuTimes: createCpuTimesReader([
          { idle: 1_000, total: 4_000 },
          { idle: 1_500, total: 6_000 },
        ]),
      },
    });

    const getResources = getRegisteredResourcesHandler(handlers);
    expect(statfsMock).not.toHaveBeenCalled();

    const response = await getResources();

    expect(statfsMock).toHaveBeenCalledWith('/home/tester');
    expect(response).toEqual({
      ok: true,
      snapshot: {
        sampledAt: expect.any(Number),
        cpu: { usagePercent: 75 },
        memory: { totalBytes: 10_000, usedBytes: 7_500, usagePercent: 75 },
        disk: {
          path: '/home/tester',
          totalBytes: 2_048_000,
          availableBytes: 512_000,
          usedBytes: 1_536_000,
          usagePercent: 75,
        },
      },
    });
    expect(DaemonResourcesGetResponseSchema.safeParse(response).success).toBe(true);
  });

  it('samples darwin memory from vm_stat as active + wired + compressor pages', async () => {
    osMocks.totalmem.mockReturnValue(9_011_200_000);
    const { handlers, registrar } = createRegistrar();

    registerMachineResourcesHandlers({
      rpcHandlerManager: registrar,
      deps: {
        homeDir: '/home/tester',
        cpuSampleDelayMs: 0,
        platform: 'darwin',
        readCpuTimes: createCpuTimesReader([
          { idle: 0, total: 100 },
          { idle: 50, total: 200 },
        ]),
        readVmStatOutput: async () => VM_STAT_FIXTURE,
      },
    });

    const response = await getRegisteredResourcesHandler(handlers)();

    expect(response).toMatchObject({
      ok: true,
      snapshot: {
        memory: { totalBytes: 9_011_200_000, usedBytes: 4_505_600_000, usagePercent: 50 },
      },
    });
    expect(DaemonResourcesGetResponseSchema.safeParse(response).success).toBe(true);
  });

  it('clamps darwin memory usage to 100 when vm_stat counters exceed os.totalmem()', async () => {
    osMocks.totalmem.mockReturnValue(1_000_000_000);
    const { handlers, registrar } = createRegistrar();

    registerMachineResourcesHandlers({
      rpcHandlerManager: registrar,
      deps: {
        homeDir: '/home/tester',
        cpuSampleDelayMs: 0,
        platform: 'darwin',
        readCpuTimes: createCpuTimesReader([
          { idle: 0, total: 100 },
          { idle: 50, total: 200 },
        ]),
        readVmStatOutput: async () => VM_STAT_FIXTURE,
      },
    });

    const response = await getRegisteredResourcesHandler(handlers)();

    expect(response).toMatchObject({
      ok: true,
      snapshot: { memory: { usagePercent: 100 } },
    });
    expect(DaemonResourcesGetResponseSchema.safeParse(response).success).toBe(true);
  });

  it('samples linux memory from /proc/meminfo as MemTotal - MemAvailable', async () => {
    osMocks.totalmem.mockReturnValue(16_384_000_000);
    const { handlers, registrar } = createRegistrar();

    registerMachineResourcesHandlers({
      rpcHandlerManager: registrar,
      deps: {
        homeDir: '/home/tester',
        cpuSampleDelayMs: 0,
        platform: 'linux',
        readCpuTimes: createCpuTimesReader([
          { idle: 0, total: 100 },
          { idle: 50, total: 200 },
        ]),
        readProcMeminfo: async () => MEMINFO_FIXTURE,
      },
    });

    const response = await getRegisteredResourcesHandler(handlers)();

    expect(response).toMatchObject({
      ok: true,
      snapshot: {
        memory: { totalBytes: 16_384_000_000, usedBytes: 4_096_000_000, usagePercent: 25 },
      },
    });
    expect(DaemonResourcesGetResponseSchema.safeParse(response).success).toBe(true);
  });

  it('falls back to total - freemem on darwin when vm_stat fails or cannot be parsed', async () => {
    const unparseable = createRegistrar();
    registerMachineResourcesHandlers({
      rpcHandlerManager: unparseable.registrar,
      deps: {
        homeDir: '/home/tester',
        cpuSampleDelayMs: 0,
        platform: 'darwin',
        readCpuTimes: createCpuTimesReader([
          { idle: 0, total: 100 },
          { idle: 50, total: 200 },
        ]),
        readVmStatOutput: async () => 'vm_stat: not a vm_stat report',
      },
    });

    await expect(getRegisteredResourcesHandler(unparseable.handlers)()).resolves.toMatchObject({
      ok: true,
      snapshot: { memory: { totalBytes: 10_000, usedBytes: 7_500, usagePercent: 75 } },
    });

    const rejected = createRegistrar();
    registerMachineResourcesHandlers({
      rpcHandlerManager: rejected.registrar,
      deps: {
        homeDir: '/home/tester',
        cpuSampleDelayMs: 0,
        platform: 'darwin',
        readCpuTimes: createCpuTimesReader([
          { idle: 0, total: 100 },
          { idle: 50, total: 200 },
        ]),
        readVmStatOutput: async () => {
          throw new Error('spawn /usr/sbin/vm_stat ENOENT');
        },
      },
    });

    await expect(getRegisteredResourcesHandler(rejected.handlers)()).resolves.toMatchObject({
      ok: true,
      snapshot: { memory: { totalBytes: 10_000, usedBytes: 7_500, usagePercent: 75 } },
    });
  });

  it('defaults the sampled disk path to os.homedir() when no homeDir is injected', async () => {
    const { handlers, registrar } = createRegistrar();

    registerMachineResourcesHandlers({
      rpcHandlerManager: registrar,
      deps: {
        cpuSampleDelayMs: 0,
        platform: 'win32',
        readCpuTimes: createCpuTimesReader([
          { idle: 0, total: 100 },
          { idle: 100, total: 200 },
        ]),
      },
    });

    const response = await getRegisteredResourcesHandler(handlers)();

    expect(statfsMock).toHaveBeenCalledWith('/fallback/home');
    expect(response).toMatchObject({
      ok: true,
      snapshot: { disk: { path: '/fallback/home' } },
    });
  });

  it('reports zero cpu usage when the total cpu delta is zero', async () => {
    const { handlers, registrar } = createRegistrar();

    registerMachineResourcesHandlers({
      rpcHandlerManager: registrar,
      deps: {
        homeDir: '/home/tester',
        cpuSampleDelayMs: 0,
        platform: 'win32',
        readCpuTimes: createCpuTimesReader([
          { idle: 400, total: 900 },
          { idle: 400, total: 900 },
        ]),
      },
    });

    const response = await getRegisteredResourcesHandler(handlers)();

    expect(response).toMatchObject({
      ok: true,
      snapshot: { cpu: { usagePercent: 0 } },
    });
    expect(DaemonResourcesGetResponseSchema.safeParse(response).success).toBe(true);
  });

  it('clamps cpu usage to 100 when counter deltas invert (cpu count changed between reads)', async () => {
    const { handlers, registrar } = createRegistrar();

    registerMachineResourcesHandlers({
      rpcHandlerManager: registrar,
      deps: {
        homeDir: '/home/tester',
        cpuSampleDelayMs: 0,
        platform: 'win32',
        readCpuTimes: createCpuTimesReader([
          { idle: 1_000, total: 4_000 },
          { idle: 500, total: 6_000 },
        ]),
      },
    });

    const response = await getRegisteredResourcesHandler(handlers)();

    expect(response).toMatchObject({
      ok: true,
      snapshot: { cpu: { usagePercent: 100 } },
    });
    expect(DaemonResourcesGetResponseSchema.safeParse(response).success).toBe(true);
  });

  it('returns the error branch when statfs rejects', async () => {
    statfsMock.mockRejectedValue(new Error('disk probe failed'));
    const { handlers, registrar } = createRegistrar();

    registerMachineResourcesHandlers({
      rpcHandlerManager: registrar,
      deps: {
        homeDir: '/home/tester',
        cpuSampleDelayMs: 0,
        platform: 'win32',
        readCpuTimes: createCpuTimesReader([
          { idle: 0, total: 100 },
          { idle: 50, total: 200 },
        ]),
      },
    });

    const response = await getRegisteredResourcesHandler(handlers)();

    expect(response).toEqual({
      ok: false,
      error: 'disk probe failed',
      errorCode: 'sample_failed',
    });
    expect(DaemonResourcesGetResponseSchema.safeParse(response).success).toBe(true);
  });

  it('returns the error branch when the sampled disk reports zero total bytes', async () => {
    statfsMock.mockResolvedValue({ bsize: 4096, blocks: 0, bavail: 0 });
    const { handlers, registrar } = createRegistrar();

    registerMachineResourcesHandlers({
      rpcHandlerManager: registrar,
      deps: {
        homeDir: '/home/tester',
        cpuSampleDelayMs: 0,
        platform: 'win32',
        readCpuTimes: createCpuTimesReader([
          { idle: 0, total: 100 },
          { idle: 50, total: 200 },
        ]),
      },
    });

    const response = await getRegisteredResourcesHandler(handlers)();

    expect(response).toMatchObject({
      ok: false,
      errorCode: 'sample_failed',
    });
    expect(DaemonResourcesGetResponseSchema.safeParse(response).success).toBe(true);
  });
});
