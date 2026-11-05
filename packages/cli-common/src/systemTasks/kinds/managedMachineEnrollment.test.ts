import { describe, expect, it } from 'vitest';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { resolveHomeTargetFromDescriptor } from '../../homeTarget/homeTarget.js';
import { runManagedMachineEnrollment, type ManagedNativeBootstrapIO } from './managedMachineEnrollment.js';

const resource = { contributionRef: { pluginId: 'test.provisioner', localId: 'vm' }, schemaVersion: 1, value: { nativeId: 'retained-1' } };
const correlation = { homeId: 'srv_managed_home', managedId: 'managed-1', requestId: 'request-1', expectedIntentRevision: 1,
  controller: { machineId: 'controller-1', installationId: 'installation-1' }, resource };
const machine = ManagedMachineV1Schema.parse({ id: correlation.managedId, homeId: correlation.homeId, custodianAccountId: 'account-1',
  launch: { provider: resource.contributionRef, schemaVersion: 1, name: 'Guest', choices: {} }, controller: correlation.controller,
  allocation: 'bound', creationState: 'active', resource, desired: 'start', desiredWhen: 'now', intentRevision: 1,
  retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, enrolledMachineId: 'same-machine',
  enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } });
const target = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: correlation.homeId,
  canonicalServerUrl: 'https://home.example.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example.test' }] },
  authority: 'trusted_enrollment' });

describe('portable managed enrollment', () => {
  it.each([false, true])('pins generated identity only when the provider installed it: %s', async generated => {
    const credentialRef = { kind: 'shared_resource' as const, resourceId: 'retained-key' };
    const publicKey = 'ssh-ed25519 AQIDBA== generated-comment';
    const carrier = { kind: 'ssh', address: 'guest.example', port: 2222, user: 'happier-bootstrap', credentialRef,
      ...(generated ? { hostKeySource: 'retained-credential' } : {}),
      hostKeyEvidence: { hostKey: '[guest.example]:2222 ssh-ed25519 BQYHCA==', fingerprint: 'SHA256:vendor-observed' } };
    const input = { correlation, target, channel: 'stable' as const, carrier,
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
  it.each([false, true])('uses local Account pairing only for the custodian row (requester=%s)', async requesterEnrollment => {
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
    const enrollment = runManagedMachineEnrollment({ correlation, target, channel: 'stable', operationId: 'admitted-operation',
      onInstalled: async () => { phases.push('installed'); },
      carrier: { kind: 'native', transport: { contributionRef: resource.contributionRef, schemaVersion: 1 } } }, {
      readCurrentManagedRow: async () => { rowReads++; return { ...machine, enrolledMachineId: undefined,
        ...(requesterEnrollment ? { enrollmentAccountId: 'requester-account' } : {}) }; },
      createPromptId: () => 'prompt',
      installNativePayload: async input => { phases.push('install'); expect(input).toMatchObject({ os: 'linux', arch: 'x64', home: '/home/guest' });
        return { binaryPath: '/home/guest/.happier/cli/current/happier' }; },
      native: { putFile: async () => {}, exec: async ({ command }) => {
        commands.push(command);
        if (command.startsWith('uname -s;')) return { status: 0, stdout: 'Linux\nx86_64\n/home/guest\n', stderr: '' };
        if (command.includes("'auth' 'request'")) { expect(phases).toEqual(['install', 'installed']); phases.push('request'); return { status: 0, stdout: JSON.stringify(request), stderr: '' }; }
        if (command.includes("'auth' 'wait'")) { phases.push('wait'); return { status: 0, stdout: JSON.stringify(completion), stderr: '' }; }
        if (command.includes("'daemon' 'start'")) running = true;
        const status = { authenticated: true, credentialState: 'valid', machineRegistrationState: 'server-confirmed', machineId: 'joined',
          services: [], service: { installed: false }, daemon: { running, healthy: running }, auth: { needsAuth: false, machineId: 'joined' },
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
    if (requesterEnrollment) {
      await expect(enrollment).rejects.toMatchObject({ code: 'admission_unavailable' });
      expect(phases).toEqual([]);
      expect(commands).toEqual([]);
      expect(rowReads).toBe(1);
      return;
    }
    expect(await enrollment).toEqual({ machineId: 'joined' });
    expect(phases).toEqual(['install', 'installed', 'request', 'approve', 'wait']);
    expect(running).toBe(true);
    expect(rowReads).toBe(1);
    expect(commands.some(command => command.includes("'service'"))).toBe(false);
    expect(JSON.stringify(events)).not.toContain(pairing.secretB64Url);
  });

  it('repairs native process boot on the same retained Machine without installation or another pairing', async () => {
    const commands: Parameters<ManagedNativeBootstrapIO['exec']>[0][] = [];
    let rowReads = 0;
    const controller = new AbortController();
    const guestHome = { homeDir: '/persistent/home', happyHomeDir: '/persistent/home/.happier', daemonStartup: 'native-process' };
    const result = await runManagedMachineEnrollment({ correlation, target, channel: 'stable', signal: controller.signal,
      carrier: { kind: 'native', transport: { contributionRef: resource.contributionRef, schemaVersion: 1 }, guestHome } }, {
      readCurrentManagedRow: async () => { rowReads++; return machine; },
      native: { exec: async request => { commands.push(request); return { status: 0, stdout: '', stderr: '' }; },
        putFile: async () => { throw new Error('Boot recovery does not transfer another payload'); } },
      createPromptId: () => 'prompt',
      runTask: async () => { throw new Error('Boot recovery does not request pairing'); },
      approveLocalAuthRequest: async () => { throw new Error('Boot recovery does not approve auth'); },
    });
    expect(result).toEqual({ machineId: 'same-machine' });
    expect(rowReads).toBe(1);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.signal).toBe(controller.signal);
    expect(commands[0]?.processConfig).toMatchObject({ environment: { HOME: guestHome.homeDir, HAPPIER_HOME_DIR: guestHome.happyHomeDir },
      detachedDaemonStartArgv: ['sh', '-c', expect.stringContaining("'daemon' 'start' '--json'")] });
    expect(commands[0]?.command).toContain("'daemon' 'start-sync'");
  });
});
