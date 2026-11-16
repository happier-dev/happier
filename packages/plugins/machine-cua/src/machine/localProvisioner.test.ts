import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PluginError, type PluginApi, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { ManagedDependencyStatus, ManagedServiceSpec } from '@happier-dev/plugin-sdk/managed-services';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { ExecService, PluginExecSpawnRequest, PluginProcessHandle, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createCuaNativeClient } from './nativeClient.js';
import { createCuaLocalProvisioner } from './localProvisioner.js';
import { CUA_PLUGIN } from '../manifest.js';
import { CuaLocalLaunchV1Schema } from './schemas.js';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { MachineProvisionerOptionsResultV1Schema, projectMachineProvisionerSelectionV1,
    type MachineProvisionerOptionsResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { localAcquireOperation } from './localProvisionerSchemas.js';

const size = { cpu: 4, memoryBytes: 4096 * 1024 ** 2, diskBytes: 20 * 1024 ** 3 };
const launch = { on: 'local', runtimeId: 'qemu', imageId: 'ghcr.io/trycua/linux:24.04-disk', size };
const resource = { kind: 'sandbox', namespace: 'local', runtimeId: 'qemu', sandboxId: 'local:owned' };
// Captured ManagedMachine.id from the server's @default(cuid()) generator.
const managedId = 'cmvnxb7gn009mmcagisyszwlh';
const doctor = { host: { os: 'linux', arch: 'x86_64', kvm: true, accel: { x86_64: 'kvm', aarch64: 'tcg' } },
    backends: [{ backend: 'qemu', ready: true, provisionable: false }],
    qemu: { version: '10.1.0' }, lume: { version: null }, container: { reachable: false, gvisor: false, runtimes: [] } };
const digest = `sha256:${'a'.repeat(64)}`;
const images = [{ ref: launch.imageId, os: 'linux', arch: ['amd64'], local: 'qemu', published: true, spacesd: true,
    digest, sizes: { digest, platforms: [{ arch: 'amd64', disk: size.diskBytes }] } }];
function select(options: MachineProvisionerOptionsResultV1) {
    return projectMachineProvisionerSelectionV1({ options, launchSchema: CuaLocalLaunchV1Schema.jsonSchema,
        selection: Object.fromEntries(Object.entries(options.dimensions).flatMap(([dimension, entries]) =>
            entries[0] ? [[dimension, entries[0].id]] : [])) });
}
function result(value: unknown): PluginProcessResult {
    return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
        stdout: new TextEncoder().encode(JSON.stringify(value)), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
}
function harness(createReplyLost = false, observedRuntime: 'qemu' | 'gvisor' | 'runc' = 'qemu', observedPower = 'running') {
    const requests: PluginExecSpawnRequest[] = [];
    const copiedBytes: Buffer[] = [];
    let temporaryId = 0;
    const run = async (request: PluginExecSpawnRequest) => {
        requests.push(request);
        const args = request.args ?? [];
        if (args.includes('doctor')) return result(doctor);
        if (args.includes('images')) return result(images);
        if (args.includes('spaces') && args.includes('ls')) return result({ spaces: [
            { id: resource.sandboxId, provider: 'local', image: launch.imageId },
        ] });
        if (args.includes('create')) {
            if (createReplyLost) throw new Error('dropped response');
            const name = args.find((arg) => arg.startsWith('--name='))?.slice(7);
            return result({ id: `local:${name}`, name, location: 'local', runtime: 'qemu', kind: 'vm',
                image: launch.imageId, status: 'ready', state: 'running', ephemeral: false });
        }
        if (args.includes('info')) return result({ id: resource.sandboxId, name: 'owned', location: 'local', runtime: observedRuntime,
            kind: observedRuntime === 'qemu' ? 'vm' : 'container', image: launch.imageId, status: 'ready', state: observedPower, ephemeral: false });
        if (args.includes('cp')) {
            const content = await readFile(args[args.indexOf('cp') + 1]);
            copiedBytes.push(content);
            return result({ direction: 'upload', size: content.length, sha256: createHash('sha256').update(content).digest('hex') });
        }
        // A runc guest shell runs as the image's `cua` user, whose home is /home/cua (observed with `cua sandbox shell`).
        if (args.includes('shell')) return { ...result(null), stdout: args.at(-1)?.startsWith('mktemp -d')
            ? new TextEncoder().encode(`/tmp/happier-cua.action-${++temporaryId}\n`) : args.at(-1)?.includes("'cat'")
                ? new Uint8Array([255, 0, 128]) : args.at(-1)?.includes("'printenv' 'HOME'")
                    ? new TextEncoder().encode('/home/cua\n') : new Uint8Array() };
        throw new Error('unexpected native effect');
    };
    return { requests, copiedBytes, run, provider: createCuaLocalProvisioner(createCuaNativeClient({ exec: { run }, executable: { kind: 'systemTool', id: 'cua' } }), 'local-sandbox', 10) };
}

// Native process boundary only: checkpoint state, lost replies and exact deletion.
function preparationHarness(options: { lostCheckpointReply?: boolean; failedSetup?: boolean; foreignCheckpoint?: boolean; lostWarmReply?: boolean } = {}) {
    const h = harness();
    const requests: PluginExecSpawnRequest[] = [];
    const builder = 'happier-prepared-build-one';
    const checkpoint = 'happier-prepared-one';
    let present = false;
    let saved = options.foreignCheckpoint === true;
    let pinned = saved;
    const spaces = new Map<string, string>();
    const info = (name: string) => ({ id: `local:${name}`, name, location: 'local', runtime: 'qemu',
        kind: 'vm', image: launch.imageId, status: 'ready', state: 'running', ephemeral: false });
    const run: ExecService['run'] = async request => {
        requests.push(request);
        const args = request.args ?? [];
        if (args.includes('checkpoints')) {
            if (args.includes('unpin')) { pinned = false; return result(null); }
            if (args.includes('rm')) { saved = false; return result(null); }
            return result(saved ? [{ name: checkpoint, source: options.foreignCheckpoint ? 'somebody-else' : builder,
                runtime_type: 'qemu', image: launch.imageId, pinned, host: '' }] : []);
        }
        if (args.includes('checkpoint')) {
            saved = true; pinned = true;
            if (options.lostCheckpointReply) throw new Error('native connection lost');
            return result({ name: checkpoint, source: builder, runtime: 'qemu', pinned: true, host: '' });
        }
        if (args.includes('create')) {
            const name = args.find(arg => arg.startsWith('--name='))?.slice(7) ?? builder;
            if (name === builder) present = true;
            if (args.includes('spaces')) {
                // v0.27.5 restores the checkpoint's base image into the registry.
                spaces.set(`local:${name}`, args.at(-1)!.startsWith('checkpoint:') ? launch.imageId : args.at(-1)!);
                if (name === 'happier-warm' && options.lostWarmReply) throw new Error('create reply lost');
                return result({ spaces: [{ id: `local:${name}`, provider: 'local' }] });
            }
            return result(info(name));
        }
        if (args.includes('fork')) return result({ id: 'local:happier-warm', name: 'happier-warm', source: checkpoint });
        if (args.includes('info')) {
            const name = args.includes('local:happier-warm') ? 'happier-warm' : builder;
            // Observed on mac QEMU: create reports the base; later info/ls do not.
            if (name === 'happier-warm' || present) return result({ ...info(name), image: null });
            return { ...result(null), termination: {
                observed: { kind: 'exit', exitCode: 3 }, requestedBy: { kind: 'none' } } };
        }
        if (args.includes('spaces') && args.includes('rm')) { spaces.delete(args.at(-1)!); return result(null); }
        if (args.includes('rm')) { present = false; return result({ deleted: `local:${builder}`, missing: false }); }
        if (args.includes('spaces') && args.includes('add')) return result({ id: 'local:happier-warm', provider: 'local' });
        if (args.includes('spaces') && args.includes('ls')) return result({ spaces: [...spaces].map(([id, image]) => ({ id, image, provider: 'local' })) });
        const response = await h.run(request);
        return options.failedSetup && args.includes('shell') && args.at(-1)?.includes("'sh' '-s'")
            ? { ...response, termination: { observed: { kind: 'exit', exitCode: 17 }, requestedBy: { kind: 'none' } } } : response;
    };
    return { requests, run, copiedBytes: h.copiedBytes, state: () => ({ checkpoint: saved, builder: present }) };
}

function preparationInput(prefix: string, choices = launch, setupScript = 'echo prepared') {
    return { launch: { provider: { pluginId: CUA_PLUGIN.manifest.id, localId: `local-${prefix}` }, schemaVersion: 1, choices },
        cli: { identity: 'home-payload:fixture', versionId: '0.3.0', binaryPath: '/opt/happier/cli/happier',
            installScript: 'printf cli-installed', files: [{ path: 'happier-cli-payload.tar.gz', contentsBase64: 'AP8=' }] },
        setupScript };
}

describe('credential-free native Cua preparation', () => {
    it.each(['sandbox', 'space'] as const)('accepts the shared preset build envelope and raw recovery for %s', async prefix => {
        const native = preparationHarness();
        const h = await activated(true, native.run);
        const kit = await createPluginTestkit({ manifest: CUA_PLUGIN.manifest, module: CUA_PLUGIN,
            services: h.context.services as unknown as PluginTestServicesFixture });
        const provider = { pluginId: CUA_PLUGIN.manifest.id, localId: `local-${prefix}` };
        try {
            const built = await kit.invokeAction(`${prefix}-prepare-build`, { operationId: 'one', input: {
                launch: { provider, schemaVersion: 1, choices: launch },
                cli: { identity: 'home-payload:fixture', versionId: '0.3.0', binaryPath: '/opt/happier/cli/happier',
                    installScript: 'printf cli-installed', files: [{ path: 'happier-cli-payload.tar.gz', contentsBase64: 'AP8=' }] },
                setupScript: 'printf setup-after-cli',
            } }, { surface: 'plugin' });
            expect(built).toMatchObject({ kind: 'ready', artifact: { value: { launch: { preparedOperationId: 'one' } } } });
            expect(await kit.invokeAction(`${prefix}-prepare-inspect`, { operationId: 'one', launch }, { surface: 'plugin' })).toEqual(built);
            expect(native.copiedBytes).toContainEqual(Buffer.from([0, 255]));
            const script = native.copiedBytes.map(bytes => bytes.toString()).find(value => value.includes('cli-installed'));
            expect(script).toBeDefined();
            expect(script!.indexOf('cli-installed')).toBeLessThan(script!.indexOf('setup-after-cli'));
            expect(JSON.stringify(native.requests)).not.toContain('AP8=');
            expect(JSON.stringify(native.requests)).not.toContain('cli-installed');
        } finally { await kit.dispose(); }
    });
    it.each(['sandbox', 'space'] as const)('builds, launches and destroys only its owned %s checkpoint', async prefix => {
        const native = preparationHarness();
        const h = await activated(true, native.run);
        const built = await h.action(`${prefix}-prepare-build`)({ operationId: 'one', input: preparationInput(prefix) }, h.context);
        expect(built).toMatchObject({ kind: 'ready', artifact: { contributionRef: { localId: `local-${prefix}` },
            value: { operationId: 'one', launch: { ...launch, preparedOperationId: 'one' } } } });
        expect(native.state()).toEqual({ checkpoint: true, builder: false });
        const artifact = (built as { artifact: { value: unknown } }).artifact;
        const creates = native.requests.filter(request => request.args?.includes('create'));
        expect(creates).toHaveLength(1);
        expect(creates[0].args).toContain(launch.imageId);
        const acquired = await h.action(`${prefix}-acquire`)({ managedId: 'warm', launch: (artifact.value as { launch: unknown }).launch }, h.context);
        expect(acquired).toMatchObject({ kind: 'bound', resource: { value: { sandboxId: 'local:happier-warm' } } });
        if (prefix === 'sandbox') expect(native.requests.filter(request => request.args?.includes('fork'))).toHaveLength(1);
        else expect(native.requests.filter(request => request.args?.includes('create')).map(request => request.args?.at(-1)))
            .toEqual([launch.imageId, 'checkpoint:happier-prepared-one']);
        expect(await h.action(`${prefix}-prepare-destroy`)({ artifact }, h.context)).toEqual({ kind: 'confirmed' });
        expect(native.state()).toEqual({ checkpoint: false, builder: false });
        expect(native.requests.some(request => request.args?.includes('prune'))).toBe(false);
    });
    it('preserves a Space preset with a grown QEMU disk during clean preparation', async () => {
        const native = preparationHarness();
        const h = await activated(true, native.run);
        const larger = { ...launch, size: { ...size, diskBytes: 40 * 1024 ** 3 } };
        const built = await h.action('space-prepare-build')({ operationId: 'one', input: preparationInput('space', larger) }, h.context);
        expect(built).toMatchObject({ kind: 'ready', artifact: { value: { launch: { ...larger, preparedOperationId: 'one' } } } });
        expect(native.requests.find(request => request.args?.includes('create'))?.args).toContain('--disk-gb=40');
    });
    it('reconciles a prepared Space after a lost create reply using its checkpoint registry image', async () => {
        const native = preparationHarness({ lostWarmReply: true });
        const h = await activated(true, native.run);
        const built = await h.action('space-prepare-build')({ operationId: 'one', input: preparationInput('space') }, h.context);
        const preparedLaunch = (built as { artifact: { value: { launch: unknown } } }).artifact.value.launch;
        const acquired = await h.action('space-acquire')({ managedId: 'warm', launch: preparedLaunch }, h.context);
        expect(acquired).toMatchObject({ kind: 'pending', nativeOperationRef: { value: { imageId: launch.imageId } } });
        const nativeOperation = (acquired as { nativeOperationRef: { value: unknown } }).nativeOperationRef.value;
        expect(await h.action('space-reconcile')({ nativeOperation }, h.context)).toMatchObject({ kind: 'bound', resource: { value: { spaceId: 'local:happier-warm' } } });
        expect(native.requests.filter(request => request.args?.includes('create') && request.args.includes('checkpoint:happier-prepared-one'))).toHaveLength(1);
    });
    it('recovers a lost checkpoint reply by inspecting the retained operation without another create', async () => {
        const native = preparationHarness({ lostCheckpointReply: true });
        const h = await activated(true, native.run);
        const built = await h.action('sandbox-prepare-build')({ operationId: 'one', input: preparationInput('sandbox') }, h.context);
        expect(built).toMatchObject({ kind: 'unknown', nativeOperationRef: { value: { operationId: 'one', launch } } });
        const nativeOperation = (built as { nativeOperationRef: unknown }).nativeOperationRef;
        const before = native.requests.length;
        expect(await h.action('sandbox-prepare-inspect')({ nativeOperation }, h.context)).toMatchObject({ kind: 'pending' });
        expect(native.requests.slice(before).some(request => request.args?.includes('rm'))).toBe(false);
        expect(await h.action('sandbox-prepare-build')({ operationId: 'one', input: preparationInput('sandbox') }, h.context)).toMatchObject({ kind: 'ready' });
        expect(native.requests.filter(request => request.args?.includes('create'))).toHaveLength(1);
    });
    it('does not checkpoint failed setup and lets owned cleanup settle the builder', async () => {
        const native = preparationHarness({ failedSetup: true });
        const h = await activated(true, native.run);
        const built = await h.action('sandbox-prepare-build')({ operationId: 'one', input: preparationInput('sandbox', launch, 'exit 17') }, h.context);
        expect(built).toMatchObject({ kind: 'unknown' });
        expect(native.requests.some(request => request.args?.includes('checkpoint'))).toBe(false);
        expect(await h.action('sandbox-prepare-destroy')({ nativeOperation: (built as { nativeOperationRef: unknown }).nativeOperationRef }, h.context)).toEqual({ kind: 'confirmed' });
    });
    it('refuses to overwrite or delete a foreign checkpoint with the same native name', async () => {
        const native = preparationHarness({ foreignCheckpoint: true });
        const h = await activated(true, native.run);
        const reference = { contributionRef: { pluginId: 'happier.machine.cua', localId: 'local-sandbox' }, schemaVersion: 1,
            value: { operationId: 'one', launch } };
        expect(await h.action('sandbox-prepare-build')({ operationId: 'one', input: preparationInput('sandbox') }, h.context)).toMatchObject({ kind: 'unknown' });
        expect(await h.action('sandbox-prepare-destroy')({ nativeOperation: reference }, h.context)).toMatchObject({ kind: 'unknown' });
        expect(native.requests.some(request => request.args?.includes('create') || request.args?.includes('unpin') || request.args?.includes('rm'))).toBe(false);
    });
});

it('preserves authored failure details through local acquisition and retained reconciliation', async () => {
    const refusal = new PluginError({ code: 'host_access_denied', message: 'Allow the native process', details: { phase: 'admission' } });
    const h = harness();
    const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: { run: async request => {
        if (request.args?.includes('create') || request.args?.includes('info')) throw refusal;
        return h.run(request);
    } } });
    const provider = createCuaLocalProvisioner(native, 'local-sandbox', 10);
    await expect(provider.acquire(launch, managedId)).rejects.toBe(refusal);
    await expect(provider.reconcile(localAcquireOperation('local-sandbox', launch, managedId))).rejects.toBe(refusal);
});

