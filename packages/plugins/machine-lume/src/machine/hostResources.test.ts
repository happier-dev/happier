import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createLumeNativeClient } from './nativeClient';

// Native /lume/config storage projection recorded in LUME-LIVE2 attempt 4,
// 2026-11-09 10:39Z: defaultLocationName=home, vmLocations=[home: ~/.lume].
const nativeStorage = { defaultLocationName: 'home', vmLocations: [{ name: 'home', path: '~/.lume' }] };

describe('Lume native home storage headroom', () => {
  it.each(['~/.lume', '~\\.lume'])('measures the host volume for %s without exposing its path', async path => {
    // Only the OS filesystem boundary is replaced; native decoding stays real.
    const measurement = vi.spyOn(fs, 'statfs').mockImplementation(async target => {
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
    } finally { measurement.mockRestore(); }
  });

  it('keeps multiple native locations unknown even when the default is home', async () => {
    const measurement = vi.spyOn(fs, 'statfs');
    const client = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async () =>
      Response.json({ ...nativeStorage, cachingEnabled: true,
        vmLocations: [...nativeStorage.vmLocations, { name: 'external', path: '/Volumes/External/lume' }] }) });
    try {
      const facts = await client.hostFacts(123);
      expect(facts.localResources).toMatchObject({ observedAt: 123, availableMemoryBytes: expect.any(Number) });
      expect(facts.localResources).not.toHaveProperty('availableDiskBytes');
      expect(measurement).not.toHaveBeenCalled();
    } finally { measurement.mockRestore(); }
  });
});
