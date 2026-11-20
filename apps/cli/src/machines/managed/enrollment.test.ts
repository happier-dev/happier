import { guestCliExecutable } from './enrollmentPayload.testkit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import axios from 'axios';
import { ApiClient } from '@/api/api';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { encodePlainMachineStoredContent, decodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachineUpdateMetadataRequestSchema } from '@happier-dev/protocol/machines/metadataUpdate';
import { MACHINE_PROVISIONER_PUT_FILE_BASE64_MAX_LENGTH_V1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedResourceV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { projectManagedMachineBootstrapPrompt, runManagedMachineEnrollment, type ManagedNativeBootstrapIO } from './enrollment';
import { createSystemTasksRunner } from '@happier-dev/cli-common/systemTasks';
import { createProtocolSystemTasksRunnerAdapter, createSystemTasksCapability } from '@/capabilities/registry/toolSystemTasks';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { machineSetup } from '@happier-dev/cli-common';
import { SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks';
import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh';
import { MachineEffectInternalRequestSchema } from '@/machines/setup/effectInternalProtocol';
import { prepareDedicatedDaemonBootstrap } from './dedicatedDaemonBootstrap';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';

const execFileAsync = promisify(execFile);

const resource = ManagedResourceV1Schema.parse({ contributionRef: { pluginId: 'test.provisioner', localId: 'vm' }, schemaVersion: 1, value: { nativeId: 'retained-1' } });
const correlation = { homeId: 'srv_managed_home', managedId: 'managed-1', requestId: 'request-1', expectedIntentRevision: 1, controller: { machineId: 'controller-1', installationId: 'installation-1' }, resource };
const machine = ManagedMachineV1Schema.parse({
  id: correlation.managedId, homeId: correlation.homeId, custodianAccountId: 'account-1',
  launch: { provider: resource.contributionRef, schemaVersion: 1, name: 'Guest', choices: {} },
  controller: correlation.controller, allocation: 'bound', creationState: 'active', resource,
  desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
  enrollmentIdentity: { kind: 'existingUser', role: 'personal' },
});
const target = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: correlation.homeId, canonicalServerUrl: 'https://home.example.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example.test' }] }, authority: 'trusted_enrollment' });
const carrier = { kind: 'native', transport: { contributionRef: resource.contributionRef, schemaVersion: 1 } };

