import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { renderSystemdServiceUnit } from '@happier-dev/cli-common/service';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
// The CLI process is the system boundary; profile resolution and service discovery stay real.
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()), spawn: spawnMock,
}));

import { readLocalServerProfileScopeForRelay } from './localSetupFlowExecutor.js';

afterEach(() => { vi.unstubAllEnvs(); spawnMock.mockReset(); });

it.skipIf(process.platform !== 'linux')('ignores a pinned service from another release ring when resolving setup scope', async () => {
  const home = await mkdtemp(join(tmpdir(), 'setup-scope-ring-'));
  try {
    const happierHomeDir = join(home, '.happier');
    const servicesDir = join(home, '.config', 'systemd', 'user');
    await mkdir(servicesDir, { recursive: true });
    for (const [label, ring, mode] of [
      ['happier-daemon.company', 'stable', 'pinned'],
      ['happier-daemon.default', 'preview', 'default-following'],
    ] as const) {
      await writeFile(join(servicesDir, `${label}.service`), renderSystemdServiceUnit({
        description: label, execStart: [process.execPath, 'daemon', 'start-sync'], restart: 'on-failure',
        env: {
          HAPPIER_HOME_DIR: happierHomeDir,
          HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
          HAPPIER_DAEMON_SERVICE_TARGET_MODE: mode,
          HAPPIER_PUBLIC_RELEASE_CHANNEL: ring,
          HAPPIER_ACTIVE_SERVER_ID: 'company',
        },
      }));
    }
    vi.stubEnv('HOME', home);
    vi.stubEnv('HAPPIER_HOME_DIR', happierHomeDir);
    vi.stubEnv('HAPPIER_BOOTSTRAP_CLI_PATH', process.execPath);
    spawnMock.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
      });
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, data: {
          activeServerId: 'company', profiles: [{ id: 'company', serverUrl: 'https://company.test' }],
        } })));
        child.emit('exit', 0);
      });
      return child;
    });
    const scope = await readLocalServerProfileScopeForRelay({
      releaseRing: 'preview',
      relayProfile: { serverUrl: 'https://company.test', webappUrl: 'https://company.test', localServerUrl: null },
    });
    expect(scope).toMatchObject({ serverId: 'company', targetMode: 'default-following', selectedService: { ring: 'preview' } });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
