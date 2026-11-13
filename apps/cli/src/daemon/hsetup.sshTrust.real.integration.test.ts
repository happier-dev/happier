import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { expect, it } from 'vitest';
import { SystemTaskEventSchema, SystemTaskResultSchema, type SystemTaskResult } from '@happier-dev/protocol';
import { SSH_TUNNEL_SYSTEM_TASK_KINDS } from '@happier-dev/protocol/ssh/tunnels';
import { runHsetupCli } from '../../../bootstrap/src/bin/hsetup';
import { ElectronSystemTasks } from '../../../desktop/src/main/commands/systemTasks';
import { createDaemonControlApp } from './controlServer';
import { createSshTunnelRegistry, createSshTunnelSupervisor } from './ssh/tunnels';
import { reloadConfiguration } from '@/configuration';
import { clearDaemonStateForTestTeardown, writeDaemonState } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { findAvailableLoopbackPort } from '@/cloud/loopbackPort';

// Real OpenSSH is the platform boundary. Run explicitly on a host with sshd/ssh-keygen.
const nativeBinary = process.env.HAPPIER_TEST_HSETUP_BINARY;
it.skipIf(process.platform !== 'linux' || !existsSync('/usr/sbin/sshd'))(`keeps first-use trust answerable, saves the key, then Connect serves HTTP through the daemon SSH lease (${nativeBinary ? 'Electron/native' : 'source'})`, async () => {
  const home = await createTempDir('ssh-trust-');
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_BOOTSTRAP_CLI_PATH', 'HAPPIER_STACK_REPO_DIR']);
  const repo = resolve(import.meta.dirname, '../../../..');
  env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_BOOTSTRAP_CLI_PATH: join(repo, 'apps/cli/bin/happier.mjs'), HAPPIER_STACK_REPO_DIR: repo });
  reloadConfiguration();
  const key = join(home, 'identity');
  const hostKey = join(home, 'host');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
  const sshPort = await findAvailableLoopbackPort();
  const config = join(home, 'sshd_config');
  await writeFile(config, `Port ${sshPort}\nListenAddress 127.0.0.1\nHostKey ${hostKey}\nAuthorizedKeysFile ${key}.pub\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPidFile ${home}/sshd.pid\nLogLevel VERBOSE\n`);
  const sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', config], { stdio: ['ignore', 'ignore', 'pipe'] });
  const remote = http.createServer((_req, res) => res.end('remote-host-connected'));
  const supervisor = createSshTunnelSupervisor({ registry: createSshTunnelRegistry({ registryPath: join(home, 'tunnels.json') }), controlDir: home });
  const daemon = createDaemonControlApp({ getChildren: () => [], machineId: 'trust-test', stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'test-session' }), requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'trust-token', sshTunnels: supervisor });
  let sshdLog = '';
  try {
    await new Promise<void>((ready, reject) => {
      sshd.once('error', reject);
      sshd.once('exit', () => reject(new Error(`sshd exited: ${sshdLog}`)));
      sshd.stderr.on('data', chunk => { sshdLog += String(chunk); if (sshdLog.includes('Server listening')) ready(); });
    });
    await new Promise<void>(ready => remote.listen(0, '127.0.0.1', ready));
    const remoteAddress = remote.address();
    if (!remoteAddress || typeof remoteAddress === 'string') throw new Error('Missing remote listener');
    await daemon.listen({ port: 0, host: '127.0.0.1' });
    const daemonAddress = daemon.server.address();
    if (!daemonAddress || typeof daemonAddress === 'string') throw new Error('Missing daemon listener');
    writeDaemonState({ pid: process.pid, httpPort: daemonAddress.port, startedAt: Date.now(), startedWithCliVersion: 'test', controlToken: 'trust-token' });
    const knownHostsPath = join(home, 'known_hosts');
    const ssh = { target: `${userInfo().username}@127.0.0.1`, port: sshPort, auth: 'keyfile', identityFile: key, knownHostsPath };
    const runTask = async (kind: string, params: unknown, accept = true) => {
      if (nativeBinary) {
        let promptSeen = false;
        let resolveResult: ((result: SystemTaskResult) => void) | undefined;
        let rejectResult: ((error: unknown) => void) | undefined;
        const settled = new Promise<SystemTaskResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
        const host = new ElectronSystemTasks({
          resolveHsetupPath: () => nativeBinary,
          emitEvent: (_name, payload) => {
            const terminal = SystemTaskResultSchema.safeParse(payload);
            if (terminal.success) { resolveResult?.(terminal.data); return; }
            const event = SystemTaskEventSchema.parse(payload);
            if (event.type !== 'prompt') return;
            // Wait a turn as a native UI would: the old adapter already settled here.
            setImmediate(() => {
              try {
                expect(host.snapshot(event.taskId).result).toBeNull();
                expect(event.data).toMatchObject({ kind: 'ssh.trustHost', fingerprint: expect.stringMatching(/^SHA256:/) });
                promptSeen = true;
                void host.respondToPrompt(event.taskId, JSON.stringify({ trusted: accept })).catch(rejectResult);
              } catch (error) { rejectResult?.(error); }
            });
          },
        });
        await host.start(JSON.stringify({ protocolVersion: 1, kind, params }));
        const result = await settled;
        return { code: result.ok ? 0 : 1, promptSeen, result };
      }
      const lines = [JSON.stringify({ protocolVersion: 1, kind, params })];
      const output: unknown[] = [];
      let promptSeen = false;
      let answerPrompt: ((answer: string) => void) | undefined;
      const answer = new Promise<string>(resolveAnswer => { answerPrompt = resolveAnswer; });
      const code = await runHsetupCli(['system-tasks', 'run'], {
        stdin: { readAll: async () => '', readLine: async () => {
          if (lines.length) return lines.shift()!;
          // Answer only after the native prompt event, before any terminal result.
          const line = await answer;
          expect(output.some(event => SystemTaskResultSchema.safeParse(event).success)).toBe(false);
          return line;
        } },
        stdout: { write: chunk => {
          const event = JSON.parse(chunk);
          output.push(event);
          if (event.type === 'prompt') {
            expect(event.data).toMatchObject({ kind: 'ssh.trustHost', fingerprint: expect.stringMatching(/^SHA256:/) });
            promptSeen = true;
            answerPrompt?.(JSON.stringify({ trusted: accept }));
          }
        } },
        stderr: { write: chunk => { throw new Error(chunk); } },
      });
      return { code, promptSeen, result: SystemTaskResultSchema.parse(output.at(-1)) };
    };
    const declined = await runTask('remote.ssh.manageHost.v1', { action: 'testConnection', ssh }, false);
    expect(declined.result).toMatchObject({ ok: false, error: { code: 'host_trust_declined' } });
    await expect(readFile(knownHostsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const trusted = await runTask('remote.ssh.manageHost.v1', { action: 'testConnection', ssh });
    expect(trusted).toMatchObject({ code: 0, promptSeen: true, result: { ok: true } });
    expect(await readFile(knownHostsPath, 'utf8')).toContain((await readFile(`${hostKey}.pub`, 'utf8')).split(' ')[1]);
    const connected = await runTask(SSH_TUNNEL_SYSTEM_TASK_KINDS.ensure, { ssh, remoteHost: '127.0.0.1', remotePort: remoteAddress.port, purpose: 'remote-host-access' });
    expect(connected).toMatchObject({ code: 0, result: { ok: true, data: { ok: true, lease: { status: 'available' } } } });
    const result = connected.result;
    if (!result.ok || !result.data || typeof result.data !== 'object' || Array.isArray(result.data)) throw new Error('Missing lease result');
    const lease = result.data.lease;
    if (!lease || typeof lease !== 'object' || Array.isArray(lease) || typeof lease.httpBaseUrl !== 'string') throw new Error('Missing lease URL');
    const response = await fetch(lease.httpBaseUrl);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('remote-host-connected');
  } finally {
    await supervisor.stopAllTunnels();
    await daemon.close();
    await new Promise<void>(ready => remote.close(() => ready()));
    if (sshd.exitCode === null) { const exited = once(sshd, 'exit'); sshd.kill('SIGTERM'); await exited; }
    await clearDaemonStateForTestTeardown();
    env.restore();
    reloadConfiguration();
    await removeTempDir(home);
  }
});