async function withReleaseMirror(run: (releases: string[]) => Promise<void>) {
  const releases: string[] = [];
  // GitHub is the external boundary; enrollment, task composition and HTTP selection stay real.
  const mirror = createServer((request, response) => {
    // Loopback discovery can probe `/`; only release API requests belong to
    // this installer boundary. Managed enrollment must never request a release.
    if (request.url?.startsWith('/repos/')) releases.push(request.url);
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise<void>((resolve, reject) => { mirror.once('error', reject); mirror.listen(0, '127.0.0.1', resolve); });
  try {
    const address = mirror.address();
    if (!address || typeof address === 'string') throw new Error('Release mirror was not listening');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('HAPPIER_FIRST_PARTY_RELEASE_API_BASE_URL', `http://127.0.0.1:${address.port}`);
    await run(releases);
  } finally {
    await new Promise<void>((resolve, reject) => mirror.close(error => error ? reject(error) : resolve()));
  }
}

describe('runManagedMachineEnrollment', () => {
  beforeEach(() => {
    const fetch = globalThis.fetch;
    // Home HTTP is external; keep the real guest-source selection beneath it.
    vi.spyOn(globalThis, 'fetch').mockImplementation((request, init) => {
      const url = request instanceof Request ? request.url : String(request);
      if (url === 'https://home.example.test/v1/features') {
        return Promise.resolve(Response.json({ capabilities: { guestCli: {
          source: 'home-payload', line: '0.3', channel: 'stable',
        } } }));
      }
      return fetch(request, init);
    });
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it.each(['fresh', 'changed', 'missing'] as const)('enrolls an admitted App and updates changed private service binding (retained=%s)', async bindingState => {
    const retained = bindingState !== 'fresh';
    const root = await mkdtemp(join(tmpdir(), 'happier-app-enrollment-'));
    const events: string[] = [];
    const commands: string[] = [];
    const http = createServer();
    const sockets = new SocketServer(http, { path: '/v1/updates/' });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing test Home address');
    const target = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: correlation.homeId,
      canonicalServerUrl: `http://127.0.0.1:${address.port}`, revision: 1, endpoints: [{ kind: 'https', url: `http://127.0.0.1:${address.port}` }] }, authority: 'trusted_enrollment' });
    const deploymentAppBinding = { serviceName: 'private-renamed-collector-service', port: 5318 };
    const originalMetadata = { host: 'collector', platform: 'linux', happyCliVersion: '0.3', homeDir: '/home/collector',
      happyHomeDir: '/home/collector/.happier', displayName: 'Retained collector name',
      ...(bindingState === 'missing' ? {} : { deploymentApp: { serviceName: 'old-service', port: 4318 } }) };
    let metadata = encodePlainMachineStoredContent(originalMetadata);
    let writes = 0;
    sockets.on('connection', socket => {
      expect(socket.handshake.auth.token).toBe('admitted-app-account');
      socket.on('machine-update-metadata', (raw: unknown, acknowledge: (result: unknown) => void) => {
        const request = MachineUpdateMetadataRequestSchema.parse(raw);
        expect(events).toContain('bound-existing');
        expect(request.machineId).toBe('collector-machine');
        expect(request.expectedVersion).toBe(1);
        expect(decodePlainMachineStoredContent(request.metadata)).toEqual({ ...originalMetadata, deploymentApp: deploymentAppBinding });
        writes++; metadata = request.metadata;
        acknowledge({ result: 'success', version: 2, metadata });
      });
    });
    const enrollment = { source: 'deploymentApp' as const, homeId: target.homeServerIdentityId!,
      environmentId: 'environment-collector', deploymentId: 'deployment-collector', actionOperationId: 'operation-collector',
      controller: { machineId: 'controller-1', installationId: 'installation-1' } };
    const publicKey = Buffer.alloc(32, 7).toString('base64');
    const request = { kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
      publicKey, homeServerIdentityId: target.homeServerIdentityId,
      pairing: { secretB64Url: Buffer.alloc(32, 9).toString('base64url'), createdAtMs: Date.now(), expiresAtMs: Date.now() + 240_000 },
      supportsTokenOnly: true, pairingRequirement: 'v3', remoteProfileId: 'app-home' };
    let authenticated = retained;
    let running = false;
    try {
      await writeFile(join(root, 'happier'), '#!/bin/sh\nexit 0\n');
      vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', root);
      vi.mocked(globalThis.fetch).mockImplementation(async () => Response.json({ features: {},
        capabilities: { serverIdentity: { serverIdentityId: target.homeServerIdentityId },
          guestCli: { source: 'home-payload', line: '0.3', channel: 'stable' } },
        homeConnectionDescriptor: target.descriptor }));
      vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, data: String(url).endsWith('/v1/account/encryption/currentness')
        ? createAccountEncryptionCurrentnessFixture({ mode: 'plain', version: 1, contentKeyFingerprint: null })
        : String(url).endsWith('/v1/account/encryption') ? { mode: 'plain', updatedAt: 1 }
        : { machine: { id: 'collector-machine', metadata, metadataVersion: writes ? 2 : 1, daemonState: null, daemonStateVersion: 0,
          dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, storageMode: 'plain' } } }));
      const approve = vi.spyOn(axios, 'post').mockImplementation(async (url, _body, options) => {
        expect(url).toBe(`${target.applicationUrl}/v1/auth/response`);
        expect(options?.headers?.Authorization).toBe('Bearer admitted-app-account');
        expect(events).toContain('bound-pairing');
        events.push('approved');
        return { status: 200, data: {} };
      });
      await expect(runManagedMachineEnrollment({ source: 'deploymentApp', enrollment, target,
        deploymentAppBinding, enrollmentAccountId: 'requester-account',
        onExistingMachine: async machineId => { expect(retained).toBe(true); expect(machineId).toBe('collector-machine'); events.push('bound-existing'); },
        machineDisplayName: 'Telemetry collector', binaryPath: '/opt/happier/current/happier',
        homeDir: '/home/collector', happyHomeDir: '/home/collector/.happier', channel: 'stable',
        accountCredentials: { token: 'admitted-app-account', encryption: null },
        onTask: () => { events.push('task'); },
        onPairingRequest: async key => { expect(key).toBe(publicKey); events.push('bound-pairing'); },
        restartDaemon: async () => { expect(authenticated).toBe(true);
          if (retained) expect(decodePlainMachineStoredContent(metadata)).toMatchObject({ deploymentApp: deploymentAppBinding });
          running = true; events.push('restart'); },
      }, { native: {
        putFile: async () => {},
        exec: async ({ command, input }) => {
          commands.push(command);
          const invocation = command.replaceAll(/["']/gu, '');
          if (command.includes('managed_guest_cli_absent')) return { status: 0, stdout: 'managed_guest_cli_absent\n', stderr: '' };
          if (command.includes('uname -m')) return { status: 0, stdout: 'Linux\nx86_64\n/home/collector\n', stderr: '' };
          if (invocation.includes('server list')) return { status: 0, stderr: '', stdout: JSON.stringify({ data: { activeServerId: 'app-home',
            profiles: [{ id: 'app-home', serverUrl: target.canonicalAuthUrl, homeServerIdentityId: target.homeServerIdentityId }] } }) };
          if (invocation.includes('auth request')) {
            expect(retained).toBe(false);
            expect(JSON.parse(input ?? '{}')).toMatchObject({ managedEnrollment: enrollment, machineDisplayName: 'Telemetry collector', deploymentAppBinding });
            return { status: 0, stdout: JSON.stringify(request), stderr: '' };
          }
          if (invocation.includes('auth wait')) {
            expect(events).toContain('approved');
            authenticated = true;
            return { status: 0, stdout: JSON.stringify({ kind: 'remote_home_enrollment_result', protocolVersion: 1,
              success: true, homeServerIdentityId: target.homeServerIdentityId, machineId: 'collector-machine',
              encryptionType: 'tokenOnly', pairingAuthentication: 'v3', remoteProfileId: 'app-home' }), stderr: '' };
          }
          if (invocation.includes('auth status') || invocation.includes('daemon status')) {
            const status = { authenticated, server: { activeServerId: 'app-home' }, accountId: authenticated ? 'requester-account' : undefined,
              credentialState: authenticated ? 'valid' : 'missing', machineRegistrationState: authenticated ? 'server-confirmed' : 'unconfirmed',
              machineId: authenticated ? 'collector-machine' : undefined, daemon: { running, healthy: running }, service: { installed: false },
              auth: { needsAuth: !authenticated, machineId: 'collector-machine' }, services: [] };
            return { status: 0, stderr: '', stdout: JSON.stringify({ ...status, v: 1, ok: true, kind: 'auth_status', data: status }) };
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      } })).resolves.toEqual({ machineId: 'collector-machine' });
      expect(approve).toHaveBeenCalledTimes(retained ? 0 : 1);
      expect(writes).toBe(retained ? 1 : 0);
      if (retained) {
        const api = await ApiClient.create({ token: 'admitted-app-account', encryption: null });
        const machine = await runWithServerHttpBaseUrl(target.applicationUrl, () => api.getMachine('collector-machine'));
        expect(machine?.metadata).toMatchObject({ displayName: originalMetadata.displayName, deploymentApp: deploymentAppBinding });
      }
      expect(events).toEqual(retained ? ['task', 'bound-existing', 'restart'] : ['task', 'bound-pairing', 'approved', 'restart']);
      expect(commands.some(command => /\bdaemon\b.*\bservice\b/u.test(command))).toBe(false);
    } finally { await new Promise<void>(resolve => sockets.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
  });

  it('retains the original typed installation failure through the local task wait', async () => {
    const cause = Object.assign(new Error('private filesystem path'), { code: 'EACCES' });
    const failure = new SystemTaskExecutionError('invalid_payload', 'Payload preparation failed.', { cause });
    await expect(runManagedMachineEnrollment({ correlation, homeCorrelation: correlation, target, carrier }, {
      readCurrentManagedRow: async () => machine,
      native: {
        // Native execution is the OS boundary; the real enrollment/task owner must retain its failure.
        exec: async () => { throw failure; },
        putFile: async () => { throw new Error('Installation must fail before file delivery'); },
      },
    })).rejects.toBe(failure);
    expect(failure.cause).toBe(cause);
  });

  it('refuses requester enrollment without the owning Action operation before any guest effect', async () => {
    let effects = 0;
    await expect(runManagedMachineEnrollment({ correlation, homeCorrelation: correlation, target, carrier }, {
      readCurrentManagedRow: async () => Object.assign({}, machine, { enrollmentAccountId: 'requesting-member' }),
      native: {
        exec: async () => { effects++; throw new Error('Requester approval has no owning operation'); },
        putFile: async () => { effects++; },
      },
    })).rejects.toMatchObject({ code: 'admission_unavailable' });
    expect(effects).toBe(0);
  });

  it('projects an administrator establishment question through the retained operation and transient response without publishing its answer', async () => {
    const runner = createSystemTasksRunner({ kinds: {} });
    const published: unknown[] = [];
    let delivered: unknown;
    await runner.startAdmitted({ taskId: 'establish-task', kind: 'remote.ssh.bootstrapMachine.v1', params: {} }, {
      async run(context) {
        const prompt = { kind: 'administrator.establish', message: 'Establish reviewed administrator',
          data: { promptId: 'administrator-1', administratorUsername: 'operator' } };
        const projected = projectManagedMachineBootstrapPrompt(prompt);
        published.push(ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: correlation.requestId, revision: 1,
          actionId: 'machines.managed.acquire', state: 'running', scope: { accountId: 'account-1', machineId: correlation.controller.machineId },
          title: 'Create Guest', createdAt: 1, startedAt: 1, cancellation: 'supported', domainRef: { kind: 'managedMachine', id: correlation.managedId,
            controller: correlation.controller, resource, bootstrapTask: { id: 'establish-task', taskKind: 'remote.ssh.bootstrapMachine.v1', prompt: projected } } }));
        delivered = await context.prompt(prompt);
        return { machineId: 'target-machine' };
      },
    });
    expect((await runner.poll({ taskId: 'establish-task', cursor: 0 })).pendingPrompt).toMatchObject({ kind: 'administrator.establish',
      data: { promptId: 'administrator-1', administratorUsername: 'operator' } });
    expect(published).toHaveLength(1);
    const capability = createSystemTasksCapability(createProtocolSystemTasksRunnerAdapter(runner));
    expect(await capability.invoke?.({ method: 'respond', params: { taskId: 'establish-task', expectedPromptKind: 'administrator.establish',
      expectedPromptId: 'administrator-1', answer: { password: 'private-establishment-password' } } })).toMatchObject({ ok: true });
    expect(delivered).toEqual({ password: 'private-establishment-password' });
    const cold = JSON.parse(JSON.stringify(await runner.poll({ taskId: 'establish-task', cursor: 0 })));
    expect(cold).toMatchObject({ pendingPrompt: null, result: { ok: true, data: { machineId: 'target-machine' } } });
    expect(JSON.stringify([published, cold])).not.toContain('private-establishment-password');
  });

  it.each([undefined, { homeDir: '/persistent/home', happyHomeDir: '/persistent/home/.happier', daemonStartup: 'native-process' as const }])('refuses an unsupported dedicated identity before installing or inheriting the bootstrap account (%j)', async guestHome => {
    const commands: string[] = [];
    await expect(runManagedMachineEnrollment({ correlation, homeCorrelation: correlation, target, carrier: { ...carrier, ...(guestHome ? { guestHome } : {}) } }, {
      readCurrentManagedRow: async () => ({ ...machine, enrollmentIdentity: {
        kind: 'dedicatedDaemonUser' as const, username: 'happier' as const, serviceMode: 'user' as const,
        role: 'deployTarget' as const, adminAccessAtCreation: 'preauthorized' as const,
      } }),
      native: {
        exec: async ({ command }) => { commands.push(command); return { status: 0, stdout: 'Darwin\n501\nguest\n', stderr: '' }; },
        putFile: async () => { throw new Error('Unsupported identity must not receive an installer'); },
      },
    })).rejects.toMatchObject({ code: 'dedicated_identity_unsupported' });
    expect(commands).toHaveLength(1);
  });

  it.skipIf(process.platform !== 'linux')('detects stale active user-manager groups before dedicated daemon startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-manager-groups-'));
    const accountGroups = [...new Set([process.getgid!(), ...process.getgroups!()])].sort((a, b) => a - b);
    const changedGroups = [...accountGroups, Math.max(...accountGroups) + 1];
    const groupsFile = join(root, 'account-groups');
    let program: machineSetup.MachineSetupEffectPlanV1 | undefined;
    try {
      // systemctl and NSS are native boundaries. The production command reads
      // the real process's kernel group set through /proc, not fixture prose.
      await writeFile(join(root, 'systemctl'), `#!/bin/sh\ncase "$1" in show) printf '%s\\n' 'MainPID=${process.pid}' 'ActiveState=active' ;; is-active) exit 0 ;; *) exit 1 ;; esac\n`, { mode: 0o755 });
      await writeFile(join(root, 'id'), `#!/bin/sh\n/bin/cat ${safeBashSingleQuote(groupsFile)}\n`, { mode: 0o755 });
      await writeFile(join(root, 'getent'), `#!/bin/sh\nprintf '%s\\n' 'happier:x:${process.getuid!()}:${process.getgid!()}::/home/happier:/bin/bash'\n`, { mode: 0o755 });
      await writeFile(groupsFile, changedGroups.join(' ') + '\n');
      await expect(prepareDedicatedDaemonBootstrap({ row: { ...machine, enrollmentIdentity: {
        kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'deployTarget', adminAccessAtCreation: 'preauthorized' } },
        correlation, binaryPath: '/opt/happier/cli/current/happier', channel: 'stable',
        emit() {}, prompt: async () => { throw new Error('No attendance for Preauthorized'); },
        exec: async request => {
          if (request.command.includes('/etc/os-release')) return { status: 0, stdout: 'ubuntu\nnoble\namd64\n', stderr: '' };
          if (request.command === 'id -u happier') return { status: 0, stdout: '1000\n', stderr: '' };
          if (request.command === 'which dockerd') return { status: 1, stdout: '', stderr: '' };
          const frame = MachineEffectInternalRequestSchema.parse(JSON.parse(request.input ?? '{}'));
          if (frame.mode !== 'check' || !('basis' in frame) || !('steps' in frame)) throw new Error('plan captured before mutation');
          program = await machineSetup.checkMachineSetupEffectPlan({ basis: frame.basis, steps: frame.steps,
            backend: { observe: async step => ({ stepId: step.id, status: 'satisfied', facts: {} }), apply: async () => {} } });
          return { status: 0, stdout: JSON.stringify({ type: 'result', result: { status: 'checked', plan: program } }) + '\n', stderr: '' };
        },
      })).rejects.toThrow('plan captured before mutation');
      const manager = program?.steps.find(step => step.id === 'daemon-user-manager');
      if (!manager || manager.kind !== 'command') throw new Error('Manager requires a native group check');
      const backend = machineSetup.createMachineSetupNativeBackend({ run: async command => {
        try {
          const result = await execFileAsync(command.executable, [...command.args], { env: { ...process.env, PATH: `${root}:/usr/bin:/bin` } });
          return { code: 0, ...result };
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'number') return { code: error.code, stdout: '', stderr: '' };
          throw error;
        }
      } });
      await expect(backend.observe(manager)).resolves.toMatchObject({ status: 'drifted' });
      await writeFile(groupsFile, accountGroups.join(' ') + '\n');
      await expect(backend.observe(manager)).resolves.toMatchObject({ status: 'satisfied' });
      expect(manager.executable).toBe('systemctl');
      expect(manager.args).toEqual(['restart', '--', 'user@1000.service']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    { applyStatus: 'applied', adminAccessAtCreation: 'preauthorized', multiFragment: true, streamProgress: true },
    { applyStatus: 'plan_changed', adminAccessAtCreation: 'preauthorized' },
    { applyStatus: 'outcome_unknown', adminAccessAtCreation: 'preauthorized', streamProgress: true },
    { applyStatus: 'applied', adminAccessAtCreation: 'preauthorized', streamProgress: true, afterTerminal: true },
    { applyStatus: 'applied', adminAccessAtCreation: 'preauthorized', streamProgress: true, malformedTerminal: true },
    { applyStatus: 'applied', adminAccessAtCreation: 'ask' },
    { applyStatus: 'outcome_unknown', adminAccessAtCreation: 'ask' },
    { applyStatus: 'applied', adminAccessAtCreation: 'ask', invalidEstablishment: true },
    { applyStatus: 'applied', adminAccessAtCreation: 'none' },
    { applyStatus: 'applied', adminAccessAtCreation: 'preauthorized', interpreterFailure: 'missing_result' },
    { applyStatus: 'applied', adminAccessAtCreation: 'preauthorized', interpreterFailure: 'invalid_response' },
    { applyStatus: 'unavailable', adminAccessAtCreation: 'preauthorized', interpreterFailure: 'result' },
  ] as const)('consumes the reviewed dedicated root window ($adminAccessAtCreation/$applyStatus) through the installed interpreter before sign-in or first daemon, regardless of carrier guestHome', async ({ applyStatus, adminAccessAtCreation, ...scenario }) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-dedicated-bootstrap-'));
    const payloadRoot = join(root, 'payload');
    const requests: { command: string; input?: string }[] = [];
    const plans: machineSetup.MachineSetupEffectPlanV1[] = [];
    const events: unknown[] = [];
    const prompts: unknown[] = [];
    const password = 'invalidEstablishment' in scenario ? 'invalid\npassword' : 'private-bootstrap-establishment-password';
    let taskId = '';
    let fragments = 0;
    let progressBeforeProcessExit = false;
    const { getLiveSystemTasksRunnerAdapter } = await import('@/capabilities/systemTasks/liveSystemTasksRunner');
    try {
      await mkdir(payloadRoot);
      await writeFile(join(payloadRoot, 'happier'), '#!/bin/sh\nexit 0\n');
      if ('multiFragment' in scenario) await writeFile(join(payloadRoot, 'bundle.bin'), randomBytes(MACHINE_PROVISIONER_PUT_FILE_BASE64_MAX_LENGTH_V1));
      vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', payloadRoot);
      // The target OS/process/file transport is the boundary. Installation,
      // retained task composition, plan construction and command routing stay real.
      const native: ManagedNativeBootstrapIO = {
        async exec(request) {
          requests.push(request);
          const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
          if (request.command.includes('managed_guest_cli_absent')) return ok('managed_guest_cli_absent\n');
          if (request.command.includes('uname -s') && !request.command.includes('uname -m')) return ok('Linux\n');
          if (request.command.includes('uname -m')) return ok('Linux\naarch64\n/home/bootstrap\n');
          if (request.command.includes('/etc/os-release')) return ok('ubuntu\nnoble\narm64\n');
          if (request.command === 'id -u happier') return ok('1001\n');
          if (request.command === 'which dockerd') return { status: 1, stdout: '', stderr: '' };
          if (request.command === "id -u 'operator.name'") return ok('1002\n');
          if (request.command.includes('mktemp')) return ok('/tmp/happier-bootstrap-transfer.123\n');
          if (request.command.includes('effect-internal')) {
            if ('interpreterFailure' in scenario && scenario.interpreterFailure !== 'result') {
              return { status: 127, stdout: scenario.interpreterFailure === 'invalid_response' ? 'private-invalid-output' : '',
                stderr: 'private-bootstrap-establishment-password private-native-stderr' };
            }
            const [requestFrame, ...credentialFrames] = (request.input ?? '{}').trimEnd().split('\n');
            const input = MachineEffectInternalRequestSchema.parse(JSON.parse(requestFrame!));
            if (input.mode === 'check') {
              if (!('basis' in input) || !('steps' in input)) throw new Error('Expected a bootstrap check');
              const plan = machineSetup.createMachineSetupEffectPlan({ basis: input.basis, steps: input.steps,
                nativeFacts: input.steps.map(step => {
                  const facts: Record<string, boolean> = step.kind === 'user' ? { present: false } : {};
                  return { stepId: step.id, status: 'drifted' as const, facts };
                }) });
              plans.push(plan);
              return ok(`${JSON.stringify({ type: 'ready' })}\n${JSON.stringify({ type: 'result', result: { status: 'checked', plan } })}\n`);
            }
            expect(input.mode).toBe('apply');
            if (!('plans' in input)) throw new Error('Bootstrap must apply its reviewed plan');
            expect(input.plans).toHaveLength(1);
            const reviewed = input.plans[0]!;
            expect(reviewed.plan).toEqual(plans[0]);
            if (adminAccessAtCreation === 'ask') {
              expect(input).toMatchObject({ administrator: { stepId: 'bootstrap-administrator', username: 'operator.name' } });
              expect(credentialFrames).toHaveLength(1);
              expect(JSON.parse(credentialFrames[0]!)).toEqual({ type: 'administrator.establish', operationId: correlation.requestId,
                planDigest: reviewed.plan.planDigest, stepId: 'bootstrap-administrator', username: 'operator.name', password });
            } else expect(credentialFrames).toHaveLength(0);
            const progress = `${JSON.stringify({ type: 'ready' })}\n${JSON.stringify({ type: 'progress', stepId: 'agent-account', phase: 'check', status: 'drifted' })}\n`;
            const terminal = 'malformedTerminal' in scenario ? 'private-invalid-output\n'
              : JSON.stringify({ type: 'result', result: { status: applyStatus,
                completedStepIds: applyStatus === 'applied' ? reviewed.plan.steps.map(step => step.id) : [],
                daemonRestartRequired: applyStatus === 'applied',
                ...('interpreterFailure' in scenario ? { reason: 'native_effect_failed' } : {}) } });
            const tail = 'afterTerminal' in scenario ? '\n{"type":"ready"}\n' : '';
            const stdout = progress + terminal + tail;
            if ('streamProgress' in scenario) {
              // The command remains open with no terminal record yet. The
              // returned buffer later repeats the streamed bytes exactly.
              for (const chunk of [progress.slice(0, 31), progress.slice(31, 77), progress.slice(77)]) request.onStdoutChunk?.(chunk);
              await Promise.resolve();
              progressBeforeProcessExit = events.some(event => typeof event === 'object' && event !== null
                && 'stepId' in event && event.stepId === 'agent-account');
              request.onStdoutChunk?.(terminal + tail);
            }
            return { ...ok(stdout),
              status: applyStatus === 'applied' ? 0 : 1 };
          }
          if (request.command.includes('auth')) throw new SystemTaskExecutionError('auth_probe_reached', 'Stopped at the next real guest boundary.');
          return ok();
        },
        async putFile() { fragments++; },
      };
      await expect(runManagedMachineEnrollment({ correlation, homeCorrelation: correlation, target, channel: 'preview', onEvent: event => { events.push(event); },
        onTask: task => { taskId = task.taskId; }, onPrompt: prompt => {
          prompts.push(prompt);
          if (prompt?.kind === 'administrator.establish') queueMicrotask(() => {
            void getLiveSystemTasksRunnerAdapter().respond({ taskId, expectedPromptKind: prompt.kind,
              expectedPromptId: prompt.promptId, answer: { password } });
          });
        },
        carrier: { ...carrier, guestHome: { homeDir: '/persistent/bootstrap', happyHomeDir: '/persistent/bootstrap/.happier', daemonStartup: 'native-process' } },
      }, { native, readCurrentManagedRow: async () => ({ ...machine, enrollmentIdentity: {
        kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'deployTarget', adminAccessAtCreation,
        ...(adminAccessAtCreation === 'ask' ? { administrator: { username: 'operator.name' } } : {}),
      } }) })).rejects.toMatchObject({ code: 'afterTerminal' in scenario || 'malformedTerminal' in scenario ? 'bootstrap_effect_unconfirmed'
        : 'interpreterFailure' in scenario && scenario.interpreterFailure !== 'result'
        ? 'bootstrap_effect_unconfirmed' : 'invalidEstablishment' in scenario ? 'administrator_establishment_invalid'
        : applyStatus === 'applied' ? 'auth_probe_reached' : `bootstrap_effect_${applyStatus}`,
        ...('interpreterFailure' in scenario ? { details: { kind: 'managedBootstrap',
          phase: scenario.interpreterFailure === 'result' ? 'apply' : 'check',
          response: scenario.interpreterFailure, exitStatus: scenario.interpreterFailure === 'result' ? 1 : 127,
          stdoutPresent: scenario.interpreterFailure !== 'missing_result', stderrPresent: scenario.interpreterFailure !== 'result',
          ...(scenario.interpreterFailure === 'result' ? { resultStatus: 'unavailable', reason: 'native_effect_failed' } : {}) } } : {}),
        ...('afterTerminal' in scenario || 'malformedTerminal' in scenario ? { details: { kind: 'managedBootstrap',
          phase: 'apply', response: 'invalid_response', exitStatus: 0, stdoutPresent: true, stderrPresent: false } } : {}),
      });
      if ('streamProgress' in scenario) {
        expect(progressBeforeProcessExit).toBe(true);
        expect(events.filter(event => typeof event === 'object' && event !== null
          && 'stepId' in event && event.stepId === 'agent-account')).toHaveLength(1);
      }
      if ('afterTerminal' in scenario || 'malformedTerminal' in scenario) {
        expect(requests.some(request => request.command.includes('auth'))).toBe(false);
        expect(JSON.stringify(events)).not.toContain('private-invalid-output');
        return;
      }
      if ('interpreterFailure' in scenario) {
        expect(requests.some(request => request.command.includes('auth'))).toBe(false);
        expect(JSON.stringify(events)).not.toMatch(/private-native-stderr|private-invalid-output|private-bootstrap-establishment-password/u);
        return;
      }
      expect(plans).toHaveLength(1);
      if ('invalidEstablishment' in scenario) {
        expect(requests.some(request => request.input?.includes('"mode":"apply"') || request.command.includes('auth'))).toBe(false);
        expect(JSON.stringify([events, plans, prompts])).not.toContain(password);
        return;
      }
      const plan = plans[0]!;
      expect(plan.basis).toMatchObject({ kind: 'bootstrap', managedId: correlation.managedId, operationId: correlation.requestId });
      expect(plan.steps).toEqual(expect.arrayContaining([
        ...(adminAccessAtCreation === 'none' ? [] : [expect.objectContaining({ kind: 'file', path: '/etc/sudoers.d/90-happier-daemon', content: { kind: 'literal',
          value: adminAccessAtCreation === 'ask' ? 'Defaults:happier targetpw, timestamp_timeout=0\nhappier ALL=(operator.name) PASSWD: ALL\n' : 'happier ALL=(ALL:ALL) NOPASSWD: ALL\n' } })]),
        expect.objectContaining({ kind: 'user', username: 'happier-agent', locked: true }),
        expect.objectContaining({ kind: 'group', name: 'docker', members: ['happier'] }),
        expect.objectContaining({ kind: 'serviceUnit', unit: 'docker.service', running: true }),
      ]));
      const packages = plan.steps.flatMap(step => step.kind === 'package' ? step.packages.map(pkg => pkg.name) : []);
      expect(packages).toEqual(expect.arrayContaining(['acl', 'git', 'docker.io', 'docker-buildx', 'docker-compose-v2']));
      if (adminAccessAtCreation === 'none') expect(plan.steps.some(step => step.kind === 'file' && step.path === '/etc/sudoers.d/90-happier-daemon')).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({ type: 'progress', stepId: 'agent-account' }));
      const signIn = requests.findIndex(request => request.command.includes('auth'));
      const rootApply = requests.findIndex(request => request.command.includes('effect-internal') && request.input?.includes('"mode":"apply"'));
      expect(rootApply).toBeGreaterThan(-1);
      if (applyStatus === 'applied') {
        expect(signIn).toBeGreaterThan(rootApply);
        expect(requests[signIn]!.command).toContain('runuser -u happier');
        expect(requests[signIn]!.command).toContain('/opt/happier/cli-preview/current/happier');
      } else expect(signIn).toBe(-1);
      if ('multiFragment' in scenario) {
        expect(fragments).toBeGreaterThan(1);
        // The serial native delivery owner can reuse one private transfer
        // file for the archive, rather than spawning mktemp per fragment.
        expect(requests.filter(request => request.command.includes('mktemp'))).toHaveLength(1);
      }
      if (adminAccessAtCreation === 'ask') {
        expect(plan.steps).toContainEqual({ id: 'bootstrap-administrator', kind: 'user', username: 'operator.name' });
        expect(prompts).toContainEqual(expect.objectContaining({ kind: 'administrator.establish', administratorUsername: 'operator.name' }));
        const secretRequests = requests.filter(request => request.input?.includes(password));
        expect(secretRequests).toHaveLength(1);
        expect(secretRequests[0]!.command).toContain('effect-internal');
        expect(requests.some(request => request.command.includes('chpasswd'))).toBe(false);
        expect(JSON.stringify([events, plans, prompts, requests.map(request => request.command)])).not.toContain(password);
        expect(await getLiveSystemTasksRunnerAdapter().poll({ taskId, cursor: 0 })).toMatchObject({ pendingPrompt: null });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    { reportedMachineId: 'ordinary-machine', serviceInstalled: true, errorCode: null },
    { reportedMachineId: 'another-machine', serviceInstalled: true, errorCode: 'machine_registration_unconfirmed' },
    { reportedMachineId: 'ordinary-machine', serviceInstalled: false, errorCode: 'daemon_service_not_ready' },
  ])('updates an enrolled dedicated daemon without replaying creation authority: $reportedMachineId / service $serviceInstalled', async ({ reportedMachineId, serviceInstalled, errorCode }) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-dedicated-update-'));
    const commands: string[] = [];
    let readyReads = 0;
    try {
      await writeFile(join(root, 'happier'), '#!/bin/sh\nexit 0\n');
      vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', root);
      const update = runManagedMachineEnrollment({ correlation, homeCorrelation: correlation, target, carrier, channel: 'preview' }, {
        readCurrentManagedRow: async () => ({ ...machine, enrolledMachineId: 'ordinary-machine', enrollmentIdentity: {
          kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'deployTarget', adminAccessAtCreation: 'preauthorized',
        } }),
        native: { async exec({ command }) {
          commands.push(command);
          if (command.includes('managed_guest_cli_absent')) return { status: 0, stdout: 'managed_guest_cli_absent\n', stderr: '' };
          if (command.includes('effect-internal') || command.includes('useradd')) throw new Error('Creation authority must not replay after enrollment');
          if (/\bdaemon\b.*\bstatus\b.*--json/u.test(command)) return { status: 0, stderr: '', stdout: JSON.stringify({
            daemon: { running: serviceInstalled, healthy: ++readyReads >= 2, ...(!serviceInstalled ? { pid: 314 } : {}) }, service: { installed: serviceInstalled },
            auth: { needsAuth: false, machineId: reportedMachineId },
          }) };
          const stdout = command.includes('uname -m') ? 'Linux\naarch64\n/home/bootstrap\n'
            : command === 'uname -s' ? 'Linux\n' : command.includes('/etc/os-release') ? 'ubuntu\nnoble\narm64\n'
              : command === 'id -u happier' ? '1001\n' : command.includes('mktemp') ? '/tmp/happier-bootstrap-transfer.123\n' : '';
          return { status: 0, stdout, stderr: '' };
        }, async putFile() {} },
      });
      if (!errorCode) await expect(update).resolves.toEqual({ machineId: 'ordinary-machine' });
      else await expect(update).rejects.toMatchObject({ code: errorCode });
      expect(commands.some(command => command.includes('effect-internal') || command.includes('useradd'))).toBe(false);
      expect(commands.at(-1)).toContain('runuser -u happier');
      expect(commands.at(-1)).toContain('/opt/happier/cli-preview/current/happier');
      if (serviceInstalled) expect(readyReads).toBe(2);
      else expect(readyReads).toBe(1);
      expect(commands.filter(command => /\bdaemon\b.*\bservice\b.*\binstall\b.*--json/u.test(command))).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('delivers the operator payload through native enrollment and executes the promoted CLI', async () => {
    if (process.platform === 'win32') return; // Managed guest installation targets POSIX.
    const root = await mkdtemp(join(tmpdir(), 'happier-native-source-payload-'));
    const payloadRoot = join(root, 'payload');
    const guestHome = join(root, 'guest');
    try {
      await mkdir(payloadRoot);
      await mkdir(guestHome);
      // The executable is the OS boundary; it records invocation and returns no auth material.
      const executable = guestCliExecutable('printf "%s\\n" "$@" > "$HOME/invoked-args"\n');
      await writeFile(join(payloadRoot, 'happier'), executable);
      const moduleContent = 'export const sourcePayload = "retained source module";\n'.repeat(10_000);
      await writeFile(join(payloadRoot, 'bundle.js'), moduleContent);
      vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', ` ${payloadRoot} `);
      let archiveHeader: Uint8Array | undefined;
      let authorityReads = 0;
      let enrollmentInput: string | undefined;
      const native: ManagedNativeBootstrapIO = {
        exec: async ({ command, input }) => {
          if (input) enrollmentInput = input;
          const result = await execFileAsync('/bin/sh', ['-c', command], { env: { ...process.env, HOME: guestHome } });
          return { status: 0, stdout: result.stdout, stderr: result.stderr };
        },
        putFile: async ({ path, bytes }) => {
          archiveHeader = bytes.slice(0, 2);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, bytes);
        },
      };
      // Installation must reach the real recipe's auth consumer; empty output is deliberately invalid.
      await withReleaseMirror(async (releases) => {
        await expect(runManagedMachineEnrollment({ correlation, homeCorrelation: correlation, target, carrier, channel: 'stable' }, {
          readCurrentManagedRow: async () => { authorityReads++; return machine; }, native,
        })).rejects.toMatchObject({ code: 'invalid_cli_response' });
        expect(releases).toEqual([]);
      });
      // Invalid pairing output stops before registration. Only admission
      // reads Home, regardless of payload fragments and native commands.
      expect(authorityReads).toBe(1);
      // Native transport serializes this archive; require the compressed producer's bytes.
      expect(Array.from(archiveHeader ?? [])).toEqual([0x1f, 0x8b]);
      expect(await readFile(join(guestHome, '.happier/cli/current/happier'), 'utf8')).toBe(executable);
      expect(await readFile(join(guestHome, '.happier/cli/current/bundle.js'), 'utf8')).toBe(moduleContent);
      expect((await readFile(join(guestHome, 'invoked-args'), 'utf8')).split('\n')).toEqual(expect.arrayContaining([
        'auth', 'request', '--remote-enrollment', '--home-target-stdin', '--managed-enrollment-stdin',
      ]));
      expect(JSON.parse(enrollmentInput ?? '{}')).toMatchObject({ machineDisplayName: machine.launch.name });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(['declined', 'canceled'] as const)('publishes the guest sign-in consent while the task waits on it, and clears it once answered or canceled (%s)', async outcome => {
    if (process.platform === 'win32') return; // Managed guest installation targets POSIX.
    const root = await mkdtemp(join(tmpdir(), 'happier-native-consent-'));
    const payloadRoot = join(root, 'payload');
    const guestHome = join(root, 'guest');
    try {
      await mkdir(payloadRoot);
      await mkdir(guestHome);
      // The guest CLI is the process boundary: it answers `auth request` with a v3 pairing request.
      const request = { kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1, publicKey: Buffer.alloc(32, 1).toString('base64'),
        homeServerIdentityId: correlation.homeId, pairing: { secretB64Url: Buffer.alloc(32, 2).toString('base64url'), createdAtMs: Date.now(), expiresAtMs: Date.now() + 15 * 60_000 },
        supportsTokenOnly: true, pairingRequirement: 'v3', remoteProfileId: 'guest-home' };
      await writeFile(join(payloadRoot, 'happier'), guestCliExecutable(`if [ "$1 $2" = "auth request" ]; then cat >/dev/null; printf '%s\\n' '${JSON.stringify(request)}'; fi\n`));
      vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', payloadRoot);
      const commands: string[] = [];
      const native: ManagedNativeBootstrapIO = {
        exec: async ({ command, input }) => {
          commands.push(command);
          const child = execFileAsync('/bin/sh', ['-c', command], { env: { ...process.env, HOME: guestHome } });
          child.child.stdin?.on('error', () => {}); // Commands that never read stdin close it early.
          child.child.stdin?.end(input ?? '');
          const result = await child;
          return { status: 0, stdout: result.stdout, stderr: result.stderr };
        },
        putFile: async ({ path, bytes }) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); },
      };
      const prompts: unknown[] = [];
      const lifetime = new AbortController();
      let authorityReads = 0;
      let taskId = '';
      const { getLiveSystemTasksRunnerAdapter } = await import('@/capabilities/systemTasks/liveSystemTasksRunner');
      const consent = { kind: 'auth.approveRemoteProvisioning', message: 'Sign this managed machine into your Account for Account-wide automation?' };
      await withReleaseMirror(async () => {
        const enrollment = runManagedMachineEnrollment({ correlation, homeCorrelation: correlation, target, carrier, channel: 'stable', signal: lifetime.signal,
          onTask: (task) => { taskId = task.taskId; }, onPrompt: (prompt) => { prompts.push(prompt); },
        }, { readCurrentManagedRow: async () => {
          authorityReads++;
          return machine;
        }, native });
        enrollment.catch(() => {});
        await vi.waitFor(async () => {
          expect(taskId).not.toBe('');
          expect(await getLiveSystemTasksRunnerAdapter().poll({ taskId, cursor: 0 }))
            .toMatchObject({ pendingPrompt: { kind: consent.kind } });
        }, { timeout: 20_000 });
        // The waiting surface reads the question from the operation while the task holds it.
        expect(prompts).toEqual([consent]);
        // Admitted work stops through its local cancel signal, without another
        // Home authority read while the private question is open.
        if (outcome === 'canceled') lifetime.abort();
        else await getLiveSystemTasksRunnerAdapter().respond({ taskId, answer: { approved: false } });
        await expect(enrollment).rejects.toMatchObject({ code: outcome === 'canceled' ? 'cancelled' : 'approval_declined' });
      });
      expect(authorityReads).toBe(1);
      expect(commands.some(command => /'auth' 'wait'/u.test(command))).toBe(false);
      expect(prompts).toEqual([consent, null]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects a bad operator payload with a typed failure before delivery or release fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-native-invalid-payload-'));
    try {
      vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', root);
      await withReleaseMirror(async (releases) => {
        await expect(runManagedMachineEnrollment({ correlation, homeCorrelation: correlation, target, carrier }, {
          readCurrentManagedRow: async () => machine,
          native: {
            exec: async ({ command }) => ({ status: 0, stdout: command.includes('managed_guest_cli_absent')
              ? 'managed_guest_cli_absent\n' : 'Linux\nx86_64\n/home/guest\n', stderr: '' }),
            putFile: async () => { throw new Error('Invalid payload must not be delivered'); },
          },
        })).rejects.toMatchObject({ code: 'guest_payload_missing' });
        expect(releases).toEqual([]);
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    ['preview', undefined],
    ['dev', undefined],
    ['preview', 'stable'],
  ] as const)('refuses a missing Home payload for controller channel %s and override %s without public fallback', async (hostChannel, channel) => {
    vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', '');
    vi.stubEnv('HAPPIER_PUBLIC_RELEASE_CHANNEL', hostChannel);
    await withReleaseMirror(async (releases) => {
      await expect(runManagedMachineEnrollment({ correlation, homeCorrelation: correlation, target, carrier, ...(channel ? { channel } : {}) }, {
        readCurrentManagedRow: async () => machine,
        native: { exec: async () => ({ status: 0, stdout: 'Linux\nx86_64\n/home/guest\n', stderr: '' }),
          putFile: async () => { throw new Error('No payload may be delivered after release lookup fails'); } },
      })).rejects.toMatchObject({ code: 'guest_payload_missing' });
      expect(releases).toEqual([]);
    });
  });
  it.each([0, 1] as const)('updates an enrolled service-managed native guest without pairing another Machine (service exit %s)', async serviceExit => {
    if (process.platform === 'win32') return; // Managed guest installation targets POSIX.
    const root = await mkdtemp(join(tmpdir(), 'happier-native-enrolled-update-'));
    const payloadRoot = join(root, 'payload');
    const guestHome = join(root, 'guest');
    try {
      await mkdir(payloadRoot);
      await mkdir(guestHome);
      // The guest executable is the OS boundary, recording the actual service command.
      const executable = guestCliExecutable(`printf "%s\\n" "$@" >> "$HOME/invoked-args"\nif [ "$1 $2" = "daemon status" ]; then printf '%s\\n' '{"daemon":{"running":true,"healthy":true},"service":{"installed":true},"auth":{"needsAuth":false,"machineId":"ordinary-machine"}}'; exit 0; fi\nexit ${serviceExit}\n`);
      await writeFile(join(payloadRoot, 'happier'), executable);
      vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', payloadRoot);
      const native: ManagedNativeBootstrapIO = {
        exec: ({ command }) => new Promise((resolve, reject) => {
          execFile('/bin/sh', ['-c', command], { env: { ...process.env, HOME: guestHome } }, (error, stdout, stderr) => {
            if (error && typeof error.code !== 'number') reject(error);
            else resolve({ status: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
          });
        }),
        putFile: async ({ path, bytes }) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); },
      };
      await withReleaseMirror(async releases => {
        const update = runManagedMachineEnrollment({ correlation, homeCorrelation: correlation, target, carrier, channel: 'stable' }, {
          readCurrentManagedRow: async () => ({ ...machine, enrollmentIdentity: serviceExit === 0 ? undefined : machine.enrollmentIdentity,
            enrolledMachineId: 'ordinary-machine' }), native,
        });
        if (serviceExit === 0) await expect(update).resolves.toEqual({ machineId: 'ordinary-machine' });
        else await expect(update).rejects.toMatchObject({ code: 'background_service_failed' });
        expect(releases).toEqual([]);
      });
      expect(await readFile(join(guestHome, '.happier/cli/current/happier'), 'utf8')).toBe(executable);
      const args = (await readFile(join(guestHome, 'invoked-args'), 'utf8')).trim().split('\n');
      expect(args).toEqual(['daemon', 'service', 'install', '--json', ...(serviceExit === 0 ? ['daemon', 'service', 'restart', '--json', 'daemon', 'status', '--json'] : [])]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('retries an enrolled sandbox without guestHome through process boot instead of installing an unsupported user service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-native-process-retry-'));
    const commands: string[] = [];
    try {
      await writeFile(join(root, 'happier'), '#!/bin/sh\nexit 0\n');
      vi.stubEnv('HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT', root);
      const result = runManagedMachineEnrollment({ correlation, homeCorrelation: correlation, target, carrier, channel: 'stable' }, {
        readCurrentManagedRow: async () => ({ ...machine, enrolledMachineId: 'ordinary-machine',
          enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } }),
        native: { async exec({ command }) {
          commands.push(command);
          if (command.includes('managed_guest_cli_absent')) return { status: 0, stdout: 'managed_guest_cli_absent\n', stderr: '' };
          if (/\bdaemon\b.*\bservice\b/u.test(command)) return { status: 1, stdout: '', stderr: 'User services unavailable' };
          if (command.includes('uname -m')) return { status: 0, stdout: 'Linux\nx86_64\n/home/sandbox\n', stderr: '' };
          if (/\bdaemon\b.*\bstatus\b/u.test(command)) return { status: 0, stderr: '', stdout: JSON.stringify({
            daemon: { running: true, healthy: true }, service: { installed: false },
            auth: { needsAuth: false, machineId: 'ordinary-machine' },
          }) };
          return { status: 0, stdout: '', stderr: '' };
        }, async putFile() {} },
      });
      await expect(result).resolves.toEqual({ machineId: 'ordinary-machine' });
      expect(commands.some(command => /\bdaemon\b.*\bservice\b/u.test(command))).toBe(false);
      expect(commands.some(command => /\bdaemon\b.*\brestart\b.*--json/u.test(command))).toBe(true);
      expect(commands.some(command => /\bauth\b.*\b(request|wait)\b/u.test(command))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('retries an unconfirmed native boot update after enrollment using the same installed binary and Machine without reinstalling or pairing', async () => {
    const bootCarrier = { ...carrier, guestHome: { homeDir: '/persistent/home', happyHomeDir: '/persistent/home/.happier', daemonStartup: 'native-process' } };
    const requests: unknown[] = [];
    let attempt = 0;
    const dependencies = { readCurrentManagedRow: async () => ({ ...machine, enrollmentIdentity: { kind: 'guestProcess' as const, role: 'sandbox' as const }, enrolledMachineId: 'ordinary-machine' }),
      native: { exec: async (request: { command: string; processConfig?: unknown }) => {
        requests.push(request);
        if (!request.processConfig) throw new Error('Retry must not reinstall or re-enroll the ordinary Machine');
        return { status: attempt++ === 0 ? 1 : 0, stdout: '', stderr: '' };
      }, putFile: async () => { throw new Error('Retry must not deliver another installer or pairing payload'); } } };
    await expect(runManagedMachineEnrollment({ correlation, homeCorrelation: correlation, target, carrier: bootCarrier }, dependencies)).rejects.toMatchObject({ code: 'native_boot_unconfirmed' });
    expect(await runManagedMachineEnrollment({ correlation, homeCorrelation: correlation, target, carrier: bootCarrier }, dependencies)).toEqual({ machineId: 'ordinary-machine' });
    expect(requests).toEqual([expect.objectContaining({ command: expect.stringContaining("'/persistent/home/.happier/cli/current/happier' 'daemon' 'start-sync'"),
      processConfig: {
        environment: { HOME: '/persistent/home', HAPPIER_HOME_DIR: '/persistent/home/.happier' },
        detachedDaemonStartArgv: ['sh', '-c', expect.stringContaining("'/persistent/home/.happier/cli/current/happier' 'daemon' 'start' '--json'")],
      } }), expect.anything()]);
    expect(requests[1]).toEqual(requests[0]);
  });
  it('runs native installer observations under the declared persistent guest home, not the image default home', async () => {
    const commands: string[] = [];
    await expect(runManagedMachineEnrollment({ correlation, homeCorrelation: correlation, target, carrier: { ...carrier,
      guestHome: { homeDir: '/persistent/home', happyHomeDir: '/persistent/home/.happier', daemonStartup: 'native-process' } } }, {
      readCurrentManagedRow: async () => ({ ...machine, enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } }),
      native: { exec: async ({ command }) => { commands.push(command); return { status: 1, stdout: '', stderr: '' }; }, putFile: async () => {} },
    })).rejects.toMatchObject({ code: 'remote_command_failed' });
    expect(commands[0]).toContain("HOME='/persistent/home'");
    expect(commands[0]).toContain("HAPPIER_HOME_DIR='/persistent/home/.happier'");
    expect(commands[0]).toContain('uname -s; uname -m;');
  });
  it('resolves the native startup namespace once when the provider declares only the startup mode', async () => {
    const commands: string[] = [];
    await expect(runManagedMachineEnrollment({ correlation, homeCorrelation: correlation, target,
      carrier: { ...carrier, daemonStartup: 'native-process' } }, {
      readCurrentManagedRow: async () => ({ ...machine, enrolledMachineId: 'ordinary-machine',
        enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } }),
      native: { exec: async ({ command }) => {
        commands.push(command);
        return { status: 0, stdout: command.includes('uname -s') ? 'Linux\nx86_64\n/native/home\n' : '', stderr: '' };
      }, putFile: async () => { throw new Error('Must reuse the installed native guest'); } },
    })).resolves.toEqual({ machineId: 'ordinary-machine' });
    expect(commands.filter(command => command.includes('uname -s'))).toHaveLength(1);
    expect(commands.at(-1)).toContain("'/native/home/.happier/cli/current/happier' 'daemon' 'start-sync'");
  });
  it('refuses retired enrollment without sending a private payload to the guest', async () => {
    let nativeCalls = 0;
    await expect(runManagedMachineEnrollment({ correlation, homeCorrelation: correlation, target, carrier }, {
      readCurrentManagedRow: async () => ({ ...machine, creationState: 'canceled' }),
      native: {
        exec: async () => { nativeCalls++; return { status: 0, stdout: '', stderr: '' }; },
        putFile: async () => { nativeCalls++; },
      },
    })).rejects.toMatchObject({ code: 'enrollment_retired' });
    expect(nativeCalls).toBe(0);
  });

  it('refuses a replaced native identity without installing or reacquiring', async () => {
    let nativeCalls = 0;
    await expect(runManagedMachineEnrollment({ correlation, homeCorrelation: correlation, target, carrier }, {
      readCurrentManagedRow: async () => ({ ...machine, resource: { ...resource, value: { nativeId: 'another-guest' } } }),
      native: {
        exec: async () => { nativeCalls++; return { status: 0, stdout: '', stderr: '' }; },
        putFile: async () => { nativeCalls++; },
      },
    })).rejects.toMatchObject({ code: 'resource_mismatch' });
    expect(nativeCalls).toBe(0);
  });
});
