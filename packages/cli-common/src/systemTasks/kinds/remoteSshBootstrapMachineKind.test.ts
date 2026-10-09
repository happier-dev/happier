import { describe, expect, it, vi } from 'vitest';
import { readFile, stat } from 'node:fs/promises';

import { createSystemTasksRunner } from '../interactiveTaskKinds.js';
import { resolveHomeTargetFromDescriptor } from '../../homeTarget/homeTarget.js';
import {
  createRemoteSshBootstrapMachineTaskKind as createProductionRemoteSshBootstrapMachineTaskKind,
  createRemoteNativeBootstrapMachineTaskKind,
  parseRemoteBootstrapMachineParams,
  preflightRemoteBackgroundServiceReplacement,
  SERVICE_RECONCILIATION_DECLINED_MESSAGE,
  type RemoteSshBootstrapMachineDeps,
} from './remoteSshBootstrapMachineKind.js';

type RemoteEnrollmentExecutorParams = Parameters<
  NonNullable<RemoteSshBootstrapMachineDeps['createRemoteEnrollmentExecutor']>
>[0];

describe('native transport through the remote bootstrap task', () => {
  it('preserves the daemon service replacement prompt from a normal CLI JSON envelope', async () => {
    const prompts: string[] = [];
    const task = createRemoteNativeBootstrapMachineTaskKind({
      configuration: { relay: { relayUrl: HOME_TARGET.canonicalAuthUrl }, homeTarget: HOME_TARGET, serviceMode: 'user' },
      assertCurrent: async () => {}, installRemoteCli: async () => {}, approveLocalAuthRequest: async () => {},
      executor: {
        runHappierText: async () => { throw new Error('Enrollment must not start before service replacement consent.'); },
        runHappierJson: async () => ({ ok: true, data: { services: [{ serviceType: 'daemon', label: 'old-preview', ring: 'preview', targetMode: 'pinned', running: true }] } }),
      },
    });
    await expect(task.run({ params: {}, emit: () => undefined, prompt: async (request) => { prompts.push(request.kind); return { approved: false }; } })).rejects.toMatchObject({ code: 'service_reconciliation_declined' });
    expect(prompts).toEqual(['daemon.replaceRemoteBackgroundServices']);
  });

  it('enrolls with buffered native exec and carries exact managed correlation in private stdin', async () => {
    let approved = false;
    const correlation = { homeId: 'srv_home_identity', managedId: 'managed-1', requestId: 'request-1', expectedIntentRevision: 1, controller: { machineId: 'controller', installationId: 'installation' }, resource: { contributionRef: { pluginId: 'test.provisioner', localId: 'vm' }, schemaVersion: 1, value: { nativeId: 'retained-1' } } };
    let guestInput: unknown;
    const runner = createSystemTasksRunner({ kinds: {} });
    const task = createRemoteNativeBootstrapMachineTaskKind({
      configuration: { relay: { relayUrl: HOME_TARGET.canonicalAuthUrl }, homeTarget: HOME_TARGET, managedEnrollment: correlation, serviceMode: 'none' },
      assertCurrent: async () => {}, installRemoteCli: async () => {},
      approveLocalAuthRequest: async () => { approved = true; },
      executor: {
        runHappierJson: async () => ({ ok: true, data: { authenticated: true, credentialState: 'valid', machineRegistrationState: 'server-confirmed', machineId: 'joined-machine' } }),
        runHappierText: async (args, options) => {
          expect(options?.onStdoutChunk).toBeUndefined();
          if (args[1] === 'request') {
            expect(args).toEqual(['auth', 'request', '--json', '--remote-enrollment', '--home-target-stdin', '--managed-enrollment-stdin']);
            guestInput = JSON.parse(options!.input!);
            const request = { kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1, publicKey: Buffer.alloc(32, 1).toString('base64'), homeServerIdentityId: correlation.homeId, pairing: { secretB64Url: Buffer.alloc(32, 2).toString('base64url'), createdAtMs: 10, expiresAtMs: 20 }, supportsTokenOnly: true, pairingRequirement: 'v3', remoteProfileId: 'guest-home' };
            return { status: 0, stdout: `${JSON.stringify(request)}\n`, stderr: '' };
          }
          expect(args).toEqual(['auth', 'wait', '--json', '--remote-enrollment', '--server', 'guest-home', '--no-persist', '--public-key', Buffer.alloc(32, 1).toString('base64')]);
          expect(approved).toBe(true);
          const result = { kind: 'remote_home_enrollment_result', protocolVersion: 1, success: true, homeServerIdentityId: correlation.homeId, machineId: 'joined-machine', encryptionType: 'tokenOnly', pairingAuthentication: 'v3', remoteProfileId: 'guest-home' };
          return { status: 0, stdout: `${JSON.stringify(result)}\n`, stderr: '' };
        },
      },
    });
    await runner.startAdmitted({ taskId: 'native-enrollment', kind: 'remote.ssh.bootstrapMachine.v1', params: {} }, task);
    await vi.waitFor(async () => {
      expect((await runner.poll({ taskId: 'native-enrollment', cursor: 0 })).pendingPrompt?.kind).toBe('auth.approveRemoteProvisioning');
    });
    expect((await runner.poll({ taskId: 'native-enrollment', cursor: 0 })).pendingPrompt?.data).toMatchObject({ credentialScope: 'account' });
    await runner.respond({ taskId: 'native-enrollment', answer: { approved: true } });
    await expect(runner.wait({ taskId: 'native-enrollment' })).resolves.toMatchObject({ ok: true, data: { machineId: 'joined-machine' } });
    expect(guestInput).toMatchObject({ managedEnrollment: correlation });
  });
});

type RemoteEnrollmentFixture = Readonly<{
  requestData?: Record<string, unknown>;
  resultData?: Readonly<{ homeServerIdentityId?: string; machineId?: string; remoteProfileId?: string }>;
  daemonActiveServerId?: string;
  onRun?: (params: RemoteEnrollmentExecutorParams) => void;
}>;

type RemoteSshBootstrapMachineTestDeps = RemoteSshBootstrapMachineDeps & Readonly<{
  remoteEnrollment?: RemoteEnrollmentFixture;
}>;

function createRemoteSshBootstrapMachineTaskKind({
  remoteEnrollment,
  ...deps
}: RemoteSshBootstrapMachineTestDeps) {
  if (deps.createRemoteEnrollmentExecutor) {
    return createProductionRemoteSshBootstrapMachineTaskKind(deps);
  }
  return createProductionRemoteSshBootstrapMachineTaskKind({
    ...deps,
    runRemoteCommand: async (params) => params.label === 'daemon.status'
      ? {
          ok: true,
          data: {
            service: { installed: true },
            daemon: { running: true },
            auth: { needsAuth: false, machineId: remoteEnrollment?.resultData?.machineId ?? 'remote-machine' },
            server: {
              activeServerId: remoteEnrollment?.daemonActiveServerId
                ?? remoteEnrollment?.resultData?.remoteProfileId
                ?? 'remote-home-profile',
            },
          },
        }
      : await deps.runRemoteCommand(params),
    createRemoteEnrollmentExecutor: (params) => ({
      runHappierJson: async () => { throw new Error('not used'); },
      runHappierText: async (_args, options) => {
        remoteEnrollment?.onRun?.(params);
        const requestData = createV3AuthRequestData(remoteEnrollment?.requestData);
        const publicKey = typeof requestData.publicKey === 'string' ? requestData.publicKey : '';
        const homeServerIdentityId = typeof requestData.homeServerIdentityId === 'string'
          ? requestData.homeServerIdentityId
          : 'srv_test_home';
        const request = {
          kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
          publicKey, homeServerIdentityId,
          pairing: requestData.pairing,
          supportsTokenOnly: true, pairingRequirement: 'v3',
        };
        options?.onStdoutChunk?.(`${JSON.stringify(request)}\n`);
        const machineId = remoteEnrollment?.resultData?.machineId ?? 'remote-machine';
        const result = {
          kind: 'remote_home_enrollment_result', protocolVersion: 1, success: true,
          homeServerIdentityId: remoteEnrollment?.resultData?.homeServerIdentityId ?? homeServerIdentityId,
          machineId,
          encryptionType: 'tokenOnly', pairingAuthentication: 'v3',
          remoteProfileId: remoteEnrollment?.resultData?.remoteProfileId ?? 'remote-home-profile',
        };
        const resultLine = `${JSON.stringify(result)}\n`;
        options?.onStdoutChunk?.(resultLine);
        return { status: 0, stdout: `${JSON.stringify(request)}\n${resultLine}`, stderr: '' };
      },
    }),
  });
}

const HOME_TARGET = {
  profileId: 'home-profile',
  homeServerIdentityId: 'srv_home_identity',
  descriptor: {
    v: 1 as const,
    homeServerIdentityId: 'srv_home_identity',
    canonicalServerUrl: 'https://home.example.test',
    revision: 1,
    endpoints: [{ kind: 'https' as const, url: 'https://home.example.test' }],
  },
  canonicalAuthUrl: 'https://home.example.test',
  applicationUrl: 'https://home.example.test',
  webappUrl: 'https://home.example.test',
  credentialDestination: {
    v: 1 as const,
    homeServerIdentityId: 'srv_home_identity',
    canonicalServerUrl: 'https://home.example.test',
    applicationEndpointUrls: ['https://home.example.test'],
    irohEndpointIds: [],
  },
  preferredTransport: 'https' as const,
  authority: 'saved_profile' as const,
};

const V3_PAIRING = {
  secretB64Url: 'pairing-secret-b64url',
  createdAtMs: 123,
  expiresAtMs: 456,
};

