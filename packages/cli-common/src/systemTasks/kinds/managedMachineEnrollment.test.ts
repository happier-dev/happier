import { describe, expect, it } from 'vitest';
import { ManagedMachineFullV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { resolveHomeTargetFromDescriptor } from '../../homeTarget/homeTarget.js';
import { runManagedMachineEnrollment, type ManagedNativeBootstrapIO } from './managedMachineEnrollment.js';
import { GuestCliIdentityV1Schema } from '@happier-dev/protocol/features';
import { CORE_MACHINE_ROLE_IDS_V1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';

const resource = { contributionRef: { pluginId: 'test.provisioner', localId: 'vm' }, schemaVersion: 1, value: { nativeId: 'retained-1' } };
const correlation = { homeId: 'srv_managed_home', managedId: 'managed-1', requestId: 'request-1', expectedIntentRevision: 1,
  controller: { machineId: 'controller-1', installationId: 'installation-1' }, resource };
const machine = ManagedMachineFullV1Schema.parse({ id: correlation.managedId, homeId: correlation.homeId, custodianAccountId: 'account-1',
  launch: { provider: resource.contributionRef, schemaVersion: 1, name: 'Guest', choices: {} }, controller: correlation.controller,
  allocation: 'bound', creationState: 'active', resource, desired: 'start', desiredWhen: 'now', intentRevision: 1,
  retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, enrolledMachineId: 'same-machine',
  enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } });
const target = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: correlation.homeId,
  canonicalServerUrl: 'https://home.example.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example.test' }] },
  authority: 'trusted_enrollment' });

