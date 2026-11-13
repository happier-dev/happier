import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCliPayloadFixture } from '../../../../../../packages/cli-common/src/systemTasks/testkit/createCliPayloadFixture';
import { computeSshHostKeyFingerprint } from '@happier-dev/protocol/ssh/hostTrust';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { runManagedMachineEnrollment } from '@/machines/managed/enrollment';

type OpenSshFileTransferParams = Parameters<
  typeof import('@happier-dev/cli-common/ssh').transferOpenSshFile
>[0];

const {
  spawnSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  renameSync,
  unlinkSync,
  approveTerminalAuthRequest,
  lastOpenSshParams,
  openSshParamsCalls,
  transferOpenSshFile,
  localEnrollmentExecutor,
  enrollmentResponse,
  realTrustDirectories,
} = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  approveTerminalAuthRequest: vi.fn<(params: Parameters<typeof import('@/auth/terminalAuthApproval').approveTerminalAuthRequest>[0]) => Promise<void>>(async () => undefined),
  lastOpenSshParams: { current: null as null | Record<string, unknown> },
  openSshParamsCalls: [] as Array<Record<string, unknown>>,
  transferOpenSshFile: vi.fn<(params: OpenSshFileTransferParams) => Promise<void>>(async () => undefined),
  localEnrollmentExecutor: { current: null as null | {
    runHappierText: (args: readonly string[], opts?: Readonly<{ onStdoutChunk?: (text: string) => void }>) => Promise<Readonly<{ status: number; stdout: string; stderr: string }>>;
  } },
  enrollmentResponse: { current: null as null | { status: number; stdout: string; stderr: string } },
  realTrustDirectories: new Set<string>(),
}));

