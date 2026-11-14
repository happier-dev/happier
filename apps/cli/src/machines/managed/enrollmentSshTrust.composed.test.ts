import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { buildMachineProvisionerPinnedSshBootstrap } from '@happier-dev/plugin-sdk/machine-provisioners';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { computeSshHostKeyFingerprint } from '@happier-dev/protocol/ssh/hostTrust';
import { resolveLumeBootstrap } from '../../../../../packages/plugins/machine-lume/src/machine/bootstrap';
import { createLumeNativeClient } from '../../../../../packages/plugins/machine-lume/src/machine/nativeClient';
import { reloadConfiguration } from '@/configuration';
import { getLiveSystemTasksRunnerAdapter } from '@/capabilities/systemTasks/liveSystemTasksRunner';
import { runManagedMachineEnrollment } from './enrollment';

const boundary = vi.hoisted(() => ({ key: '', commands: 0 }));
vi.mock('node:child_process', async original => {
    const actual = await original<typeof import('node:child_process')>();
    return { ...actual, spawnSync: (...args: Parameters<typeof actual.spawnSync>) => args[0] === 'ssh-keyscan'
        ? { status: 0, stdout: `192.168.64.7 ${boundary.key}\n`, stderr: '' } : actual.spawnSync(...args) };
});
// Stop at the physical SSH boundary after the real trust recipe has settled.
vi.mock('@happier-dev/cli-common/ssh', async original => ({
    ...await original<typeof import('@happier-dev/cli-common/ssh')>(),
    runOpenSshRemoteCommand: async () => {
        boundary.commands++;
        throw new SystemTaskExecutionError('fixture_after_trust', 'Fixture stops before guest installation.');
    },
}));

const imageKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const otherKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const generatedKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
const homeId = 'srv_lume_hostkey';
const controller = { machineId: 'controller', installationId: 'installation' };
const target = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
    canonicalServerUrl: 'https://home.example.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.example.test' }] },
    authority: 'trusted_enrollment' });
