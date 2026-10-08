import { describe, expect, it } from 'vitest';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { runManagedMachineEnrollment } from './enrollment';

const resource = { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1,
  value: { containerId: 'a'.repeat(64), workspaceFolder: '/host/project', configPath: '/host/project/.devcontainer/devcontainer.json',
    user: 'coder', workspaceRoot: '/work/custom', storage: { kind: 'bind', hostPath: '/host/project', childPath: '/work/custom' },
    volumes: [{ name: 'retained-data', childPath: '/data' }] } };
const correlation = { homeId: 'srv_devcontainer_home', managedId: 'managed-child', requestId: 'creation', expectedIntentRevision: 2,
  controller: { machineId: 'physical-controller', installationId: 'controller-installation' }, resource };
const machine: ManagedMachineV1 = { id: correlation.managedId, homeId: correlation.homeId, custodianAccountId: 'owner',
  controller: correlation.controller, launch: { provider: resource.contributionRef, schemaVersion: 1, name: 'Child',
    choices: { workspaceFolder: resource.value.workspaceFolder, configPath: resource.value.configPath } },
  allocation: 'bound', resource, creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 2,
  retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
const target = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: correlation.homeId,
  canonicalServerUrl: 'https://child-home.example.test', revision: 1,
  endpoints: [{ kind: 'https', url: 'https://child-home.example.test' }] }, authority: 'trusted_enrollment' });
const carrier = { kind: 'native', transport: { contributionRef: resource.contributionRef, schemaVersion: 1 } };

describe('Devcontainer consumes ordinary managed enrollment', () => {
  it.each([
    { title: 'cancelled creation', row: { ...machine, creationState: 'canceled' as const }, code: 'enrollment_retired' },
    { title: 'rebuild revision', row: { ...machine, intentRevision: 3, desired: 'rebuild' as const }, code: 'enrollment_retired' },
    { title: 'replaced container', row: { ...machine, resource: { ...resource, value: { ...resource.value, containerId: 'b'.repeat(64) } } }, code: 'resource_mismatch' },
    { title: 'different physical controller', row: { ...machine, controller: { ...machine.controller, machineId: 'other-host' } }, code: 'enrollment_retired' },
  ])('rejects $title before child credential or binary delivery', async ({ row, code }) => {
    let delivered = false;
    await expect(runManagedMachineEnrollment({ correlation, target, carrier }, {
      readCurrentManagedRow: async () => row,
      // Native IO is the external boundary. Host currentness and enrollment
      // admission execute unchanged; no enrollment or policy helper is mocked.
      native: { exec: async () => { delivered = true; return { status: 0, stdout: '', stderr: '' }; },
        putFile: async () => { delivered = true; } },
    })).rejects.toMatchObject({ code });
    expect(delivered).toBe(false);
    expect(machine.resource?.value).toEqual(resource.value);
    expect(machine.enrolledMachineId).toBeUndefined();
  });
});
