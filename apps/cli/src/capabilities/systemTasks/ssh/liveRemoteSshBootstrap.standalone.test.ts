import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { machineSetup } from '@happier-dev/cli-common';
import { createSystemTasksRunner } from '@happier-dev/cli-common/systemTasks';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import type { SystemTaskJsonObject } from '@happier-dev/protocol';
import type { ManagedMachineEnrollmentIdentityV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MANAGED_SUDOERS_PATH } from '@/machines/adminAccess/managedSudoers';
import { MachineEffectInternalRequestSchema } from '@/machines/setup/effectInternalProtocol';
import { createLiveRemoteSshBootstrapTaskKind } from './liveRemoteSshBootstrap';
import { handleMachineCommand } from '@/cli/commands/machine';
import { runHsetupCli } from '../../../../../bootstrap/src/bin/hsetup';

type SshBoundary = typeof import('@happier-dev/cli-common/ssh');
type SshRequest = Parameters<SshBoundary['runOpenSshRemoteCommand']>[0];
const boundary = vi.hoisted(() => ({
  requests: [] as SshRequest[],
  plans: [] as unknown[],
  failure: null as string | null,
  run: null as null | ((request: SshRequest) => Promise<{ status: number; stdout: string; stderr: string }>),
}));

// SSH/process/file transfer are the system boundary. The task, installer,
// dedicated bootstrap, plan builder and CLI entry all remain real.
vi.mock('@happier-dev/cli-common/ssh', async importOriginal => {
  const actual = await importOriginal<SshBoundary>();
  return { ...actual,
    runOpenSshRemoteCommand: async (request: SshRequest) => {
      boundary.requests.push(request);
      if (!boundary.run) throw new Error('Missing SSH boundary');
      try { return await boundary.run(request); }
      catch (error) { boundary.failure = error instanceof Error ? error.message : String(error); throw error; }
    },
    transferOpenSshFile: async () => {},
  };
});

const hostKey = 'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual,
    spawnSync: (...args: Parameters<typeof actual.spawnSync>) => args[0] === 'ssh-keyscan'
      ? { status: 0, stdout: hostKey + '\n', stderr: '' } : actual.spawnSync(...args),
    // The shared Node SSH transport reaches the SCP process boundary.
    spawn: (...args: Parameters<typeof actual.spawn>) => args[0] === 'scp'
      ? actual.spawn(process.execPath, ['-e', 'process.exit(0)']) : actual.spawn(...args),
  };
});

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); process.exitCode = undefined; });

async function runDesktopTask(params: unknown, taskId: string, answers: unknown[] = []) {
  const outputs: string[] = [];
  const stdin = [JSON.stringify({ protocolVersion: 1, kind: 'remote.ssh.bootstrapMachine.v1', params }), ...answers.map(answer => JSON.stringify(answer))];
  const exitCode = await runHsetupCli(['system-tasks', 'run'], {
    taskIdFactory: () => taskId,
    stdin: { readAll: async () => stdin.join('\n'), readLine: async () => stdin.shift() ?? null },
    stdout: { write: value => { outputs.push(value); } }, stderr: { write: () => {} },
  });
  const stdout = outputs.join('');
  const result: unknown = JSON.parse(stdout.trim().split('\n').at(-1)!);
  return { exitCode, result, stdout };
}

it('closes desktop SSH process exceptions without publishing reflected native text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-desktop-ssh-failure-'));
  boundary.requests.length = 0;
  boundary.run = async () => { throw new Error('REMOTE HOST IDENTIFICATION HAS CHANGED! private-native-content'); };
  try {
    const result = await runDesktopTask({
      ssh: { target: 'root@example.test', auth: 'agent', trustedHostKey: hostKey, knownHostsPath: join(root, 'known_hosts') },
      knownHostsMode: 'system',
      relay: { relayUrl: 'https://home.example.test' },
      enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'none' },
    }, 'desktop-process-failure');
    expect(result.result, boundary.failure ?? JSON.stringify(result.result)).toMatchObject({ ok: false, error: { code: 'ssh_host_key_changed' } });
    expect(result.stdout).not.toContain('private-native-content');
    expect(boundary.requests).toHaveLength(1);
  } finally { boundary.run = null; await rm(root, { recursive: true, force: true }); }
});

