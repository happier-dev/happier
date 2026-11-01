import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { applyMachineSetupEffectPlan, checkMachineSetupEffectPlan, type MachineRecipeStepV1 } from './index.js';
import { createMachineSetupNativeBackend, type MachineSetupNativeCommand, type MachineSetupNativeCommandResult } from './nativeBackend.js';
import { createCloudflareConnectorSetupSteps, ensureNativeCloudflareConnector, observeNativeCloudflareConnector, removeNativeCloudflareConnector,
    type NativeCloudflareConnectorInput } from './nativeCloudflare.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const ok = (stdout = ''): MachineSetupNativeCommandResult => ({ code: 0, stdout, stderr: '' });
const input: NativeCloudflareConnectorInput = {
    tunnelId: '12345678-1234-4234-8234-123456789abc',
    connector: { imageRef: 'docker.io/cloudflare/cloudflared:2025.4.0', version: '2025.4.0' },
    networkName: 'observed-caddy-network', grantRef: 'opaque-connector-grant',
};
const tokenPath = '/etc/cloudflared/happier-12345678-1234-4234-8234-123456789abc.token';
async function settled(steps: MachineRecipeStepV1[] = []) {
    const backend = createMachineSetupNativeBackend();
    const plan = await checkMachineSetupEffectPlan({ backend, steps,
        basis: { kind: 'bootstrap', managedId: 'native-cloudflare-test', operationId: 'op', admittedInputDigest: 'a'.repeat(64) } });
    const result = await applyMachineSetupEffectPlan({ backend, plan });
    expect(result.status).toBe('applied');
    return result;
}
function fixture() {
    const commands: MachineSetupNativeCommand[] = [];
    let version = '2025.4.0';
    let readable = true;
    let lostCreate = false;
    type Container = { Id: string; Name: string; Config: { Image: string; Entrypoint: string[]; Cmd: string[]; User: string; Labels: Record<string, string> };
        HostConfig: { NetworkMode: string; RestartPolicy: { Name: string }; Binds: null; Mounts: Array<{ Type: string; Source: string; Target: string; ReadOnly: boolean }>;
            PortBindings: object; Privileged: false; ReadonlyRootfs: true; PublishAllPorts: false; CapAdd: null; CapDrop: string[]; SecurityOpt: string[] };
        NetworkSettings: { Networks: Record<string, object> }; State: { Running: boolean } };
    let container: Container | undefined;
    // Docker is the genuine process/OS boundary. Native selection, ownership,
    // command construction, interpreter settlement and redaction remain real.
    const run = async (command: MachineSetupNativeCommand): Promise<MachineSetupNativeCommandResult> => {
        command.signal?.throwIfAborted();
        commands.push(command);
        expect(command.executable).toBe('docker');
        const args = command.args;
        if (args[0] === 'container' && args[1] === 'ls') return ok(container ? JSON.stringify(container.Id) + '\n' : '');
        if (args[0] === 'container' && args[1] === 'inspect') return container ? ok(JSON.stringify([container])) : { code: 1, stdout: '', stderr: '' };
        if (args[0] === 'container' && args[1] === 'create') {
            const value = (flag: string) => {
                const index = args.indexOf(flag), result = index < 0 ? undefined : args[index + 1];
                if (result === undefined) throw new Error(`Missing Docker argument ${flag}`);
                return result;
            };
            const labels = Object.fromEntries([value('--label').split('=')]);
            const mount = Object.fromEntries(value('--mount').split(',').map(part => part.split('=')));
            const image = value('--');
            if (!mount.type || !mount.src || !mount.dst) throw new Error('Missing bind mount operand');
            container = { Id: 'owned-connector', Name: `/${value('--name')}`,
                Config: { Image: image, Entrypoint: [value('--entrypoint')],
                    Cmd: [...args.slice(args.indexOf('--') + 2)], User: value('--user'), Labels: labels },
                HostConfig: { NetworkMode: value('--network'), RestartPolicy: { Name: value('--restart') }, Binds: null,
                    Mounts: [{ Type: mount.type, Source: mount.src, Target: mount.dst, ReadOnly: Object.hasOwn(mount, 'readonly') }],
                    PortBindings: {}, Privileged: false, ReadonlyRootfs: true, PublishAllPorts: false,
                    CapAdd: null, CapDrop: [value('--cap-drop')], SecurityOpt: [value('--security-opt')] },
                NetworkSettings: { Networks: { [value('--network')]: {} } }, State: { Running: false } };
            if (lostCreate) { lostCreate = false; throw new Error('lost create acknowledgement'); }
            return ok(container.Id);
        }
        if (args[0] === 'container' && (args[1] === 'start' || args[1] === 'restart')) {
            if (!container) throw new Error('Missing container');
            container.State.Running = true; return ok(container.Id);
        }
        if (args[0] === 'container' && args[1] === 'stop') {
            if (!container) throw new Error('Missing container');
            container.State.Running = false; return ok(container.Id);
        }
        if (args[0] === 'container' && args[1] === 'rm') { container = undefined; return ok(); }
        if (args[0] === 'exec' && args.at(-1) === '--version') return ok(`cloudflared version ${version} (test build)\n`);
        if (args[0] === 'exec' && args.at(-1) === 'ready') return readable ? ok() : { code: 1, stdout: 'private diagnostic', stderr: 'private diagnostic' };
        throw new Error('Unexpected Docker operation');
    };
    return { commands, run, get container() {
        if (!container) throw new Error('Missing container');
        return container;
    }, version: (value: string) => { version = value; },
        unreadable: () => { readable = false; }, loseCreate: () => { lostCreate = true; } };
}