function createV3AuthRequestData(overrides: Record<string, unknown> = {}) {
  return {
    publicKey: 'pub-key',
    homeServerIdentityId: HOME_TARGET.homeServerIdentityId,
    pairing: V3_PAIRING,
    supportsTokenOnly: true,
    pairingRequirement: 'v3',
    ...overrides,
  };
}

async function waitForPendingPrompt(
  runner: ReturnType<typeof createSystemTasksRunner>,
  params: Readonly<{ taskId: string; cursor: number }>,
) {
  let latest = await runner.poll(params);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    latest = await runner.poll(params);
    if (latest.pendingPrompt) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Expected pending prompt for ${params.taskId}: ${JSON.stringify(latest)}`);
}

async function waitForResult(
  runner: ReturnType<typeof createSystemTasksRunner>,
  params: Readonly<{ taskId: string; cursor: number }>,
) {
  let latest = await runner.poll(params);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    latest = await runner.poll(params);
    if (latest.result) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Expected final result for ${params.taskId}: ${JSON.stringify(latest)}`);
}

describe('createRemoteSshBootstrapMachineTaskKind', () => {
  it.each([
    { serviceMode: 'none', relayRuntime: false },
    { serviceMode: 'user', relayRuntime: false },
    { serviceMode: 'user', relayRuntime: true },
  ] as const)('installs an empty descriptor target before any remote CLI use ($serviceMode, relay=$relayRuntime)', async ({ serviceMode, relayRuntime }) => {
    let installed = false;
    const steps: string[] = [];
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => { installed = true; steps.push('install'); },
      approveLocalAuthRequest: async () => undefined,
      remoteEnrollment: {
        resultData: { machineId: 'remote-machine' },
        onRun: () => {
          if (!installed) throw new Error('Remote CLI missing at enrollment');
          steps.push('enroll');
        },
      },
      runRemoteCommand: async ({ label }) => {
        if (!installed) throw new Error(`Remote CLI missing at ${label}`);
        steps.push(label);
        if (label === 'relay.runtime.install') return { ok: true, data: { relayUrl: HOME_TARGET.applicationUrl } };
        if (label === 'daemon.service.list') return { ok: true, data: { services: [], platform: 'darwin' } };
        if (label === 'auth.status') return { ok: true, data: {
          authenticated: true, credentialState: 'valid', machineRegistrationState: 'server-confirmed', machineId: 'remote-machine',
        } };
        if (label === 'daemon.service.install' || label === 'daemon.service.start') return { ok: true, data: {} };
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });
    const runner = createSystemTasksRunner({ kinds: { 'remote.ssh.bootstrapMachine.v1': kind } });
    await runner.start({
      taskId: 'empty-descriptor-target', kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: { target: 'dev@example.test', auth: 'agent' },
        relay: { relayUrl: HOME_TARGET.applicationUrl }, homeTarget: HOME_TARGET, serviceMode,
        ...(relayRuntime ? { relayRuntime: { enabled: true, mode: 'user' } } : {}),
        promptResolution: { authApproval: { publicKey: 'pub-key' } },
      },
    });
    const completed = await waitForResult(runner, { taskId: 'empty-descriptor-target', cursor: 0 });
    expect(completed.result).toMatchObject({ ok: true, data: { machineId: 'remote-machine' } });
    expect(steps[0]).toBe('install');
    expect(steps).toContain('enroll');
    expect(steps).not.toContain('server.configure');
  });

  it('enrolls an Iroh-only Home through the single-process streaming owner without public URL configuration', async () => {
    const endpointId = 'c'.repeat(64);
    const target = resolveHomeTargetFromDescriptor({
      descriptor: {
        v: 1,
        homeServerIdentityId: 'srv_iroh_only_home',
        canonicalServerUrl: 'http://localhost:3010',
        revision: 1,
        endpoints: [{ kind: 'iroh', endpointId }],
      },
      authority: 'trusted_enrollment',
    });
    const labels: string[] = [];
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async () => undefined,
      createRemoteEnrollmentExecutor: () => ({
        runHappierJson: async () => { throw new Error('JSON mode is not the streaming enrollment owner'); },
        runHappierText: async (_args, options) => {
          const request = JSON.stringify({
            kind: 'remote_home_enrollment_pairing_request',
            protocolVersion: 1,
            publicKey: Buffer.alloc(32, 1).toString('base64'),
            homeServerIdentityId: target.homeServerIdentityId,
            pairing: { secretB64Url: Buffer.alloc(32, 2).toString('base64url'), createdAtMs: 10, expiresAtMs: 20 },
            supportsTokenOnly: true,
            pairingRequirement: 'v3',
          });
          const result = JSON.stringify({
            kind: 'remote_home_enrollment_result',
            protocolVersion: 1,
            success: true,
            homeServerIdentityId: target.homeServerIdentityId,
            machineId: 'machine-iroh',
            encryptionType: 'tokenOnly',
            pairingAuthentication: 'v3',
            remoteProfileId: 'remote-home-profile',
          });
          options?.onStdoutChunk?.(`${request}\n${result}\n`);
          return { status: 0, stdout: `${request}\n${result}\n`, stderr: '' };
        },
      }),
      runRemoteCommand: async ({ label }) => {
        labels.push(label);
        if (label === 'auth.status') {
          return { ok: true, data: {
            authenticated: true,
            credentialState: 'valid',
            machineRegistrationState: 'server-confirmed',
            machineId: 'machine-iroh',
          } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });
    const runner = createSystemTasksRunner({ kinds: { 'remote.ssh.bootstrapMachine.v1': kind } });
    await runner.start({
      taskId: 'iroh-only-enrollment',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: { target: 'dev@example.test', auth: 'agent' },
        relay: { relayUrl: target.applicationUrl },
        homeTarget: target,
        serviceMode: 'none',
        promptResolution: {
          authApproval: { publicKey: Buffer.alloc(32, 1).toString('base64') },
        },
      },
    });
    const completed = await waitForResult(runner, { taskId: 'iroh-only-enrollment', cursor: 0 });
    expect(completed.result).toMatchObject({ ok: true, data: { machineId: 'machine-iroh' } });
    expect(labels).toEqual(['auth.status']);
    expect(JSON.stringify(completed)).not.toContain(Buffer.alloc(32, 2).toString('base64url'));
  });

  it('strictly parses and retains the canonical Home target instead of dropping it', () => {
    const parsed = parseRemoteBootstrapMachineParams({
      ssh: { target: 'dev@example.test', auth: 'agent' },
      relay: { relayUrl: 'https://home.example.test' },
      homeTarget: HOME_TARGET,
    });

    expect(parsed.homeTarget).toEqual(HOME_TARGET);
  });

  it('round-trips an Iroh-only Home target without fabricating an HTTPS destination', () => {
    const endpointId = 'c'.repeat(64);
    const target = resolveHomeTargetFromDescriptor({
      descriptor: {
        v: 1,
        homeServerIdentityId: 'srv_iroh_only_home',
        canonicalServerUrl: 'http://localhost:3010',
        revision: 1,
        endpoints: [{ kind: 'iroh', endpointId, relayUrls: ['https://relay.example.test/'] }],
      },
      authority: 'trusted_enrollment',
    });
    const serializedTarget = JSON.parse(JSON.stringify(target)) as unknown;

    expect(parseRemoteBootstrapMachineParams({
      ssh: { target: 'dev@example.test', auth: 'agent' },
      relay: { relayUrl: 'http://localhost:3010' },
      homeTarget: serializedTarget,
    }).homeTarget).toEqual(target);

    expect(() => parseRemoteBootstrapMachineParams({
      ssh: { target: 'dev@example.test', auth: 'agent' },
      relay: { relayUrl: 'http://localhost:3010' },
      homeTarget: {
        ...target,
        credentialDestination: { ...target.credentialDestination!, irohEndpointIds: ['d'.repeat(64)] },
      },
    })).toThrowError(expect.objectContaining({ code: 'invalid_target' }));
    expect(() => parseRemoteBootstrapMachineParams({
      ssh: { target: 'dev@example.test', auth: 'agent' },
      relay: { relayUrl: 'http://localhost:3010' },
      homeTarget: { ...target, preferredTransport: 'https' },
    })).toThrowError(expect.objectContaining({ code: 'invalid_target' }));
  });

  it('rejects the unreleased scalar Home identity authority', () => {
    expect(() => parseRemoteBootstrapMachineParams({
      ssh: { target: 'dev@example.test', auth: 'agent' },
      relay: { relayUrl: 'https://home.example.test' },
      expectedHomeServerIdentityId: HOME_TARGET.homeServerIdentityId,
    })).toThrowError(expect.objectContaining({ code: 'invalid_params' }));
  });

  it('fails pairing on canonical Home target identity mismatch without exposing the pairing secret', async () => {
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async () => {
        throw new Error('identity mismatch must fail before approval');
      },
      remoteEnrollment: {
        requestData: { homeServerIdentityId: 'srv_other_home' },
      },
      runRemoteCommand: async ({ label }) => {
        if (label === 'server.configure') return { ok: true, data: {} };
        if (label === 'auth.status') return { ok: true, data: { authenticated: false } };
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });
    const runner = createSystemTasksRunner({ kinds: { 'remote.ssh.bootstrapMachine.v1': kind } });

    await runner.start({
      taskId: 'home-target-mismatch',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: { target: 'dev@example.test', auth: 'agent' },
        relay: { relayUrl: 'https://home.example.test' },
        homeTarget: HOME_TARGET,
        serviceMode: 'none',
      },
    });

    const result = await waitForResult(runner, { taskId: 'home-target-mismatch', cursor: 0 });
    expect(result.result).toMatchObject({ ok: false, error: { code: 'home_identity_mismatch' } });
    expect(JSON.stringify(result)).not.toContain(V3_PAIRING.secretB64Url);
  });

  it('requires the selected Home to confirm the same machine identity before succeeding', async () => {
    let authStatusReads = 0;
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async () => undefined,
      runRemoteCommand: async ({ label }) => {
        if (label === 'server.configure') return { ok: true, data: {} };
        if (label === 'auth.status') {
          authStatusReads += 1;
          return authStatusReads === 1
            ? { ok: true, data: { authenticated: false } }
            : { ok: true, data: { authenticated: true, credentialState: 'valid', machineRegistrationState: 'local-only', machineId: 'machine-unconfirmed' } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    await expect(kind.run({
      params: {
        ssh: { target: 'dev@example.test', auth: 'agent' },
        relay: { relayUrl: 'https://home.example.test' },
        homeTarget: HOME_TARGET,
        serviceMode: 'none',
      },
      emit: () => undefined,
      prompt: async () => ({ approved: true }),
    })).rejects.toMatchObject({ code: 'machine_registration_unconfirmed' });
  });

  it('does not let a ready daemon on another active Home satisfy machine setup completion', async () => {
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async () => undefined,
      remoteEnrollment: {
        resultData: { machineId: 'machine-home-b', remoteProfileId: 'home-b' },
        daemonActiveServerId: 'cloud',
      },
      runRemoteCommand: async ({ label }) => {
        if (label === 'daemon.service.list') return { ok: true, data: { services: [] } };
        if (label === 'daemon.service.install' || label === 'daemon.service.start') return { ok: true, data: {} };
        if (label === 'auth.status') return { ok: true, data: {
          authenticated: true,
          credentialState: 'valid',
          machineRegistrationState: 'server-confirmed',
          machineId: 'machine-home-b',
        } };
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    await expect(kind.run({
      params: {
        ssh: { target: 'dev@example.test', auth: 'agent' },
        relay: { relayUrl: HOME_TARGET.applicationUrl },
        homeTarget: HOME_TARGET,
        serviceMode: 'user',
      },
      emit: () => undefined,
      prompt: async () => ({ approved: true, replaceExistingServices: true }),
    })).rejects.toMatchObject({ code: 'daemon_home_mismatch' });
  });

  it('does not let an already-authenticated daemon on Home A satisfy an explicit URL target for Home B', async () => {
    const homeB = {
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
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async () => {
        throw new Error('already-authenticated target must not request another approval');
      },
      remoteEnrollment: { daemonActiveServerId: 'home-a' },
      runRemoteCommand: async ({ label }) => {
        if (label === 'server.configure') {
          return { ok: true, data: { active: { id: 'home-b' } } };
        }
        if (label === 'daemon.service.list') return { ok: true, data: { services: [] } };
        if (label === 'daemon.service.install' || label === 'daemon.service.start') return { ok: true, data: {} };
        if (label === 'auth.status') return { ok: true, data: {
          authenticated: true,
          credentialState: 'valid',
          machineRegistrationState: 'server-confirmed',
          machineId: 'machine-home-b',
        } };
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    await expect(kind.run({
      params: {
        ssh: { target: 'dev@example.test', auth: 'agent' },
        relay: { relayUrl: homeB.applicationUrl },
        homeTarget: homeB,
        serviceMode: 'user',
      },
      emit: () => undefined,
      prompt: async () => ({ approved: true, replaceExistingServices: true }),
    })).rejects.toMatchObject({ code: 'daemon_home_mismatch' });
  });

  it('passes relayRuntime local URL to remote bootstrap commands so the remote CLI/daemon can prefer the locally hosted relay runtime', async () => {
    type RemoteLabel = Parameters<RemoteSshBootstrapMachineDeps['runRemoteCommand']>[0]['label'];

    const mapArgsToRemoteLabel = (args: readonly string[]) => {
      if (args[0] === 'server' && args[1] === 'set') return 'server.configure' as const;
      if (args[0] === 'auth' && args[1] === 'status') return 'auth.status' as const;
      if (args[0] === 'daemon' && args[1] === 'status') return 'daemon.status' as const;
      if (args[0] === 'service' && args[1] === 'install') return 'daemon.service.install' as const;
      if (args[0] === 'service' && args[1] === 'start') return 'daemon.service.start' as const;
      if (args[0] === 'daemon' && args[1] === 'service' && args[2] === 'install') return 'daemon.service.install' as const;
      if (args[0] === 'daemon' && args[1] === 'service' && args[2] === 'start') return 'daemon.service.start' as const;
      if (args[0] === 'relay' && args[1] === 'runtime' && args[2] === 'install') return 'relay.runtime.install' as const;
      throw new Error(`Unexpected remote happier args: ${JSON.stringify(args)}`);
    };

    let remoteCliInstalled = false;
    const runRemoteCommandBase: RemoteSshBootstrapMachineDeps['runRemoteCommand'] = async ({ label, parsed, data }) => {
      expect(parsed.relay.relayUrl).toBe('https://relay.example.test');

      if (label === 'relay.runtime.install') {
        return { ok: true, data: { relayUrl: 'http://127.0.0.1:9999', mode: 'user' } };
      }

      if (label === 'server.configure') {
        if (!remoteCliInstalled) {
          throw new Error('remote cli missing');
        }
        return { ok: true, data: { configured: true } };
      }

      if (label === 'auth.status') {
        return { ok: true, data: { authenticated: false } };
      }

      if (label === 'daemon.service.install') {
        return { ok: true, data: { installed: true } };
      }

      if (label === 'daemon.service.start') {
        return { ok: true, data: { started: true } };
      }

      if (label === 'daemon.status') {
        return { ok: true, data: {
          service: { installed: true },
          daemon: { running: true },
          auth: { needsAuth: false, machineId: 'remote-machine' },
          server: { activeServerId: 'remote-home-profile' },
        } };
      }

      throw new Error(`Unexpected remote command: ${label}`);
    };

    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => {
        remoteCliInstalled = true;
      },
      createHappierJsonExecutor: ({ parsed, auth, knownHostsMode, localServerUrl }) => ({
        runHappierJson: async ({ args }) => {
          const label: RemoteLabel = mapArgsToRemoteLabel(args);
          return await runRemoteCommandBase({
            label,
            parsed,
            auth,
            knownHostsMode,
            data: {
              ...(localServerUrl ? { localServerUrl } : {}),
              __viaExecutor: true,
            },
          });
        },
      }),
      approveLocalAuthRequest: async ({ parsed }) => {
        expect(parsed.relay.relayUrl).toBe('http://127.0.0.1:9999');
        expect(parsed.relay.publicRelayUrl).toBe('https://relay.example.test');
      },
      runRemoteCommand: async ({ label, parsed, auth, knownHostsMode, data }) => {
        if (label === 'server.configure' || label === 'daemon.service.install' || label === 'daemon.service.start') {
          expect((data ?? {}).localServerUrl).toBe('http://127.0.0.1:9999');
          expect((data ?? {}).__viaExecutor).toBe(true);
        }
        return await runRemoteCommandBase({
          label,
          parsed,
          auth,
          knownHostsMode,
          data,
        });
      },
    });

    const runner = createSystemTasksRunner({
      kinds: { 'remote.ssh.bootstrapMachine.v1': kind },
    });

    await runner.start({
      taskId: 'ssh-task',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'http://127.0.0.1:3005',
          publicRelayUrl: 'https://relay.example.test',
          webappUrl: 'http://localhost:3005',
        },
        relayRuntime: {
          enabled: true,
          mode: 'user',
        },
        channel: 'preview',
        serviceMode: 'user',
        promptResolution: {
          authApproval: {
            publicKey: 'pub-key',
          },
        },
      },
    });

    const result = await waitForResult(runner, { taskId: 'ssh-task', cursor: 0 });
    expect(result.result?.ok).toBe(true);
    if (!result.result || result.result.ok !== true) {
      throw new Error('Expected remote ssh bootstrap to succeed');
    }
    expect(result.result.data).toEqual({
      publicKey: 'pub-key',
      machineId: 'remote-machine',
      relayRuntime: {
        relayUrl: 'http://127.0.0.1:9999',
        mode: 'user',
      },
    });
  });

  it('keeps the original relay target when no public relay URL is available', async () => {
    const invocations: string[] = [];
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async ({ parsed }) => {
        expect(parsed.relay.relayUrl).toBe('https://api.happier.dev');
      },
      remoteEnrollment: { onRun: () => invocations.push('auth.enroll-remote') },
      runRemoteCommand: async ({ label, parsed, data }) => {
        invocations.push(label);
        if (label === 'relay.runtime.install') {
          return { ok: true, data: { relayUrl: 'http://127.0.0.1:9999', mode: 'user' } };
        }

        if (label === 'server.configure' || label === 'daemon.service.install' || label === 'daemon.service.start') {
          expect((data ?? {}).localServerUrl).toBeUndefined();
        }

        expect(parsed.relay.relayUrl).toBe('https://api.happier.dev');

        if (label === 'server.configure') {
          return { ok: true, data: { configured: true } };
        }

        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }

        if (label === 'daemon.service.install') {
          return { ok: true, data: { installed: true } };
        }

        if (label === 'daemon.service.start') {
          return { ok: true, data: { started: true } };
        }

        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: { 'remote.ssh.bootstrapMachine.v1': kind },
    });

    await runner.start({
      taskId: 'ssh-task',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://api.happier.dev',
          webappUrl: 'https://app.happier.dev',
        },
        relayRuntime: {
          enabled: true,
          mode: 'user',
        },
        channel: 'dev',
        serviceMode: 'user',
        promptResolution: {
          authApproval: {
            publicKey: 'pub-key',
          },
        },
      },
    });

    const result = await waitForResult(runner, { taskId: 'ssh-task', cursor: 0 });
    expect(result.result?.ok).toBe(true);
    if (!result.result || result.result.ok !== true) {
      throw new Error('Expected remote ssh bootstrap to succeed');
    }
    expect(result.result.data).toEqual({
      publicKey: 'pub-key',
      machineId: 'remote-machine',
      relayRuntime: {
        relayUrl: 'http://127.0.0.1:9999',
        mode: 'user',
      },
    });
    expect(invocations[0]).toBe('relay.runtime.install');
    expect(invocations).toContain('server.configure');
    expect(invocations.indexOf('relay.runtime.install')).toBeLessThan(invocations.indexOf('server.configure'));
    expect(invocations.indexOf('server.configure')).toBeLessThan(invocations.indexOf('auth.enroll-remote'));
  });

  it('switches to the installed relay runtime when relay.relayUrl is loopback and no public relay URL exists', async () => {
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async ({ parsed }) => {
        expect(parsed.relay.relayUrl).toBe('http://127.0.0.1:9999');
      },
      runRemoteCommand: async ({ label, parsed, data }) => {
        if (label === 'relay.runtime.install') {
          return { ok: true, data: { relayUrl: 'http://127.0.0.1:9999', mode: 'user' } };
        }

        if (
          label === 'server.configure'
          || label === 'daemon.service.install'
          || label === 'daemon.service.start'
        ) {
          expect((data ?? {}).localServerUrl).toBeUndefined();
          expect(parsed.relay.relayUrl).toBe('http://127.0.0.1:9999');
        }

        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }

        if (label === 'server.configure') {
          return { ok: true, data: { configured: true } };
        }

        if (label === 'daemon.service.install') {
          return { ok: true, data: { installed: true } };
        }

        if (label === 'daemon.service.start') {
          return { ok: true, data: { started: true } };
        }

        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: { 'remote.ssh.bootstrapMachine.v1': kind },
    });

    await runner.start({
      taskId: 'ssh-task-loopback',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'http://127.0.0.1:3005',
          webappUrl: 'http://localhost:3005',
        },
        relayRuntime: {
          enabled: true,
          mode: 'user',
        },
        channel: 'dev',
        serviceMode: 'user',
        promptResolution: {
          authApproval: {
            publicKey: 'pub-key',
          },
        },
      },
    });

    const result = await waitForResult(runner, { taskId: 'ssh-task-loopback', cursor: 0 });
    expect(result.result?.ok).toBe(true);
    if (!result.result || result.result.ok !== true) {
      throw new Error('Expected remote ssh bootstrap to succeed');
    }
    expect(result.result.data).toEqual({
      publicKey: 'pub-key',
      machineId: 'remote-machine',
      relayRuntime: {
        relayUrl: 'http://127.0.0.1:9999',
        mode: 'user',
      },
    });
  });

  it('prefers relay.publicRelayUrl for remote commands when provided', async () => {
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async () => undefined,
      runRemoteCommand: async ({ label, parsed }) => {
        expect(parsed.relay.relayUrl).toBe('https://public.example.test');
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }
        if (label === 'server.configure') {
          return { ok: true, data: { configured: true } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: { 'remote.ssh.bootstrapMachine.v1': kind },
    });

    await runner.start({
      taskId: 'ssh-task',
      kind: 'remote.ssh.bootstrapMachine.v1',
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
        serviceMode: 'none',
        promptResolution: {
          authApproval: {
            publicKey: 'pub-key',
          },
        },
      },
    });

    const result = await waitForResult(runner, { taskId: 'ssh-task', cursor: 0 });
    expect(result.result?.ok).toBe(true);
  });

  it('accepts publicdev as an alias for the dev channel label', async () => {
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async ({ parsed }) => {
        expect(parsed.channel).toBe('dev');
      },
      approveLocalAuthRequest: async () => undefined,
      runRemoteCommand: async ({ label }) => {
        if (label === 'auth.status') return { ok: true, data: { authenticated: true, credentialState: 'valid', machineRegistrationState: 'server-confirmed', machineId: 'machine-remote-0' } };
        if (label === 'server.configure') return { ok: true, data: { configured: true } };
        if (label === 'daemon.service.install') return { ok: true, data: { installed: true } };
        if (label === 'daemon.service.start') return { ok: true, data: { started: true } };
        return { ok: true, data: {} };
      },
    });

    const runner = createSystemTasksRunner({
      kinds: { 'remote.ssh.bootstrapMachine.v1': kind },
    });

    await runner.start({
      taskId: 'ssh-task',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://api.happier.dev',
          webappUrl: 'https://app.happier.dev',
        },
        channel: 'publicdev',
        serviceMode: 'user',
        promptResolution: {
          authApproval: {
            publicKey: 'pub',
          },
        },
      },
    });

    const result = await waitForResult(runner, { taskId: 'ssh-task', cursor: 0 });
    expect(result.result?.ok).toBe(true);
  });

  it('prompts for host trust, redacts auth secrets, and completes the canonical bootstrap flow in order', async () => {
    let remoteCliInstalled = false;
    const invocations: string[] = [];
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({
        status: 'prompt',
        promptKind: 'ssh.trustHost',
        promptMessage: 'Trust this SSH host?',
        promptData: {
          host: 'example.test',
          keyType: 'ssh-ed25519',
          fingerprint: 'SHA256:abc',
        },
        accept: async () => undefined,
      }),
      installRemoteCli: async ({ parsed }) => {
        expect(parsed.channel).toBe('preview');
        invocations.push('installRemoteCli');
        remoteCliInstalled = true;
      },
      approveLocalAuthRequest: async ({ publicKey }) => {
        invocations.push(`approveLocalAuthRequest:${publicKey}`);
      },
      remoteEnrollment: {
        resultData: { machineId: 'machine-remote-0' },
        onRun: () => invocations.push('auth.enroll-remote'),
      },
      runRemoteCommand: async ({ label, data }) => {
        invocations.push(label);
        if (label === 'server.configure') {
          if (!remoteCliInstalled) {
            throw new Error('remote happier cli not installed');
          }
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }
        if (label === 'daemon.service.install') {
          return { ok: true, data: { installed: true } };
        }
        if (label === 'daemon.service.start') {
          return { ok: true, data: { started: true } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      now: (() => {
        let ts = 2_000;
        return () => ts++;
      })(),
      kinds: {
        'remote.ssh.bootstrapMachine.v1': kind,
      },
    });

    await runner.start({
      taskId: 'ssh-task',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        channel: 'preview',
        serviceMode: 'user',
      },
    });
    const firstPoll = await waitForPendingPrompt(runner, { taskId: 'ssh-task', cursor: 0 });
    expect(firstPoll.pendingPrompt).toEqual({
      kind: 'ssh.trustHost',
      data: {
        host: 'example.test',
        keyType: 'ssh-ed25519',
        fingerprint: 'SHA256:abc',
      },
    });

    await runner.respond({
      taskId: 'ssh-task',
      answer: { trusted: true },
    });

    const secondPoll = await waitForPendingPrompt(runner, { taskId: 'ssh-task', cursor: firstPoll.nextCursor });
    expect(secondPoll.pendingPrompt).toEqual({
      kind: 'auth.approveRemoteProvisioning',
      data: {
        publicKey: 'pub-key',
        homeServerIdentityId: 'srv_home_identity',
        pairing: {
          createdAtMs: V3_PAIRING.createdAtMs,
          expiresAtMs: V3_PAIRING.expiresAtMs,
        },
        pairingRequirement: 'v3',
      },
    });

    await runner.respond({
      taskId: 'ssh-task',
      answer: { approved: true },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-task', cursor: secondPoll.nextCursor });
    expect(finalPoll.result).toEqual({
      protocolVersion: 1,
      taskId: 'ssh-task',
      ok: true,
      data: {
        publicKey: 'pub-key',
        machineId: 'machine-remote-0',
      },
    });
    expect(invocations).toEqual([
      'installRemoteCli',
      'daemon.service.list',
      'server.configure',
      'auth.status',
      'auth.enroll-remote',
      'approveLocalAuthRequest:pub-key',
      'daemon.service.install',
      'daemon.service.start',
    ]);
  });

  it('forwards the remote request pairing context and token-only capability to approveLocalAuthRequest', async () => {
    let remoteCliInstalled = false;
    let installCalls = 0;
    let authRequestCalls = 0;
    let remoteEnrollmentSignal: AbortSignal | undefined;
    let approvalInput: unknown;
    const forwarded: Array<Record<string, unknown>> = [];
    const pairing = { secretB64Url: 'pairing-secret-b64url', createdAtMs: 123, expiresAtMs: 456 };
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => {
        remoteCliInstalled = true;
        installCalls += 1;
      },
      approveLocalAuthRequest: async (input) => {
        approvalInput = input;
        const { publicKey, homeServerIdentityId, pairing: forwardedPairing, supportsTokenOnly } = input;
        forwarded.push({ publicKey, homeServerIdentityId, pairing: forwardedPairing, supportsTokenOnly });
      },
      remoteEnrollment: {
        requestData: {
          claimSecret: 'secret-value',
          stateFile: '/tmp/claim-state.json',
          pairing,
        },
        resultData: { machineId: 'machine-remote-pairing' },
        onRun: (params) => {
          authRequestCalls += 1;
          remoteEnrollmentSignal = params.signal;
        },
      },
      runRemoteCommand: async ({ label, data }) => {
        if (label === 'server.configure') {
          if (!remoteCliInstalled) {
            throw new Error('remote happier cli not installed');
          }
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'remote.ssh.bootstrapMachine.v1': kind,
      },
    });

    await runner.start({
      taskId: 'ssh-pairing-context-task',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        channel: 'preview',
        serviceMode: 'none',
        promptResolution: {
          authApproval: {
            publicKey: 'pub-key',
          },
        },
      },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-pairing-context-task', cursor: 0 });
    expect(finalPoll.result?.ok).toBe(true);
    expect(installCalls).toBe(1);
    expect(authRequestCalls).toBe(1);
    // The remote request's pairing context must reach the local approval verbatim
    // so the approval seals a pairing-bound v3 response instead of failing closed.
    expect(forwarded).toEqual([
      { publicKey: 'pub-key', homeServerIdentityId: 'srv_home_identity', pairing, supportsTokenOnly: true },
    ]);
    expect(approvalInput).toEqual(expect.objectContaining({ signal: remoteEnrollmentSignal }));
  });

  it('prompts for SSH passwords without leaking the password into emitted prompt events', async () => {
    let remoteCliInstalled = false;
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => {
        remoteCliInstalled = true;
      },
      approveLocalAuthRequest: async () => undefined,
      runRemoteCommand: async ({ label }) => {
        if (label === 'server.configure') {
          if (!remoteCliInstalled) {
            throw new Error('remote cli should not be required for password prompt handling');
          }
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: true, credentialState: 'valid', machineRegistrationState: 'server-confirmed', machineId: 'machine-password' } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: { 'remote.ssh.bootstrapMachine.v1': kind },
    });

    await runner.start({
      taskId: 'ssh-password-task',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'password',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        serviceMode: 'none',
      },
    });

    const firstPoll = await waitForPendingPrompt(runner, { taskId: 'ssh-password-task', cursor: 0 });
    expect(firstPoll.pendingPrompt).toEqual({
      kind: 'ssh.password',
      data: {
        target: 'dev@example.test',
      },
    });
    expect(JSON.stringify(firstPoll.events)).not.toContain('super-secret');

    await runner.respond({
      taskId: 'ssh-password-task',
      answer: { password: 'super-secret' },
    });

    const result = await waitForResult(runner, { taskId: 'ssh-password-task', cursor: firstPoll.nextCursor });
    expect(result.result?.ok).toBe(true);
  });

  it('does not prompt for SSH passwords when ssh.password is provided in params', async () => {
    let remoteCliInstalled = false;
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => {
        remoteCliInstalled = true;
      },
      approveLocalAuthRequest: async () => undefined,
      runRemoteCommand: async ({ label }) => {
        if (label === 'server.configure') {
          if (!remoteCliInstalled) {
            throw new Error('remote cli missing');
          }
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: true, credentialState: 'valid', machineRegistrationState: 'server-confirmed', machineId: 'machine-password-provided' } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: { 'remote.ssh.bootstrapMachine.v1': kind },
    });

    await runner.start({
      taskId: 'ssh-password-provided',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'password',
          password: 'super-secret',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        serviceMode: 'none',
      },
    });

    const result = await waitForResult(runner, { taskId: 'ssh-password-provided', cursor: 0 });
    expect(result.result?.ok).toBe(true);
    expect(result.events.some((event) => event.type === 'prompt')).toBe(false);
  });

  it('accepts ssh.identityPrivateKey for keyfile auth by materializing a temp identity file for the run', async () => {
    let remoteCliInstalled = false;
    let observedIdentityPath: string | null = null;
    const privateKeyMaterial = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n';

    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => {
        remoteCliInstalled = true;
      },
      approveLocalAuthRequest: async () => undefined,
      runRemoteCommand: async ({ label, auth }) => {
        if (label === 'server.configure') {
          if (!remoteCliInstalled) {
            throw new Error('remote cli missing');
          }
          if (auth.mode !== 'keyFile') {
            throw new Error('expected keyFile auth');
          }
          observedIdentityPath = auth.privateKeyPath;
          const contents = await readFile(auth.privateKeyPath, 'utf8');
          expect(contents).toContain('abc');
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: true, credentialState: 'valid', machineRegistrationState: 'server-confirmed', machineId: 'machine-key-material' } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: { 'remote.ssh.bootstrapMachine.v1': kind },
    });

    await runner.start({
      taskId: 'key-material',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'keyfile',
          identityPrivateKey: privateKeyMaterial,
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        serviceMode: 'none',
      },
    });

    const result = await waitForResult(runner, { taskId: 'key-material', cursor: 0 });
    expect(result.result?.ok).toBe(true);
    expect(typeof observedIdentityPath).toBe('string');

    if (observedIdentityPath) {
      await expect(stat(observedIdentityPath)).rejects.toBeTruthy();
    }
  });

  it('continues when the remote machine is already authenticated', async () => {
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({
        status: 'prompt',
        promptKind: 'ssh.trustHost',
        promptMessage: 'Trust this SSH host?',
        promptData: {
          host: 'example.test',
          keyType: 'ssh-ed25519',
          fingerprint: 'SHA256:abc',
        },
        accept: async () => undefined,
      }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async () => {
        throw new Error('should not approve when already authenticated');
      },
      runRemoteCommand: async ({ label }) => {
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: true, credentialState: 'valid', machineRegistrationState: 'server-confirmed', machineId: 'machine-already' } };
        }
        if (label === 'server.configure') {
          return { ok: true, data: {} };
        }
        if (label === 'daemon.service.install') {
          return { ok: true, data: {} };
        }
        if (label === 'daemon.service.start') {
          return { ok: true, data: {} };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'remote.ssh.bootstrapMachine.v1': kind,
      },
    });

    await runner.start({
      taskId: 'ssh-task-authenticated',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
      },
    });

    const firstPoll = await waitForPendingPrompt(runner, { taskId: 'ssh-task-authenticated', cursor: 0 });
    expect(firstPoll.pendingPrompt?.kind).toBe('ssh.trustHost');

    await runner.respond({
      taskId: 'ssh-task-authenticated',
      answer: { trusted: true },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-task-authenticated', cursor: firstPoll.nextCursor });
    expect(finalPoll.result).toEqual({
      protocolVersion: 1,
      taskId: 'ssh-task-authenticated',
      ok: true,
      data: {
        machineId: 'machine-already',
      },
    });
  });

  it('prompts before replacing conflicting remote background services and removes them when approved', async () => {
    const invocations: string[] = [];
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async () => undefined,
      remoteEnrollment: { onRun: () => invocations.push('auth.enroll-remote') },
      runRemoteCommand: async ({ label, data }) => {
        invocations.push(label);
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }
        if (label === 'server.configure') {
          return { ok: true, data: { configured: true } };
        }
        if (label === 'daemon.service.list') {
          return {
            ok: true,
            data: {
              services: [
                {
                  id: 'service-preview',
                  serviceType: 'daemon',
                  label: 'happier-daemon.preview',
                  ring: 'preview',
                  targetMode: 'pinned',
                  installed: true,
                  running: true,
                },
              ],
            },
          };
        }
        if (label === 'daemon.service.uninstallAll') {
          return { ok: true, data: { removed: 1 } };
        }
        if (label === 'daemon.service.install') {
          return { ok: true, data: { installed: true } };
        }
        if (label === 'daemon.service.start') {
          return { ok: true, data: { started: true } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'remote.ssh.bootstrapMachine.v1': kind,
      },
    });

    await runner.start({
      taskId: 'ssh-task-conflict',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        channel: 'dev',
        serviceMode: 'user',
        promptResolution: {
          authApproval: {
            publicKey: 'pub-key',
          },
        },
      },
    });

    const promptPoll = await waitForPendingPrompt(runner, { taskId: 'ssh-task-conflict', cursor: 0 });
    expect(promptPoll.pendingPrompt).toEqual({
      kind: 'daemon.replaceRemoteBackgroundServices',
      data: {
        targetServerUrl: 'https://relay.example.test',
        targetReleaseChannel: 'dev',
        services: [
          {
            label: 'happier-daemon.preview',
            releaseChannel: 'preview',
            targetMode: 'pinned',
            running: true,
          },
        ],
      },
    });

    await runner.respond({
      taskId: 'ssh-task-conflict',
      answer: { replaceExistingServices: true },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-task-conflict', cursor: promptPoll.nextCursor });
    expect(finalPoll.result).toEqual({
      protocolVersion: 1,
      taskId: 'ssh-task-conflict',
      ok: true,
      data: {
        publicKey: 'pub-key',
        machineId: 'remote-machine',
      },
    });
    expect(invocations).toEqual([
      'daemon.service.list',
      'daemon.service.uninstallAll',
      'server.configure',
      'auth.status',
      'auth.enroll-remote',
      'daemon.service.install',
      'daemon.service.start',
    ]);
  });

  it('fails without pairing when conflicting services are not reconciled', async () => {
    const invocations: string[] = [];
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async () => undefined,
      runRemoteCommand: async ({ label, data }) => {
        invocations.push(label);
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }
        if (label === 'server.configure') {
          return { ok: true, data: { configured: true } };
        }
        if (label === 'daemon.service.list') {
          return {
            ok: true,
            data: {
              services: [
                {
                  id: 'service-preview',
                  serviceType: 'daemon',
                  label: 'happier-daemon.preview',
                  ring: 'preview',
                  targetMode: 'pinned',
                  installed: true,
                  running: true,
                },
              ],
            },
          };
        }
        if (label === 'daemon.service.uninstallAll' || label === 'daemon.service.install' || label === 'daemon.service.start') {
          throw new Error(`Did not expect ${label} when replacement is declined`);
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'remote.ssh.bootstrapMachine.v1': kind,
      },
    });

    await runner.start({
      taskId: 'ssh-task-conflict-decline',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        channel: 'dev',
        serviceMode: 'user',
        promptResolution: {
          authApproval: {
            publicKey: 'pub-key',
          },
        },
      },
    });

    const promptPoll = await waitForPendingPrompt(runner, { taskId: 'ssh-task-conflict-decline', cursor: 0 });
    expect(promptPoll.pendingPrompt?.kind).toBe('daemon.replaceRemoteBackgroundServices');

    await runner.respond({
      taskId: 'ssh-task-conflict-decline',
      answer: { replaceExistingServices: false },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-task-conflict-decline', cursor: promptPoll.nextCursor });
    expect(finalPoll.result).toEqual({
      protocolVersion: 1,
      taskId: 'ssh-task-conflict-decline',
      ok: false,
      error: {
        code: 'service_reconciliation_declined',
        message: SERVICE_RECONCILIATION_DECLINED_MESSAGE,
      },
    });
    expect(invocations).toEqual([
      'daemon.service.list',
    ]);
  });

  it('continues waiting for pairing even when local approval cannot be submitted because the operator is not authenticated', async () => {
    const invocations: string[] = [];
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async () => {
        throw new Error('Not authenticated. Run `happier auth login` first.');
      },
      remoteEnrollment: { onRun: () => invocations.push('auth.enroll-remote') },
      runRemoteCommand: async ({ label, data }) => {
        invocations.push(label);
        if (label === 'server.configure') {
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: { 'remote.ssh.bootstrapMachine.v1': kind },
    });

    await runner.start({
      taskId: 'ssh-task-not-auth',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        channel: 'preview',
        serviceMode: 'none',
      },
    });

    const firstPoll = await waitForPendingPrompt(runner, { taskId: 'ssh-task-not-auth', cursor: 0 });
    expect(firstPoll.pendingPrompt?.kind).toBe('auth.approveRemoteProvisioning');
    await runner.respond({
      taskId: 'ssh-task-not-auth',
      answer: { approved: true },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-task-not-auth', cursor: firstPoll.nextCursor });
    expect(finalPoll.result?.ok).toBe(true);
    expect(invocations).toEqual(['server.configure', 'auth.status', 'auth.enroll-remote']);
  });

  it('fails closed when local approval is required but cannot be submitted because the operator is not authenticated', async () => {
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async () => {
        throw new Error('Not authenticated. Run `happier auth login` first.');
      },
      runRemoteCommand: async ({ label, data }) => {
        if (label === 'server.configure') {
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: { 'remote.ssh.bootstrapMachine.v1': kind },
    });

    await runner.start({
      taskId: 'ssh-task-not-auth-required',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        channel: 'preview',
        serviceMode: 'none',
        requireLocalApproval: true,
      },
    });

    const firstPoll = await waitForPendingPrompt(runner, { taskId: 'ssh-task-not-auth-required', cursor: 0 });
    expect(firstPoll.pendingPrompt?.kind).toBe('auth.approveRemoteProvisioning');
    await runner.respond({
      taskId: 'ssh-task-not-auth-required',
      answer: { approved: true },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-task-not-auth-required', cursor: firstPoll.nextCursor });
    expect(finalPoll.result).toEqual({
      protocolVersion: 1,
      taskId: 'ssh-task-not-auth-required',
      ok: false,
      error: {
        code: 'local_approval_required',
        message: 'Remote setup requires local approval, but this CLI is not authenticated.',
      },
    });
  });

  it('fails closed when relay.relayUrl is loopback and relay runtime install is not enabled', async () => {
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => {
        throw new Error('should not install cli when relay url is invalid');
      },
      approveLocalAuthRequest: async () => {
        throw new Error('should not approve when relay url is invalid');
      },
      runRemoteCommand: async () => {
        throw new Error('should not run remote commands when relay url is invalid');
      },
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'remote.ssh.bootstrapMachine.v1': kind,
      },
    });

    await runner.start({
      taskId: 'ssh-task-loopback-relay',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'http://localhost.:3005',
          webappUrl: 'http://localhost.:3005',
        },
      },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-task-loopback-relay', cursor: 0 });
    expect(finalPoll.result).toEqual({
      protocolVersion: 1,
      taskId: 'ssh-task-loopback-relay',
      ok: false,
      error: {
        code: 'relay_url_unreachable',
        message: 'Remote setup cannot use a loopback Relay URL. Provide relay.publicRelayUrl.',
      },
    });
  });

  it('allows loopback relay URLs when relay runtime install is enabled and keeps the relay target explicit while reconciling remote commands to the installed runtime', async () => {
    const invocations: Array<Readonly<{ label: string; relayUrl: string; localServerUrl?: string }>> = [];
    const approvalCalls: Array<Readonly<{ relayUrl: string }>> = [];
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async ({ parsed }) => {
        approvalCalls.push({
          relayUrl: parsed.relay.relayUrl,
        });
      },
      remoteEnrollment: {
        resultData: { machineId: 'machine-loopback-1' },
        onRun: ({ parsed }) => invocations.push({
          label: 'auth.enroll-remote',
          relayUrl: parsed.relay.relayUrl,
        }),
      },
      runRemoteCommand: async ({ label, parsed, data }) => {
        invocations.push({
          label,
          relayUrl: parsed.relay.relayUrl,
          ...(typeof data?.localServerUrl === 'string'
            ? { localServerUrl: data.localServerUrl }
            : {}),
        });

        if (label === 'relay.runtime.install') {
          return { ok: true, data: { relayUrl: 'http://10.0.0.5:3005' } };
        }
        if (label === 'server.configure' || label === 'daemon.service.install' || label === 'daemon.service.start') {
          expect((data ?? {}).localServerUrl).toBe('http://10.0.0.5:3005');
        }
        if (label === 'server.configure') {
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }
        if (label === 'daemon.service.install') {
          return { ok: true, data: { installed: true } };
        }
        if (label === 'daemon.service.start') {
          return { ok: true, data: { started: true } };
        }

        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'remote.ssh.bootstrapMachine.v1': kind,
      },
    });

    await runner.start({
      taskId: 'ssh-task-loopback-install-relay-runtime',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'http://127.0.0.1:3005',
          webappUrl: 'http://127.0.0.1:3005',
        },
        serviceMode: 'user',
        relayRuntime: {
          enabled: true,
          mode: 'user',
        },
        promptResolution: {
          authApproval: {
            publicKey: 'pub-key',
          },
        },
      },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-task-loopback-install-relay-runtime', cursor: 0 });
    expect(finalPoll.result).toEqual({
      protocolVersion: 1,
      taskId: 'ssh-task-loopback-install-relay-runtime',
      ok: true,
      data: {
        publicKey: 'pub-key',
        machineId: 'machine-loopback-1',
        relayRuntime: {
          relayUrl: 'http://10.0.0.5:3005',
          mode: 'user',
        },
      },
    });
    expect(approvalCalls).toEqual([
      {
        relayUrl: 'http://127.0.0.1:3005',
      },
    ]);
    expect(invocations).toEqual([
      { label: 'relay.runtime.install', relayUrl: 'http://127.0.0.1:3005' },
      { label: 'daemon.service.list', relayUrl: 'http://127.0.0.1:3005', localServerUrl: 'http://10.0.0.5:3005' },
      { label: 'server.configure', relayUrl: 'http://127.0.0.1:3005', localServerUrl: 'http://10.0.0.5:3005' },
      { label: 'auth.status', relayUrl: 'http://127.0.0.1:3005', localServerUrl: 'http://10.0.0.5:3005' },
      { label: 'auth.enroll-remote', relayUrl: 'http://127.0.0.1:3005' },
      { label: 'daemon.service.install', relayUrl: 'http://127.0.0.1:3005', localServerUrl: 'http://10.0.0.5:3005' },
      { label: 'daemon.service.start', relayUrl: 'http://127.0.0.1:3005', localServerUrl: 'http://10.0.0.5:3005' },
    ]);
  });

  it('installs the CLI before the optional relay runtime and machine pairing', async () => {
    const invocations: Array<Readonly<{ label: string; data?: Record<string, unknown> }>> = [];
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({
        status: 'prompt',
        promptKind: 'ssh.trustHost',
        promptMessage: 'Trust this SSH host?',
        promptData: {
          host: 'example.test',
          keyType: 'ssh-ed25519',
          fingerprint: 'SHA256:abc',
        },
        accept: async () => undefined,
      }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async () => undefined,
      remoteEnrollment: { resultData: { machineId: 'machine-remote-relay-1' } },
      runRemoteCommand: async ({ label, data }) => {
        invocations.push({ label, data });
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }
        if (label === 'server.configure') {
          return { ok: true, data: { configured: true } };
        }
        if (label === 'relay.runtime.install') {
          return { ok: true, data: { relayUrl: 'http://10.0.0.5:3005' } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'remote.ssh.bootstrapMachine.v1': kind,
      },
    });

    await runner.start({
      taskId: 'ssh-relay-task',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        serviceMode: 'none',
        relayRuntime: {
          enabled: true,
          mode: 'system',
          env: {
            PORT: '4455',
          },
          selfHostRelayBinaryOverride: '/tmp/happier-server',
        },
      },
    });
    const firstPoll = await waitForPendingPrompt(runner, { taskId: 'ssh-relay-task', cursor: 0 });
    expect(firstPoll.pendingPrompt?.kind).toBe('ssh.trustHost');
    await runner.respond({ taskId: 'ssh-relay-task', answer: { trusted: true } });

    const secondPoll = await waitForPendingPrompt(runner, { taskId: 'ssh-relay-task', cursor: firstPoll.nextCursor });
    expect(secondPoll.pendingPrompt?.kind).toBe('auth.approveRemoteProvisioning');
    expect(secondPoll.events.map((event) => event.stepId)).toEqual([
      'ssh.installCli',
      'relay.runtime.install',
      'ssh.auth.request',
      'ssh.auth.wait',
      'ssh.auth.approval',
    ]);
    await runner.respond({ taskId: 'ssh-relay-task', answer: { approved: true } });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-relay-task', cursor: secondPoll.nextCursor });

    expect(finalPoll.events.map((event) => event.stepId)).toEqual(['ssh.complete']);
    expect(finalPoll.result).toEqual({
      protocolVersion: 1,
      taskId: 'ssh-relay-task',
      ok: true,
      data: {
        publicKey: 'pub-key',
        machineId: 'machine-remote-relay-1',
        relayRuntime: {
          relayUrl: 'http://10.0.0.5:3005',
          mode: 'system',
        },
      },
    });
    expect(invocations.map((entry) => entry.label)).toContain('relay.runtime.install');
  });

  it('keeps the remote CLI/daemon on the original relay target while using the installed relay runtime as the local server URL', async () => {
    const invocations: Array<Readonly<{ label: string; relayUrl: string }>> = [];
    const installRemoteCliCalls: Array<Readonly<{ relayUrl: string }>> = [];
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async ({ parsed }) => {
        installRemoteCliCalls.push({
          relayUrl: parsed.relay.relayUrl,
        });
      },
      approveLocalAuthRequest: async () => undefined,
      remoteEnrollment: {
        resultData: { machineId: 'machine-runtime-port-1' },
        onRun: ({ parsed }) => invocations.push({ label: 'auth.enroll-remote', relayUrl: parsed.relay.relayUrl }),
      },
      runRemoteCommand: async ({ label, parsed }) => {
        invocations.push({
          label,
          relayUrl: parsed.relay.relayUrl,
        });
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }
        if (label === 'server.configure') {
          return { ok: true, data: { configured: true } };
        }
        if (label === 'relay.runtime.install') {
          return { ok: true, data: { relayUrl: 'http://10.0.0.5:3005' } };
        }
        if (label === 'daemon.service.install') {
          return { ok: true, data: { installed: true } };
        }
        if (label === 'daemon.service.start') {
          return { ok: true, data: { started: true } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'remote.ssh.bootstrapMachine.v1': kind,
      },
    });

    await runner.start({
      taskId: 'ssh-relay-runtime-switch',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        serviceMode: 'user',
        relayRuntime: {
          enabled: true,
          mode: 'user',
        },
      },
    });

    const firstPoll = await waitForPendingPrompt(runner, { taskId: 'ssh-relay-runtime-switch', cursor: 0 });
    expect(firstPoll.pendingPrompt?.kind).toBe('auth.approveRemoteProvisioning');
    await runner.respond({
      taskId: 'ssh-relay-runtime-switch',
      answer: { approved: true },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-relay-runtime-switch', cursor: firstPoll.nextCursor });
    expect(finalPoll.result?.ok).toBe(true);

    expect(invocations).toEqual([
      { label: 'relay.runtime.install', relayUrl: 'https://relay.example.test' },
      { label: 'daemon.service.list', relayUrl: 'https://relay.example.test' },
      { label: 'server.configure', relayUrl: 'https://relay.example.test' },
      { label: 'auth.status', relayUrl: 'https://relay.example.test' },
      { label: 'auth.enroll-remote', relayUrl: 'https://relay.example.test' },
      { label: 'daemon.service.install', relayUrl: 'https://relay.example.test' },
      { label: 'daemon.service.start', relayUrl: 'https://relay.example.test' },
    ]);
    expect(installRemoteCliCalls).toEqual([
      { relayUrl: 'https://relay.example.test' },
    ]);
  });

  it('approves remote pairing against the relay runtime local URL while preserving the public relay URL for canonical targeting', async () => {
    const approvalCalls: Array<Readonly<{ relayUrl: string; publicRelayUrl?: string; webappUrl?: string }>> = [];
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async ({ parsed }) => {
        approvalCalls.push({
          relayUrl: parsed.relay.relayUrl,
          ...(parsed.relay.publicRelayUrl ? { publicRelayUrl: parsed.relay.publicRelayUrl } : {}),
          ...(parsed.relay.webappUrl ? { webappUrl: parsed.relay.webappUrl } : {}),
        });
      },
      runRemoteCommand: async ({ label }) => {
        if (label === 'relay.runtime.install') {
          return { ok: true, data: { relayUrl: 'https://relay-runtime.example.test' } };
        }
        if (label === 'server.configure') {
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }
        return { ok: true, data: {} };
      },
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'remote.ssh.bootstrapMachine.v1': kind,
      },
    });

    await runner.start({
      taskId: 'ssh-relay-runtime-approval',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'http://127.0.0.1:3005',
          webappUrl: 'http://127.0.0.1:3005',
          publicRelayUrl: 'https://public-relay.example.test',
        },
        relayRuntime: {
          enabled: true,
          mode: 'user',
        },
        serviceMode: 'none',
        promptResolution: {
          authApproval: {
            publicKey: 'pub-key',
          },
        },
      },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-relay-runtime-approval', cursor: 0 });
    expect(finalPoll.result?.ok).toBe(true);
    expect(approvalCalls).toEqual([
      {
        relayUrl: 'https://relay-runtime.example.test',
        publicRelayUrl: 'https://public-relay.example.test',
        webappUrl: 'http://127.0.0.1:3005',
      },
    ]);
  });

  it('derives the installed relay runtime URL from serverPort without switching the remote CLI/daemon by default', async () => {
    const invocations: Array<Readonly<{ label: string; relayUrl: string }>> = [];
    const installRemoteCliCalls: Array<Readonly<{ relayUrl: string }>> = [];
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async ({ parsed }) => {
        installRemoteCliCalls.push({
          relayUrl: parsed.relay.relayUrl,
        });
      },
      approveLocalAuthRequest: async () => undefined,
      remoteEnrollment: {
        resultData: { machineId: 'machine-runtime-port-1' },
        onRun: ({ parsed }) => invocations.push({ label: 'auth.enroll-remote', relayUrl: parsed.relay.relayUrl }),
      },
      runRemoteCommand: async ({ label, parsed }) => {
        invocations.push({
          label,
          relayUrl: parsed.relay.relayUrl,
        });
        if (label === 'relay.runtime.install') {
          return { ok: true, data: { serverPort: 4449 } };
        }
        if (label === 'server.configure') {
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }
        if (label === 'daemon.service.install') {
          return { ok: true, data: { installed: true } };
        }
        if (label === 'daemon.service.start') {
          return { ok: true, data: { started: true } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'remote.ssh.bootstrapMachine.v1': kind,
      },
    });

    await runner.start({
      taskId: 'ssh-relay-runtime-serverPort',
      kind: 'remote.ssh.bootstrapMachine.v1',
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
        serviceMode: 'user',
        relayRuntime: {
          enabled: true,
          mode: 'user',
        },
        promptResolution: {
          authApproval: {
            publicKey: 'pub-key',
          },
        },
      },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-relay-runtime-serverPort', cursor: 0 });
    expect(finalPoll.result).toEqual({
      protocolVersion: 1,
      taskId: 'ssh-relay-runtime-serverPort',
      ok: true,
      data: {
        publicKey: 'pub-key',
        machineId: 'machine-runtime-port-1',
        relayRuntime: {
          relayUrl: 'http://127.0.0.1:4449',
          mode: 'user',
        },
      },
    });

    expect(invocations).toEqual([
      { label: 'relay.runtime.install', relayUrl: 'https://public.example.test' },
      { label: 'daemon.service.list', relayUrl: 'https://public.example.test' },
      { label: 'server.configure', relayUrl: 'https://public.example.test' },
      { label: 'auth.status', relayUrl: 'https://public.example.test' },
      { label: 'auth.enroll-remote', relayUrl: 'https://public.example.test' },
      { label: 'daemon.service.install', relayUrl: 'https://public.example.test' },
      { label: 'daemon.service.start', relayUrl: 'https://public.example.test' },
    ]);
    expect(installRemoteCliCalls).toEqual([
      { relayUrl: 'https://public.example.test' },
    ]);
  });

  it('skips interactive prompts when matching desktop prompt resolutions are provided', async () => {
    const invocations: string[] = [];
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({
        status: 'prompt',
        promptKind: 'ssh.trustHost',
        promptMessage: 'Trust this SSH host?',
        promptData: {
          host: 'example.test',
          keyType: 'ssh-ed25519',
          fingerprint: 'SHA256:abc',
        },
        accept: async () => {
          invocations.push('acceptHostTrust');
        },
      }),
      installRemoteCli: async () => { invocations.push('installRemoteCli'); },
      approveLocalAuthRequest: async ({ publicKey }) => {
        invocations.push(`approveLocalAuthRequest:${publicKey}`);
      },
      remoteEnrollment: {
        resultData: { machineId: 'machine-remote-1' },
        onRun: () => invocations.push('auth.enroll-remote'),
      },
      runRemoteCommand: async ({ label, data }) => {
        invocations.push(label);
        if (label === 'server.configure') {
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }
        if (label === 'daemon.service.install') {
          return { ok: true, data: { installed: true } };
        }
        if (label === 'daemon.service.start') {
          return { ok: true, data: { started: true } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const promptCalls: string[] = [];
    const result = await kind.run({
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        promptResolution: {
          hostTrust: {
            kind: 'ssh.trustHost',
            fingerprint: 'SHA256:abc',
          },
          authApproval: {
            publicKey: 'pub-key',
          },
        },
      },
      emit: () => undefined,
      prompt: async (prompt) => {
        promptCalls.push(prompt.kind);
        throw new Error(`Unexpected prompt: ${prompt.kind}`);
      },
    });

    expect(promptCalls).toEqual([]);
    expect(result).toEqual({
      publicKey: 'pub-key',
      machineId: 'machine-remote-1',
    });
    expect(invocations).toEqual([
      'acceptHostTrust',
      'installRemoteCli',
      'daemon.service.list',
      'server.configure',
      'auth.status',
      'auth.enroll-remote',
      'approveLocalAuthRequest:pub-key',
      'daemon.service.install',
      'daemon.service.start',
    ]);
  });

  it('fails closed and keeps prompting when auth approval resolution does not match the requested public key', async () => {
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({
        status: 'prompt',
        promptKind: 'ssh.trustHost',
        promptMessage: 'Trust this SSH host?',
        promptData: {
          host: 'example.test',
          keyType: 'ssh-ed25519',
          fingerprint: 'SHA256:abc',
        },
        accept: async () => undefined,
      }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async () => {
        throw new Error('should not auto-approve when the prompt resolution is stale');
      },
      remoteEnrollment: { requestData: { publicKey: 'pub-key-fresh' } },
      runRemoteCommand: async ({ label }) => {
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }
        if (label === 'server.configure') {
          return { ok: true, data: { configured: true } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const promptCalls: string[] = [];
    await expect(kind.run({
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        promptResolution: {
          hostTrust: {
            kind: 'ssh.trustHost',
            fingerprint: 'SHA256:abc',
          },
          authApproval: {
            publicKey: 'pub-key-stale',
          },
        },
      },
      emit: () => undefined,
      prompt: async (prompt) => {
        promptCalls.push(prompt.kind);
        throw new Error(`Prompt surfaced: ${prompt.kind}`);
      },
    })).rejects.toThrow('Prompt surfaced: auth.approveRemoteProvisioning');

    expect(promptCalls).toEqual(['auth.approveRemoteProvisioning']);
  });

  it('does not auto-approve remote provisioning without an expected public key', async () => {
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async () => undefined,
      approveLocalAuthRequest: async () => {
        throw new Error('should not auto-approve without an expected public key');
      },
      remoteEnrollment: { requestData: { publicKey: 'pub-key-fresh' } },
      runRemoteCommand: async ({ label }) => {
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: false } };
        }
        if (label === 'server.configure') {
          return { ok: true, data: { configured: true } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const promptCalls: string[] = [];
    await expect(kind.run({
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'agent',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        promptResolution: {
          autoApproveAuthRequest: true,
        },
      },
      emit: () => undefined,
      prompt: async (prompt) => {
        promptCalls.push(prompt.kind);
        throw new Error(`Prompt surfaced: ${prompt.kind}`);
      },
    })).rejects.toThrow('Prompt surfaced: auth.approveRemoteProvisioning');

    expect(promptCalls).toEqual(['auth.approveRemoteProvisioning']);
  });

  it('rejects invalid host-trust resolution kinds instead of coercing them', async () => {
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => {
        throw new Error('should not resolve host trust when params are invalid');
      },
      installRemoteCli: async () => {
        throw new Error('should not install remote cli when params are invalid');
      },
      approveLocalAuthRequest: async () => {
        throw new Error('should not approve auth when params are invalid');
      },
      runRemoteCommand: async () => {
        throw new Error('should not run remote commands when params are invalid');
      },
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
        promptResolution: {
          hostTrust: {
            kind: 'ssh.unexpectedKind',
            fingerprint: 'SHA256:abc',
          },
        },
      },
      emit: () => undefined,
      prompt: async () => {
        throw new Error('should not prompt when params are invalid');
      },
    })).rejects.toMatchObject({
      code: 'invalid_params',
      message: 'Unsupported promptResolution.hostTrust.kind.',
    });
  });

  it('treats unsupported SSH auth modes as agent auth (no password prompt)', async () => {
    const observedAuthModes: string[] = [];
    const kind = createRemoteSshBootstrapMachineTaskKind({
      resolveHostTrust: async () => ({ status: 'trusted' }),
      installRemoteCli: async ({ auth }) => {
        observedAuthModes.push(auth.mode);
      },
      approveLocalAuthRequest: async () => undefined,
      runRemoteCommand: async ({ label, auth }) => {
        observedAuthModes.push(auth.mode);
        if (label === 'server.configure') {
          return { ok: true, data: { configured: true } };
        }
        if (label === 'auth.status') {
          return { ok: true, data: { authenticated: true, credentialState: 'valid', machineRegistrationState: 'server-confirmed', machineId: 'machine-remote-1' } };
        }
        if (label === 'daemon.service.install') {
          return { ok: true, data: { installed: true } };
        }
        if (label === 'daemon.service.start') {
          return { ok: true, data: { started: true } };
        }
        throw new Error(`Unexpected remote command: ${label}`);
      },
    });

    const runner = createSystemTasksRunner({
      kinds: {
        'remote.ssh.bootstrapMachine.v1': kind,
      },
    });

    await runner.start({
      taskId: 'ssh-task-password',
      kind: 'remote.ssh.bootstrapMachine.v1',
      params: {
        ssh: {
          target: 'dev@example.test',
          auth: 'unsupported',
        },
        relay: {
          relayUrl: 'https://relay.example.test',
        },
        serviceMode: 'none',
      },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'ssh-task-password', cursor: 0 });
    expect(finalPoll.result?.ok).toBe(true);
    expect(new Set(observedAuthModes)).toEqual(new Set(['agent']));
  });
});