it('does not turn a caller task id or synthetic managed correlation into standalone task or desktop authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-standalone-ssh-denial-'));
  boundary.requests.length = 0;
  boundary.run = async () => { throw new Error('Unadmitted root effects must not reach SSH'); };
  try {
    const params = {
      taskId: 'forged-task',
      ssh: { target: 'root@example.test', auth: 'agent', trustedHostKey: hostKey, knownHostsPath: join(root, 'known_hosts') },
      relay: { relayUrl: 'https://home.example.test' },
      enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'none' },
    };
    await expect(createLiveRemoteSshBootstrapTaskKind().run({ params, emit() {}, prompt: async () => ({ trusted: true }) }))
      .rejects.toMatchObject({ code: 'managed_enrollment_unavailable' });
    const runner = createSystemTasksRunner({ kinds: { bootstrap: createLiveRemoteSshBootstrapTaskKind() } });
    const managedEnrollment = {
      homeId: 'foreign-home', managedId: 'synthetic-managed', requestId: 'foreign-request', expectedIntentRevision: 1,
      controller: { machineId: 'foreign-controller', installationId: 'foreign-installation' },
      resource: { contributionRef: { pluginId: 'test.vm', localId: 'vm' }, schemaVersion: 1, value: { id: 'foreign-guest' } },
    };
    await runner.start({ taskId: 'real-task', kind: 'bootstrap', params: { ...params, managedEnrollment } });
    expect(await runner.wait({ taskId: 'real-task' })).toMatchObject({ ok: false, error: { code: 'managed_enrollment_unavailable' } });
    expect(boundary.requests).toEqual([]);
    const desktop = await runDesktopTask({ ...params, knownHostsMode: 'system', managedEnrollment }, 'real-desktop-task');
    expect(desktop.result).toMatchObject({ ok: false, error: { code: 'managed_enrollment_unavailable' } });
    expect(boundary.requests).toEqual([]);
  } finally { boundary.run = null; await rm(root, { recursive: true, force: true }); }
});

