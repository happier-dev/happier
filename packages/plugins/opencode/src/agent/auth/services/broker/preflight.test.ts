import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV } from '../../../runtime/server/managedServerState.js';

import {
  OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV,
  OPEN_CODE_BROKER_LOAD_NONCE_ENV,
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  serializeOpenCodeBrokerSelections,
} from './env.js';
import { resolveOpenCodeConnectedConfigHomeDir } from './configHome.js';
import { ensureOpenCodeBrokerPluginAssets, resolveOpenCodeBrokerPluginPath } from './assets.js';
import {
  verifyOpenCodeBrokerReadyForConnectedSession,
  verifyOpenCodeBrokerLoadHandshakeForConnectedSession,
  type OpenCodeBrokerLoadHandshakeProbe,
} from './preflight.js';
import { prepareOpenCodeBrokerForConnectedSession } from './prepare.js';

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeConfigHome(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), 'happier-broker-ready-'));
  tmpDirs.push(rootDir);
  return resolveOpenCodeConnectedConfigHomeDir(rootDir);
}

async function writeDaemonState(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-broker-ready-daemon-'));
  tmpDirs.push(dir);
  const file = join(dir, 'daemon.state.json');
  await writeFile(file, JSON.stringify({ httpPort: 1234, controlToken: 'tok' }), 'utf8');
  return file;
}