it('keeps the connector grant in the existing protected P20 file program, not native command data', () => {
    expect(createCloudflareConnectorSetupSteps(input)).toEqual([
        { id: 'cloudflare-connector-directory', kind: 'directory', path: '/etc/cloudflared', owner: 'root', group: 'root', mode: 0o755, protectedAncestors: true },
        { id: 'cloudflare-connector-token', kind: 'file', path: tokenPath, owner: 'root', group: 'root', mode: 0o600,
            content: { kind: 'secretGrant', grantRef: input.grantRef } },
    ]);
});

it('starts a persistent private connector with the exact selected image, reader and file-only credential command', async () => {
    const f = fixture();
    expect(await ensureNativeCloudflareConnector(input, { run: f.run, setupResult: await settled() })).toEqual({ status: 'ready', containerId: 'owned-connector' });
    const create = f.commands.find(command => command.args[1] === 'create');
    if (!create) throw new Error('Missing create effect');
    expect(create.args).toEqual(['container', 'create', '--name', `happier-cloudflared-${input.tunnelId}`,
        '--label', 'dev.happier.machine-setup.recipe=cloudflare-connector@1', '--restart', 'unless-stopped', '--user', '0:0',
        '--network', input.networkName, '--entrypoint', 'cloudflared', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--mount', `type=bind,src=${tokenPath},dst=${tokenPath},readonly`, '--', input.connector.imageRef,
        'tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:20241', 'run', '--token=', '--token-file', tokenPath]);
    expect(create.env).toBeUndefined(); expect(create.inputBytes).toBeUndefined();
    expect(JSON.stringify(f.commands)).not.toContain(input.grantRef);
    const before = f.commands.length;
    expect(await ensureNativeCloudflareConnector(input, { run: f.run, setupResult: await settled() })).toEqual({ status: 'ready', containerId: 'owned-connector' });
    expect(f.commands.slice(before).filter(command => ['create', 'start', 'restart'].includes(command.args[1] ?? ''))).toHaveLength(0);
});

it('does not treat User 0 or a matching image label as reader or actual-version evidence', async () => {
    const f = fixture();
    await ensureNativeCloudflareConnector(input, { run: f.run, setupResult: await settled() });
    f.unreadable();
    expect(await observeNativeCloudflareConnector(input, { run: f.run })).toEqual({ status: 'unavailable', reason: 'native_effect_failed' });
    f.version('2025.3.0');
    const before = f.commands.length;
    expect(await observeNativeCloudflareConnector(input, { run: f.run })).toEqual({ status: 'unavailable', reason: 'required_fact_unavailable' });
    expect(f.commands.slice(before).some(command => command.args.at(-1) === 'ready')).toBe(false);
});

