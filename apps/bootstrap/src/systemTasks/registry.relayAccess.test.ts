import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createBuiltinRelayAccessSelection } from '@happier-dev/cli-common/relayAccess';
import { executeSystemTask, type RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';
import { createFakeTailscaleCli } from '@happier-dev/tests/testkit/tailscale/fakeTailscaleCli';
import { expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  ssh: vi.fn<typeof import('@happier-dev/cli-common/ssh').runOpenSshRemoteCommand>(),
  command: vi.fn<typeof import('./taskRuntime.js').runCommandCapture>(),
}));

// Only the SSH and SCP process boundaries are substituted. Registry, task
// dispatch, selection admission, native codecs and persisted files stay real.
vi.mock('@happier-dev/cli-common/ssh', async (importOriginal) => ({
  ...await importOriginal<typeof import('@happier-dev/cli-common/ssh')>(),
  runOpenSshRemoteCommand: transport.ssh,
}));
vi.mock('./taskRuntime.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./taskRuntime.js')>(),
  runCommandCapture: transport.command,
}));

import { createHsetupSystemTaskRegistry } from './registry.js';

it.skipIf(process.platform === 'win32').each(['local', 'ssh'] as const)('round trips Home access on the addressed %s host through the default bootstrap registry', async (kind) => {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-home-access-'));
  const localHome = join(root, 'local');
  const remoteHome = join(root, 'remote');
  const target: RelayAccessTaskTarget = kind === 'ssh'
    ? { kind: 'ssh', ssh: { target: 'home@example.test', auth: 'agent', port: 2222 } }
    : { kind: 'local' };
  vi.stubEnv('HAPPIER_HOME_DIR', localHome);
  transport.ssh.mockReset().mockImplementation(async request => {
    expect(request.target).toBe('home@example.test');
    expect(request.port).toBe(2222);
    const quoted = request.remoteCommand[2] ?? '';
    const command = quoted.slice(1, -1).replaceAll("'\"'\"'", "'");
    return { status: 0, stdout: execFileSync('bash', ['-c', command], {
      env: { ...process.env, HOME: remoteHome }, encoding: 'utf8',
    }), stderr: '' };
  });
  transport.command.mockReset().mockImplementation(async request => {
    expect(request.command).toBe('scp');
    const source = request.args.at(-2);
    const destination = request.args.at(-1);
    if (!source || !destination?.startsWith('home@example.test:')) throw new Error('Unexpected SCP destination');
    copyFileSync(source, join(remoteHome, destination.slice('home@example.test:'.length)));
    return { status: 0, stdout: '', stderr: '' };
  });
  const config = createBuiltinRelayAccessSelection('lan', { url: 'https://remote.home.example.test' });
  const registry = createHsetupSystemTaskRegistry();
  const run = (operation: 'configure' | 'status' | 'disable') => executeSystemTask({
    registry, taskId: `home-${kind}-${operation}`, spec: { protocolVersion: 1, kind: `relay.access.${operation}.v1`,
      params: { target, ...(operation === 'configure' ? { config } : {}) } },
  });
  const persisted = join(kind === 'ssh' ? remoteHome : localHome, ...(kind === 'ssh' ? ['.happier'] : []), 'relay', 'access', 'local.json');
  try {
    expect(await run('configure')).toMatchObject({ ok: true, data: {
      configured: true, selection: config, status: { state: 'enabled', shareUrl: 'https://remote.home.example.test' },
    } });
    expect(JSON.parse(readFileSync(persisted, 'utf8'))).toEqual(config);
    // A fresh registry must read the writer's actual bytes, rather than memory.
    const status = await executeSystemTask({ registry: createHsetupSystemTaskRegistry(), taskId: 'read-after-restart',
      spec: { protocolVersion: 1, kind: 'relay.access.status.v1', params: { target } } });
    expect(status).toMatchObject({ ok: true, data: { selection: config, status: { shareUrl: 'https://remote.home.example.test' } } });
    expect(await run('disable')).toMatchObject({ ok: true, data: { configured: false, selection: null } });
    expect(await run('status')).toMatchObject({ ok: true, data: { configured: false } });
    expect(() => readFileSync(persisted)).toThrow();
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === 'win32')('uses the remote Tailscale executable for an SSH Home despite local binary overrides', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-home-ssh-native-'));
  const fakeCli = createFakeTailscaleCli({ statusJsons: [{ BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/test' }] });
  const bin = join(root, 'bin');
  const remoteHome = join(root, 'remote');
  const configDir = join(remoteHome, '.happier', 'relay', 'access');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'local.json'), JSON.stringify(createBuiltinRelayAccessSelection('tailscaleServe')));
  mkdirSync(bin);
  symlinkSync(fakeCli.cliPath, join(bin, 'tailscale'));
  vi.stubEnv('HAPPIER_HOME_DIR', join(root, 'local'));
  vi.stubEnv('HAPPIER_TAILSCALE_BIN', '/local-only/tailscale');
  vi.stubEnv('HAPPIER_STACK_TAILSCALE_BIN', '/local-stack-only/tailscale');
  transport.ssh.mockReset().mockImplementation(async request => {
    expect(request.target).toBe('home@example.test');
    const quoted = request.remoteCommand[2] ?? '';
    const command = quoted.slice(1, -1).replaceAll("'\"'\"'", "'");
    return { status: 0, stdout: execFileSync('bash', ['-c', command], { encoding: 'utf8', env: {
      ...process.env, HOME: remoteHome, PATH: `${bin}:${process.env.PATH ?? ''}`,
      HAPPIER_FAKE_TAILSCALE_STATE_PATH: join(dirname(fakeCli.cliPath), 'scenario.json'),
      HAPPIER_FAKE_TAILSCALE_LOG_PATH: join(dirname(fakeCli.cliPath), 'invocations.log'),
    } }), stderr: '' };
  });
  try {
    const result = await executeSystemTask({ registry: createHsetupSystemTaskRegistry(), taskId: 'remote-native',
      spec: { protocolVersion: 1, kind: 'relay.access.status.v1', params: {
        target: { kind: 'ssh', ssh: { target: 'home@example.test', auth: 'agent' } },
      } } });
    expect(result).toMatchObject({ ok: true, data: { configured: true, providerId: 'tailscaleServe', status: { state: 'needs_auth' } } });
    expect(fakeCli.readInvocations()).toEqual([['status', '--json']]);
  } finally {
    vi.unstubAllEnvs();
    fakeCli.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