describe('verifyOpenCodeBrokerReadyForConnectedSession (fail-closed preflight)', () => {
  it('is a no-op for native sessions (no selection identity)', async () => {
    expect(await verifyOpenCodeBrokerReadyForConnectedSession({} as NodeJS.ProcessEnv)).toEqual({ ready: true });
  });

  it('is ready for a connected direct-API-key session (no brokered provider)', async () => {
    const env = { [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'opencode|connected|x' } as NodeJS.ProcessEnv;
    expect(await verifyOpenCodeBrokerReadyForConnectedSession(env)).toEqual({ ready: true });
  });

  it('fails closed when the brokered plugin file is missing (not written to the auto-load dir)', async () => {
    // Readiness depends on the plugin FILE existing in the config-home auto-load dir, NOT on any
    // OPENCODE_CONFIG_CONTENT.plugin registration (which OpenCode does not honor for an absolute path).
    const configHome = await makeConfigHome();
    const env = {
      [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'opencode|connected|openai-codex:p:',
      [OPEN_CODE_BROKER_SELECTIONS_ENV]: serializeOpenCodeBrokerSelections({ openai: { serviceId: 'openai-codex', profileId: 'p', accountId: null, planType: null } }),
      [OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV]: await writeDaemonState(),
      XDG_CONFIG_HOME: configHome,
    } as NodeJS.ProcessEnv;
    const result = await verifyOpenCodeBrokerReadyForConnectedSession(env);
    expect(result).toEqual({ ready: false, reason: 'broker_plugin_file_missing:openai' });
  });

  it('is ready when the brokered plugin .js file exists on disk and the daemon bridge is reachable', async () => {
    const configHome = await makeConfigHome();
    await ensureOpenCodeBrokerPluginAssets({ providers: ['openai'], connectedConfigHomeDir: configHome });
    // The plugin is a `.js` file in the connected config home's opencode/plugin/ auto-load dir.
    expect(resolveOpenCodeBrokerPluginPath('openai', configHome).endsWith('.js')).toBe(true);
    const env = {
      [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'opencode|connected|openai-codex:p:',
      [OPEN_CODE_BROKER_SELECTIONS_ENV]: serializeOpenCodeBrokerSelections({ openai: { serviceId: 'openai-codex', profileId: 'p', accountId: null, planType: null } }),
      [OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV]: await writeDaemonState(),
      XDG_CONFIG_HOME: configHome,
    } as NodeJS.ProcessEnv;
    expect(await verifyOpenCodeBrokerReadyForConnectedSession(env)).toEqual({ ready: true });
  });

  it('fails closed when the daemon bridge state is unreachable', async () => {
    const configHome = await makeConfigHome();
    await ensureOpenCodeBrokerPluginAssets({ providers: ['openai'], connectedConfigHomeDir: configHome });
    const env = {
      [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'opencode|connected|openai-codex:p:',
      [OPEN_CODE_BROKER_SELECTIONS_ENV]: serializeOpenCodeBrokerSelections({ openai: { serviceId: 'openai-codex', profileId: 'p', accountId: null, planType: null } }),
      [OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV]: '/nonexistent/daemon.state.json',
      XDG_CONFIG_HOME: configHome,
    } as NodeJS.ProcessEnv;
    expect(await verifyOpenCodeBrokerReadyForConnectedSession(env)).toEqual({ ready: false, reason: 'broker_daemon_bridge_unreachable' });
  });
});

describe('verifyOpenCodeBrokerLoadHandshakeForConnectedSession (F4 post-spawn load handshake)', () => {
  const brokeredEnv = (daemonStatePath: string): NodeJS.ProcessEnv => ({
    [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'opencode|connected|broker:1|openai-codex:p:',
    [OPEN_CODE_BROKER_SELECTIONS_ENV]: serializeOpenCodeBrokerSelections({ openai: { serviceId: 'openai-codex', profileId: 'p', accountId: null, planType: null } }),
    [OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV]: daemonStatePath,
    [OPEN_CODE_BROKER_LOAD_NONCE_ENV]: 'opencode-spawn-1',
  } as NodeJS.ProcessEnv);

  it('is a no-op for native sessions (no selection identity)', async () => {
    const probe = vi.fn<OpenCodeBrokerLoadHandshakeProbe>(async () => false);
    expect(await verifyOpenCodeBrokerLoadHandshakeForConnectedSession({} as NodeJS.ProcessEnv, { probe })).toEqual({ ready: true });
    expect(probe).not.toHaveBeenCalled();
  });

  it('is a no-op for a connected direct-API-key session (no brokered provider)', async () => {
    const probe = vi.fn<OpenCodeBrokerLoadHandshakeProbe>(async () => false);
    const env = { [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'opencode|connected|x' } as NodeJS.ProcessEnv;
    expect(await verifyOpenCodeBrokerLoadHandshakeForConnectedSession(env, { probe })).toEqual({ ready: true });
    expect(probe).not.toHaveBeenCalled();
  });

  it('is ready when the daemon reports the broker load handshake was observed', async () => {
    const env = brokeredEnv(await writeDaemonState());
    const probe = vi.fn<OpenCodeBrokerLoadHandshakeProbe>(async () => true);
    expect(await verifyOpenCodeBrokerLoadHandshakeForConnectedSession(env, { probe })).toEqual({ ready: true });
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({
      httpPort: 1234,
      controlToken: 'tok',
      loadNonce: 'opencode-spawn-1',
    }));
  });

  it('fails closed when a brokered server has no spawn load nonce', async () => {
    const env = brokeredEnv(await writeDaemonState());
    delete env[OPEN_CODE_BROKER_LOAD_NONCE_ENV];
    const probe = vi.fn<OpenCodeBrokerLoadHandshakeProbe>(async () => true);
    expect(await verifyOpenCodeBrokerLoadHandshakeForConnectedSession(env, { probe })).toEqual({ ready: false, reason: 'broker_load_nonce_missing' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('fails closed (broker_plugin_not_loaded) when the handshake never arrives within the bounded wait', async () => {
    const env = brokeredEnv(await writeDaemonState());
    const probe = vi.fn<OpenCodeBrokerLoadHandshakeProbe>(async () => false);
    const sleep = vi.fn(async () => {});
    // now() advances past the deadline on the second read so the loop runs exactly one extra poll.
    let t = 0;
    const now = () => { const v = t; t += 60; return v; };
    const result = await verifyOpenCodeBrokerLoadHandshakeForConnectedSession(env, { probe, waitMs: 100, pollIntervalMs: 10, now, sleep });
    expect(result).toEqual({ ready: false, reason: 'broker_plugin_not_loaded' });
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(sleep).toHaveBeenCalled();
  });

  it('fails closed (broker_daemon_bridge_unreachable) when the daemon-state file is missing', async () => {
    const env = brokeredEnv('/nonexistent/daemon.state.json');
    const probe = vi.fn<OpenCodeBrokerLoadHandshakeProbe>(async () => true);
    expect(await verifyOpenCodeBrokerLoadHandshakeForConnectedSession(env, { probe })).toEqual({ ready: false, reason: 'broker_daemon_bridge_unreachable' });
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('prepareOpenCodeBrokerForConnectedSession (live launch step: write assets + preflight)', () => {
  it('is a no-op for native sessions (no selection identity)', async () => {
    expect(await prepareOpenCodeBrokerForConnectedSession({})).toEqual({ ready: true });
  });

  it('writes the broker assets into the isolated config home, then reports ready', async () => {
    const configHome = await makeConfigHome();
    const env = {
      [OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV]: 'opencode|connected|claude-subscription:p:',
      [OPEN_CODE_BROKER_SELECTIONS_ENV]: serializeOpenCodeBrokerSelections({ anthropic: { serviceId: 'claude-subscription', profileId: 'p', accountId: null, planType: null } }),
      [OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV]: await writeDaemonState(),
      XDG_CONFIG_HOME: configHome,
    } as Record<string, string>;

    // Before prepare, the preflight fails (asset not written yet); prepare writes it and turns ready.
    expect(await verifyOpenCodeBrokerReadyForConnectedSession(env)).toEqual({ ready: false, reason: 'broker_plugin_file_missing:anthropic' });
    expect(await prepareOpenCodeBrokerForConnectedSession(env)).toEqual({ ready: true });
    expect(await verifyOpenCodeBrokerReadyForConnectedSession(env)).toEqual({ ready: true });
  });
});