it.skipIf(process.platform === 'win32')('restarts only after the real interpreter reports an applied token step, never on a settled no-op', async () => {
    const f = fixture(); await ensureNativeCloudflareConnector(input, { run: f.run, setupResult: await settled() });
    const root = await mkdtemp(join(tmpdir(), 'happier-cf-step-')); roots.push(root);
    // A harmless local file exercises actual P20 changed-step settlement.
    // Protected root secretGrant bytes are covered by the installed P20 gate.
    const group = (await promisify(execFile)('id', ['-gn'])).stdout.trim();
    const steps: MachineRecipeStepV1[] = [{ id: 'cloudflare-connector-token', kind: 'file', path: join(root, 'rotation'),
        owner: userInfo().username, group, mode: 0o600, content: { kind: 'literal', value: 'rotation-test' } }];
    const changed = await settled(steps); expect(changed.completedStepIds).toContain('cloudflare-connector-token');
    const before = f.commands.length;
    expect(await ensureNativeCloudflareConnector(input, { run: f.run, setupResult: changed })).toEqual({ status: 'ready', containerId: 'owned-connector' });
    expect(f.commands.slice(before).filter(command => command.args[1] === 'restart')).toHaveLength(1);
    const unchanged = await settled(steps); expect(unchanged.completedStepIds).toEqual([]);
    const after = f.commands.length;
    await ensureNativeCloudflareConnector(input, { run: f.run, setupResult: unchanged });
    expect(f.commands.slice(after).filter(command => command.args[1] === 'restart')).toHaveLength(0);
});

it('keeps a lost Docker acknowledgement unknown and resumes the owned container without a duplicate create', async () => {
    const f = fixture(); f.loseCreate();
    const setupResult = await settled();
    expect(await ensureNativeCloudflareConnector(input, { run: f.run, setupResult })).toEqual({ status: 'outcome_unknown', reason: 'native_effect_failed' });
    expect(await ensureNativeCloudflareConnector(input, { run: f.run, setupResult })).toEqual({ status: 'ready', containerId: 'owned-connector' });
    expect(f.commands.filter(command => command.args[1] === 'create')).toHaveLength(1);
    const cancelled = new AbortController(); cancelled.abort();
    const before = f.commands.length;
    await expect(observeNativeCloudflareConnector(input, { run: f.run, signal: cancelled.signal })).rejects.toThrow();
    expect(f.commands).toHaveLength(before);
});

it('retires only the exact reviewed owned container, preserving foreign containers and leaving the protected file to P20', async () => {
    const f = fixture();
    expect(await ensureNativeCloudflareConnector(input, { run: f.run, setupResult: await settled() }))
        .toEqual({ status: 'ready', containerId: 'owned-connector' });
    f.container.Config.Labels['dev.happier.machine-setup.recipe'] = 'foreign';
    const foreign = f.commands.length;
    expect(await removeNativeCloudflareConnector(input, { run: f.run })).toEqual({ status: 'unavailable', reason: 'foreign_effect_conflict' });
    expect(f.commands.slice(foreign).some(command => ['stop', 'rm'].includes(command.args[1] ?? ''))).toBe(false);
    f.container.Config.Labels['dev.happier.machine-setup.recipe'] = 'cloudflare-connector@1';
    const owned = f.commands.length;
    expect(await removeNativeCloudflareConnector(input, { run: f.run })).toEqual({ status: 'removed' });
    expect(f.commands.slice(owned).filter(command => ['stop', 'rm'].includes(command.args[1] ?? '')).map(command => command.args))
        .toEqual([['container', 'stop', '--', 'owned-connector'], ['container', 'rm', '--', 'owned-connector']]);
    expect(await removeNativeCloudflareConnector(input, { run: f.run })).toEqual({ status: 'removed' });
});