it.each(['task', 'cli', 'hsetup', 'hsetup-ask'] as const)('uses admitted standalone %s authority for the same dedicated bootstrap before pairing', async entry => {
  const root = await mkdtemp(join(tmpdir(), 'happier-standalone-ssh-'));
  boundary.requests.length = 0;
  boundary.plans.length = 0;
  boundary.failure = null;
  try {
    const payload = join(root, 'payload');
    await mkdir(payload);
    await writeFile(join(payload, 'happier'), '#!/bin/sh\nexit 0\n');
    vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', payload);
    const homeTarget = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: 'srv_ssh_home',
      canonicalServerUrl: 'https://home.example.test', revision: 1,
      endpoints: [{ kind: 'https', url: 'https://home.example.test' }] }, authority: 'trusted_enrollment' });
    boundary.run = async request => {
      // The actual SSH boundary receives one POSIX-quoted bash -lc payload.
      const shellArgument = request.remoteCommand.at(-1)!;
      const command = shellArgument.slice(1, -1).replaceAll("'\"'\"'", "'");
      const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
      if (command.includes('effect-internal')) {
        const lines = String(request.input ?? '').trim().split('\n');
        const frame = MachineEffectInternalRequestSchema.parse(JSON.parse(lines[0]!));
        if (frame.mode === 'check') {
          if (!('basis' in frame) || !('steps' in frame)) throw new Error('Expected a bootstrap check');
          const plan = await machineSetup.checkMachineSetupEffectPlan({ basis: frame.basis, steps: frame.steps,
            backend: { observe: async (step): ReturnType<machineSetup.MachineSetupBackend['observe']> => step.id === 'bootstrap-administrator'
              ? { stepId: step.id, status: 'drifted', facts: { present: false } }
              : { stepId: step.id, status: 'satisfied', facts: step.kind === 'user'
                ? { present: true, username: step.username, uid: 1001 } : {} }, apply: async () => {} } });
          boundary.plans.push(plan);
          return ok(JSON.stringify({ type: 'result', result: { status: 'checked', plan } }) + '\n');
        }
        if (entry === 'hsetup-ask') {
          expect(JSON.parse(lines[1]!)).toMatchObject({ type: 'administrator.establish', operationId: 'standalone-task',
            username: 'operator', password: 'desktop-transient-password' });
          expect(command).not.toContain('desktop-transient-password');
        }
        if (!('plans' in frame)) throw new Error('Expected bootstrap plans');
        const result = await machineSetup.applyMachineSetupEffectPlans({ ...frame, daemonUsername: 'daemonUsername' in frame ? frame.daemonUsername ?? undefined : undefined,
          backend: { observe: async step => ({ stepId: step.id, status: 'satisfied', facts: {} }), apply: async () => {} } });
        return ok(JSON.stringify({ type: 'result', result }) + '\n');
      }
      if (command.includes('/etc/os-release')) return ok('ubuntu\nnoble\namd64\n');
      if (command === 'uname -s') return ok('Linux\n');
      if (command === 'id -u happier') return ok('1001\n');
      if (command.includes('"arch"')) return ok(JSON.stringify({ platform: 'linux', arch: 'x86_64' }));
      if (command.includes('mktemp -d /tmp/happier-bootstrap-upload.')) return ok('/tmp/happier-bootstrap-upload.test\n');
      if (command.includes('current_target##*/')) return ok('current=test\nprevious=\nversion=test\n');
      // Invalid remote auth output deliberately stops AFTER bootstrap, before
      // this bounded fixture would need a real Account pairing credential.
      if (command.includes('auth')) return ok('{}\n');
      return ok('{}\n');
    };
    const runner = createSystemTasksRunner({ kinds: { 'remote.ssh.bootstrapMachine.v1': createLiveRemoteSshBootstrapTaskKind() } });
    const taskId = 'standalone-task';
    let taskStarted = entry === 'task';
    if (entry === 'task') {
      const identity: Extract<ManagedMachineEnrollmentIdentityV1, { kind: 'dedicatedDaemonUser' }> = {
        kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'none',
      };
      await runner.start({ taskId, kind: 'remote.ssh.bootstrapMachine.v1', params: {
        ssh: { target: 'root@example.test', auth: 'agent', trustedHostKey: hostKey, knownHostsPath: join(root, 'known_hosts') },
        relay: { relayUrl: homeTarget.applicationUrl }, homeTarget,
        enrollmentIdentity: identity,
      } });
      // A caller cannot upgrade the already admitted task's role or policy.
      identity.role = 'deployTarget';
      identity.adminAccessAtCreation = 'preauthorized';
    } else if (entry === 'cli') {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk, callback) => {
        callback?.();
        return true;
      });
      await handleMachineCommand(['enroll', '--ssh', 'root@example.test', '--role', 'server', '--admin-access', 'none',
        '--known-hosts-path', join(root, 'known_hosts'), '--trusted-host-key', hostKey, '--yes', '--json'], {
        resolveHomeTarget: async () => homeTarget,
        readRelaySelection: () => ({ relayUrl: homeTarget.applicationUrl, webappUrl: homeTarget.webappUrl }),
        createRunner: () => ({ start: ({ spec }) => {
          taskStarted = true;
          return runner.start({ taskId, kind: spec.kind, params: spec.params });
        },
          poll: async input => {
            const snapshot = await runner.poll(input);
            return { ...snapshot, pendingPrompt: snapshot.pendingPrompt ? { kind: snapshot.pendingPrompt.kind,
              data: snapshot.pendingPrompt.data as SystemTaskJsonObject } : null };
          }, respond: async input => { await runner.respond(input); }, cancel: runner.cancel }),
        isInteractiveTerminal: () => false, sleep: async () => { await new Promise(resolve => setImmediate(resolve)); },
      });
    } else {
      const desktop = await runDesktopTask({
        taskId: 'forged-input-task',
        ssh: { target: 'root@example.test', auth: 'agent' }, knownHostsMode: 'system',
        relay: { relayUrl: homeTarget.applicationUrl }, homeTarget,
        enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server',
          ...(entry === 'hsetup-ask' ? { adminAccessAtCreation: 'ask', administrator: { username: 'operator' } } : { adminAccessAtCreation: 'none' }) },
      }, taskId, entry === 'hsetup-ask' ? [{ password: 'desktop-transient-password' }] : []);
      taskStarted = true;
      expect(desktop.result, boundary.failure ?? JSON.stringify(desktop.result)).toMatchObject({ ok: false, error: { code: 'invalid_cli_response' } });
      expect(desktop.exitCode).toBe(1);
      expect(desktop.stdout).not.toContain('desktop-transient-password');
    }
    expect(taskStarted, 'The CLI must admit the reviewed server identity through its existing task entry').toBe(true);
    if (entry === 'task' || entry === 'cli') {
      const result = await runner.wait({ taskId });
      expect(result, boundary.failure ?? JSON.stringify(result)).toMatchObject({ ok: false, error: { code: 'invalid_cli_response' } });
    }
    expect(boundary.plans).toHaveLength(1);
    expect(boundary.plans[0]).toMatchObject({ basis: { kind: 'sshBootstrap', operationId: taskId } });
    if (entry === 'hsetup-ask') expect(JSON.stringify(boundary.plans[0])).toContain(MANAGED_SUDOERS_PATH);
    else expect(JSON.stringify(boundary.plans[0])).not.toContain(MANAGED_SUDOERS_PATH);
    expect(JSON.stringify(boundary.plans[0])).not.toContain('docker-ce');
    const commands = boundary.requests.map(request => request.remoteCommand.join(' '));
    expect(commands.findIndex(command => command.includes('effect-internal'))).toBeLessThan(commands.findIndex(command => command.includes('auth')));
    expect(commands.find(command => command.includes('auth'))).toContain('runuser -u happier');
    expect(JSON.stringify(boundary.plans)).not.toContain('managedId');
  } finally { boundary.run = null; await rm(root, { recursive: true, force: true }); }
});
