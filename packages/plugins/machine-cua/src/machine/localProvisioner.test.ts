import type { MachineProvisionerOptionsResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import { projectMachineProvisionerSelectionV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
function select(options: MachineProvisionerOptionsResultV1) {
    return projectMachineProvisionerSelectionV1({ options, launchSchema: CuaLocalLaunchV1Schema.jsonSchema,
        selection: Object.fromEntries(Object.entries(options.dimensions).flatMap(([dimension, entries]) =>
            entries[0] ? [[dimension, entries[0].id]] : [])) });
}
import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { ManagedDependencyStatus, ManagedServiceSpec } from '@happier-dev/plugin-sdk/managed-services';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { ExecService, PluginExecSpawnRequest, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { createCuaNativeClient } from './nativeClient.js';
import { createCuaLocalProvisioner } from './localProvisioner.js';
import { CUA_PLUGIN } from '../manifest.js';
import { CuaLocalLaunchV1Schema } from './schemas.js';
import { createPluginTestkit, type PluginTestServicesFixture } from '@happier-dev/plugin-sdk/testing';
import { MachineProvisionerOptionsResultV1Schema } from '@happier-dev/plugin-sdk/machine-provisioners';
import { localAcquireOperation } from './localProvisionerSchemas.js';

const size = { cpu: 4, memoryBytes: 4096 * 1024 ** 2, diskBytes: 20 * 1024 ** 3 };
const launch = { on: 'local', runtimeId: 'qemu', imageId: 'ghcr.io/trycua/linux:24.04-disk', size };
const resource = { kind: 'sandbox', namespace: 'local', runtimeId: 'qemu', sandboxId: 'local:owned' };
const managedId = 'ac2c7f10-2a41-4af1-88ac-d64eeb18bdc7';
const doctor = { host: { os: 'linux', arch: 'x86_64', kvm: true, accel: { x86_64: 'kvm', aarch64: 'tcg' } },
    backends: [{ backend: 'qemu', ready: true, provisionable: false }],
    qemu: { version: '10.1.0' }, lume: { version: null }, container: { reachable: false, gvisor: false, runtimes: [] } };
const digest = `sha256:${'a'.repeat(64)}`;
const images = [{ ref: launch.imageId, os: 'linux', arch: ['amd64'], local: 'qemu', published: true, spacesd: true,
    digest, sizes: { digest, platforms: [{ arch: 'amd64', disk: size.diskBytes }] } }];
function result(value: unknown): PluginProcessResult {
    return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
        stdout: new TextEncoder().encode(JSON.stringify(value)), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
}
function harness(createReplyLost = false, observedRuntime: 'qemu' | 'gvisor' | 'runc' = 'qemu') {
    const requests: PluginExecSpawnRequest[] = [];
    const copiedBytes: Buffer[] = [];
    let temporaryId = 0;
    const run = async (request: PluginExecSpawnRequest) => {
        requests.push(request);
        const args = request.args ?? [];
        if (args.includes('doctor')) return result(doctor);
        if (args.includes('images')) return result(images);
        if (args.includes('create')) {
            if (createReplyLost) throw new Error('dropped response');
            const name = args.find((arg) => arg.startsWith('--name='))?.slice(7);
            return result({ id: `local:${name}`, name, location: 'local', runtime: 'qemu', kind: 'vm',
                image: launch.imageId, status: 'ready', state: 'running', ephemeral: false });
        }
        if (args.includes('info')) return result({ id: resource.sandboxId, name: 'owned', location: 'local', runtime: observedRuntime,
            kind: observedRuntime === 'qemu' ? 'vm' : 'container', image: launch.imageId, status: 'ready', state: 'running', ephemeral: false });
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

async function activated(dependencyReady = true, nativeRun?: ExecService['run'], signal = new AbortController().signal,
    version = '0.5.0', supervise?: (spec: ManagedServiceSpec) => Promise<unknown>, observedRuntime: 'qemu' | 'gvisor' | 'runc' = 'qemu') {
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
    it.each(['sandbox', 'space'])('declares the reviewed selectors needed to obtain a complete fresh %s launch', async prefix => {
        const h = await activated();
        const options = CUA_PLUGIN.manifest.contributes.actions?.find(action => action.id === `${prefix}-options`);
        const paths = options?.inputHints?.fields.map(field => field.path) ?? [];
        // Runtime and image are chosen from the returned choices, so they are not also asked as text filters;
        // the disk follows the image, so only a Space is asked for one.
        expect(paths).toEqual(['size.cpu', 'size.memoryBytes', ...(prefix === 'space' ? ['size.diskBytes'] : [])]);
        expect(options?.inputHints?.fields.filter(field => field.required).map(field => [field.path, field.defaultValue]))
            .toEqual([['size.cpu', 2], ['size.memoryBytes', 4 * 1024 ** 3]]);
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
    it.each(['wrong-image', 'unavailable'])('refuses pending Space deletion when native identity qualification is %s', async condition => {
        const requests: PluginExecSpawnRequest[] = [];
        const pendingResource = { kind: 'space', spaceId: 'local:owned', sandboxId: 'local:owned', runtimeId: 'qemu' };
        const h = await activated(true, async request => {
            requests.push(request);
            if (request.args?.includes('info')) {
                if (condition === 'unavailable') throw new Error('Native read unavailable');
                return result({ id: 'local:owned', name: 'owned', location: 'local', runtime: 'qemu', kind: 'vm',
                    image: 'other-image', status: 'ready', state: 'running', ephemeral: false });
            }
            if (request.args?.includes('ls')) return result({ spaces: [] });
            throw new Error('No cleanup effect is qualified');
        });
        expect(await h.action('space-destroy')({ nativeOperation: { resource: pendingResource, imageId: launch.imageId } }, h.context))
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
    it('returns complete options only from reviewed size selectors and reopens stored additions through the SDK owner', async () => {
        const h = harness();
        expect(select(await h.provider.options({ size }))).toMatchObject({ kind: 'ready', launch });
        expect(await h.provider.inspectStored({ ...resource, future: true })).toEqual({ observedAt: 10, availability: 'present', power: 'running',
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
        const first = await activated(true, run, new AbortController().signal, '0.5.0', undefined, 'runc');
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
            ? result({ ok: true, status: 'starting' }) : native.run(request), new AbortController().signal, '0.5.0', undefined, 'runc');
        await expect(notReady.action('sandbox-exec')({ resource: runc, argv, processConfig }, notReady.context))
            .rejects.toMatchObject({ code: 'cua_guest_daemon_hold_unavailable' });
    });
    it('refuses a foreground hold whose home is not the home the guest shell actually runs in', async () => {
        const h = await activated(true, undefined, new AbortController().signal, '0.5.0', undefined, 'runc');
        const processConfig = { environment: { HOME: '/root', HAPPIER_HOME_DIR: '/root/.happier' },
            detachedDaemonStartArgv: ['true'] };
        await expect(h.action('sandbox-exec')({ resource: { ...resource, runtimeId: 'runc' }, argv: ['true'], processConfig }, h.context))
            .rejects.toMatchObject({ code: 'cua_guest_daemon_hold_unavailable' });
    });
    it('returns the existing unavailable reason when a runtime cannot own detached daemon startup', async () => {
        const h = await activated(true, undefined, new AbortController().signal, '0.5.0', undefined, 'gvisor');
        const processConfig = { environment: { HOME: '/home/cua', HAPPIER_HOME_DIR: '/home/cua/.happier' },
            detachedDaemonStartArgv: ['true'] };
        await expect(h.action('sandbox-exec')({ resource: { ...resource, runtimeId: 'gvisor' }, argv: ['true'], processConfig }, h.context))
            .rejects.toMatchObject({ code: 'cua_guest_daemon_hold_unavailable' });
    });
    it('qualifies the installed cua CLI against the oldest release that has every flag called, failing at check and before any native effect', async () => {
        // 0.3.0 is the first release containing the pinned vendor commit (trycua/cua@2bce4442) all flags were read from.
        const old = await activated(true, undefined, undefined, '0.2.9');
        expect(await old.action('sandbox-check')({}, old.context)).toMatchObject({ available: false, code: 'cua_native_outdated',
            status: { key: 'machineCua.presentation.cua_native_outdated' } });
        expect(await old.action('sandbox-acquire')({ launch, managedId }, old.context)).toEqual({ kind: 'rejected', code: 'provider_unavailable' });
        expect(old.requests).toEqual([]);
        for (const version of ['0.3.0', '0.10.1']) {
            const current = await activated(true, undefined, undefined, version);
            expect(await current.action('sandbox-check')({}, current.context)).toMatchObject({ available: true });
        }
        const unreadable = await activated(true, undefined, undefined, 'unknown');
        expect(await unreadable.action('space-check')({}, unreadable.context)).toMatchObject({ available: false, code: 'cua_native_outdated' });
    });
    it('rejects unavailable native setup before acquisition without inventing a recovery resource', async () => {
        const h = await activated(false);
        expect(await h.action('sandbox-acquire')({ launch, managedId }, h.context)).toEqual({ kind: 'rejected', code: 'provider_unavailable' });
        expect(h.requests).toEqual([]);
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

});
