import { describe, expect, it } from 'vitest';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedResourceV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { runManagedMachineEnrollment } from './enrollment';

const resource = ManagedResourceV1Schema.parse({ contributionRef: { pluginId: 'test.provisioner', localId: 'vm' }, schemaVersion: 1, value: { nativeId: 'retained-1' } });
const correlation = { homeId: 'srv_managed_home', managedId: 'managed-1', requestId: 'request-1', expectedIntentRevision: 1, controller: { machineId: 'controller-1', installationId: 'installation-1' }, resource };
const machine = ManagedMachineV1Schema.parse({
  id: correlation.managedId, homeId: correlation.homeId, custodianAccountId: 'account-1',
  launch: { provider: resource.contributionRef, schemaVersion: 1, name: 'Guest', choices: {} },
  controller: correlation.controller, allocation: 'bound', creationState: 'active', resource,
  desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
});
const target = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: correlation.homeId, canonicalServerUrl: 'https://home.example.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example.test' }] }, authority: 'trusted_enrollment' });
const carrier = { kind: 'native', transport: { contributionRef: resource.contributionRef, schemaVersion: 1 } };

describe('runManagedMachineEnrollment', () => {
  it('retries an unconfirmed native boot update after enrollment using the same installed binary and Machine without reinstalling or pairing', async () => {
    const bootCarrier = { ...carrier, guestHome: { homeDir: '/persistent/home', happyHomeDir: '/persistent/home/.happier', daemonStartup: 'native-process' } };
    const requests: unknown[] = [];
    let attempt = 0;
    const dependencies = { readCurrentManagedRow: async () => ({ ...machine, enrolledMachineId: 'ordinary-machine' }),
      native: { exec: async (request: { command: string; processConfig?: unknown }) => {
        requests.push(request);
        if (!request.processConfig) throw new Error('Retry must not reinstall or re-enroll the ordinary Machine');
        return { status: attempt++ === 0 ? 1 : 0, stdout: '', stderr: '' };
      }, putFile: async () => { throw new Error('Retry must not deliver another installer or pairing payload'); } } };
    await expect(runManagedMachineEnrollment({ correlation, target, carrier: bootCarrier }, dependencies)).rejects.toMatchObject({ code: 'native_boot_unconfirmed' });
    expect(await runManagedMachineEnrollment({ correlation, target, carrier: bootCarrier }, dependencies)).toEqual({ machineId: 'ordinary-machine' });
    expect(requests).toEqual([expect.objectContaining({ command: expect.stringContaining("'/persistent/home/.happier/cli/current/happier' 'daemon' 'start-sync'"),
      processConfig: { environment: { HOME: '/persistent/home', HAPPIER_HOME_DIR: '/persistent/home/.happier' } } }), expect.anything()]);
    expect(requests[1]).toEqual(requests[0]);
  });
  it('runs native installer observations under the declared persistent guest home, not the image default home', async () => {
    const commands: string[] = [];
    await expect(runManagedMachineEnrollment({ correlation, target, carrier: { ...carrier,
      guestHome: { homeDir: '/persistent/home', happyHomeDir: '/persistent/home/.happier', daemonStartup: 'native-process' } } }, {
      readCurrentManagedRow: async () => machine,
      native: { exec: async ({ command }) => { commands.push(command); return { status: 1, stdout: '', stderr: '' }; }, putFile: async () => {} },
    })).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(commands[0]).toContain("HOME='/persistent/home'");
    expect(commands[0]).toContain("HAPPIER_HOME_DIR='/persistent/home/.happier'");
    expect(commands[0]).toContain('uname -s; uname -m;');
  });
  it('refuses retired enrollment without sending a private payload to the guest', async () => {
    let nativeCalls = 0;
    await expect(runManagedMachineEnrollment({ correlation, target, carrier }, {
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
    await expect(runManagedMachineEnrollment({ correlation, target, carrier }, {
      readCurrentManagedRow: async () => ({ ...machine, resource: { ...resource, value: { nativeId: 'another-guest' } } }),
      native: {
        exec: async () => { nativeCalls++; return { status: 0, stdout: '', stderr: '' }; },
        putFile: async () => { nativeCalls++; },
      },
    })).rejects.toMatchObject({ code: 'resource_mismatch' });
    expect(nativeCalls).toBe(0);
  });
});