const { isLoopbackPortAvailable, findAvailableLoopbackPort } = vi.hoisted(() => ({
  isLoopbackPortAvailable: vi.fn<(port: number) => Promise<boolean>>(),
  findAvailableLoopbackPort: vi.fn<(requestedPort: number) => Promise<number>>(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    // macOS temp-directory ownership probes the real local process via ps.
    spawnSync: (...args: Parameters<typeof actual.spawnSync>) => args[0] === 'ps'
      ? actual.spawnSync(...args)
      : spawnSync(...args),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  // Only the simulated SSH trust store is external here; payload/temp files stay real.
  const isTrustPath = (path: unknown) => ![...realTrustDirectories].some(root => String(path).startsWith(root))
    && (String(path).includes('known_hosts') || String(path).startsWith('/mock-home'));
  return {
    ...actual,
    mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => isTrustPath(args[0]) ? mkdirSync(...args) : actual.mkdirSync(...args),
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => isTrustPath(args[0]) ? readFileSync(...args) : actual.readFileSync(...args),
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => isTrustPath(args[0]) ? writeFileSync(...args) : actual.writeFileSync(...args),
    chmodSync: (...args: Parameters<typeof actual.chmodSync>) => isTrustPath(args[0]) ? chmodSync(...args) : actual.chmodSync(...args),
    renameSync: (...args: Parameters<typeof actual.renameSync>) => isTrustPath(args[0]) ? renameSync(...args) : actual.renameSync(...args),
    unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => isTrustPath(args[0]) ? unlinkSync(...args) : actual.unlinkSync(...args),
  };
});

vi.mock('@happier-dev/cli-common/ssh', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/ssh')>();
  return {
    ...actual,
    runOpenSshRemoteCommand: async (params: Parameters<typeof actual.runOpenSshRemoteCommand>[0]) => {
      lastOpenSshParams.current = params as unknown as Record<string, unknown>;
      openSshParamsCalls.push(params as unknown as Record<string, unknown>);
      const remoteCommand = params.remoteCommand.join(' ');
      if (remoteCommand.includes('current_target##*/') && remoteCommand.includes('version_path##*/')) {
        return { status: 0, stdout: 'current=test-version\nprevious=\nversion=test-version\n', stderr: '' };
      }
      if (String(params.remoteCommand).includes('enroll-remote')) {
        if (enrollmentResponse.current) {
          const response = enrollmentResponse.current;
          params.onStdoutChunk?.(response.stdout);
          params.signal?.throwIfAborted();
          if (response.status !== 0 && params.rejectOnNonZero !== false) throw new Error('SSH command failed');
          return response;
        }
        const input = JSON.parse(String(params.input ?? '{}')) as { descriptor?: { homeServerIdentityId?: string } };
        const homeServerIdentityId = input.descriptor?.homeServerIdentityId ?? 'srv_live_remote_bootstrap';
        remoteEnrollmentCompleted = true;
        const stdout = `${JSON.stringify({
          kind: 'remote_home_enrollment_pairing_request',
          protocolVersion: 1,
          publicKey: REMOTE_PUBLIC_KEY,
          homeServerIdentityId,
          pairing: REMOTE_REQUEST_PAIRING,
          supportsTokenOnly: true,
          pairingRequirement: 'v3',
        })}\n${JSON.stringify({
          kind: 'remote_home_enrollment_result',
          protocolVersion: 1,
          success: true,
          homeServerIdentityId,
          machineId: 'machine-1',
          encryptionType: 'tokenOnly',
          pairingAuthentication: 'v3',
          remoteProfileId: 'remote-home-profile',
        })}\n`;
        params.onStdoutChunk?.(stdout);
        return { status: 0, stdout, stderr: '' };
      }
      const invocation = actual.buildOpenSshCommand({
        sshBin: params.sshBin ?? 'ssh',
        target: params.target,
        remoteCommand: params.remoteCommand,
        sshConfigFile: params.sshConfigFile,
        knownHostsPath: params.knownHostsPath,
        knownHostsMode: params.knownHostsMode,
        auth: params.auth,
        port: params.port,
        connectTimeoutSec: params.connectTimeoutSec,
        serverAliveIntervalSec: params.serverAliveIntervalSec,
        serverAliveCountMax: params.serverAliveCountMax,
      });
      const result = spawnSync(invocation.command, invocation.args, {
        encoding: 'utf8',
        ...(invocation.env ? { env: invocation.env } : {}),
      }) as { status?: number | null; stdout?: string; stderr?: string; error?: Error };
      if (result.error) throw result.error;
      const status = result.status ?? 1;
      const stdout = String(result.stdout ?? '');
      const stderr = String(result.stderr ?? '');
      params.onStdoutChunk?.(stdout);
      if (status !== 0 && params.rejectOnNonZero !== false) throw new Error(stderr || stdout || 'SSH command failed');
      return { status, stdout, stderr };
    },
    transferOpenSshFile,
  };
});

vi.mock('@/auth/terminalAuthApproval', () => ({
  approveTerminalAuthRequest,
}));

vi.mock('@/configuration', () => ({
  configuration: {
    happyHomeDir: '/mock-home',
    settingsFile: '/mock-home/settings.json',
    serversDir: '/mock-home/servers',
  },
}));

vi.mock('@/cloud/loopbackPort', () => ({
  isLoopbackPortAvailable,
  findAvailableLoopbackPort,
}));

vi.mock('@happier-dev/cli-common/systemTasks', async () => {
  const actual = await vi.importActual<typeof import('@happier-dev/cli-common/systemTasks')>(
    '@happier-dev/cli-common/systemTasks',
  );
  return {
    ...actual,
    createLocalHappierJsonExecutor: () => localEnrollmentExecutor.current ?? actual.createLocalHappierJsonExecutor(),
  };
});

import { createLiveRemoteEnrollmentExecutor, createLiveRemoteSshBootstrapTaskKind, createLiveRemoteSshManageHostTaskKind } from './liveRemoteSshBootstrap';
import { createServer } from 'node:http';
import { encodeHomeQrInviteV2Payload, type HomeQrInviteV2 } from '@happier-dev/protocol';
import { createSystemTasksRunner, parseSshKnownHostLine, runRemoteHomeEnrollmentFlow } from '@happier-dev/cli-common/systemTasks';
import { SystemTaskResultSchema } from '@happier-dev/protocol/system/tasks/spec';

function jsonResult(data: Record<string, unknown>) {
  return {
    status: 0,
    stdout: `${JSON.stringify(data)}\n`,
    stderr: '',
  };
}

const REMOTE_PUBLIC_KEY = Buffer.alloc(32, 1).toString('base64');
const REMOTE_REQUEST_PAIRING = {
  secretB64Url: Buffer.alloc(32, 2).toString('base64url'),
  createdAtMs: 123,
  expiresAtMs: 456,
};
let remoteEnrollmentCompleted = false;

	const TRUSTED_HOST_KEY = 'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
	const MISMATCHED_TRUSTED_HOST_KEY = 'example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
	const BRACKETED_PORT_HOST_KEY = '[127.0.0.1]:54470 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
	const UNBRACKETED_PORT_KEYSCAN_OUTPUT = '127.0.0.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

describe('createLiveRemoteSshBootstrapTaskKind', () => {
  let payloadFixture: Awaited<ReturnType<typeof createCliPayloadFixture>>;
  beforeAll(async () => { payloadFixture = await createCliPayloadFixture(); });
  afterAll(async () => { await payloadFixture?.cleanup(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('merges overlapping task trust approvals into the current real known_hosts file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-ssh-trust-test-'));
    realTrustDirectories.add(root);
    const knownHostsPath = join(root, 'known_hosts');
    const unrelatedKey = TRUSTED_HOST_KEY.replace('example.test', 'retained.test');
    await writeFile(knownHostsPath, `${unrelatedKey}\r\n`, 'utf8');
    spawnSync.mockImplementation((command: string, args: readonly string[] = []) => command === 'ssh-keyscan'
      ? { status: 0, stdout: `${TRUSTED_HOST_KEY.replace('example.test', args.at(-1)!)}\n`, stderr: '' }
      : { status: 1, stdout: '', stderr: 'Installation stops at the OS boundary' });
    const runner = createSystemTasksRunner({ kinds: { bootstrap: createLiveRemoteSshBootstrapTaskKind() } });
    const ids = ['overlap-a', 'overlap-b'];
    try {
      await Promise.all(ids.map((taskId, index) => runner.start({ taskId, kind: 'bootstrap', params: {
        ssh: { target: `dev@host-${index}.test`, auth: 'agent', knownHostsPath },
        relay: { relayUrl: 'https://relay.example.test' }, serviceMode: 'none',
      } })));
      for (const taskId of ids) await vi.waitFor(async () => {
        expect((await runner.poll({ taskId, cursor: 0 })).pendingPrompt?.kind).toBe('ssh.trustHost');
      });
      for (const taskId of ids) {
        await runner.respond({ taskId, answer: { trusted: true } });
        expect(SystemTaskResultSchema.parse(await runner.wait({ taskId }))).toMatchObject({
          ok: false, error: { code: 'ssh_command_failed' },
        });
      }
      const persisted = await readFile(knownHostsPath, 'utf8');
      expect(persisted).toContain(unrelatedKey);
      expect(persisted).toContain(TRUSTED_HOST_KEY.replace('example.test', 'host-0.test'));
      expect(persisted).toContain(TRUSTED_HOST_KEY.replace('example.test', 'host-1.test'));
    } finally {
      await Promise.all(ids.map(taskId => runner.cancel({ taskId })));
      await Promise.all(ids.map(taskId => runner.wait({ taskId })));
      realTrustDirectories.delete(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps explicit replacement consent and merges unrelated entries added while the prompt was open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-ssh-trust-test-'));
    realTrustDirectories.add(root);
    const knownHostsPath = join(root, 'known_hosts');
    const original = MISMATCHED_TRUSTED_HOST_KEY.replace('example.test', 'example.test,127.0.0.1');
    await writeFile(knownHostsPath, `${original}\r\n`, 'utf8');
    const unrelated = TRUSTED_HOST_KEY.replace('example.test', 'other.test');
    const scanner = spawnSync.getMockImplementation()!;
    spawnSync.mockImplementation((command: string, args: readonly string[] = []) => command === 'ssh-keyscan'
      ? scanner(command, args)
      : { status: 1, stdout: '', stderr: 'Installation stops at the OS boundary' });
    const runner = createSystemTasksRunner({ kinds: { bootstrap: createLiveRemoteSshBootstrapTaskKind() } });
    const taskId = 'replace-current-trust';
    try {
      await runner.start({ taskId, kind: 'bootstrap', params: {
        ssh: { target: 'dev@example.test', auth: 'agent', knownHostsPath },
        relay: { relayUrl: 'https://relay.example.test' }, serviceMode: 'none',
      } });
      await vi.waitFor(async () => {
        expect((await runner.poll({ taskId, cursor: 0 })).pendingPrompt?.kind).toBe('ssh.replaceHostKey');
      });
      await writeFile(knownHostsPath, `${original}\r\n${unrelated}\r\n`, 'utf8');
      await runner.respond({ taskId, answer: { trusted: true } });
      expect(SystemTaskResultSchema.parse(await runner.wait({ taskId }))).toMatchObject({
        ok: false, error: { code: 'ssh_command_failed' },
      });
      const persisted = await readFile(knownHostsPath, 'utf8');
      expect(persisted).toContain(TRUSTED_HOST_KEY.replace('example.test', 'example.test,127.0.0.1'));
      expect(persisted).toContain(unrelated);
      expect(persisted).not.toContain(MISMATCHED_TRUSTED_HOST_KEY.split(' ').at(-1));
    } finally {
      await runner.cancel({ taskId });
      await runner.wait({ taskId });
      realTrustDirectories.delete(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['new host', 'replacement', 'replacement with an appended conflicting key'] as const)('refuses a stale %s approval after saved trust changes', async initial => {
    const root = await mkdtemp(join(tmpdir(), 'happier-ssh-trust-test-'));
    realTrustDirectories.add(root);
    const knownHostsPath = join(root, 'known_hosts');
    const changedKey = TRUSTED_HOST_KEY.replace(/BBBBB/gu, 'DDDDD');
    if (initial !== 'new host') await writeFile(knownHostsPath, `${MISMATCHED_TRUSTED_HOST_KEY}\n`, 'utf8');
    const runner = createSystemTasksRunner({ kinds: { bootstrap: createLiveRemoteSshBootstrapTaskKind() } });
    const taskId = 'stale-trust';
    try {
      await runner.start({ taskId, kind: 'bootstrap', params: {
        ssh: { target: 'dev@example.test', auth: 'agent', knownHostsPath },
        relay: { relayUrl: 'https://relay.example.test' }, serviceMode: 'none',
      } });
      await vi.waitFor(async () => {
        expect((await runner.poll({ taskId, cursor: 0 })).pendingPrompt?.kind)
          .toBe(initial === 'new host' ? 'ssh.trustHost' : 'ssh.replaceHostKey');
      });
      const currentText = `${initial === 'replacement with an appended conflicting key' ? `${MISMATCHED_TRUSTED_HOST_KEY}\n` : ''}${changedKey}\n`;
      await writeFile(knownHostsPath, currentText, 'utf8');
      await runner.respond({ taskId, answer: { trusted: true } });
      expect(SystemTaskResultSchema.parse(await runner.wait({ taskId }))).toMatchObject({
        ok: false, error: { code: 'trusted_host_key_mismatch' },
      });
      expect(await readFile(knownHostsPath, 'utf8')).toBe(currentText);
      expect(transferOpenSshFile).not.toHaveBeenCalled();
    } finally {
      await runner.cancel({ taskId });
      await runner.wait({ taskId });
      realTrustDirectories.delete(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs dedicated SSH enrollment against the same public managed payload as the non-root daemon rather than inheriting the SSH login', async () => {
    const params = { ssh: { target: 'bootstrap@example.test', auth: 'agent' as const }, auth: { mode: 'agent' as const },
      knownHostsMode: 'system' as const, channel: 'preview' as const,
      enrollmentIdentity: { kind: 'dedicatedDaemonUser' as const, username: 'happier' as const, serviceMode: 'user' as const,
        role: 'deployTarget' as const, adminAccessAtCreation: 'preauthorized' as const } };
    await createLiveRemoteEnrollmentExecutor(params).runHappierText(['auth', 'status', '--json']);
    const command = String(lastOpenSshParams.current?.remoteCommand);
    expect(command).toContain('runuser -u happier');
    expect(command).toContain('/opt/happier/cli-preview/current/happier');
    expect(command).toContain('env -i');
    expect(command).not.toContain('$HOME/.happier/cli');
  });

  it.each(['unreachable', 'empty', 'missing-tool'] as const)('settles a %s host-key scan with a typed failure before installation', async failure => {
    spawnSync.mockImplementation((command: string) => {
      if (command !== 'ssh-keyscan') throw new Error('No guest command may run without host trust');
      return { status: failure === 'empty' ? 0 : 1, stdout: '', stderr: 'private native diagnostic',
        ...(failure === 'missing-tool' ? { error: new Error('private tool path') } : {}) };
    });
    const prompt = vi.fn(async () => ({ trusted: true }));
    await expect(createLiveRemoteSshBootstrapTaskKind().run({
      params: { ssh: { target: 'dev@example.test', auth: 'agent' },
        relay: { relayUrl: 'https://relay.example.test' }, serviceMode: 'none' }, emit: () => undefined, prompt,
    })).rejects.toMatchObject({ code: 'native_ssh_host_key_unavailable' });
    expect(prompt).not.toHaveBeenCalled();
    expect(transferOpenSshFile).not.toHaveBeenCalled();
  });

  it('does not treat provider host-key evidence as permission to replace saved trust', async () => {
    readFileSync.mockReturnValue(`${MISMATCHED_TRUSTED_HOST_KEY}\n`);
    const prompt = vi.fn(async (request: Readonly<{ kind: string }>) => {
      expect(request.kind).toBe('ssh.replaceHostKey');
      return { trusted: false };
    });
    await expect(createLiveRemoteSshBootstrapTaskKind().run({
      params: {
        ssh: { target: 'dev@example.test', auth: 'agent', hostKeyEvidence: {
          hostKey: TRUSTED_HOST_KEY, fingerprint: parseSshKnownHostLine(TRUSTED_HOST_KEY)!.fingerprint,
        } },
        relay: { relayUrl: 'https://relay.example.test' }, serviceMode: 'none',
      }, emit: () => undefined, prompt,
    })).rejects.toMatchObject({ code: 'host_trust_declined' });
    expect(prompt).toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(transferOpenSshFile).not.toHaveBeenCalled();
  });

  it('refuses provider host-key evidence that does not match the fresh scan', async () => {
    const prompt = vi.fn(async () => ({ trusted: true }));
    await expect(createLiveRemoteSshBootstrapTaskKind().run({
      params: {
        ssh: { target: 'dev@example.test', auth: 'agent', hostKeyEvidence: {
          hostKey: MISMATCHED_TRUSTED_HOST_KEY, fingerprint: parseSshKnownHostLine(MISMATCHED_TRUSTED_HOST_KEY)!.fingerprint,
        } },
        relay: { relayUrl: 'https://relay.example.test' }, serviceMode: 'none',
      }, emit: () => undefined, prompt,
    })).rejects.toMatchObject({ code: 'host_key_evidence_mismatch' });
    expect(prompt).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(transferOpenSshFile).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Payload acquisition is an environment/filesystem boundary; keep the installer real.
    vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', payloadFixture.payloadRoot);
    vi.stubEnv('HAPPIER_TOKEN', `hap_v1_123e4567-e89b-42d3-a456-426614174000_${'A'.repeat(43)}`);
    const createdAtMs = Date.now();
    REMOTE_REQUEST_PAIRING.createdAtMs = createdAtMs;
    REMOTE_REQUEST_PAIRING.expiresAtMs = createdAtMs + 60_000;
    lastOpenSshParams.current = null;
    openSshParamsCalls.length = 0;
    transferOpenSshFile.mockImplementation(async () => undefined);
    localEnrollmentExecutor.current = null;
    remoteEnrollmentCompleted = false;
    enrollmentResponse.current = null;
    isLoopbackPortAvailable.mockResolvedValue(true);
    findAvailableLoopbackPort.mockImplementation(async (requestedPort: number) => requestedPort + 1);
    readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('missing known_hosts'), { code: 'ENOENT' });
    });
    writeFileSync.mockReturnValue(undefined);
    mkdirSync.mockReturnValue(undefined);
    spawnSync.mockImplementation((command: string, args: readonly string[] = []) => {
      if (command === 'ssh' && args.includes('-G')) {
        expect(args).toContain('-F');
        expect(args).toContain('/tmp/lima-ssh.config');
        expect(args).toContain('lima-happier-wsrepl-qa-local');
        return {
          status: 0,
          stdout: [
            'hostname 127.0.0.1',
            'port 50977',
            'user leeroy',
          ].join('\n'),
          stderr: '',
        };
      }
      if (command === 'ssh-keyscan') {
        return {
          status: 0,
          stdout: `${TRUSTED_HOST_KEY}\n`,
          stderr: '',
        };
      }
      if (command === 'scp') {
        return {
          status: 0,
          stdout: '',
          stderr: '',
        };
      }
      if (command !== 'ssh') {
        throw new Error(`Unexpected command: ${command}`);
      }
      const remoteCommand = String(args.at(-1) ?? '');
      if (remoteCommand.includes('$PATH') && remoteCommand.includes('printf')) {
        return {
          status: 0,
          stdout: '/usr/local/bin:/usr/bin:/bin\n',
          stderr: '',
        };
      }
      if (remoteCommand.includes('exit 0') && remoteCommand.includes('echo ""')) {
        return {
          status: 0,
          stdout: '\n',
          stderr: '',
        };
      }
      if (remoteCommand.includes('echo yes') && (remoteCommand.includes('[ -d ') || remoteCommand.includes('[ -f '))) {
        return {
          status: 0,
          stdout: 'yes\n',
          stderr: '',
        };
      }
      if (remoteCommand.includes('homeDir')) {
        return jsonResult({
          platform: 'linux',
          arch: 'x86_64',
          homeDir: '/home/leeroy',
        });
      }
      if (remoteCommand.includes('prismaEnginePath')) {
        return jsonResult({
          hasNodeModules: true,
          prismaEnginePath: '/home/leeroy/.happier/server/current/node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node',
        });
      }
      if (remoteCommand.includes('"arch"')) {
        return jsonResult({
          platform: 'linux',
          arch: 'x86_64',
        });
      }
      if (remoteCommand.includes('auth status --json')) {
        return jsonResult({
          v: 1,
          ok: true,
          kind: 'auth_status',
          data: {
            authenticated: remoteEnrollmentCompleted,
            credentialState: remoteEnrollmentCompleted ? 'valid' : 'missing',
            machineRegistrationState: remoteEnrollmentCompleted ? 'server-confirmed' : 'no-local-id',
            machineId: remoteEnrollmentCompleted ? 'machine-1' : null,
          },
        });
      }
      if (remoteCommand.includes('daemon status --json')) {
        return jsonResult({
          server: { activeServerId: 'remote-home-profile' },
          service: { installed: true },
          daemon: { running: true },
          auth: { needsAuth: false, machineId: 'machine-1' },
        });
      }
	      if (remoteCommand.includes('server set')) {
	        expect(remoteCommand).not.toContain('--public-server-url');
	        return jsonResult({
	          ok: true,
	          data: {},
	        });
	      }
      if (remoteCommand.includes('relay host install')) {
        return jsonResult({
          ok: true,
          kind: 'relay_host_install',
          data: {
            relayUrl: 'http://127.0.0.1:4001',
            mode: 'user',
          },
        });
      }
      return jsonResult({
        ok: true,
        data: {},
      });
    });
  });

  it.each([
    { platform: 'darwin', command: 'start', status: 1, stdout: JSON.stringify({ ok: false, error: 'service_start_timeout', serviceStep: 'bootstrap', serviceStepStatus: 'deadline_elapsed', message: 'private-launchd-output' }), stderr: '', guestCliCode: 'service_start_timeout', serviceStep: 'bootstrap' },
    { platform: 'darwin', command: 'start', status: 1, stdout: '', stderr: JSON.stringify({ ok: false, error: 'service_ownership_failed', serviceStep: 'wait', serviceStepStatus: 'failed', reason: 'launchd_exited', message: 'private-launchd-output' }), guestCliCode: 'service_ownership_failed', serviceStep: 'wait' },
    { platform: 'linux', command: 'start', status: 1, stdout: JSON.stringify({ ok: false, error: 'not_installed', message: 'private-service-path' }), stderr: '', guestCliCode: 'not_installed' },
    { platform: 'darwin', command: 'start', status: 1, stdout: JSON.stringify({ ok: false, error: 'private-secret', serviceStep: 'bootstrap', serviceStepStatus: 'failed' }), stderr: '' },
    { platform: 'darwin', command: 'start', status: 1, stdout: JSON.stringify({ ok: false, error: { code: 'service_start_timeout' }, serviceStep: 'bootstrap', serviceStepStatus: 'failed' }), stderr: '' },
    { platform: 'darwin', command: 'install', status: 1, stdout: '', stderr: 'private-launchd-output' },
    { platform: 'darwin', command: 'start', status: 1, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error\nprivate-launchd-output', reason: 'launchctl_io_error' },
    { platform: 'darwin', command: 'start', status: 1, stdout: '', stderr: 'Bootstrap failed: 125: Domain does not support specified action\nprivate-launchd-output', reason: 'launchctl_domain_unsupported' },
    { platform: 'darwin', command: 'start', status: 1, stdout: '', stderr: 'Could not find service "private-label" in domain for user gui: 501', reason: 'launchctl_service_missing' },
    { platform: 'darwin', command: 'start', status: 1, stdout: '', stderr: 'Bootstrap failed: 6: Device not configured' },
    { platform: 'darwin', command: 'start', status: 1, stdout: '', stderr: 'private-prefix Bootstrap failed: 5: Input/output error' },
    { platform: 'darwin', command: 'start', status: 3, stdout: '{"private":"guest-secret"}', stderr: '' },
    { platform: 'linux', command: 'install', status: 255, stdout: 'private-command-output', stderr: 'private-ssh-output' },
    { platform: 'darwin', command: 'install', status: 0, stdout: '', stderr: '', errorCode: 'ssh_invalid_response' },
    { platform: 'linux', command: 'start', status: 1, stdout: '', stderr: '', throws: true },
  ])('retains the closed post-registration $platform service $command failure in the task result', async scenario => {
    const previousImplementation = spawnSync.getMockImplementation()!;
    let failedCommands = 0;
    const guestCommands: string[] = [];
    spawnSync.mockImplementation((command: string, args: readonly string[] = []) => {
      const remoteCommand = String(args.at(-1) ?? '');
      if (command === 'ssh') {
        guestCommands.push(remoteCommand);
        if (remoteCommand.includes('"arch"')) return jsonResult({ platform: scenario.platform, arch: 'arm64' });
        if (remoteCommand.includes(`service ${scenario.command} `)) {
          expect(remoteEnrollmentCompleted).toBe(true);
          failedCommands += 1;
          if ('throws' in scenario) throw new Error('private process launch error');
          return scenario;
        }
      }
      return previousImplementation(command, args);
    });
    const kind = createLiveRemoteSshBootstrapTaskKind();
    const runner = createSystemTasksRunner({ kinds: { bootstrap: { run: ctx => kind.run({ ...ctx,
      prompt: async request => {
        expect(request.kind).toBe('auth.approveRemoteProvisioning');
        return { approved: true };
      },
    }) } } });
    const task = await runner.start({ taskId: 'post-registration', kind: 'bootstrap', params: {
      ssh: { target: 'person@example.test', auth: 'agent', trustedHostKey: TRUSTED_HOST_KEY },
      relay: { relayUrl: 'https://relay.example.test' }, knownHostsMode: 'system', serviceMode: 'user',
      enrollmentIdentity: { kind: 'existingUser', role: 'personal' },
    } });
    const result = SystemTaskResultSchema.parse(await runner.wait(task));
    expect(result).toMatchObject({ ok: false, error: { code: 'errorCode' in scenario ? scenario.errorCode : 'ssh_command_failed' } });
    if (result.ok) throw new Error('Expected service failure');
    expect(result.error.message).toContain(`phase daemon.service.${scenario.command}`);
    expect(result.error.message).toContain(`exitStatus ${'throws' in scenario ? 'unknown' : scenario.status}`);
    expect(result.error.message).toContain(`stdoutPresent ${'throws' in scenario ? 'unknown' : Boolean(scenario.stdout)}`);
    expect(result.error.message).toContain(`stderrPresent ${'throws' in scenario ? 'unknown' : Boolean(scenario.stderr)}`);
    if ('reason' in scenario) expect(result.error.message).toContain(`reason ${scenario.reason}`);
    else expect(result.error.message).not.toContain('; reason ');
    if ('guestCliCode' in scenario) {
      expect(result.error.message).toContain(`guestCliCode ${scenario.guestCliCode}`);
      if ('serviceStep' in scenario) expect(result.error.message).toContain(`serviceStep ${scenario.serviceStep}`);
    } else expect(result.error.message).not.toContain('guestCliCode');
    expect(JSON.stringify(result)).not.toMatch(/private-|guest-secret|person@example/);
    expect(failedCommands).toBe(1); // Terminal command failures must not re-poll or retry the effect.
    expect(guestCommands.join('\n')).not.toMatch(/useradd|runuser|sudoers|bootstrap-effects/);
  });

  it('returns the released unsupported enrollment command as update-required through the live SSH executor and recipe', async () => {
    enrollmentResponse.current = JSON.parse(await readFile(new URL(
      '../../../../../../packages/cli-common/src/systemTasks/flows/fixtures/authEnrollRemote.cli-v0.2.16.json', import.meta.url,
    ), 'utf8'));
    const approvePairingRequest = vi.fn(async () => {});
    const error = await runRemoteHomeEnrollmentFlow({
      executor: createLiveRemoteEnrollmentExecutor({ ssh: { target: 'example.test', auth: 'agent' },
        auth: { mode: 'agent' }, knownHostsMode: 'system' }),
      homeTargetInput: { kind: 'https_url', url: 'https://home.example.test' },
      approvePairingRequest,
    }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'remote_cli_update_required' });
    expect(approvePairingRequest).not.toHaveBeenCalled();
    expect(openSshParamsCalls).toHaveLength(1);
    expect(lastOpenSshParams.current).toMatchObject({ rejectOnNonZero: false, includeStdoutInError: false });
    expect(String(lastOpenSshParams.current?.remoteCommand)).toContain('enroll-remote');
    expect(String(error)).not.toContain('Authentication management');
    expect(JSON.stringify(error)).not.toContain('Authentication management');
  });

  it('forwards the manage-host task AbortSignal to the canonical OpenSSH connection test', async () => {
    const controller = new AbortController();

    await createLiveRemoteSshManageHostTaskKind().run({
      params: {
        action: 'testConnection',
        ssh: { target: 'example.test', auth: 'agent', trustedHostKey: TRUSTED_HOST_KEY },
      },
      signal: controller.signal,
      emit: () => undefined,
      prompt: async () => {
        throw new Error('unexpected prompt');
      },
    });

    expect(lastOpenSshParams.current?.signal).toBe(controller.signal);
  });

  it('delivers remote Home erase approval over bounded stdin and parses the canonical task result', async () => {
    const controller = new AbortController();
    const defaultSpawn = spawnSync.getMockImplementation();
    spawnSync.mockImplementation((command: string, args: readonly string[] = [], options?: unknown) => {
      const remoteCommand = String(args.at(-1) ?? '');
      const taskResult = (data: Record<string, unknown>) => jsonResult({
        kind: 'personal_home_task_result',
        protocolVersion: 1,
        result: { protocolVersion: 1, ok: true, taskId: 'remote-home-task', data },
      });
      if (command === 'ssh' && remoteCommand.includes('happier') && remoteCommand.includes('status')) {
        return taskResult({
          purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
          identity: { homeServerIdentityId: 'srv_remote_home' },
          storage: { ownedErasePaths: ['/var/lib/happier-home'], estimatedOwnedBytes: 4096 },
        });
      }
      if (command === 'ssh' && remoteCommand.includes('happier') && remoteCommand.includes('erase')) {
        return taskResult({ outcome: 'completed', removedPaths: ['/var/lib/happier-home'] });
      }
      return defaultSpawn?.(command, args, options) as ReturnType<typeof spawnSync>;
    });

    const kind = createLiveRemoteSshManageHostTaskKind();
    const result = await kind.run({
      params: {
        action: 'personalHome.erase',
        channel: 'preview',
        relayRuntime: { channel: 'preview', mode: 'system' },
        ssh: { target: 'example.test', auth: 'agent', trustedHostKey: TRUSTED_HOST_KEY },
      },
      signal: controller.signal,
      emit: () => undefined,
      prompt: async (request) => {
        expect(request).toMatchObject({
          kind: 'personal_home.confirm_remote_erase.v1',
          data: {
            sshHost: 'example.test',
            homeServerIdentityId: 'srv_remote_home',
            paths: ['/var/lib/happier-home'],
            estimatedBytes: 4096,
          },
        });
        return { confirmed: true };
      },
    });

    expect(result).toMatchObject({ action: 'personalHome.erase', personalHome: { outcome: 'completed' } });
    expect(lastOpenSshParams.current?.input).toBe(`${JSON.stringify({
      v: 1,
      operation: 'erase',
      canonicalServerUrl: 'http://127.0.0.1:43123',
      homeServerIdentityId: 'srv_remote_home',
      paths: ['/var/lib/happier-home'],
      estimatedBytes: 4096,
      confirmed: true,
    })}\n`);
    expect(String(lastOpenSshParams.current?.remoteCommand)).not.toContain('srv_remote_home');
    expect(String(lastOpenSshParams.current?.remoteCommand)).not.toContain('4096');
    expect(lastOpenSshParams.current?.signal).toBeUndefined();
    expect(lastOpenSshParams.current?.timeoutMs).toBeNull();
    const inspectionTimeouts = openSshParamsCalls.map((call) => call.timeoutMs);
    expect(inspectionTimeouts).toContain(15 * 60_000);
  });

  it('downloads a remote Home backup without overwriting an existing local archive', async () => {
    const defaultSpawn = spawnSync.getMockImplementation();
    spawnSync.mockImplementation((command: string, args: readonly string[] = [], options?: unknown) => {
      const remoteCommand = String(args.at(-1) ?? '');
      if (command === 'ssh' && remoteCommand.includes('happier') && remoteCommand.includes('backup')) {
        return jsonResult({
          kind: 'personal_home_task_result',
          protocolVersion: 1,
          result: {
            protocolVersion: 1,
            ok: true,
            taskId: 'remote-home-backup',
            data: {
              path: '/srv/home/backups/home.tar',
              sha256: 'abc',
              archiveBytes: 12,
              manifest: { format: 'happier-personal-home-backup', version: 1, homeServerIdentityId: 'srv_remote_home' },
            },
          },
        });
      }
      return defaultSpawn?.(command, args, options) as ReturnType<typeof spawnSync>;
    });
    transferOpenSshFile.mockImplementation(async (params) => {
      if (params.direction === 'download') await writeFile(params.localPath, 'new archive', 'utf8');
    });
    const directory = await mkdtemp(join(tmpdir(), 'happier-home-download-'));
    const outputPath = join(directory, 'home.tar');
    await writeFile(outputPath, 'existing archive', 'utf8');

    try {
      const kind = createLiveRemoteSshManageHostTaskKind();
      await expect(kind.run({
        params: {
          action: 'personalHome.backup',
          channel: 'preview',
          relayRuntime: { channel: 'preview', mode: 'system' },
          personalHomeOperation: { outputPath },
          ssh: { target: 'example.test', auth: 'agent', trustedHostKey: TRUSTED_HOST_KEY },
        },
        emit: () => undefined,
        prompt: async () => ({}),
      })).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await readFile(outputPath, 'utf8')).toBe('existing archive');
      expect(transferOpenSshFile).toHaveBeenCalledWith(expect.objectContaining({
        direction: 'download',
        remotePath: '/srv/home/backups/home.tar',
      }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('renders a strict remote Home invite as a local QR and preserves an expired optional outcome', async () => {
    const descriptor = {
      v: 1 as const,
      homeServerIdentityId: 'srv_remote_home',
      canonicalServerUrl: 'http://127.0.0.1:43123',
      revision: 1,
      endpoints: [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
    };
    const invite: HomeQrInviteV2 = {
      v: 2,
      intent: 'home_device',
      direction: 'trusted_home_displays',
      pairId: 'remote-home-pair',
      home: descriptor,
      qrSecretBase64Url: Buffer.alloc(32, 7).toString('base64url'),
      issuedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    };
    const link = `happier:///pair?v=2&payload=${encodeURIComponent(encodeHomeQrInviteV2Payload(invite))}`;
    const defaultSpawn = spawnSync.getMockImplementation();
    spawnSync.mockImplementation((command: string, args: readonly string[] = [], options?: unknown) => {
      const remoteCommand = String(args.at(-1) ?? '');
      if (command === 'ssh' && remoteCommand.includes('home') && remoteCommand.includes('create')) {
        return jsonResult({
          v: 1,
          ok: true,
          kind: 'personal_home_create',
          data: {
            status: 'complete',
            profileId: 'remote-home',
            homeServerIdentityId: descriptor.homeServerIdentityId,
            canonicalServerUrl: descriptor.canonicalServerUrl,
            accountCreated: true,
            channel: 'preview',
            mode: 'system',
            descriptor,
            accountServiceLink: { kind: 'not_requested' },
          },
        });
      }
      if (command === 'ssh' && remoteCommand.includes('pair-device')) {
        return {
          status: 0,
          stdout: [
            JSON.stringify({ v: 1, kind: 'home_pair_device.invite', link }),
            JSON.stringify({ v: 1, kind: 'home_pair_device.result', result: { kind: 'expired' } }),
            '',
          ].join('\n'),
          stderr: '',
        };
      }
      return defaultSpawn?.(command, args, options) as ReturnType<typeof spawnSync>;
    });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await createLiveRemoteSshManageHostTaskKind().run({
      params: {
        action: 'personalHome.create',
        channel: 'preview',
        relayRuntime: { channel: 'preview', mode: 'system' },
        pairDevice: true,
        ssh: { target: 'example.test', auth: 'agent', trustedHostKey: TRUSTED_HOST_KEY },
      },
      emit: () => undefined,
      prompt: async () => ({}),
    });

    expect(result).toMatchObject({
      action: 'personalHome.create',
      personalHome: { status: 'complete', pairing: { kind: 'expired' } },
    });
    expect(output.mock.calls[0]?.[0]).toBe('Scan this QR code with the phone or browser you want to add:');
    expect(output.mock.calls.some(([value]) => value === link)).toBe(false);
    expect(String(lastOpenSshParams.current?.remoteCommand)).toContain('pair-device');
    expect(String(lastOpenSshParams.current?.remoteCommand)).toContain('--system-task-stream');
    expect(String(lastOpenSshParams.current?.remoteCommand)).not.toContain('--copy-link');
  });

  it('enrolls the invoking CLI through bounded v3 stdin without putting pairing material in SSH argv or task JSON', async () => {
    const descriptor = {
      v: 1 as const,
      homeServerIdentityId: 'srv_remote_home',
      canonicalServerUrl: 'http://127.0.0.1:43123',
      revision: 1,
      endpoints: [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
    };
    const pairingRequest = {
      kind: 'remote_home_enrollment_pairing_request',
      protocolVersion: 1,
      publicKey: Buffer.alloc(32, 3).toString('base64'),
      homeServerIdentityId: descriptor.homeServerIdentityId,
      pairing: { ...REMOTE_REQUEST_PAIRING, secretB64Url: 'short-lived-v3-context' },
      supportsTokenOnly: true,
      pairingRequirement: 'v3',
    } as const;
    const enrollmentResult = {
      kind: 'remote_home_enrollment_result',
      protocolVersion: 1,
      success: true,
      homeServerIdentityId: descriptor.homeServerIdentityId,
      machineId: 'local-machine',
      encryptionType: 'tokenOnly',
      pairingAuthentication: 'v3',
      remoteProfileId: 'remote-home-profile',
    } as const;
    const runHappierText = vi.fn(async (_args: readonly string[], opts?: Readonly<{ onStdoutChunk?: (text: string) => void }>) => {
      const stdout = `${JSON.stringify(pairingRequest)}\n${JSON.stringify(enrollmentResult)}\n`;
      opts?.onStdoutChunk?.(stdout);
      return { status: 0, stdout, stderr: '' };
    });
    localEnrollmentExecutor.current = { runHappierText };
    const defaultSpawn = spawnSync.getMockImplementation();
    spawnSync.mockImplementation((command: string, args: readonly string[] = [], options?: unknown) => {
      const remoteCommand = String(args.at(-1) ?? '');
      if (command === 'ssh' && remoteCommand.includes('home') && remoteCommand.includes('create')) {
        return jsonResult({
          v: 1,
          ok: true,
          kind: 'personal_home_create',
          data: {
            status: 'complete',
            profileId: 'remote-home',
            homeServerIdentityId: descriptor.homeServerIdentityId,
            canonicalServerUrl: descriptor.canonicalServerUrl,
            accountCreated: true,
            channel: 'preview',
            mode: 'system',
            descriptor,
            accountServiceLink: { kind: 'not_requested' },
          },
        });
      }
      if (command === 'ssh' && remoteCommand.includes('auth') && remoteCommand.includes('approve')) {
        return jsonResult({ success: true });
      }
      return defaultSpawn?.(command, args, options) as ReturnType<typeof spawnSync>;
    });

    const result = await createLiveRemoteSshManageHostTaskKind().run({
      params: {
        action: 'personalHome.create',
        channel: 'preview',
        relayRuntime: { channel: 'preview', mode: 'system' },
        enrollInvokingClient: true,
        ssh: { target: 'example.test', auth: 'agent', trustedHostKey: TRUSTED_HOST_KEY },
      },
      emit: () => undefined,
      prompt: async () => ({}),
    });

    expect(runHappierText).toHaveBeenCalledWith(
      ['auth', 'enroll-remote', '--json-lines', '--home-target-stdin'],
      expect.objectContaining({ includeStdoutInError: false }),
    );
    const approvalCall = openSshParamsCalls.find((params) => String(params.remoteCommand).includes('approve'));
    expect(approvalCall).toBeDefined();
    const remoteCommand = String(approvalCall?.remoteCommand);
    expect(remoteCommand).toContain('auth');
    expect(remoteCommand).toContain('approve');
    expect(remoteCommand).not.toContain(pairingRequest.pairing.secretB64Url);
    expect(approvalCall?.input).toContain(pairingRequest.pairing.secretB64Url);
    expect(result).toMatchObject({
      personalHome: { status: 'complete', invokingClientEnrollment: { kind: 'enrolled' } },
    });
    expect(JSON.stringify(result)).not.toMatch(/short-lived-v3-context|accessToken|credential|claim/i);
  });

  it('uses a local payload root for remote CLI install when HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT is set', async () => {
    const previous = process.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT;
    const localPayloadRoot = await mkdtemp(join(tmpdir(), 'happier-local-cli-payload-'));
    await writeFile(join(localPayloadRoot, 'happier'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
    process.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT = localPayloadRoot;
    try {
      const kind = createLiveRemoteSshBootstrapTaskKind();

      await kind.run({
        params: {
          ssh: {
            target: 'lima-happier-wsrepl-qa-local',
            sshConfigFile: '/tmp/lima-ssh.config',
            auth: 'agent',
          },
          relay: {
            relayUrl: 'https://relay.example.test',
            webappUrl: 'https://relay.example.test',
          },
          channel: 'dev',
        },
        signal: new AbortController().signal,
        emit: () => undefined,
        prompt: async (prompt: { kind: string }) => {
          if (prompt.kind === 'ssh.trustHost') return { trusted: true };
          if (prompt.kind === 'auth.approveRemoteProvisioning') return { approved: true };
          return {};
        },
      } as any);

      const sshRemoteCommands = spawnSync.mock.calls
        .filter(([command]) => command === 'ssh')
        .map(([, args]) => String((args as readonly string[]).at(-1) ?? ''));
      expect(sshRemoteCommands.join('\n')).toContain('local-cli-payload');
      expect(transferOpenSshFile).toHaveBeenCalledWith(expect.objectContaining({
        direction: 'upload',
        recursive: true,
        signal: expect.any(AbortSignal),
      }));
    } finally {
      if (previous === undefined) delete process.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT;
      else process.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT = previous;
      await rm(localPayloadRoot, { recursive: true, force: true });
    }
  });

  it('uses default release acquisition without a local payload and reports a missing guest archive before upload or pairing', async () => {
    const releaseRequests: string[] = [];
    const server = createServer((request, response) => {
      releaseRequests.push(request.url ?? '');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ assets: [
        'checksums-happier-v1.2.3.txt', 'checksums-happier-v1.2.3.txt.minisig',
      ].map(name => ({ name, browser_download_url: `http://127.0.0.1/${name}` })) }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing loopback release address');
      vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', '');
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('HAPPIER_FIRST_PARTY_RELEASE_API_BASE_URL', `http://127.0.0.1:${address.port}`);
      const kind = createLiveRemoteSshBootstrapTaskKind();

      await expect(kind.run({
        params: {
          ssh: {
            target: 'lima-happier-wsrepl-qa-local',
            sshConfigFile: '/tmp/lima-ssh.config',
            auth: 'agent',
          },
          relay: {
            relayUrl: 'https://relay.example.test',
            webappUrl: 'https://relay.example.test',
          },
          channel: 'dev',
        },
        signal: new AbortController().signal,
        emit: () => undefined,
        prompt: async (prompt: { kind: string }) => {
          if (prompt.kind === 'ssh.trustHost') return { trusted: true };
          if (prompt.kind === 'auth.approveRemoteProvisioning') return { approved: true };
          return {};
        },
      })).rejects.toMatchObject({ code: 'guest_payload_missing' });
      expect(releaseRequests).toEqual([expect.stringContaining('/releases/tags/')]);
      expect(transferOpenSshFile).not.toHaveBeenCalled();
      expect(remoteEnrollmentCompleted).toBe(false);
      expect(approveTerminalAuthRequest).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('uses ssh config files to resolve Lima-style SSH aliases and target the real host', async () => {
    const kind = createLiveRemoteSshBootstrapTaskKind();

    await kind.run({
      params: {
        ssh: {
          target: 'lima-happier-wsrepl-qa-local',
          auth: 'agent',
          sshConfigFile: '/tmp/lima-ssh.config',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        channel: 'preview',
        serviceMode: 'none',
      },
      emit: () => undefined,
      prompt: async (request) => {
        if (request.kind === 'auth.approveRemoteProvisioning') {
          return { approved: true };
        }
        if (request.kind === 'ssh.trustHost' || request.kind === 'ssh.replaceHostKey') {
          return { trusted: true };
        }
        throw new Error(`Unexpected prompt: ${request.kind}`);
      },
    });

    const sshInvocations = spawnSync.mock.calls
      .filter(([command]) => command === 'ssh')
      .map(([, args]) => args as readonly string[]);

    expect(sshInvocations.some((args) => args.includes('-F') && args.includes('/tmp/lima-ssh.config'))).toBe(true);
  });

	  it('never emits deprecated --public-server-url when a relay public url is provided', async () => {
	    const previousImplementation = spawnSync.getMockImplementation();
	    if (!previousImplementation) {
	      throw new Error('Missing spawnSync mock implementation');
	    }
	    spawnSync.mockImplementation((command: string, args: readonly string[] = []) => {
	      if (command === 'ssh') {
	        const remoteCommand = String(args.at(-1) ?? '');
	        if (remoteCommand.includes('server set')) {
	          expect(remoteCommand).toContain('https://public.example.test');
	          expect(remoteCommand).not.toContain('127.0.0.1:3005');
	          expect(remoteCommand).not.toContain('localhost:3005');
	        }
	      }
	      return previousImplementation(command, args);
	    });

	    const kind = createLiveRemoteSshBootstrapTaskKind();

	    await kind.run({
	      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'http://127.0.0.1:3005',
          webappUrl: 'http://localhost:3005',
          publicRelayUrl: 'https://public.example.test',
        },
        channel: 'preview',
        knownHostsMode: 'system',
        serviceMode: 'none',
      },
	      emit: () => undefined,
	      prompt: async (request) => {
	        if (request.kind === 'auth.approveRemoteProvisioning') {
	          return { approved: true };
	        }
	        throw new Error(`Unexpected prompt: ${request.kind}`);
	      },
	    });
	  });

	  it('prompts to replace host keys when known_hosts already contains a mismatched entry for a non-22 port', async () => {
	    readFileSync.mockReturnValue(`${BRACKETED_PORT_HOST_KEY}\n`);

	    spawnSync.mockImplementation((command: string, args: readonly string[] = []) => {
	      if (command === 'ssh-keyscan') {
	        expect(args).toContain('-p');
	        expect(args).toContain('54470');
	        return {
	          status: 0,
	          stdout: `${UNBRACKETED_PORT_KEYSCAN_OUTPUT}\n`,
	          stderr: '',
	        };
	      }
	      throw new Error(`Unexpected command: ${command}`);
	    });

	    const kind = createLiveRemoteSshBootstrapTaskKind();

	    await expect(kind.run({
	      params: {
	        ssh: {
	          target: '127.0.0.1:54470',
	          auth: 'agent',
	          knownHostsPath: '/tmp/custom-known_hosts',
	        },
	        relay: {
	          relayUrl: 'https://relay.example.test',
	        },
	        channel: 'preview',
	        serviceMode: 'none',
	      },
	      emit: () => undefined,
	      prompt: async (request) => {
	        if (request.kind === 'ssh.replaceHostKey') {
	          return { trusted: false };
	        }
	        throw new Error(`Unexpected prompt: ${request.kind}`);
	      },
	    })).rejects.toThrow(/host trust was declined/i);
	  });

  it('installs the selected remote payload through CLI promotion instead of curl-bash', async () => {
    const kind = createLiveRemoteSshBootstrapTaskKind();
    const controller = new AbortController();

    await kind.run({
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        channel: 'preview',
        knownHostsMode: 'system',
        serviceMode: 'none',
      },
      emit: () => undefined,
      signal: controller.signal,
      prompt: async (request) => {
        if (request.kind === 'auth.approveRemoteProvisioning') {
          return { approved: true };
        }
        throw new Error(`Unexpected prompt: ${request.kind}`);
      },
    });

    const sshRemoteCommands = spawnSync.mock.calls
      .filter(([command]) => command === 'ssh')
      .map(([, args]) => String((args as readonly string[]).at(-1) ?? ''));

    // CLI promotion belongs to its installed self command, not a second
    // transport-owned symlink installer. Keep the requested payload identity.
    expect(sshRemoteCommands).toContainEqual(expect.stringContaining('self __install-payload --component happier-cli'));
    expect(sshRemoteCommands).toContainEqual(expect.stringMatching(/--version local-preview-\d+ --channel preview/u));
    expect(sshRemoteCommands.join('\n')).not.toContain('curl -fsSL https://happier.dev/install');
    expect(approveTerminalAuthRequest).toHaveBeenCalledWith(expect.objectContaining({
      publicKey: REMOTE_PUBLIC_KEY,
      pairing: REMOTE_REQUEST_PAIRING,
      supportsTokenOnly: true,
      signal: controller.signal,
    }));
  });

  it('executes remote shell commands via bash -lc to avoid /bin/sh pipefail incompatibilities', async () => {
    const kind = createLiveRemoteSshBootstrapTaskKind();

    await kind.run({
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        channel: 'preview',
        knownHostsMode: 'system',
        serviceMode: 'none',
      },
      emit: () => undefined,
      prompt: async (request) => {
        if (request.kind === 'auth.approveRemoteProvisioning') {
          return { approved: true };
        }
        throw new Error(`Unexpected prompt: ${request.kind}`);
      },
    });

    const sshArgs = spawnSync.mock.calls
      .filter(([command]) => command === 'ssh')
      .map(([, args]) => args as readonly string[]);

    expect(sshArgs.some((args) => args.includes('bash') && args.includes('-lc'))).toBe(true);
  });

  it('installs the relay runtime over ssh without hstack self-host and returns the computed relay url', async () => {
    const kind = createLiveRemoteSshBootstrapTaskKind();

    const result = await kind.run({
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        channel: 'preview',
        knownHostsMode: 'system',
        serviceMode: 'none',
        relayRuntime: {
          enabled: true,
          mode: 'user',
          env: {
            PORT: '4001',
          },
        },
      },
      emit: () => undefined,
      prompt: async (request) => {
        if (request.kind === 'auth.approveRemoteProvisioning') {
          return { approved: true };
        }
        throw new Error(`Unexpected prompt: ${request.kind}`);
      },
    });

    expect(result.relayRuntime?.relayUrl).toBe('http://127.0.0.1:4001');

    const sshRemoteCommands = spawnSync.mock.calls
      .filter(([command]) => command === 'ssh')
      .map(([, args]) => String((args as readonly string[]).at(-1) ?? ''))
      .join('\n');

    expect(sshRemoteCommands).not.toContain('hstack');
    expect(sshRemoteCommands).not.toContain('hstack self-host');
    expect(sshRemoteCommands).not.toContain('self-host install');
    expect(sshRemoteCommands).not.toContain("--component 'hstack'");
    expect(sshRemoteCommands).not.toContain('/Users/leeroy/Documents/Development/happier/dev');
    // Guardrail: relay runtime install must use the shared relay host engine, not the bespoke heredoc/prisma probe flow.
    expect(sshRemoteCommands).not.toContain('HAPPIER_EOF');
    expect(sshRemoteCommands).not.toContain('prismaEnginePath');
  });

  it('honors provided trusted host keys and known_hosts paths without prompting again', async () => {
    const promptKinds: string[] = [];
    const kind = createLiveRemoteSshBootstrapTaskKind();

    await kind.run({
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
          knownHostsPath: '/tmp/custom-known_hosts',
          trustedHostKey: TRUSTED_HOST_KEY,
          hostKeyEvidence: { hostKey: TRUSTED_HOST_KEY, fingerprint: computeSshHostKeyFingerprint(TRUSTED_HOST_KEY.split(' ')[2]!) },
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        channel: 'preview',
        serviceMode: 'none',
      },
      emit: () => undefined,
      prompt: async (request) => {
        promptKinds.push(request.kind);
        if (request.kind === 'auth.approveRemoteProvisioning') {
          return { approved: true };
        }
        if (request.kind === 'ssh.trustHost' || request.kind === 'ssh.replaceHostKey') {
          return { trusted: true };
        }
        throw new Error(`Unexpected prompt: ${request.kind}`);
      },
    });

    expect(promptKinds).toEqual(['auth.approveRemoteProvisioning']);

    const transportArgs = spawnSync.mock.calls
      .filter(([command]) => command === 'ssh' || command === 'scp')
      .map(([, args]) => args as readonly string[]);

    expect(transportArgs.every((args) => args.includes('UserKnownHostsFile=/tmp/custom-known_hosts'))).toBe(true);
    expect(writeFileSync).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/custom-known_hosts\..+\.tmp$/u), `${TRUSTED_HOST_KEY}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    expect(renameSync).toHaveBeenCalledWith(expect.any(String), '/tmp/custom-known_hosts');
  });

  it('honors explicit ssh.port when resolving trusted host keys (even if the ssh config file does not match the target)', async () => {
    const promptKinds: string[] = [];
    const kind = createLiveRemoteSshBootstrapTaskKind();
    const trustedHostKey = '[dev.example.test]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTestsOnlyDoNotUseInProd';

    const previousImplementation = spawnSync.getMockImplementation();
    if (!previousImplementation) {
      throw new Error('Missing spawnSync mock implementation');
    }

    spawnSync.mockImplementation((command: string, args: readonly string[] = []) => {
      if (command === 'ssh' && args.includes('-G') && args.includes('-F') && args.includes('/tmp/ssh_config')) {
        // Simulate a config file that exists but doesn't apply to the target; ssh -G falls back to port 22.
        return {
          status: 0,
          stdout: 'hostname dev.example.test\nport 22\n',
          stderr: '',
        };
      }
      if (command === 'ssh-keyscan') {
        // Mirror the port-aware host token so it matches `ssh.port` resolution.
        return {
          status: 0,
          stdout: `${trustedHostKey}\n`,
          stderr: '',
        };
      }
      return previousImplementation(command, args);
    });

    await expect(kind.run({
      params: {
        ssh: {
          target: 'dev.example.test',
          port: 2222,
          auth: 'agent',
          sshConfigFile: '/tmp/ssh_config',
          trustedHostKey,
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        channel: 'preview',
        serviceMode: 'none',
      },
      emit: () => undefined,
      prompt: async (request) => {
        promptKinds.push(request.kind);
        if (request.kind === 'auth.approveRemoteProvisioning') {
          return { approved: true };
        }
        throw new Error(`Unexpected prompt: ${request.kind}`);
      },
    })).resolves.toBeTruthy();

    // Guardrail: trusted host key should avoid SSH trust prompts.
    expect(promptKinds).toEqual(['auth.approveRemoteProvisioning']);

    const keyscanArgs = spawnSync.mock.calls
      .filter(([command]) => command === 'ssh-keyscan')
      .map(([, args]) => args as readonly string[]);
    expect(keyscanArgs).toHaveLength(1);
    expect(keyscanArgs[0]).toContain('-p');
    expect(keyscanArgs[0]).toContain('2222');
  });

  it.each([false, true])('authenticates the retained generated key through the shared recipe before SSH or pairing (matches=%s)', async matches => {
    readFileSync.mockReturnValue('');
    const previousSpawn = spawnSync.getMockImplementation()!;
    spawnSync.mockImplementation((command: string, args: readonly string[] = []) => command === 'ssh'
      ? { status: 1, stdout: '', stderr: 'Fixture authenticated SSH unavailable' } : previousSpawn(command, args));
    const resource = { contributionRef: { pluginId: 'happier.machine.hetzner', localId: 'hetzner' }, schemaVersion: 1,
      value: { serverId: 41, owned: { volumeIds: [7], primaryIpIds: [9] } } };
    const correlation = { homeId: 'srv_live_remote_bootstrap', managedId: 'managed-41', requestId: 'request-1',
      expectedIntentRevision: 1, resource };
    const credentialRef = { kind: 'shared_resource' as const, resourceId: 'retained-bootstrap-key' };
    const row = ManagedMachineV1Schema.parse({ id: correlation.managedId, homeId: correlation.homeId, custodianAccountId: 'owner',
      launch: { provider: resource.contributionRef, schemaVersion: 1, name: 'Guest', choices: {} },
      allocation: 'bound', creationState: 'active', resource, desired: 'start', desiredWhen: 'now', intentRevision: 1,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, bootstrapCredentialRef: credentialRef,
      enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } });
    const target = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: correlation.homeId,
      canonicalServerUrl: 'https://relay.example.test', revision: 1,
      endpoints: [{ kind: 'https', url: 'https://relay.example.test' }] }, authority: 'trusted_enrollment' });
    const dispose = vi.fn(async () => {});
    // Both fresh scan and supplied evidence agree on the substituted key. Only
    // the retained bundle's generated pin must decide trust through the real adapter.
    const enrollment = runManagedMachineEnrollment({ correlation, target, channel: 'preview',
      guestHostPublicKey: (matches ? TRUSTED_HOST_KEY : MISMATCHED_TRUSTED_HOST_KEY).split(' ').slice(1).join(' '),
      carrier: { kind: 'ssh', address: 'example.test', user: 'happier-bootstrap', port: 22, credentialRef,
        hostKeySource: 'retained-credential',
        hostKeyEvidence: { hostKey: TRUSTED_HOST_KEY, fingerprint: computeSshHostKeyFingerprint(TRUSTED_HOST_KEY.split(' ')[2]!) } },
      onPrompt: prompt => { if (prompt) throw new Error(`Unexpected prompt: ${prompt.kind}`); },
    }, {
      readCurrentManagedRow: async () => row,
      materializeBootstrapCredential: async () => ({ path: '/tmp/retained-bootstrap-key', dispose }),
    });

    if (matches) {
      // Correct custody crosses the trust boundary without a first-connect
      // prompt; the deliberate OS refusal stops before installation/pairing.
      await expect(enrollment).rejects.toBeInstanceOf(Error);
      expect(spawnSync.mock.calls.filter(([command]) => command === 'ssh').length).toBeGreaterThan(0);
    } else {
      await expect(enrollment).rejects.toMatchObject({ code: 'trusted_host_key_mismatch' });
      expect(spawnSync.mock.calls.filter(([command]) => command === 'ssh')).toHaveLength(0);
      expect(writeFileSync).not.toHaveBeenCalled();
    }
    expect(spawnSync.mock.calls.filter(([command]) => command === 'scp')).toHaveLength(0);
    expect(approveTerminalAuthRequest).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('returns a closed failure when an SSH command fails without stderr', async () => {
    const kind = createLiveRemoteSshBootstrapTaskKind();

    spawnSync.mockImplementation((command: string, args: readonly string[] = []) => {
      if (command === 'ssh-keyscan') {
        return {
          status: 0,
          stdout: `${TRUSTED_HOST_KEY}\n`,
          stderr: '',
        };
      }
      if (command === 'scp') {
        return {
          status: 0,
          stdout: '',
          stderr: '',
        };
      }
      if (command !== 'ssh') {
        throw new Error(`Unexpected command: ${command}`);
      }
      const remoteCommand = String(args.at(-1) ?? '');
      if (remoteCommand.includes('"arch"')) {
        return jsonResult({
          platform: 'linux',
          arch: 'x86_64',
        });
      }
      if (remoteCommand.includes('server set')) {
        return {
          status: 127,
          stdout: '',
          stderr: 'bash: happier: command not found\n',
        };
      }
      if (remoteCommand.includes('__install-payload')) {
        return {
          status: 255,
          stdout: 'remote installer failed\n',
          stderr: '',
        };
      }
      return jsonResult({ ok: true, data: {} });
    });

    await expect(
      kind.run({
        params: {
          ssh: {
            target: 'dev@example.test',
            auth: 'agent',
            trustedHostKey: TRUSTED_HOST_KEY,
          },
          relay: {
            relayUrl: 'https://relay.example.test',
          },
          channel: 'preview',
          knownHostsMode: 'system',
          serviceMode: 'none',
        },
        emit: () => undefined,
        prompt: async () => {
          throw new Error('Unexpected prompt');
        },
      }),
    ).rejects.toMatchObject({ code: 'ssh_command_failed', message: expect.stringMatching(/^The SSH command failed\. \(phase ssh\.command; exitStatus 255;/u) });
  });

  it.each([
    ['WARNING: Your password has expired. Password change required but no TTY available.', 'ssh_password_expired'],
    ['You are required to change your password immediately (administrator enforced).', 'ssh_password_expired'],
    ['WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!', 'ssh_host_key_changed'],
    ['Host key verification failed.', 'ssh_host_key_unverified'],
    ['unrecognized native content', 'ssh_command_failed'],
  ])('keeps SSH diagnostics closed at installCli (%s)', async (diagnostic, code) => {
    spawnSync.mockImplementation((command: string) => command === 'ssh-keyscan'
      ? { status: 0, stdout: `${TRUSTED_HOST_KEY}\n`, stderr: '' }
      : { status: 255, stdout: '', stderr: `${diagnostic}\nprivate-reflected-content /private/home` });
    const failure = await createLiveRemoteSshBootstrapTaskKind().run({
      params: { ssh: { target: 'root@example.test', auth: 'agent', trustedHostKey: TRUSTED_HOST_KEY },
        relay: { relayUrl: 'https://relay.example.test' }, channel: 'preview', knownHostsMode: 'system', serviceMode: 'none' },
      emit: () => undefined, prompt: async () => { throw new Error('Unexpected prompt'); },
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: 'SystemTaskExecutionError', code });
    expect(String(failure)).not.toContain('private');
    expect(String(failure)).not.toContain(diagnostic);
    expect(openSshParamsCalls).toHaveLength(1); // Non-retryable login failures settle once.
  });

  it('closes an SCP failure through the same SSH diagnostic owner', async () => {
    transferOpenSshFile.mockRejectedValueOnce(new Error('REMOTE HOST IDENTIFICATION HAS CHANGED! private-reflected-content'));
    let authorityReads = 0;
    const failure = await createLiveRemoteSshBootstrapTaskKind({
      assertManagedEnrollmentCurrent: async () => { authorityReads++; },
    }).run({
      params: { ssh: { target: 'happier@example.test', auth: 'agent', trustedHostKey: TRUSTED_HOST_KEY },
        managedEnrollment: { homeId: 'srv_live_remote_bootstrap', managedId: 'managed', requestId: 'create', expectedIntentRevision: 0,
          controller: { machineId: 'controller', installationId: 'installation' }, resource: {
            contributionRef: { pluginId: 'test.machine', localId: 'vm' }, schemaVersion: 1, value: { nativeId: 'guest' },
          } },
        relay: { relayUrl: 'https://relay.example.test' }, channel: 'preview', knownHostsMode: 'system', serviceMode: 'none' },
      emit: () => undefined, prompt: async () => { throw new Error('Unexpected prompt'); },
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: 'SystemTaskExecutionError', code: 'ssh_host_key_changed' });
    expect(String(failure)).not.toContain('private');
    // Payload delivery failed before pairing admission. Guest commands and
    // copies must not ask Home whether the admitted installation is current.
    expect(authorityReads).toBe(0);
  });

  it.each([
    { name: 'SSH transport failure', status: 255, value: { v: 1, ok: false, kind: 'auth_status', error: { code: 'not_authenticated' } } },
    { name: 'unexpected process failure', status: 2, value: { v: 1, ok: false, kind: 'auth_status', error: { code: 'not_authenticated' } } },
    { name: 'unavailable auth', status: 0, value: { v: 1, ok: false, kind: 'auth_status', error: { code: 'auth_status_unavailable' } } },
    { name: 'missing auth envelope', status: 0, value: { authenticated: false } },
    { name: 'malformed auth success', status: 0, value: { v: 1, ok: true, kind: 'auth_status', data: {} } },
    { name: 'signed-out response to server selection', status: 1, match: 'server set', value: { v: 1, ok: false, kind: 'auth_status', error: { code: 'not_authenticated' } } },
  ])('refuses $name before remote pairing', async ({ status, value, ...scenario }) => {
    const previousImplementation = spawnSync.getMockImplementation();
    if (!previousImplementation) throw new Error('Missing spawnSync mock implementation');
    spawnSync.mockImplementation((command: string, args: readonly string[] = []) => {
      if (command === 'ssh' && String(args.at(-1) ?? '').includes(scenario.match ?? 'auth status --json')) {
        return { status, stdout: `${JSON.stringify(value)}\n`, stderr: '' };
      }
      return previousImplementation(command, args);
    });
    await expect(createLiveRemoteSshBootstrapTaskKind().run({
      params: {
        ssh: { target: 'dev@example.test', auth: 'agent' }, relay: { relayUrl: 'https://relay.example.test' },
        channel: 'preview', knownHostsMode: 'system', serviceMode: 'none',
      },
      emit: () => undefined,
      prompt: async () => ({ approved: true }),
    })).rejects.toThrow();
    expect(approveTerminalAuthRequest).not.toHaveBeenCalled();
    expect(remoteEnrollmentCompleted).toBe(false);
  });

  it('parses JSON output even when the remote command exits non-zero (auth status not authenticated)', async () => {
    const kind = createLiveRemoteSshBootstrapTaskKind();
    const previousImplementation = spawnSync.getMockImplementation();
    if (!previousImplementation) {
      throw new Error('Missing spawnSync mock implementation');
    }

    spawnSync.mockImplementation((command: string, args: readonly string[] = []) => {
      if (command === 'ssh') {
        const remoteCommand = String(args.at(-1) ?? '');
        if (remoteCommand.includes('auth status --json')) {
          return {
            status: 1,
            stdout: `${JSON.stringify({
              v: 1,
              ok: false,
              kind: 'auth_status',
              error: { code: 'not_authenticated' },
            })}\n`,
            stderr: '',
          };
        }
      }
      return previousImplementation(command, args);
    });

    await expect(kind.run({
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        channel: 'preview',
        knownHostsMode: 'system',
        serviceMode: 'none',
      },
      emit: () => undefined,
      prompt: async (request) => {
        if (request.kind === 'auth.approveRemoteProvisioning') {
          return { approved: true };
        }
        throw new Error(`Unexpected prompt: ${request.kind}`);
      },
    })).resolves.toBeDefined();

    expect(approveTerminalAuthRequest).toHaveBeenCalledWith(expect.objectContaining({
      publicKey: REMOTE_PUBLIC_KEY,
      pairing: REMOTE_REQUEST_PAIRING,
      supportsTokenOnly: true,
    }));
  });

  it('passes the target relay selection explicitly without changing the active Home', async () => {
    const kind = createLiveRemoteSshBootstrapTaskKind();
    const previousServerUrl = process.env.HAPPIER_SERVER_URL;
    const previousWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const previousPublicServerUrl = process.env.HAPPIER_PUBLIC_SERVER_URL;
    const previousLocalServerUrl = process.env.HAPPIER_LOCAL_SERVER_URL;

    process.env.HAPPIER_SERVER_URL = 'https://original.example.test';
    process.env.HAPPIER_WEBAPP_URL = 'https://original-app.example.test';
    process.env.HAPPIER_PUBLIC_SERVER_URL = 'https://original-public.example.test';
    process.env.HAPPIER_LOCAL_SERVER_URL = 'http://127.0.0.1:59999';

    let observedServerUrl: string | null = null;
    let observedWebappUrl: string | null = null;

    approveTerminalAuthRequest.mockImplementation(async params => {
      observedServerUrl = params.target?.applicationUrl ?? null;
      observedWebappUrl = params.target?.webappUrl ?? null;
    });

    await kind.run({
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
        },
        channel: 'preview',
        knownHostsMode: 'system',
        serviceMode: 'none',
      },
      emit: () => undefined,
      prompt: async (request) => {
        if (request.kind === 'auth.approveRemoteProvisioning') {
          return { approved: true };
        }
        throw new Error(`Unexpected prompt: ${request.kind}`);
      },
    });

    expect(observedServerUrl).toBe('https://relay.example.test');
    expect(observedWebappUrl).toBe('https://app.example.test');

    expect(process.env.HAPPIER_SERVER_URL).toBe('https://original.example.test');
    expect(process.env.HAPPIER_WEBAPP_URL).toBe('https://original-app.example.test');
    expect(process.env.HAPPIER_PUBLIC_SERVER_URL).toBe('https://original-public.example.test');
    expect(process.env.HAPPIER_LOCAL_SERVER_URL).toBe('http://127.0.0.1:59999');

    if (typeof previousServerUrl === 'string') process.env.HAPPIER_SERVER_URL = previousServerUrl;
    else delete process.env.HAPPIER_SERVER_URL;
    if (typeof previousWebappUrl === 'string') process.env.HAPPIER_WEBAPP_URL = previousWebappUrl;
    else delete process.env.HAPPIER_WEBAPP_URL;
    if (typeof previousPublicServerUrl === 'string') process.env.HAPPIER_PUBLIC_SERVER_URL = previousPublicServerUrl;
    else delete process.env.HAPPIER_PUBLIC_SERVER_URL;
    if (typeof previousLocalServerUrl === 'string') process.env.HAPPIER_LOCAL_SERVER_URL = previousLocalServerUrl;
    else delete process.env.HAPPIER_LOCAL_SERVER_URL;
  });

  it('passes an explicit manual Home target to approval instead of using the ambient active Home', async () => {
    const kind = createLiveRemoteSshBootstrapTaskKind();
    const homeTarget = {
      profileId: null,
      homeServerIdentityId: null,
      descriptor: null,
      canonicalAuthUrl: 'https://home-b.example.test',
      applicationUrl: 'https://home-b.example.test',
      webappUrl: 'https://home-b.example.test',
      credentialDestination: null,
      preferredTransport: 'https' as const,
      authority: 'manual_url' as const,
    };

    await kind.run({
      params: {
        ssh: { target: 'dev@example.test', auth: 'agent' },
        relay: { relayUrl: homeTarget.applicationUrl, webappUrl: homeTarget.webappUrl },
        homeTarget,
        channel: 'preview',
        knownHostsMode: 'system',
        serviceMode: 'none',
      },
      emit: () => undefined,
      prompt: async (request) => request.kind === 'auth.approveRemoteProvisioning'
        ? { approved: true }
        : Promise.reject(new Error(`Unexpected prompt: ${request.kind}`)),
    });

    expect(approveTerminalAuthRequest).toHaveBeenCalledWith(expect.objectContaining({
      publicKey: REMOTE_PUBLIC_KEY,
      pairing: REMOTE_REQUEST_PAIRING,
      supportsTokenOnly: true,
      target: homeTarget,
    }));
  });

  it('preserves the local/public relay split when the approval target matches the current public relay url', async () => {
    const kind = createLiveRemoteSshBootstrapTaskKind();
    const previousServerUrl = process.env.HAPPIER_SERVER_URL;
    const previousWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    const previousPublicServerUrl = process.env.HAPPIER_PUBLIC_SERVER_URL;
    const previousLocalServerUrl = process.env.HAPPIER_LOCAL_SERVER_URL;

    process.env.HAPPIER_PUBLIC_SERVER_URL = 'https://public.example.test';
    process.env.HAPPIER_LOCAL_SERVER_URL = 'http://127.0.0.1:59999';
    process.env.HAPPIER_SERVER_URL = 'http://127.0.0.1:59999';
    process.env.HAPPIER_WEBAPP_URL = 'https://original-app.example.test';

    let observedServerUrl: string | null = null;
    let observedPublicServerUrl: string | null = null;
    let observedLocalServerUrl: string | null = null;
    let observedWebappUrl: string | null = null;

    approveTerminalAuthRequest.mockImplementation(async params => {
      observedServerUrl = params.target?.applicationUrl ?? null;
      observedPublicServerUrl = params.target?.canonicalAuthUrl ?? null;
      observedLocalServerUrl = params.target?.applicationUrl ?? null;
      observedWebappUrl = params.target?.webappUrl ?? null;
    });

    await kind.run({
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://public.example.test',
          webappUrl: 'https://app.example.test',
        },
        channel: 'preview',
        knownHostsMode: 'system',
        serviceMode: 'none',
      },
      emit: () => undefined,
      prompt: async (request) => {
        if (request.kind === 'auth.approveRemoteProvisioning') {
          return { approved: true };
        }
        throw new Error(`Unexpected prompt: ${request.kind}`);
      },
    });

    expect(observedServerUrl).toBe('http://127.0.0.1:59999');
    expect(observedPublicServerUrl).toBe('https://public.example.test');
    expect(observedLocalServerUrl).toBe('http://127.0.0.1:59999');
    expect(observedWebappUrl).toBe('https://app.example.test');

    if (typeof previousServerUrl === 'string') process.env.HAPPIER_SERVER_URL = previousServerUrl;
    else delete process.env.HAPPIER_SERVER_URL;
    if (typeof previousWebappUrl === 'string') process.env.HAPPIER_WEBAPP_URL = previousWebappUrl;
    else delete process.env.HAPPIER_WEBAPP_URL;
    if (typeof previousPublicServerUrl === 'string') process.env.HAPPIER_PUBLIC_SERVER_URL = previousPublicServerUrl;
    else delete process.env.HAPPIER_PUBLIC_SERVER_URL;
    if (typeof previousLocalServerUrl === 'string') process.env.HAPPIER_LOCAL_SERVER_URL = previousLocalServerUrl;
    else delete process.env.HAPPIER_LOCAL_SERVER_URL;
  });

  it('opens a loopback relay tunnel over ssh before approving remote provisioning', async () => {
    const kind = createLiveRemoteSshBootstrapTaskKind();
    const previousServerUrl = process.env.HAPPIER_SERVER_URL;
    const previousWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    let observedServerUrl: string | null = null;
    const relayPort = await new Promise<number>((resolve, reject) => {
      const server = createServer((_req, res) => {
        res.statusCode = 200;
        res.end('ok');
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as { port: number } | null)?.port ?? 0;
        server.close(() => resolve(port));
      });
    });
    if (!relayPort) {
      throw new Error('Expected to reserve an available loopback port for test');
    }

    approveTerminalAuthRequest.mockImplementation(async params => {
      observedServerUrl = params.target?.applicationUrl ?? null;
    });

    await kind.run({
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: `http://127.0.0.1:${relayPort}`,
        },
        relayRuntime: {
          enabled: true,
          mode: 'user',
          env: {
            PORT: String(relayPort),
          },
        },
        channel: 'preview',
        knownHostsMode: 'system',
        serviceMode: 'none',
      },
      emit: () => undefined,
      prompt: async (request) => {
        if (request.kind === 'auth.approveRemoteProvisioning') {
          return { approved: true };
        }
        throw new Error(`Unexpected prompt: ${request.kind}`);
      },
    });

    expect(
      spawnSync.mock.calls.some(
        ([command, args]) =>
          command === 'ssh' &&
          Array.isArray(args) &&
          args.includes('-L') &&
          args.includes(`${relayPort}:127.0.0.1:${relayPort}`),
      ),
    ).toBe(true);
    const controlPathArg = spawnSync.mock.calls
      .filter(([command]) => command === 'ssh')
      .flatMap(([, args]) => Array.from(args as readonly string[]))
      .find((arg) => typeof arg === 'string' && arg.startsWith('ControlPath='));
    expect(controlPathArg).toMatch(/^ControlPath=\/tmp\//u);
    expect(observedServerUrl).toBe(`http://localhost:${relayPort}`);
    expect(approveTerminalAuthRequest).toHaveBeenCalledWith(expect.objectContaining({
      publicKey: REMOTE_PUBLIC_KEY,
      pairing: REMOTE_REQUEST_PAIRING,
      supportsTokenOnly: true,
    }));
    expect(process.env.HAPPIER_SERVER_URL).toBe(previousServerUrl);
    expect(process.env.HAPPIER_WEBAPP_URL).toBe(previousWebappUrl);
  });

	  it('falls back to an available local port when the loopback relay port is already occupied', async () => {
	    const kind = createLiveRemoteSshBootstrapTaskKind();
	    const previousServerUrl = process.env.HAPPIER_SERVER_URL;
	    const previousWebappUrl = process.env.HAPPIER_WEBAPP_URL;
	    let observedServerUrl: string | null = null;

    const occupied = createServer((_req, res) => {
      res.statusCode = 200;
      res.end('ok');
    });

    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject);
      occupied.listen(0, '127.0.0.1', () => resolve());
    });
	    const occupiedPort = (occupied.address() as { port: number } | null)?.port ?? 0;
	    if (!occupiedPort) {
	      throw new Error('Failed to allocate an occupied loopback port for test');
	    }
	    isLoopbackPortAvailable.mockImplementation(async (port) => port !== occupiedPort);
	    findAvailableLoopbackPort.mockImplementation(async () => occupiedPort + 1);

	    try {
	      approveTerminalAuthRequest.mockImplementation(async params => {
	        observedServerUrl = params.target?.applicationUrl ?? null;
	      });

      await kind.run({
        params: {
          ssh: {
            target: 'dev@example.test',
            auth: 'agent',
          },
          relay: {
            relayUrl: `http://127.0.0.1:${occupiedPort}`,
          },
          relayRuntime: {
            enabled: true,
            mode: 'user',
            env: {
              PORT: String(occupiedPort),
            },
          },
          channel: 'preview',
          knownHostsMode: 'system',
          serviceMode: 'none',
        },
        emit: () => undefined,
        prompt: async (request) => {
          if (request.kind === 'auth.approveRemoteProvisioning') {
            return { approved: true };
          }
          throw new Error(`Unexpected prompt: ${request.kind}`);
        },
      });

      const forwarded = spawnSync.mock.calls
        .filter(([command, args]) => command === 'ssh' && Array.isArray(args) && args.includes('-L'))
        .map(([, args]) => {
          const tokens = args as readonly string[];
          const idx = tokens.indexOf('-L');
          return idx >= 0 ? String(tokens[idx + 1] ?? '') : '';
        })
        .find((spec) => spec.endsWith(`:127.0.0.1:${occupiedPort}`));

      expect(forwarded).toBeTruthy();
      const localPort = Number(String(forwarded ?? '').split(':')[0] ?? '');
      expect(Number.isFinite(localPort)).toBe(true);
      expect(localPort).not.toBe(occupiedPort);
      expect(observedServerUrl).toBe(`http://localhost:${localPort}`);
      expect(approveTerminalAuthRequest).toHaveBeenCalledWith(expect.objectContaining({
        publicKey: REMOTE_PUBLIC_KEY,
        pairing: REMOTE_REQUEST_PAIRING,
        supportsTokenOnly: true,
      }));
      expect(process.env.HAPPIER_SERVER_URL).toBe(previousServerUrl);
      expect(process.env.HAPPIER_WEBAPP_URL).toBe(previousWebappUrl);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  it('redacts sensitive values and absolute paths from stderr when ssh config resolution fails', async () => {
    const kind = createLiveRemoteSshBootstrapTaskKind();

    spawnSync.mockImplementation((command: string, args: readonly string[] = []) => {
      if (command === 'ssh' && args.includes('-G')) {
        return {
          status: 1,
          stdout: '',
          stderr: [
            'Bad configuration option: IdentityFile /Users/leeroy/.ssh/id_ed25519',
            'password=supersecret',
            'known_hosts=/mock-home/ssh/known_hosts',
          ].join('\n'),
        };
      }
      if (command === 'ssh-keyscan') {
        return {
          status: 0,
          stdout: `${TRUSTED_HOST_KEY}\n`,
          stderr: '',
        };
      }
      if (command === 'scp') {
        return {
          status: 0,
          stdout: '',
          stderr: '',
        };
      }
      if (command !== 'ssh') {
        throw new Error(`Unexpected command: ${command}`);
      }
      const remoteCommand = String(args.at(-1) ?? '');
      if (remoteCommand.includes('"arch"')) {
        return jsonResult({
          platform: 'linux',
          arch: 'x86_64',
        });
      }
      return jsonResult({ ok: true, data: {} });
    });

    try {
      await kind.run({
        params: {
          ssh: {
            target: 'lima-happier-wsrepl-qa-local',
            auth: 'agent',
            sshConfigFile: '/Users/leeroy/.ssh/config',
          },
          relay: {
            relayUrl: 'https://relay.example.test',
          },
          channel: 'preview',
          serviceMode: 'none',
        },
        emit: () => undefined,
        prompt: async (request) => {
          if (request.kind === 'auth.approveRemoteProvisioning') {
            return { approved: true };
          }
          if (request.kind === 'ssh.trustHost' || request.kind === 'ssh.replaceHostKey') {
            return { trusted: true };
          }
          throw new Error(`Unexpected prompt: ${request.kind}`);
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain('/Users/leeroy/.ssh/id_ed25519');
      expect(message).not.toContain('/mock-home/ssh/known_hosts');
      expect(message).not.toContain('supersecret');
      expect(error).toMatchObject({ code: 'ssh_command_failed' });
      expect(message).toBe('The SSH command failed.');
    }
  });
});
