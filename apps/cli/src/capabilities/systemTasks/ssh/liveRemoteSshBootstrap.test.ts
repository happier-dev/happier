import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

type OpenSshFileTransferParams = Parameters<
  typeof import('@happier-dev/cli-common/ssh').transferOpenSshFile
>[0];

const {
  spawnSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  approveTerminalAuthRequest,
  reloadConfiguration,
  lastInstallRemoteFirstPartyDeps,
  lastOpenSshParams,
  openSshParamsCalls,
  transferOpenSshFile,
  localEnrollmentExecutor,
} = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
  approveTerminalAuthRequest: vi.fn(async () => undefined),
  reloadConfiguration: vi.fn(),
  lastInstallRemoteFirstPartyDeps: { current: null as null | unknown },
  lastOpenSshParams: { current: null as null | Record<string, unknown> },
  openSshParamsCalls: [] as Array<Record<string, unknown>>,
  transferOpenSshFile: vi.fn<(params: OpenSshFileTransferParams) => Promise<void>>(async () => undefined),
  localEnrollmentExecutor: { current: null as null | {
    runHappierText: (args: readonly string[], opts?: Readonly<{ onStdoutChunk?: (text: string) => void }>) => Promise<Readonly<{ status: number; stdout: string; stderr: string }>>;
  } },
}));