const completed = (stdout = ''): PluginProcessResult => ({ stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array(),
    termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } }, stdoutTruncated: false, stderrTruncated: false });
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); reloadConfiguration(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function home() {
    const root = await mkdtemp(join(tmpdir(), 'happier-managed-hostkey-'));
    roots.push(root);
    vi.stubEnv('HAPPIER_HOME_DIR', root);
    reloadConfiguration();
    return root;
}

async function enroll(managedId: string, key: string, generated = false, retainedKey = generatedKey) {
    boundary.key = key;
    boundary.commands = 0;
    const credentialRef = { kind: 'shared_resource', resourceId: `credential-${managedId}` } as const;
    const resource = { contributionRef: { pluginId: 'happier.machine.lume', localId: 'lume' }, schemaVersion: 1,
        value: { storage: 'home', vmName: `happier-${managedId}`, keepPasswordLogin: true } };
    const row = ManagedMachineV1Schema.parse({ id: managedId, homeId, custodianAccountId: 'owner', controller,
        launch: { provider: resource.contributionRef, schemaVersion: 1, name: 'Guest', choices: {} },
        allocation: 'bound', creationState: 'active', resource, desired: 'start', desiredWhen: 'now', intentRevision: 0,
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, bootstrapCredentialRef: credentialRef,
        enrollmentIdentity: { kind: 'existingUser', role: 'personal' } });
    // Native HTTP, tool resolution and process execution are the external boundaries.
    const native = createLumeNativeClient({ baseUrl: 'http://localhost:7777', fetch: async () => Response.json({
        name: resource.value.vmName, locationName: 'home', status: 'running', os: 'macos', cpuCount: 2,
        memorySize: 4 * 1024 ** 3, diskSize: { allocated: 1024 ** 3, total: 150 * 1024 ** 3 },
        ipAddress: '192.168.64.7', sshAvailable: true,
    }) });
    // This OS boundary fixture exposes only the services the real Lume carrier uses.
    const exec = { systemTools: { resolve: async ({ toolId }: { toolId: string }) => ({ executable: { kind: 'systemTool',
        id: { pluginId: 'happier.machine.lume', localId: toolId } }, executablePath: `/usr/bin/${toolId}` }) },
        run: async (request: Parameters<ExecService['run']>[0]) => request.executable.id.localId === 'ssh-keyscan'
            ? completed(`192.168.64.7 ${key}\n`) : completed(),
    } as ExecService;
    const preparedCarrier = generated ? buildMachineProvisionerPinnedSshBootstrap({
        connection: { address: '192.168.64.7', user: 'happier-bootstrap', port: 22 }, guestHostPublicKey: retainedKey, credentialRef,
    }) : await resolveLumeBootstrap({ native, exec, resource: resource.value, credentialRef, bootstrapPublicKey: 'ssh-ed25519 cHVibGlj',
        credentials: { materializeBootstrapCredential: async () => ({ kind: 'file', path: '/fixture/login-key', dispose: async () => {} }) } });
    // A changed scanner and changed evidence must not replace retained generated trust.
    const carrier = generated ? { ...preparedCarrier, hostKeyEvidence: { hostKey: `192.168.64.7 ${key}`,
        fingerprint: computeSshHostKeyFingerprint(key.split(' ')[1]!) } } : preparedCarrier;
    const prompts: string[] = [];
    let taskReady!: (taskId: string) => void;
    const taskId = new Promise<string>(resolve => { taskReady = resolve; });
    const owner = getLiveSystemTasksRunnerAdapter();
    const correlation = { homeId, managedId, controller, resource, requestId: `request-${managedId}`, expectedIntentRevision: 0 };
    const result = await runManagedMachineEnrollment({ correlation, homeCorrelation: correlation, target, carrier, guestHostPublicKey: retainedKey,
        onTask: task => { taskReady(task.taskId); }, onPrompt: prompt => {
            if (!prompt) return;
            prompts.push(prompt.kind);
            void taskId.then(id => owner.respond({ taskId: id, answer: { trusted: true } }));
        },
    }, { readCurrentManagedRow: async () => row,
        materializeBootstrapCredential: async () => ({ path: '/fixture/login-key', dispose: async () => {} }),
    }).then(() => 'unexpected_success', (error: unknown) => error instanceof Error && 'code' in error ? error.code : 'unknown_failure');
    return { result, prompts, commands: boundary.commands };
}

it('scopes native observed trust to the managed resource across address reuse and refuses changes to that same resource', async () => {
    const root = await home();
    const globalPath = join(root, 'ssh', 'known_hosts');
    await mkdir(join(root, 'ssh'));
    const globalText = `192.168.64.7 ${otherKey}\n`;
    await writeFile(globalPath, globalText);
    expect(await enroll('resource-a', imageKey)).toMatchObject({ result: 'fixture_after_trust', prompts: ['ssh.trustHost'] });
    expect(await enroll('resource-b', otherKey)).toMatchObject({ result: 'fixture_after_trust', prompts: ['ssh.trustHost'] });
    expect(await enroll('resource-a', imageKey)).toMatchObject({ result: 'fixture_after_trust', prompts: [] });
    expect(await enroll('resource-a', otherKey)).toEqual({ result: 'trusted_host_key_mismatch', prompts: [], commands: 0 });
    expect(await readFile(globalPath, 'utf8')).toBe(globalText);
});

it.each([true, false])('keeps the installed generated host identity pinned before SSH (matches=%s)', async matches => {
    await home();
    expect(await enroll('generated-resource', matches ? generatedKey : otherKey, true)).toMatchObject(matches
        ? { result: 'fixture_after_trust', prompts: [] }
        : { result: 'trusted_host_key_mismatch', prompts: [], commands: 0 });
});

it('refuses replacing an already trusted resource key even when its retained credential changes', async () => {
    await home();
    expect(await enroll('generated-resource', generatedKey, true)).toMatchObject({ result: 'fixture_after_trust', prompts: [] });
    expect(await enroll('generated-resource', otherKey, true, otherKey)).toEqual({ result: 'trusted_host_key_mismatch', prompts: [], commands: 0 });
});
