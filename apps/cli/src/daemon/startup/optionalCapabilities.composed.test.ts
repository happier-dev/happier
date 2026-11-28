import * as filesystem from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import axios from 'axios';

import { configuration } from '@/configuration';
import { MANAGED_TOOLS_ROOT_ENV_KEY } from '@happier-dev/cli-common/firstPartyRuntime';
import { admitDaemonForegroundAgentRuntime } from '@/daemon/controlClient';
import { createForegroundAdmissionError } from '@/cli/foregroundAdmissionFailure';
import { readDaemonState } from '@/persistence';
import { startInstalledDaemonFixture } from '@/daemon/testkit/installedDaemon.composed.testkit';

it.each(['plugin_runtime', 'account_catalogs'] as const)('registers the real daemon and serves its control listener when %s is unavailable', async capability => {
  const mkdir = filesystem.mkdir;
  const get = axios.get;
  let unavailablePath = '';
  let failures = 0;
  // Only the filesystem boundary fails; startup, registry acquisition, Machine
  // registration and the real HTTP/socket Home remain composed.
  const createDirectory = vi.spyOn(filesystem, 'mkdir');
  createDirectory.mockImplementation((path, options) => {
    if (capability === 'plugin_runtime' && String(path) === unavailablePath) {
      failures++;
      return Promise.reject(Object.assign(new Error('fixture plugin directory unavailable'), { code: 'EACCES' }));
    }
    return mkdir(path, options);
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
      if (capability === 'plugin_runtime') {
        const custodianTools = join(configuration.happyHomeDir, '..', 'custodian-tools');
        vi.stubEnv(MANAGED_TOOLS_ROOT_ENV_KEY, custodianTools);
        unavailablePath = join(custodianTools, 'plugins');
      }
    } });
    expect(failures).toBeGreaterThan(0);
    const state = await readDaemonState();
    expect(state).toMatchObject({ pid: process.pid });
    expect(state?.httpPort).toBeGreaterThan(0);
    const diagnostic = await filesystem.readFile(state!.daemonLogPath!, 'utf8');
    expect(diagnostic).toContain(`"capability":"${capability}"`);
    expect(diagnostic).toContain('"status":"unavailable"');
    if (capability === 'plugin_runtime') {
      const admission = await admitDaemonForegroundAgentRuntime({
        v: 1, attemptId: 'member-foreground', sessionId: 'member-session', foregroundPid: process.pid,
        directory: fixture.directory, agentId: 'codex',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      });
      expect(admission).toMatchObject({ ok: false, error: {
        kind: 'launch_error', code: 'PLUGIN_DAEMON_RUNTIME_UNAVAILABLE',
      } });
      if (!admission.ok) {
        expect(createForegroundAdmissionError(admission.error)).toMatchObject({
          code: 'PLUGIN_DAEMON_RUNTIME_UNAVAILABLE',
          message: expect.stringMatching(/daemon-applied plugin runtime/i),
        });
      }
    }
  } finally {
    createDirectory.mockRestore();
    http.mockRestore();
    try { await fixture?.stop(); } finally { vi.unstubAllEnvs(); }
  }
}, 120_000);