async function activated(dependencyReady = true, nativeRun?: ExecService['run'], signal = new AbortController().signal,
    version = '0.27.5', supervise?: (spec: ManagedServiceSpec) => Promise<unknown>, observedRuntime: 'qemu' | 'gvisor' | 'runc' = 'qemu') {
    const h = harness(false, observedRuntime);
    const actions = new Map<string, ActionHandler>();
    // Substitute only external host registration/services and native processes;
    // real author admission, Action schemas and local lifecycle logic execute.
    const api = { actions: { register(id: string, handler: ActionHandler) {
        actions.set(id, handler); return { dispose() {} };
    } }, connectedAccounts: { register() { return { dispose() {} }; } } } as unknown as PluginApi;
    await CUA_PLUGIN.activate(api);
    const context = { invokedAtMs: 10, signal, services: { exec: { run: nativeRun ?? h.run },
        managedServices: { dependencies: { status: async (): Promise<ManagedDependencyStatus> => dependencyReady ? ({
            state: 'ready', id: 'cua-cli', version, sourceId: 'system',
            executable: { kind: 'managedDependency', id: { pluginId: CUA_PLUGIN.manifest.id, localId: 'cua-cli' } },
        }) : ({ state: 'missing', id: 'cua-cli', supported: true }) },
            supervise: supervise ?? (async () => { throw new Error('Unexpected managed service'); }) },
    } } as unknown as PluginInvocationContext;
    const action = (id: string) => {
        const handler = actions.get(id);
        if (!handler) throw new Error(`declared Action ${id} was not activated`);
        return handler;
    };
    return { ...h, action, context };
}