describe('portable managed enrollment', () => {
  it('refuses Update without its own admitted payload instead of reusing the original Create pin', async () => {
    const guestCli = GuestCliIdentityV1Schema.parse({ source: 'home-payload', line: '0.3', channel: 'stable', payloads: [{
      target: { os: 'linux', arch: 'x64' }, sha256: 'a'.repeat(64), url: '/v1/runtime/guest-cli/payloads/linux/x64',
    }] });
    await expect(runManagedMachineEnrollment({ correlation, homeCorrelation: correlation, target, channel: 'stable', replacePayload: true,
      carrier: { kind: 'native', transport: { contributionRef: resource.contributionRef, schemaVersion: 1 } } }, {
      readCurrentManagedRow: async () => ({ ...machine, guestCli }), createPromptId: () => 'prompt',
      runTask: async () => { throw new Error('Update cannot start enrollment without its pin'); },
      approveLocalAuthRequest: async () => { throw new Error('Update cannot start approval without its pin'); },
      native: { putFile: async () => { throw new Error('No guest IO before payload admission'); },
        exec: async () => { throw new Error('No guest IO before payload admission'); } },
    })).rejects.toMatchObject({ code: 'guest_payload_missing' });
  });
  it.each([false, true])('retains the frozen source after the target probe and gives Update its own snapshot (Update=%s)', async replacePayload => {
    const pin = (sha256: string) => GuestCliIdentityV1Schema.parse({ source: 'home-payload', line: '0.3', channel: 'stable', payloads: [
      { target: { os: 'linux', arch: 'arm64' }, sha256: 'c'.repeat(64), url: '/wrong-target' },
      { target: { os: 'linux', arch: 'x64' }, sha256, url: '/v1/runtime/guest-cli/payloads/linux/x64' },
    ] });
    const original = pin('a'.repeat(64));
    const updated = pin('b'.repeat(64));
    const stop = new Error('stop before payload IO');
    let selected: unknown;
    let rowReads = 0;
    await expect(runManagedMachineEnrollment({ correlation, homeCorrelation: correlation, target, channel: 'stable', replacePayload,
      ...(replacePayload ? { guestCli: updated } : {}),
      carrier: { kind: 'native', transport: { contributionRef: resource.contributionRef, schemaVersion: 1 } } }, {
      readCurrentManagedRow: async () => { rowReads++; return { ...machine, guestCli: original }; },
      createPromptId: () => 'prompt', runTask: async () => { throw new Error('Unexpected pairing'); },
      approveLocalAuthRequest: async () => { throw new Error('Unexpected approval'); },
      installNativePayload: async installation => { selected = installation; throw stop; },
      native: { putFile: async () => {}, exec: async () => ({ status: 0, stdout: 'Linux\nx86_64\n/home/guest\n', stderr: '' }) },
    })).rejects.toBe(stop);
    expect(selected).toHaveProperty('guestCli', replacePayload ? updated : original);
    expect(original.payloads?.[1]?.sha256).toBe('a'.repeat(64));
    expect(rowReads).toBe(1);
  });
  it.each([false, true])('pins generated identity only when the provider installed it: %s', async generated => {
    const credentialRef = { kind: 'shared_resource' as const, resourceId: 'retained-key' };
    const publicKey = 'ssh-ed25519 AQIDBA== generated-comment';
    const carrier = { kind: 'ssh', address: 'guest.example', port: 2222, user: 'happier-bootstrap', credentialRef,
      ...(generated ? { hostKeySource: 'retained-credential' } : {}),
      hostKeyEvidence: { hostKey: '[guest.example]:2222 ssh-ed25519 BQYHCA==', fingerprint: 'SHA256:vendor-observed' } };
    const input = { correlation, homeCorrelation: correlation, target, channel: 'stable' as const, carrier,
      guestHostPublicKey: publicKey };
    await expect(runManagedMachineEnrollment(input, {
      readCurrentManagedRow: async () => ({ ...machine, bootstrapCredentialRef: credentialRef }),
      createPromptId: () => 'prompt',
      runTask: async () => { throw new Error('Unexpected native path'); },
      approveLocalAuthRequest: async () => { throw new Error('Unexpected pairing before SSH'); },
      runSshTask: async request => {
        // The OS transport receives only custody-derived trust, not the vendor's observed key.
        expect(request).toMatchObject(generated ? { trustedHostKey: '[guest.example]:2222 ssh-ed25519 AQIDBA==' } : {});
        if (!generated) expect(request).not.toHaveProperty('trustedHostKey');
        return { machineId: 'joined' };
      },
    })).resolves.toEqual({ machineId: 'joined' });
  });
  it.each([
    { requesterEnrollment: false, dedicatedRetry: true, retainedEnrollment: true, adminAccessAtCreation: 'preauthorized' as const, noServiceManager: true },
    { requesterEnrollment: false, dedicatedRetry: true, retainedEnrollment: false, adminAccessAtCreation: 'preauthorized' as const, noServiceManager: true },
    { requesterEnrollment: false, dedicatedRetry: false, retainedEnrollment: false, adminAccessAtCreation: 'ask' as const },
    { requesterEnrollment: false, dedicatedRetry: false, retainedEnrollment: false, adminAccessAtCreation: 'ask' as const, personalGuest: true },
    { requesterEnrollment: true, dedicatedRetry: false, retainedEnrollment: false, adminAccessAtCreation: 'ask' as const },
    { requesterEnrollment: false, dedicatedRetry: true, retainedEnrollment: false, adminAccessAtCreation: 'ask' as const },
    { requesterEnrollment: false, dedicatedRetry: true, retainedEnrollment: false, adminAccessAtCreation: 'preauthorized' as const },
    { requesterEnrollment: false, dedicatedRetry: true, retainedEnrollment: true, adminAccessAtCreation: 'preauthorized' as const },
    { requesterEnrollment: false, dedicatedRetry: false, retainedEnrollment: false, adminAccessAtCreation: 'ask' as const, unreachable: true, bridge: true },
    { requesterEnrollment: false, dedicatedRetry: false, retainedEnrollment: false, adminAccessAtCreation: 'ask' as const, unreachable: true, bridge: false },
  ])('uses local Account pairing only for the custodian row (requester=$requesterEnrollment, dedicated retry=$dedicatedRetry, mode=$adminAccessAtCreation, retained=$retainedEnrollment)', async ({ requesterEnrollment, dedicatedRetry, retainedEnrollment, adminAccessAtCreation, ...availability }) => {
    const commands: string[] = [];
    const phases: string[] = [];
    const events: unknown[] = [];
    let running = false;
    let rowReads = 0;
    const pairing = { secretB64Url: 'FxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxc',
      createdAtMs: Date.now(), expiresAtMs: Date.now() + 15 * 60_000 };
    const request = { kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
      publicKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=', homeServerIdentityId: target.homeServerIdentityId,
      pairing, supportsTokenOnly: true, pairingRequirement: 'v3', remoteProfileId: 'guest-home' };
    const completion = { kind: 'remote_home_enrollment_result', protocolVersion: 1, success: true,
      homeServerIdentityId: target.homeServerIdentityId, machineId: 'joined', encryptionType: 'tokenOnly',
      pairingAuthentication: 'v3', remoteProfileId: 'guest-home' };
    const personalGuest = 'personalGuest' in availability && availability.personalGuest === true;
    const carrierCaptured = new Error('Enrollment arrived at the guest');
    const nativeCorrelation = personalGuest ? { ...correlation, resource: { ...resource, origin: 'created' as const } } : correlation;
    const { resource: _sealedResource, ...structuralCorrelation } = nativeCorrelation;
    const enrollment = runManagedMachineEnrollment({ correlation: nativeCorrelation,
      homeCorrelation: personalGuest ? structuralCorrelation : nativeCorrelation, target, channel: 'stable', operationId: 'admitted-operation',
      onInstalled: async () => { phases.push('installed'); },
      carrier: { kind: 'native', transport: { contributionRef: resource.contributionRef, schemaVersion: 1 },
        ...('bridge' in availability && availability.bridge ? { homeNetworkHint: 'authored_network' } : {}) } }, {
      readCurrentManagedRow: async () => { rowReads++; return { ...machine, enrolledMachineId: retainedEnrollment ? 'joined' : undefined,
        ...(personalGuest ? { resource: nativeCorrelation.resource, enrollmentIdentity: { kind: 'existingUser' as const, role: 'adopted' as const } } : {}),
        ...(dedicatedRetry ? { bootstrapInstalled: true as const, enrollmentIdentity: { kind: 'dedicatedDaemonUser' as const,
          username: 'happier' as const, serviceMode: 'user' as const, role: 'server' as const,
          adminAccessAtCreation, ...(adminAccessAtCreation === 'ask' ? { administrator: { username: 'operator' } } : {}) } } : {}),
        ...(requesterEnrollment ? { enrollmentAccountId: 'requester-account' } : {}) }; },
      createPromptId: () => 'prompt',
      installNativePayload: async input => { phases.push('install'); expect(input).toMatchObject({ os: 'linux', arch: 'x64', home: '/home/guest', homeUrl: target.applicationUrl });
        return { binaryPath: '/home/guest/.happier/cli/current/happier' }; },
      native: { putFile: async () => {}, exec: async ({ command, input }) => {
        commands.push(command);
        const invocation = command.replaceAll(/["']/gu, '');
        if (dedicatedRetry && (command.includes('useradd') || command.includes("'effect-internal'"))) {
          return { status: 1, stdout: '', stderr: 'sudo: a password is required' };
        }
        if (command === 'uname -s') return { status: 0, stdout: 'Linux\n', stderr: '' };
        if (command.startsWith('uname -s;')) return { status: 0, stdout: 'Linux\nx86_64\n/home/guest\n', stderr: '' };
        if (invocation.includes('auth request')) {
          if (personalGuest) {
            const enrollmentInput = JSON.parse(input ?? '{}');
            expect(enrollmentInput).toMatchObject({ managedEnrollment: structuralCorrelation,
              initialMachineMetadata: { rolesV1: { active: CORE_MACHINE_ROLE_IDS_V1.filter(id => id !== 'broker') },
                isolationV1: { environment: 'managed-guest', provisionerId: 'test.provisioner/vm' } } });
            expect(enrollmentInput.managedEnrollment).not.toHaveProperty('resource');
            throw carrierCaptured;
          }
          if ('unreachable' in availability && availability.unreachable) return { status: 1, stdout: JSON.stringify({ v: 1, ok: false, kind: 'auth_request',
            error: { code: 'AUTH_ENROLL_REMOTE_CARRIER_UNAVAILABLE', category: 'network_error',
              carrierFailure: { attemptedCarrier: 'https', reason: 'home_unreachable' } } }), stderr: '' };
          expect(phases).toEqual(['install', 'installed']); phases.push('request'); return { status: 0, stdout: JSON.stringify(request), stderr: '' };
        }
        if (invocation.includes('auth wait')) { phases.push('wait'); return { status: 0, stdout: JSON.stringify(completion), stderr: '' }; }
        if ('noServiceManager' in availability && availability.noServiceManager && invocation.includes('service install')) {
          return { status: 1, stdout: JSON.stringify({ ok: false, error: 'service_manager_unavailable', serviceStep: 'preflight', serviceStepStatus: 'unavailable' }), stderr: '' };
        }
        if (invocation.includes('daemon restart')) running = true;
        // The real installer starts a normally enabled service. A second explicit start
        // can restart it before Home has acknowledged machine-control readiness.
        if (invocation.includes('daemon start') || invocation.includes('service install') || invocation.includes('service restart')) running = true;
        const status = { authenticated: true, credentialState: 'valid', machineRegistrationState: 'server-confirmed', machineId: 'joined',
          services: [], service: { installed: dedicatedRetry }, daemon: { running, healthy: running }, auth: { needsAuth: false, machineId: 'joined' },
          server: { activeServerId: 'guest-home' } };
        return { status: 0, stdout: JSON.stringify({ ...status, v: 1, ok: true, kind: 'auth_status', data: status }), stderr: '' };
      } },
      approveLocalAuthRequest: async approval => { phases.push('approve'); expect(approval).toMatchObject({ publicKey: request.publicKey, pairing }); },
      runTask: async kind => {
        const result = await kind.run({ params: {}, emit: event => events.push(event),
          prompt: async () => ({ approved: true }) });
        if (!result || typeof result !== 'object' || Array.isArray(result) || !('machineId' in result) || typeof result.machineId !== 'string') throw new Error('Machine registration missing');
        return { machineId: result.machineId };
      },
    });
    if (personalGuest) {
      await expect(enrollment).rejects.toBe(carrierCaptured);
      return;
    }
    if (requesterEnrollment) {
      await expect(enrollment).rejects.toMatchObject({ code: 'admission_unavailable' });
      expect(phases).toEqual([]);
      expect(commands).toEqual([]);
      expect(rowReads).toBe(1);
      return;
    }
    if ('unreachable' in availability && availability.unreachable) {
      const error = await enrollment.catch(error => error);
      expect(error).toMatchObject({ code: 'home_not_guest_reachable', details: { kind: 'managedGuestHome', homeOrigin: target.applicationUrl } });
      if (availability.bridge) expect(error).toMatchObject({ details: { reason: 'authored_network' }, message: expect.stringContaining('host networking') });
      else expect(error.details).not.toHaveProperty('reason');
      return;
    }
    expect(await enrollment).toEqual({ machineId: 'joined' });
    expect(phases).toEqual(retainedEnrollment ? ['install', 'installed'] : ['install', 'installed', 'request', 'approve', 'wait']);
    expect(running).toBe(true);
    if ('noServiceManager' in availability) {
      expect(commands.some(command => command.replaceAll(/["']/gu, '').includes(retainedEnrollment ? 'daemon restart' : 'daemon start'))).toBe(true);
      expect(commands.some(command => command.replaceAll(/["']/gu, '').includes('service restart'))).toBe(false);
    }
    expect(rowReads).toBe(1);
    expect(commands.some(command => command.replaceAll(/["']/gu, '').includes('service start'))).toBe(false);
    expect(JSON.stringify(events)).not.toContain(pairing.secretB64Url);
  });

  it.each([false, true])('recovers retained process boot with explicit payload replacement %s', async replacePayload => {
    let installed = 0;
    const commands: Parameters<ManagedNativeBootstrapIO['exec']>[0][] = [];
    let rowReads = 0;
    const controller = new AbortController();
    const guestHome = { homeDir: '/persistent/home', happyHomeDir: '/persistent/home/.happier', daemonStartup: 'native-process' };
    const result = await runManagedMachineEnrollment({ correlation, homeCorrelation: correlation, target, channel: 'stable', signal: controller.signal,
      replacePayload,
      carrier: { kind: 'native', transport: { contributionRef: resource.contributionRef, schemaVersion: 1 }, guestHome } }, {
      readCurrentManagedRow: async () => { rowReads++; return machine; },
      installNativePayload: replacePayload ? async () => { installed++; return { binaryPath: '/persistent/home/.happier/cli/current/happier' }; } : undefined,
      native: { exec: async request => {
        commands.push(request);
        if (request.command.includes('uname -s;')) return { status: 0, stdout: 'Linux\nx86_64\n/persistent/home\n', stderr: '' };
        if (request.command.includes("'daemon' 'status'")) return { status: 0, stdout: JSON.stringify({ daemon: { pid: 1, running: true, healthy: true }, service: { installed: false }, auth: { needsAuth: false, machineId: 'same-machine' } }), stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      },
        putFile: async () => { throw new Error('Boot recovery does not transfer another payload'); } },
      createPromptId: () => 'prompt',
      runTask: async () => { throw new Error('Boot recovery does not request pairing'); },
      approveLocalAuthRequest: async () => { throw new Error('Boot recovery does not approve auth'); },
    });
    expect(result).toEqual({ machineId: 'same-machine' });
    expect(rowReads).toBe(1);
    expect(installed).toBe(replacePayload ? 1 : 0);
    const configured = commands.find(request => request.processConfig);
    expect(configured?.signal).toBe(controller.signal);
    expect(configured?.processConfig?.environment).toMatchObject({ HOME: guestHome.homeDir, HAPPIER_HOME_DIR: guestHome.happyHomeDir });
    expect(configured?.processConfig?.detachedDaemonStartArgv[2]).toContain("'daemon' 'start' '--json'");
    expect(configured?.processConfig?.detachedDaemonStartArgv[2]).toContain('HAPPIER_MANAGED_GUEST_PROCESS=1');
    expect(configured?.command).toContain("'daemon' 'start-sync'");
    expect(configured?.command).toContain('HAPPIER_MANAGED_GUEST_PROCESS=1');
    if (replacePayload) {
      const restart = commands.find(request => request.command.includes("'daemon' 'restart'"));
      expect(restart?.command).toContain('HAPPIER_MANAGED_GUEST_PROCESS=1');
    } else {
      expect(commands).toHaveLength(1);
    }
  });
});
