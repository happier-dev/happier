import * as fs from 'node:fs/promises';
import { cpus, homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createLumeNativeClientForTest as createLumeNativeClient } from './nativeClient.testkit.js';

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  statfs: vi.fn(),
}));

// Native /lume/config storage projection recorded in LUME-LIVE2 attempt 4,
// 2026-11-09 10:39Z: defaultLocationName=home, vmLocations=[home: ~/.lume].
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), cpus: vi.fn() }));

const nativeStorage = { defaultLocationName: 'home', vmLocations: [{ name: 'home', path: '~/.lume' }] };

describe('Lume native home storage headroom', () => {
  it.each(['~/.lume', '~\\.lume'])('measures the host volume for %s without exposing its path', async path => {
    // Only the OS filesystem boundary is replaced; native decoding stays real.
    const measurement = vi.mocked(fs.statfs).mockImplementation(async target => {
      if (target !== join(homedir(), '.lume')) throw new Error('Unexpected host volume');
      return { type: 0, bsize: 4096, blocks: 100, bfree: 20, bavail: 10, files: 100, ffree: 50 };
    });
    const client = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async () =>
      Response.json({ ...nativeStorage, cachingEnabled: true, vmLocations: [{ name: 'home', path }] }) });
    try {
      for (let call = 1; call <= 2; call++) {
        const facts = await client.hostFacts(123);
        expect(facts).toMatchObject({ cacheState: 'enabled', localResources: {
          observedAt: 123, availableMemoryBytes: expect.any(Number), availableDiskBytes: 40960,
        } });
        expect(facts.localResources).not.toHaveProperty('availableCpuCores');
        expect(JSON.stringify(facts)).not.toContain('.lume');
        expect(measurement).toHaveBeenCalledTimes(call);
      }
    } finally { measurement.mockReset(); }
  });

  it('keeps multiple native locations unknown even when the default is home', async () => {
    const measurement = vi.mocked(fs.statfs).mockReset();
    const client = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async () =>
      Response.json({ ...nativeStorage, cachingEnabled: true,
        vmLocations: [...nativeStorage.vmLocations, { name: 'external', path: '/Volumes/External/lume' }] }) });
    try {
      const facts = await client.hostFacts(123);
      expect(facts.localResources).toMatchObject({ observedAt: 123, availableMemoryBytes: expect.any(Number) });
      expect(facts.localResources).not.toHaveProperty('availableDiskBytes');
      expect(measurement).not.toHaveBeenCalled();
    } finally { measurement.mockReset(); }
  });
});

// Recorded LUME-LIVE2 attempt4-before-native.log native-ls rows (2026-11-09),
// projected to Lume 0.6.1 VMDetails JSON names. Running statuses are constructed
// variants of that stopped inventory; cpuCount is the native CPU column.
const nativeVms = [
  { name: 'happier-cmw026ag3004umcehogl1s7cr', locationName: 'home', os: 'macOS', cpuCount: 2, status: 'stopped' },
  { name: 'happier-cmw63e4oi00dvmcm0f1a77v0f', locationName: 'home', os: 'macOS', cpuCount: 2, status: 'stopped' },
  { name: 'happier-cmw554urq007gmchn9nrc1hw2', locationName: 'home', os: 'macOS', cpuCount: 2, status: 'stopped' },
];
describe('Lume total host cores and running macOS allocations', () => {
  it.each([0, 2])('reports %i running VMs without treating allocation as idle CPU', async running => {
    const hostCpu = { model: 'Apple', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } };
    vi.mocked(cpus).mockReturnValue(Array.from({ length: 16 }, () => hostCpu));
    const requests: string[] = [];
    const client = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async input => {
      const path = new URL(String(input)).pathname;
      requests.push(path);
      return Response.json(path === '/lume/config' ? nativeStorage : [
        ...nativeVms.map((vm, index) => ({ ...vm, status: index < running ? 'running' : 'stopped' })),
        { name: 'linux', locationName: 'home', os: 'linux', cpuCount: 8, status: 'running' },
      ]);
    } });
    const facts = await client.hostFacts(123);
    expect(facts.localResources).toMatchObject({ totalCpuCores: 16, allocatedCpuCores: running * 2 });
    expect(facts.localResources).not.toHaveProperty('availableCpuCores');
    expect(requests.sort()).toEqual(['/lume/config', '/lume/vms']);
    vi.mocked(cpus).mockReset();
  });
});
