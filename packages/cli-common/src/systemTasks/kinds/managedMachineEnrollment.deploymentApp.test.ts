import { expect, it } from 'vitest';
import { DeploymentAppEnrollmentCorrelationV1Schema } from '@happier-dev/protocol/machines/enrollmentV1';
import { resolveHomeTargetFromDescriptor } from '../../homeTarget/homeTarget.js';
import { runManagedMachineEnrollment } from './managedMachineEnrollment.js';

it.each(['fresh', 'retained', 'wrong-home', 'wrong-account', 'unregistered-wrong-home', 'unregistered-wrong-account'] as const)('enrolls only the admitted App identity (%s)', async scenario => {
  const retained = scenario !== 'fresh';
  const wrongHome = scenario.endsWith('wrong-home');
  const wrongAccount = scenario.endsWith('wrong-account');
  const unregistered = scenario.startsWith('unregistered-');
  const enrollment = DeploymentAppEnrollmentCorrelationV1Schema.parse({ source: 'deploymentApp', homeId: 'srv_app_home',
    environmentId: 'environment', deploymentId: 'deployment', actionOperationId: 'operation',
    controller: { machineId: 'controller', installationId: 'installation' } });
  const target = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: enrollment.homeId,
    canonicalServerUrl: 'https://home.example.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example.test' }] },
    authority: 'trusted_enrollment' });
  const pairing = { secretB64Url: 'FxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxc',
    createdAtMs: Date.now(), expiresAtMs: Date.now() + 15 * 60_000 };
  const request = { kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
    publicKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=', homeServerIdentityId: enrollment.homeId,
    pairing, supportsTokenOnly: true, pairingRequirement: 'v3', remoteProfileId: 'app-home' };
  const commands: string[] = [];
  let approved = false;
  let registered = retained && !unregistered;
  let existingBound = false;
  let restarted = false;
  const operation = runManagedMachineEnrollment({ source: 'deploymentApp', enrollment, target, channel: 'stable',
    machineDisplayName: 'Telemetry', binaryPath: 'happier', homeDir: '/home/happier', happyHomeDir: '/home/happier/.happier',
    deploymentAppBinding: { serviceName: 'collector', port: 4318 },
    enrollmentAccountId: 'account',
    restartDaemon: async () => { expect(registered).toBe(true); if (retained && !unregistered) expect(existingBound).toBe(true); restarted = true; },
    onPairingRequest: async publicKey => { expect(publicKey).toBe(request.publicKey); },
    onExistingMachine: async machineId => { expect(retained).toBe(true); expect(machineId).toBe('app-machine'); existingBound = true; } }, {
    installNativePayload: async input => { expect(input).toMatchObject({ homeUrl: target.applicationUrl,
      remoteHomeDir: '/home/happier/.happier', dedicatedIdentity: false, resource: enrollment });
      return { binaryPath: '/home/happier/.happier/cli/current/happier' }; },
    native: { putFile: async () => { throw new Error('The existing App image owns its binary'); },
      exec: async ({ command, input }) => {
        commands.push(command);
        if (command.includes('uname -s;')) return { status: 0, stdout: 'Linux\nx86_64\n/home/happier\n', stderr: '' };
        const invocation = command.replaceAll(/["']/gu, '');
        if (invocation.includes('server list')) return { status: 0, stderr: '', stdout: JSON.stringify({ ok: true, data: {
          activeServerId: 'app-home', profiles: retained ? [{ id: 'app-home', serverUrl: target.canonicalAuthUrl,
            homeServerIdentityId: wrongHome ? 'srv_other_home' : enrollment.homeId }] : [] } }) };
        if (invocation.includes('auth request')) {
          expect(JSON.parse(input!)).toMatchObject({ managedEnrollment: enrollment });
          return { status: 0, stdout: JSON.stringify(request), stderr: '' };
        }
        if (invocation.includes('auth wait')) {
          expect(approved).toBe(true); registered = true;
          return { status: 0, stdout: JSON.stringify({ kind: 'remote_home_enrollment_result', protocolVersion: 1,
            success: true, homeServerIdentityId: enrollment.homeId, machineId: 'app-machine', encryptionType: 'tokenOnly',
            pairingAuthentication: 'v3', remoteProfileId: 'app-home' }), stderr: '' };
        }
        const credentialsPresent = retained || registered;
        const status = { accountId: credentialsPresent ? wrongAccount ? 'other-account' : 'account' : null, authenticated: credentialsPresent, credentialState: credentialsPresent ? 'valid' : 'missing',
          machineRegistrationState: registered ? 'server-confirmed' : 'unknown', machineId: registered ? 'app-machine' : null,
          services: [], service: { installed: false }, daemon: { running: true, healthy: registered },
          auth: { needsAuth: !registered, machineId: registered ? 'app-machine' : null }, server: { activeServerId: 'app-home' } };
        return { status: 0, stdout: JSON.stringify({ ...status, v: 1, ok: true, kind: 'auth_status', data: status }), stderr: '' };
      } },
    approveLocalAuthRequest: async approval => { expect(approval).toMatchObject({ publicKey: request.publicKey, pairing }); approved = true; },
    runTask: async kind => {
      const value = await kind.run({ params: {}, emit() {}, prompt: async () => { throw new Error('App pairing is automatic'); } });
      if (!value || typeof value !== 'object' || Array.isArray(value) || !('machineId' in value) || typeof value.machineId !== 'string') throw new Error('Machine registration missing');
      return { machineId: value.machineId };
    },
  });
  if (wrongHome || wrongAccount) {
    await expect(operation).rejects.toMatchObject({ code: wrongHome ? 'home_identity_mismatch' : 'machine_registration_unconfirmed' });
    expect(existingBound).toBe(false);
    expect(restarted).toBe(false);
    expect(approved).toBe(false);
    return;
  }
  const result = await operation;
  expect(result).toEqual({ machineId: 'app-machine' });
  expect(restarted).toBe(true);
  expect(approved).toBe(!retained);
  expect(commands.filter(command => /'service'|'restart'|'start-sync'|'install'/.test(command))).toEqual([]);
});