describe('consumed Cua local provisioner roles', () => {
    it.each(['sandbox', 'space'] as const)('holds the %s native byte channel until exit and disposes its carrier', async prefix => {
        const h = await activated(true, undefined, undefined, '0.27.5');
        const termination = { observed: { kind: 'exit', exitCode: 37 }, requestedBy: { kind: 'none' } } as const;
        let finish!: () => void;
        const exited = new Promise<typeof termination>(resolve => { finish = () => resolve(termination); });
        const dispose = vi.fn(async () => {});
        // External Exec host boundary: the host owns the private invocation byte channel.
        const spawn: ExecService['spawn'] = vi.fn(async () => ({ waitForExit: () => exited, dispose }) as unknown as PluginProcessHandle);
        Object.assign(h.context.services.exec, { spawn });
        const target = prefix === 'space' ? { kind: 'space', spaceId: resource.sandboxId,
            sandboxId: resource.sandboxId, runtimeId: 'qemu' } : resource;
        let settled = false;
        const pending = h.action(`${prefix}-stream`)({ resource: target, argv: ['happier', 'stdio', 'literal ; $HOME'] }, h.context)
            .then(value => { settled = true; return value; });
        await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
        expect(settled).toBe(false);
        expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
            args: ['--embedded', 'sandbox', 'exec', '-i', '--timeout', '0', resource.sandboxId,
                '--', 'happier', 'stdio', 'literal ; $HOME'],
        }), { signal: h.context.signal, outputDelivery: 'invocation' });
        finish();
        expect(await pending).toEqual({ termination });
        expect(dispose).toHaveBeenCalledOnce();
    });
    it('disposes a failed native channel and preserves the host cancellation', async () => {
        const h = await activated();
        const aborted = new PluginError({ code: 'plugin_action_aborted', message: 'Cancelled' });
        const dispose = vi.fn(async () => {});
        // Genuine host-process boundary; internal role and resource admission run unchanged.
        Object.assign(h.context.services.exec, { spawn: async () => ({
            waitForExit: async () => { throw aborted; }, dispose,
        }) as unknown as PluginProcessHandle });
        await expect(h.action('sandbox-stream')({ resource, argv: ['happier', 'stdio'] }, h.context)).rejects.toBe(aborted);
        expect(dispose).toHaveBeenCalledOnce();
    });
    it.each(['sandbox', 'space'] as const)('repairs a missing CLI inline before checking %s again', async prefix => {
        const h = await activated(false);
        const check = await h.action(`${prefix}-check`)({}, h.context);
        expect(check).toMatchObject({ available: false, prerequisites: [{
            repairAction: { action: { pluginId: CUA_PLUGIN.manifest.id, localId: 'install' }, input: {} },
        }] });
        const installed = await activated();
        // Managed dependency installation/status is the host boundary; the
        // registered repair Action and subsequent native check remain real.
        h.context.services.managedServices.dependencies.ensure = async () => {
            h.context.services.managedServices.dependencies.status = installed.context.services.managedServices.dependencies.status;
            const status = await installed.context.services.managedServices.dependencies.status('cua-cli');
            if (status.state !== 'ready') throw new Error('Fixture installation did not become ready');
            return status;
        };
        await h.action('install')({}, h.context);
        expect(await h.action(`${prefix}-check`)({}, h.context)).toMatchObject({ available: true });
    });
    it.each(['local-sandbox', 'local-space'] as const)('retains projected native create failure for %s', async localId => {
        const h = harness();
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: {
            run: async request => request.args?.includes('create') ? { ...result(null),
                termination: { observed: { kind: 'exit', exitCode: 1 }, requestedBy: { kind: 'none' } },
                stderr: new TextEncoder().encode('boot failed token=private-acquisition-token') } : h.run(request),
        } });
        const acquired = await createCuaLocalProvisioner(native, localId, 10).acquire(launch, managedId);
        expect(acquired).toMatchObject({ kind: 'pending', nativeCause: { localCause: 'native_command_failed', command: 'create', exitCode: 1 } });
        expect(JSON.stringify(acquired)).not.toContain('private-acquisition-token');
    });

    it('does not bind a stopped sandbox returned by create', async () => {
        const h = harness();
        const native = createCuaNativeClient({ executable: { kind: 'systemTool', id: 'cua' }, exec: {
            run: async request => request.args?.includes('create') ? result({ id: `local:happier-${managedId}`, name: `happier-${managedId}`,
                location: 'local', runtime: 'qemu', kind: 'vm', image: launch.imageId, status: 'ready', state: 'stopped', ephemeral: false }) : h.run(request),
        } });
        expect(await createCuaLocalProvisioner(native, 'local-sandbox', 10).acquire(launch, managedId)).toMatchObject({ kind: 'pending' });
    });
    it.each(['sandbox', 'space'])('qualifies the offered local %s launch through the registered acquisition role', async prefix => {
        const h = await activated();
        const options = MachineProvisionerOptionsResultV1Schema.parse(await h.action(`${prefix}-options`)({ runtimeId: launch.runtimeId, imageId: launch.imageId, size }, h.context));
        const selected = select(options);
        expect(selected).toMatchObject({ kind: 'ready', launch });
        if (selected.kind !== 'ready') throw new Error('Expected complete native selection');
        const acquired = await h.action(`${prefix}-acquire`)({ launch: selected.launch, managedId }, h.context);
        expect(acquired).toMatchObject({ kind: prefix === 'sandbox' ? 'bound' : 'pending' });
        expect(h.requests.find(request => request.args?.includes('create'))?.args).toContain(`--name=happier-${managedId}`);
    });

    it('refuses a qemu Space disk below its image minimum before native creation', async () => {
        const h = harness();
        const provider = createCuaLocalProvisioner(createCuaNativeClient({ exec: { run: h.run },
            executable: { kind: 'systemTool', id: 'cua' } }), 'local-space', 10);
        const smaller = { ...launch, size: { ...size, diskBytes: 10 * 1024 ** 3 } };
        expect(await provider.acquire(smaller, managedId)).toEqual({ kind: 'rejected', code: 'invalid_request' });
        expect(h.requests.some((request) => request.args?.includes('create'))).toBe(false);
    });
    it.each(['sandbox', 'space'])('declares the reviewed selectors needed to obtain a complete fresh %s launch', async prefix => {
        const h = await activated();
        const options = CUA_PLUGIN.manifest.contributes.actions?.find(action => action.id === `${prefix}-options`);
        const paths = options?.inputHints?.fields.map(field => field.path) ?? [];
        // Runtime and image are chosen from the returned choices, so they are not also asked as text filters;
        // the disk follows the image, so only a Space is asked for one.
        expect(paths).toEqual(['size.cpu', 'size.memoryBytes', ...(prefix === 'space' ? ['size.diskBytes'] : [])]);
        expect(options?.inputHints?.fields.filter(field => field.required).map(field => [field.path, field.defaultValue]))
            .toEqual([['size.cpu', undefined], ['size.memoryBytes', undefined]]);
        const choices = MachineProvisionerOptionsResultV1Schema.parse(await h.action(`${prefix}-options`)({ runtimeId: launch.runtimeId, imageId: launch.imageId, size }, h.context));
        const selected = select(choices);
        expect(selected).toMatchObject({ kind: 'ready', launch });
        const { diskBytes: _imageDisk, ...withoutDisk } = size;
        expect(select(MachineProvisionerOptionsResultV1Schema.parse(await h.action(`${prefix}-options`)(
            { runtimeId: launch.runtimeId, imageId: launch.imageId, size: withoutDisk }, h.context))))
            .toMatchObject({ kind: 'ready', launch });
        if (selected.kind !== 'ready') throw new Error('Expected complete native selection');
        expect(CuaLocalLaunchV1Schema.parse(selected.launch)).toEqual(launch);
        expect(h.requests.every(request => !(request.args ?? []).includes('create'))).toBe(true);
    });
    it('recovers original host correlation by lookup after the process lost its first operation report', async () => {
        const h = await activated(true, async request => {
            const args = request.args ?? [];
            if (args.includes('info')) return result({ id: `local:happier-${managedId}`, name: `happier-${managedId}`,
                location: 'local', runtime: 'qemu', kind: 'vm', image: launch.imageId, status: 'ready', state: 'running', ephemeral: false });
            throw new Error('Correlation recovery cannot allocate');
        });
        expect(await h.action('sandbox-reconcile')({ correlation: { managedId, requestId: 'submitted', launch } }, h.context))
            .toMatchObject({ kind: 'bound', resource: { value: { sandboxId: `local:happier-${managedId}` } } });
    });
    it.each(['qemu', 'runc'])('retains submitted Space custody after allocation and an aborted %s follow-up', async runtimeId => {
        const abort = new AbortController();
        const run = async (request: PluginExecSpawnRequest) => {
            const args = request.args ?? [];
            if (args.includes('doctor')) return result({ ...doctor, container: { reachable: true, gvisor: false, runtimes: ['runc'] },
                backends: [...doctor.backends, { backend: 'container', ready: true, provisionable: false }] });
            if (args.includes('images')) return result([{ ...images[0], local: runtimeId === 'qemu' ? 'qemu' : 'container' }]);
            if (args.includes('create')) {
                abort.abort();
                const id = `local:happier-${managedId}`;
                return result(runtimeId === 'qemu' ? { spaces: [{ id, provider: 'local' }] } : {
                    id, name: `happier-${managedId}`, location: 'local', runtime: runtimeId, kind: 'container',
                    image: launch.imageId, status: 'ready', state: 'running', ephemeral: false });
            }
            throw new Error('No further native effect is admitted');
        };
        const h = await activated(true, run, abort.signal);
        expect(await h.action('space-acquire')({ launch: { ...launch, runtimeId }, managedId }, h.context))
            .toMatchObject({ kind: 'pending', nativeOperationRef: { value: { resource: {
                sandboxId: `local:happier-${managedId}`, spaceId: `local:happier-${managedId}`, runtimeId,
            }, imageId: launch.imageId } } });
    });
    it('reconciles a dropped local reply through qualified reads without another create', async () => {
        const h = await activated();
        expect(await h.action('sandbox-reconcile')({ nativeOperation: { resource, imageId: launch.imageId } }, h.context))
            .toMatchObject({ kind: 'bound', resource: { value: resource } });
        expect(h.requests.some(request => request.args?.includes('create'))).toBe(false);
    });
    it.each(['runc', 'gvisor'] as const)('deletes an exact retained pending %s Space without requiring registry membership', async runtimeId => {
        const abort = new AbortController();
        const requests: PluginExecSpawnRequest[] = [];
        const id = `local:happier-${managedId}`;
        const remaining = new Set([id, 'local:neighbor']);
        const containerLaunch = CuaLocalLaunchV1Schema.parse({ ...launch, runtimeId });
        const run: ExecService['run'] = async request => {
            requests.push(request);
            const args = request.args ?? [];
            if (args.includes('doctor')) return result({ ...doctor, container: { reachable: true, gvisor: false, runtimes: ['runc'] },
                backends: [{ backend: 'container', ready: true, provisionable: false }] });
            if (args.includes('images')) return result([{ ...images[0], local: 'container' }]);
            if (args.includes('create')) {
                abort.abort();
                return result({ id, name: `happier-${managedId}`, location: 'local', runtime: runtimeId, kind: 'container',
                    image: launch.imageId, status: 'ready', state: 'running', ephemeral: false });
            }
            if (args.includes('info')) return result({ id, name: `happier-${managedId}`, location: 'local', runtime: runtimeId, kind: 'container',
                image: launch.imageId, status: 'ready', state: 'running', ephemeral: false });
            if (args.includes('ls')) return result({ spaces: [] });
            if (args.includes('rm') && args.includes('sandbox')) {
                remaining.delete(args[args.indexOf('rm') + 1]);
                return result({ deleted: id, missing: false });
            }
            throw new Error('Unexpected native operation');
        };
        const acquiring = await activated(true, run, abort.signal);
        // gVisor can exist from older acquisitions. Reopen its canonical
        // retained-operation shape without authorizing a new gVisor allocation.
        const acquired = runtimeId === 'runc'
            ? await acquiring.action('space-acquire')({ launch: containerLaunch, managedId }, acquiring.context)
            : { kind: 'pending' as const, nativeOperationRef: { value: localAcquireOperation('local-space', containerLaunch, managedId) } };
        expect(acquired).toMatchObject({ kind: 'pending' });
        if (acquired.kind !== 'pending') throw new Error('Expected retained operation');
        const cleanup = await activated(true, run);
        // Enrollment still requires registration; cleanup only needs the exact compute.
        expect(await cleanup.action('space-reconcile')({ nativeOperation: acquired.nativeOperationRef.value }, cleanup.context))
            .toMatchObject({ kind: 'pending' });
        expect(await cleanup.action('space-destroy')({ nativeOperation: acquired.nativeOperationRef.value }, cleanup.context))
            .toEqual({ kind: 'confirmed' });
        expect([...remaining]).toEqual(['local:neighbor']);
        expect(requests.filter(request => request.args?.includes('create'))).toHaveLength(runtimeId === 'runc' ? 1 : 0);
        expect(requests.some(request => request.args?.includes('add'))).toBe(false);
    });
    it.each(['sandbox', 'space'] as const)('settles repeated pending %s cleanup after losing the native rm reply', async prefix => {
        const requests: PluginExecSpawnRequest[] = [];
        let present = true;
        const pendingResource = prefix === 'sandbox' ? resource : { kind: 'space', spaceId: 'local:owned',
            sandboxId: 'local:owned', runtimeId: 'qemu' };
        const h = await activated(true, async request => {
            requests.push(request);
            const args = request.args ?? [];
            if (args.includes('info')) return present
                ? result({ id: 'local:owned', name: 'owned', location: 'local', runtime: 'qemu', kind: 'vm',
                    image: launch.imageId, status: 'ready', state: 'running', ephemeral: false })
                : { ...result(null), termination: { observed: { kind: 'exit', exitCode: 3 }, requestedBy: { kind: 'none' } } };
            if (args.includes('ls')) return result({ spaces: [] });
            if (args.includes('sandbox') && args.includes('rm')) {
                present = false;
                throw new Error('Native rm completed but its reply was lost');
            }
            throw new Error('Unexpected native effect');
        });
        const input = { nativeOperation: { resource: pendingResource, imageId: launch.imageId } };
        expect(await h.action(`${prefix}-destroy`)(input, h.context)).toMatchObject({ kind: 'unknown' });
        expect(await h.action(`${prefix}-destroy`)(input, h.context)).toEqual({ kind: 'confirmed' });
        expect(requests.filter(request => request.args?.includes('sandbox') && request.args.includes('rm'))).toHaveLength(1);
    });
    it.each(['retained', 'reply-lost'] as const)('settles repeated pending Space cleanup after registry removal is %s', async failure => {
        const remainingCompute = new Set(['local:owned', 'local:neighbor']);
        const registrations = new Set(['local:owned', 'local:neighbor']);
        let firstRemoval = true;
        const h = await activated(true, async request => {
            const args = request.args ?? [];
            if (args.includes('info')) return remainingCompute.has('local:owned')
                ? result({ id: 'local:owned', name: 'owned', location: 'local', runtime: 'qemu', kind: 'vm',
                    image: null, status: 'ready', state: 'running', ephemeral: false })
                : { ...result(null), termination: { observed: { kind: 'exit', exitCode: 3 }, requestedBy: { kind: 'none' } } };
            if (args.includes('sandbox') && args.includes('rm')) {
                remainingCompute.delete(args[args.indexOf('rm') + 1]);
                return result({ deleted: 'local:owned', missing: false });
            }
            if (args.includes('ls')) return result({ spaces: [...registrations].map(id => ({ id, provider: 'local', image: launch.imageId })) });
            if (args.includes('spaces') && args.includes('rm')) {
                if (!firstRemoval || failure === 'reply-lost') registrations.delete(args[args.indexOf('rm') + 1]);
                if (firstRemoval) {
                    firstRemoval = false;
                    throw new Error('Native registry removal reply unavailable');
                }
                return result({ removed: { id: 'local:owned', provider: 'local' } });
            }
            throw new Error('Unexpected native effect');
        });
        const input = { nativeOperation: { resource: { kind: 'space', spaceId: 'local:owned',
            sandboxId: 'local:owned', runtimeId: 'qemu' }, imageId: launch.imageId } };
        const first = await h.action('space-destroy')(input, h.context);
        expect(first).toMatchObject({ kind: failure === 'retained' ? 'unknown' : 'confirmed' });
        if (failure === 'retained') {
            expect(await h.action('space-inspect')({ resource: input.nativeOperation.resource }, h.context))
                .toMatchObject({ availability: 'unavailable' });
        }
        expect(await h.action('space-destroy')(input, h.context)).toEqual({ kind: 'confirmed' });
        expect([...remainingCompute]).toEqual(['local:neighbor']);
        expect([...registrations]).toEqual(['local:neighbor']);
    });
    it.each([
        ['sandbox', 'wrong-image'], ['sandbox', 'unavailable'], ['space', 'wrong-image'], ['space', 'unavailable'],
        ['space', 'wrong-registry-image'], ['space', 'registry-unavailable'],
    ] as const)('refuses pending %s deletion when native identity qualification is %s', async (prefix, condition) => {
        const requests: PluginExecSpawnRequest[] = [];
        const pendingResource = prefix === 'sandbox' ? resource : { kind: 'space', spaceId: 'local:owned', sandboxId: 'local:owned', runtimeId: 'qemu' };
        const h = await activated(true, async request => {
            requests.push(request);
            if (request.args?.includes('info')) {
                if (condition === 'unavailable') throw new Error('Native read unavailable');
                return result({ id: 'local:owned', name: 'owned', location: 'local', runtime: 'qemu', kind: 'vm',
                    image: condition === 'wrong-registry-image' || condition === 'registry-unavailable' ? null : 'other-image',
                    status: 'ready', state: 'running', ephemeral: false });
            }
            if (request.args?.includes('ls')) {
                if (condition === 'registry-unavailable') throw new Error('Registry read unavailable');
                return result({ spaces: [{ id: 'local:owned', provider: 'local',
                    image: condition === 'wrong-registry-image' ? 'other-image' : launch.imageId }] });
            }
            throw new Error('No cleanup effect is qualified');
        });
        expect(await h.action(`${prefix}-destroy`)({ nativeOperation: { resource: pendingResource, imageId: launch.imageId } }, h.context))
            .toMatchObject({ kind: 'unknown' });
        expect(requests.some(request => request.args?.includes('rm'))).toBe(false);
    });
    it.each([987654, null])('forwards the containing guest budget %s and output delivery without applying it to reads', async timeoutMs => {
        const requests: Array<{ request: PluginExecSpawnRequest & { timeoutMs?: number }; options: unknown }> = [];
        const native = harness();
        const h = await activated(true, async (request, options) => {
            requests.push({ request, options });
            return native.run(request);
        });
        await h.action('sandbox-exec')({ resource, argv: ['cat'], timeoutMs }, h.context);
        const shell = requests.find(({ request }) => request.args?.includes('shell'));
        expect(shell).toMatchObject({ request: timeoutMs === null ? {} : { timeoutMs }, options: { signal: h.context.signal, outputDelivery: 'invocation' } });
        if (timeoutMs === null) expect(shell?.request.timeoutMs).toBeUndefined();
        expect(requests.find(({ request }) => request.args?.includes('info'))?.request.timeoutMs).toBeUndefined();
    });
    it('passes actual public author admission with both local native carriers and strict role schemas', () => {
        const manifest = CUA_PLUGIN.manifest;
        const admission = parsePluginManifest(manifest);
        expect(admission, JSON.stringify(admission)).toMatchObject({ ok: true });
        expect(manifest.contributes?.machineProvisioners).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'local-sandbox', bootstrapTransport: expect.objectContaining({ kind: 'native' }) }),
            expect.objectContaining({ id: 'local-space', bootstrapTransport: expect.objectContaining({ kind: 'native' }) }),
        ]));
    });
    it('qualifies selected image/runtime before creating and returns the real family envelope', async () => {
        const h = harness();
        const acquired = await h.provider.acquire(launch, managedId);
        expect(acquired).toMatchObject({ kind: 'bound', resource: { contributionRef: { pluginId: 'happier.machine.cua', localId: 'local-sandbox' }, schemaVersion: 1,
            value: { kind: 'sandbox', namespace: 'local', runtimeId: 'qemu' } } });
        if (acquired.kind !== 'bound') throw new Error('expected bound');
        const id = acquired.resource.value.sandboxId;
        expect(id).toMatch(/^local:happier-/);
        expect(h.requests.filter((request) => request.args?.includes('create'))).toHaveLength(1);
        const invalid = harness();
        expect(await invalid.provider.acquire({ ...launch, imageId: 'ghcr.io/trycua/cloud:1' }, managedId)).toEqual({ kind: 'rejected', code: 'invalid_request' });
        expect(invalid.requests.some((request) => request.args?.includes('create'))).toBe(false);
    });
    it('retains exact local recovery on uncertain acquisition and refuses unsupported Stop without replacement', async () => {
        const h = harness(true);
        expect(await h.provider.acquire(launch, managedId)).toMatchObject({ kind: 'pending', nativeOperationRef: { value: {
            resource: { sandboxId: `local:happier-${managedId}` }, imageId: launch.imageId } } });
        expect(await h.provider.power(resource, 'stop')).toEqual({ kind: 'refused', code: 'cua_unsupported_intent' });
        expect(h.requests.filter((request) => request.args?.includes('create'))).toHaveLength(1);
        expect(await h.provider.bootstrap(resource)).toEqual({ kind: 'native', transport: {
            contributionRef: { pluginId: 'happier.machine.cua', localId: 'local-sandbox' }, schemaVersion: 1,
        } });
    });
    it.each(['local-sandbox', 'local-space'] as const)('reports retained storage for suspended %s so Protocol can admit wake', async (localId) => {
        const h = harness(false, 'qemu', 'suspended');
        const provider = createCuaLocalProvisioner(createCuaNativeClient({ exec: { run: h.run },
            executable: { kind: 'systemTool', id: 'cua' } }), localId, 10);
        const target = localId === 'local-space' ? { kind: 'space', runtimeId: resource.runtimeId,
            sandboxId: resource.sandboxId, spaceId: resource.sandboxId } : resource;
        expect(await provider.inspect(target)).toMatchObject({ availability: 'present', power: 'suspended', storage: 'retained' });
    });
    it('returns complete options only from reviewed size selectors and reopens stored additions through the SDK owner', async () => {
        const h = harness();
        expect(select(await h.provider.options({ size }))).toMatchObject({ kind: 'ready', launch });
        expect(await h.provider.inspectStored({ ...resource, future: true })).toEqual({ observedAt: 10, availability: 'present', power: 'running', storage: 'retained',
            billing: { location: 'local', stoppedBilling: 'not-billed' } });
        await expect(h.provider.inspectStored({ ...resource, runtimeId: 'cloud' })).rejects.toThrow();
    });
    it('consumes the host managed identity through the activated acquire role', async () => {
        const h = await activated();
        expect(await h.action('sandbox-acquire')({ launch, managedId }, h.context)).toMatchObject({ kind: 'bound',
            resource: { value: { sandboxId: `local:happier-${managedId}` } } });
        const missing = await activated();
        expect(await missing.action('sandbox-acquire')({ launch }, missing.context)).toEqual({ kind: 'rejected', code: 'invalid_request' });
        expect(missing.requests).toEqual([]);
    });
    it('invokes activated bootstrap and private buffered carrier roles without disclosing input in argv', async () => {
        const h = await activated();
        expect(await h.action('sandbox-check')({}, h.context)).toMatchObject({ available: true,
            prerequisites: [{ requirement: { kind: 'managedDependency', id: { pluginId: CUA_PLUGIN.manifest.id, localId: 'cua-cli' } }, status: 'available' }] });
        expect(await h.action('sandbox-bootstrap')({ resource }, h.context)).toMatchObject({ kind: 'native',
            transport: { contributionRef: { pluginId: CUA_PLUGIN.manifest.id, localId: 'local-sandbox' } } });
        expect(await h.action('sandbox-exec')({ resource, argv: ['cat'], inputBase64: 'AP4K' }, h.context))
            .toMatchObject({ stdoutBase64: '/wCA', stderrBase64: '', stdoutTruncated: false });
        expect(await h.action('sandbox-put-file')({ resource, guestPath: '/tmp/bootstrap-binary', bytesBase64: 'AP4K', mode: 384 }, h.context))
            .toEqual({ kind: 'confirmed' });
        expect(JSON.stringify(h.requests)).not.toContain('AP4K');
        await expect(h.action('sandbox-exec')({ resource: { ...resource, future: true }, argv: ['cat'] }, h.context)).rejects.toThrow();
    });
    it('writes shared-admitted padding bits exactly through the local file Action', async () => {
        const h = await activated();
        const kit = await createPluginTestkit({ manifest: CUA_PLUGIN.manifest, module: CUA_PLUGIN,
            services: h.context.services as unknown as PluginTestServicesFixture });
        try {
            expect(await kit.invokeAction('sandbox-put-file', { resource, guestPath: '/tmp/bootstrap-binary', bytesBase64: 'AB==', mode: 384 }, { surface: 'plugin' }))
                .toEqual({ kind: 'confirmed' });
            expect(h.copiedBytes).toEqual([Buffer.from([0])]);
            await expect(kit.invokeAction('sandbox-put-file', { resource, guestPath: '/tmp/bootstrap-binary', bytesBase64: 'AA==\n' }, { surface: 'plugin' })).rejects.toThrow();
            expect(h.copiedBytes).toHaveLength(1);
        } finally { await kit.dispose(); }
    });
    it.each(['sandbox', 'space'])('refuses an unbootstrappable gVisor %s before any native allocation', async prefix => {
        const requests: PluginExecSpawnRequest[] = [];
        const h = await activated(true, async request => {
            requests.push(request);
            const args = request.args ?? [];
            if (args.includes('doctor')) return result({ ...doctor,
                container: { reachable: true, gvisor: true, runtimes: ['runsc'] },
                backends: [{ backend: 'container', ready: true, provisionable: false }] });
            if (args.includes('images')) return result([{ ...images[0], local: 'container' }]);
            // This boundary would allocate if acquisition bypassed option qualification.
            if (args.includes('create')) return result({ id: `local:happier-${managedId}`,
                name: `happier-${managedId}`, location: 'local', runtime: 'gvisor', kind: 'container',
                image: launch.imageId, status: 'ready', state: 'running', ephemeral: false });
            return result({ spaces: [] });
        });
        const options = MachineProvisionerOptionsResultV1Schema.parse(
            await h.action(`${prefix}-options`)({ runtimeId: 'gvisor', imageId: launch.imageId, size }, h.context));
        expect(select(options)).toMatchObject({ kind: 'unavailable' });
        expect(select(options)).not.toHaveProperty('launch');
        expect(await h.action(`${prefix}-acquire`)({ launch: { ...launch, runtimeId: 'gvisor' }, managedId }, h.context))
            .toEqual({ kind: 'rejected', code: 'invalid_request' });
        // Cost/safety contract: an unusable choice creates no resource, even via direct acquire.
        expect(requests.filter(request => request.args?.includes('create'))).toHaveLength(0);
    });
    it('qualifies runc and QEMU bootstrap while refusing a retained legacy gVisor resource', async () => {
        const runc = harness(false, 'runc');
        await expect(runc.provider.bootstrap({ ...resource, runtimeId: 'runc' })).resolves.toMatchObject({ kind: 'native',
            guestHome: { homeDir: '/home/cua', happyHomeDir: '/home/cua/.happier', daemonStartup: 'native-process' } });
        const h = harness();
        await expect(h.provider.bootstrap(resource)).resolves.not.toHaveProperty('guestHome');
        const gvisor = harness(false, 'gvisor');
        await expect(gvisor.provider.bootstrap({ ...resource, runtimeId: 'gvisor' }))
            .rejects.toMatchObject({ code: 'cua_guest_daemon_hold_unavailable' });
    });
    it('waits for the finite runc start carrier to confirm a detached daemon before settling', async () => {
        const requests: Array<{ request: PluginExecSpawnRequest; options: unknown }> = [];
        const native = harness(false, 'runc');
        const detachedCommand = "'sh' '-c' 'exec env '\\''/home/cua/.happier/cli/current/happier'\\'' '\\''daemon'\\'' '\\''start'\\'' '\\''--json'\\'''";
        let completeCarrier: ((value: PluginProcessResult) => void) | undefined;
        const carrier = new Promise<PluginProcessResult>((resolve) => { completeCarrier = resolve; });
        const run: ExecService['run'] = async (request, options) => {
            requests.push({ request, options });
            if (request.args?.at(-1) === detachedCommand) return carrier;
            return native.run(request);
        };
        const runc = { ...resource, runtimeId: 'runc' as const };
        // Cua selects the typed detached alternative and never parses the
        // host-owned foreground invocation, whose quoting/order may evolve.
        const argv = ['sh', '-c', 'host-owned foreground invocation'];
        const detachedArgv = ['sh', '-c', "exec env '/home/cua/.happier/cli/current/happier' 'daemon' 'start' '--json'"];
        const processConfig = { environment: { HOME: '/home/cua', HAPPIER_HOME_DIR: '/home/cua/.happier' },
            detachedDaemonStartArgv: detachedArgv };
        const first = await activated(true, run, new AbortController().signal, '0.27.5', undefined, 'runc');
        let settled = false;
        const configured = first.action('sandbox-exec')({ resource: runc, argv, processConfig }, first.context)
            .then((value) => { settled = true; return value; });
        await vi.waitFor(() => expect(requests.some(({ request }) => request.args?.at(-1) === detachedCommand)).toBe(true));
        expect(settled).toBe(false);
        completeCarrier?.(result({ ok: true, status: 'started', relay: 'https://example.test', relayId: 'example' }));
        await expect(configured).resolves.toEqual({ kind: 'process-configured' });
        expect(requests.find(({ request }) => request.args?.at(-1) === detachedCommand)).toMatchObject({
            request: { args: ['--embedded', 'sandbox', 'shell', 'local:owned', detachedCommand], env: { HOME: expect.any(String) } },
            options: { signal: first.context.signal, outputDelivery: 'invocation' },
        });
        expect(requests.some(({ request }) => request.args?.at(-1)?.includes('host-owned foreground invocation'))).toBe(false);

        const notReady = await activated(true, async (request) => request.args?.at(-1) === detachedCommand
            ? result({ ok: true, status: 'starting' }) : native.run(request), new AbortController().signal, '0.27.5', undefined, 'runc');
        await expect(notReady.action('sandbox-exec')({ resource: runc, argv, processConfig }, notReady.context))
            .rejects.toMatchObject({ code: 'cua_guest_daemon_hold_unavailable' });
    });
    it('refuses a foreground hold whose home is not the home the guest shell actually runs in', async () => {
        const h = await activated(true, undefined, new AbortController().signal, '0.27.5', undefined, 'runc');
        const processConfig = { environment: { HOME: '/root', HAPPIER_HOME_DIR: '/root/.happier' },
            detachedDaemonStartArgv: ['true'] };
        await expect(h.action('sandbox-exec')({ resource: { ...resource, runtimeId: 'runc' }, argv: ['true'], processConfig }, h.context))
            .rejects.toMatchObject({ code: 'cua_guest_daemon_hold_unavailable' });
    });
    it('returns the existing unavailable reason when a runtime cannot own detached daemon startup', async () => {
        const h = await activated(true, undefined, new AbortController().signal, '0.27.5', undefined, 'gvisor');
        const processConfig = { environment: { HOME: '/home/cua', HAPPIER_HOME_DIR: '/home/cua/.happier' },
            detachedDaemonStartArgv: ['true'] };
        await expect(h.action('sandbox-exec')({ resource: { ...resource, runtimeId: 'gvisor' }, argv: ['true'], processConfig }, h.context))
            .rejects.toMatchObject({ code: 'cua_guest_daemon_hold_unavailable' });
    });
    it('rejects unavailable native setup before acquisition without inventing a recovery resource', async () => {
        const h = await activated(false);
        expect(await h.action('sandbox-acquire')({ launch, managedId }, h.context)).toEqual({ kind: 'rejected', code: 'provider_unavailable' });
        expect(h.requests).toEqual([]);
    });
});