describe('preflightRemoteBackgroundServiceReplacement', () => {
  function createPromptContext(answer: unknown) {
    const prompts: Array<Readonly<{ kind: string; stepId?: string; data: unknown }>> = [];
    return {
      prompts,
      ctx: {
        prompt: async (prompt: Readonly<{ kind: string; stepId?: string; message: string; data: unknown }>) => {
          prompts.push({ kind: prompt.kind, stepId: prompt.stepId, data: prompt.data });
          return answer;
        },
      },
    };
  }

  function listing(...services: Record<string, unknown>[]) {
    return async () => ({ services, entries: [] });
  }

  it('does not prompt when the only remote service is already the exact install target', async () => {
    const { ctx, prompts } = createPromptContext({ replaceExistingServices: true });
    await expect(preflightRemoteBackgroundServiceReplacement({
      ctx,
      listServices: listing({
        serviceType: 'daemon', platform: 'linux', mode: 'user', label: 'happier-daemon.dev',
        ring: 'publicdev', targetMode: 'default-following', serverId: 'cloud', running: true,
      }),
      targetReleaseChannel: 'dev',
      targetServerUrl: null,
      mode: 'user',
      stepId: 'daemon.service.preflight',
    })).resolves.toBe(false);
    expect(prompts).toEqual([]);
  });

  it('prompts for a single same-channel service the canonical conflict plan says competes', async () => {
    const { ctx, prompts } = createPromptContext({ replaceExistingServices: true });
    await expect(preflightRemoteBackgroundServiceReplacement({
      ctx,
      listServices: listing({
        serviceType: 'daemon', platform: 'linux', mode: 'user', label: 'happier-daemon.stable.pinned',
        ring: 'stable', targetMode: 'pinned', serverId: 'srv_a', running: false,
      }),
      targetReleaseChannel: 'stable',
      targetServerUrl: 'https://relay.example.test',
      mode: 'user',
      stepId: 'daemon.service.preflight',
    })).resolves.toBe(true);
    expect(prompts).toEqual([{
      kind: 'daemon.replaceRemoteBackgroundServices',
      stepId: 'daemon.service.preflight',
      data: {
        targetServerUrl: 'https://relay.example.test',
        targetReleaseChannel: 'stable',
        services: [{ label: 'happier-daemon.stable.pinned', releaseChannel: 'stable', targetMode: 'pinned', running: false }],
      },
    }]);
  });

  it('refuses with the typed reconciliation error when replacement is declined', async () => {
    const { ctx } = createPromptContext({ replaceExistingServices: false });
    await expect(preflightRemoteBackgroundServiceReplacement({
      ctx,
      listServices: listing({
        serviceType: 'daemon', platform: 'linux', mode: 'user', label: 'happier-daemon.preview',
        ring: 'preview', targetMode: 'default-following', running: true,
      }),
      targetReleaseChannel: 'stable',
      targetServerUrl: null,
      mode: 'user',
      stepId: 'personal_home.service_preflight',
    })).rejects.toMatchObject({
      code: 'service_reconciliation_declined',
      message: SERVICE_RECONCILIATION_DECLINED_MESSAGE,
    });
  });

  it('stays quiet when the remote service list cannot be read', async () => {
    const { ctx, prompts } = createPromptContext({ replaceExistingServices: true });
    await expect(preflightRemoteBackgroundServiceReplacement({
      ctx,
      listServices: async () => { throw new Error('older remote CLI'); },
      targetReleaseChannel: 'stable',
      targetServerUrl: null,
      mode: 'user',
      stepId: 'daemon.service.preflight',
    })).resolves.toBe(false);
    expect(prompts).toEqual([]);
  });
});
