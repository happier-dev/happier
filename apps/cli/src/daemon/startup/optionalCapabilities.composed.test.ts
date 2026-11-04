import * as filesystem from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import axios from 'axios';

import { configuration } from '@/configuration';
import { readDaemonState } from '@/persistence';
import { startInstalledDaemonFixture } from '@/daemon/testkit/installedDaemon.testkit';

it.each(['plugin_runtime', 'account_catalogs'] as const)('registers the real daemon and serves its control listener when %s is unavailable', async capability => {
  const readdir = filesystem.readdir;
  const get = axios.get;
  let unavailablePath = '';
  let failures = 0;
  // Only the filesystem boundary fails; startup, registry acquisition, Machine
  // registration and the real HTTP/socket Home remain composed.
  const read = vi.spyOn(filesystem, 'readdir').mockImplementation((path, options) => {
    if (capability === 'plugin_runtime' && String(path) === unavailablePath) {
      failures++;
      return Promise.reject(Object.assign(new Error('fixture plugin directory unavailable'), { code: 'EIO' }));
    }
    return readdir(path, options);
  });
  const http = vi.spyOn(axios, 'get').mockImplementation((url, options) => {
    if (capability === 'account_catalogs' && new URL(String(url)).pathname === '/v2/account/settings') {
      failures++;
      return Promise.reject(Object.assign(new Error('fixture Home settings unavailable'), { code: 'ECONNREFUSED' }));
    }
    return get(url, options);
  });
  let fixture: Awaited<ReturnType<typeof startInstalledDaemonFixture>> | undefined;
  try {
    fixture = await startInstalledDaemonFixture({ onStartupPhase: phase => {
      if (phase !== 'daemonStart') return;
      unavailablePath = join(configuration.happyHomeDir, 'plugins', 'plugins', 'cache', 'development-candidates');
      mkdirSync(unavailablePath, { recursive: true });
    } });
    expect(failures).toBeGreaterThan(0);
    const state = await readDaemonState();
    expect(state).toMatchObject({ pid: process.pid });
    expect(state?.httpPort).toBeGreaterThan(0);
    const diagnostic = await filesystem.readFile(state!.daemonLogPath!, 'utf8');
    expect(diagnostic).toContain(`"capability":"${capability}"`);
    expect(diagnostic).toContain('"status":"unavailable"');
  } finally {
    read.mockRestore();
    http.mockRestore();
    await fixture?.stop();
  }
}, 120_000);
