import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildMachineProvisionerPinnedSshBootstrap } from '@happier-dev/plugin-sdk/machine-provisioners';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { reloadConfiguration } from '@/configuration';
import { runManagedMachineEnrollment } from './enrollment';

const scan = vi.hoisted(() => ({ resultClass: 'empty' }));
// Only the actual OS process boundary is substituted; the task and enrollment stay real.
vi.mock('node:child_process', async original => {
    const actual = await original<typeof import('node:child_process')>();
    return { ...actual, spawnSync: (...args: Parameters<typeof actual.spawnSync>) => {
        if (args[0] !== 'ssh-keyscan') return actual.spawnSync(...args);
        return { pid: 1, status: scan.resultClass === 'command_failed' ? 1 : 0, signal: null,
            stdout: scan.resultClass === 'invalid' ? 'invalid-key' : '', stderr: 'private native text', output: [],
            ...(scan.resultClass === 'spawn_failed' ? { error: new Error('private executable path') } : {}) };
    } };
});

const roots: string[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    reloadConfiguration();
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it.each(['empty', 'invalid', 'command_failed', 'spawn_failed'] as const)(
    'retains the %s keyscan result through the real pinned enrollment task', async resultClass => {
        const root = await mkdtemp(join(tmpdir(), 'managed-keyscan-cause-'));
        roots.push(root);
        vi.stubEnv('HAPPIER_HOME_DIR', root);
        reloadConfiguration();
        scan.resultClass = resultClass;
        const controller = { machineId: 'controller', installationId: 'installation' };
        const provider = { pluginId: 'happier.machine.hetzner', localId: 'hetzner' };
        const resource = { contributionRef: provider, schemaVersion: 1, value: { serverId: 41, owned: { volumeIds: [], primaryIpIds: [] } } };
        const credentialRef = { kind: 'shared_resource', resourceId: 'key' } as const;
        const homeId = 'srv_hetzner_boot';
        const row = ManagedMachineV1Schema.parse({ id: 'managed', homeId, custodianAccountId: 'owner', controller,
            launch: { provider, schemaVersion: 1, name: 'Guest', choices: {} }, allocation: 'bound', creationState: 'active',
            resource, desired: 'start', desiredWhen: 'now', intentRevision: 0, retention: { kind: 'until-delete' },
            wakeOnAcceptedMessage: false, bootstrapCredentialRef: credentialRef, enrollmentIdentity: { kind: 'existingUser', role: 'personal' } });
        const guestHostPublicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
        const carrier = buildMachineProvisionerPinnedSshBootstrap({ connection: { address: '192.0.2.1', user: 'happier-bootstrap' },
            credentialRef, guestHostPublicKey });
        const target = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
            canonicalServerUrl: 'https://home.example.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example.test' }] },
            authority: 'trusted_enrollment' });
        await expect(runManagedMachineEnrollment({ correlation: { homeId, managedId: row.id, controller, resource,
            requestId: 'request', expectedIntentRevision: 0 }, target, carrier, guestHostPublicKey }, {
            readCurrentManagedRow: async () => row,
            materializeBootstrapCredential: async () => ({ path: '/fixture/key', dispose: async () => {} }),
        })).rejects.toMatchObject({ code: 'native_ssh_host_key_unavailable',
            details: { kind: 'managedNative', nativeCause: { localCause: 'ssh_keyscan_failed', resultClass } } });
    });