const { isLoopbackPortAvailable, findAvailableLoopbackPort } = vi.hoisted(() => ({
  isLoopbackPortAvailable: vi.fn<(port: number) => Promise<boolean>>(),
  findAvailableLoopbackPort: vi.fn<(requestedPort: number) => Promise<number>>(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync,
  };
});

vi.mock('node:fs', () => ({
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
}));

vi.mock('@happier-dev/cli-common/ssh', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/ssh')>();
  return {
    ...actual,
    runOpenSshRemoteCommand: async (params: Parameters<typeof actual.runOpenSshRemoteCommand>[0]) => {
      lastOpenSshParams.current = params as unknown as Record<string, unknown>;
      openSshParamsCalls.push(params as unknown as Record<string, unknown>);
      if (String(params.remoteCommand).includes('enroll-remote')) {
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
  },
  reloadConfiguration,
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
    installRemoteFirstPartyComponent: async (
      ...args: Parameters<typeof actual.installRemoteFirstPartyComponent>
    ) => {
      const [params, deps] = args;
      lastInstallRemoteFirstPartyDeps.current = deps;
      return await actual.installRemoteFirstPartyComponent(params, {
        ...deps,
        preparePayload: deps.preparePayload ?? (async ({ componentId, channel }) => {
          const payloadRoot = await mkdtemp(join(tmpdir(), 'happier-ssh-bootstrap-payload-'));
          await mkdir(join(payloadRoot, 'bin'), { recursive: true });
          await writeFile(join(payloadRoot, 'bin', 'happier'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
          return {
            componentId,
            channel,
            versionId: 'test-version',
            payloadRoot,
            source: 'unit-test',
            cleanup: async () => {
              await rm(payloadRoot, { recursive: true, force: true });
            },
          };
        }),
      });
    },
  };
});

import { createLiveRemoteSshBootstrapTaskKind, createLiveRemoteSshManageHostTaskKind } from './liveRemoteSshBootstrap';
import { createServer } from 'node:http';
import { encodeHomeQrInviteV2Payload, type HomeQrInviteV2 } from '@happier-dev/protocol';

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
  beforeEach(() => {
    vi.clearAllMocks();
    lastInstallRemoteFirstPartyDeps.current = null;
    lastOpenSshParams.current = null;
    openSshParamsCalls.length = 0;
    transferOpenSshFile.mockImplementation(async () => undefined);
    localEnrollmentExecutor.current = null;
    remoteEnrollmentCompleted = false;
    isLoopbackPortAvailable.mockResolvedValue(true);
    findAvailableLoopbackPort.mockImplementation(async (requestedPort: number) => requestedPort + 1);
    readFileSync.mockImplementation(() => {
      throw new Error('missing known_hosts');
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
          ok: true,
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
      pairing: { secretB64Url: 'short-lived-v3-context', createdAtMs: 100, expiresAtMs: 200 },
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
    await mkdir(join(localPayloadRoot, 'bin'), { recursive: true });
    await writeFile(join(localPayloadRoot, 'bin', 'happier'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
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

  it('does not pass preparePayload: undefined to installRemoteFirstPartyComponent when no local payload override is set', async () => {
    const previous = process.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT;
    delete process.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT;
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
      });

      expect(lastInstallRemoteFirstPartyDeps.current).toBeTruthy();
      const deps = lastInstallRemoteFirstPartyDeps.current as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(deps, 'preparePayload')).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT;
      } else {
        process.env.HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT = previous;
      }
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

  it('installs the remote CLI from the verified payload path instead of curl-bash', async () => {
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

    expect(sshRemoteCommands.some((command) => command.includes('ln -sfn'))).toBe(true);
    expect(sshRemoteCommands.join('\n')).not.toContain('curl -fsSL https://happier.dev/install');
    expect(approveTerminalAuthRequest).toHaveBeenCalledWith({
      publicKey: REMOTE_PUBLIC_KEY,
      pairing: REMOTE_REQUEST_PAIRING,
      supportsTokenOnly: true,
      signal: controller.signal,
    });
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
    expect(writeFileSync).toHaveBeenCalledWith('/tmp/custom-known_hosts', `${TRUSTED_HOST_KEY}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
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

  it('fails closed when an explicit trusted host key mismatches the fresh keyscan result', async () => {
    readFileSync.mockReturnValue(`${TRUSTED_HOST_KEY}\n`);
    const kind = createLiveRemoteSshBootstrapTaskKind();

    await expect(kind.run({
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
          knownHostsPath: '/tmp/custom-known_hosts',
          trustedHostKey: MISMATCHED_TRUSTED_HOST_KEY,
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        channel: 'preview',
        serviceMode: 'none',
      },
      emit: () => undefined,
      prompt: async (request) => {
        throw new Error(`Unexpected prompt: ${request.kind}`);
      },
    })).rejects.toThrow(/trusted host key/i);

    expect(spawnSync.mock.calls.filter(([command]) => command === 'ssh')).toHaveLength(0);
    expect(spawnSync.mock.calls.filter(([command]) => command === 'scp')).toHaveLength(0);
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(approveTerminalAuthRequest).not.toHaveBeenCalled();
  });

  it('surfaces stdout when an SSH command fails without stderr', async () => {
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
      if (remoteCommand.includes('ln -sfn') || remoteCommand.includes('cp -R')) {
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
    ).rejects.toThrow(/remote installer failed/i);
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

    expect(approveTerminalAuthRequest).toHaveBeenCalledWith({
      publicKey: REMOTE_PUBLIC_KEY,
      pairing: REMOTE_REQUEST_PAIRING,
      supportsTokenOnly: true,
    });
  });

  it('temporarily applies the target relay selection when approving remote provisioning against a non-loopback relay URL', async () => {
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

    approveTerminalAuthRequest.mockImplementation(async () => {
      observedServerUrl = String(process.env.HAPPIER_SERVER_URL ?? '');
      observedWebappUrl = String(process.env.HAPPIER_WEBAPP_URL ?? '');
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

    expect(approveTerminalAuthRequest).toHaveBeenCalledWith({
      publicKey: REMOTE_PUBLIC_KEY,
      pairing: REMOTE_REQUEST_PAIRING,
      supportsTokenOnly: true,
      target: homeTarget,
    });
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

    approveTerminalAuthRequest.mockImplementation(async () => {
      observedServerUrl = String(process.env.HAPPIER_SERVER_URL ?? '');
      observedPublicServerUrl = String(process.env.HAPPIER_PUBLIC_SERVER_URL ?? '');
      observedLocalServerUrl = String(process.env.HAPPIER_LOCAL_SERVER_URL ?? '');
      observedWebappUrl = String(process.env.HAPPIER_WEBAPP_URL ?? '');
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

    approveTerminalAuthRequest.mockImplementation(async () => {
      observedServerUrl = String(process.env.HAPPIER_SERVER_URL ?? '');
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
    expect(observedServerUrl).toMatch(new RegExp(`^http://(127\\\\.0\\\\.0\\\\.1|localhost):${relayPort}$`, 'u'));
    expect(approveTerminalAuthRequest).toHaveBeenCalledWith({
      publicKey: REMOTE_PUBLIC_KEY,
      pairing: REMOTE_REQUEST_PAIRING,
      supportsTokenOnly: true,
    });
    expect(reloadConfiguration).toHaveBeenCalled();
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
	      approveTerminalAuthRequest.mockImplementation(async () => {
	        observedServerUrl = String(process.env.HAPPIER_SERVER_URL ?? '');
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
      expect(observedServerUrl).toMatch(new RegExp(`^http://(127\\\\.0\\\\.0\\\\.1|localhost):${localPort}$`, 'u'));
      expect(approveTerminalAuthRequest).toHaveBeenCalledWith({
        publicKey: REMOTE_PUBLIC_KEY,
        pairing: REMOTE_REQUEST_PAIRING,
        supportsTokenOnly: true,
      });
      expect(reloadConfiguration).toHaveBeenCalled();
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
      expect(message).toContain('id_ed25519');
      expect(message).toContain('known_hosts');
    }
  });
});
