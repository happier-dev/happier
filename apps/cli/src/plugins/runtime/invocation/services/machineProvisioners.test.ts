import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMachineProvisionersInvocationService } from './machineProvisioners';
import { createManagedServiceCredentialFileOwner } from './managedServiceCredentialFileOwner';
import type { PluginInvocationServicesSeed } from './types';
import { createPluginInvocationLifetime } from '../lifetime';
import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginActionInvocation } from '@happier-dev/protocol/plugins/actions/invocation';
import type { PluginAccountActionContext, PluginAccountActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { ConnectedAccountMaterializationRequest, ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import { activateAccount as activateDigitalOceanAccount } from '../../../../../../../packages/plugins/machine-digitalocean/src/index';
import { connectedAccountRuntime } from '../../../../../../../packages/plugins/machine-digitalocean/src/account';
import { createManagedBootstrapSshCredential, ManagedMachineControllerError, readManagedBootstrapCredential } from '@happier-dev/cli-common/machines/managed';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('waits for native snapshot observation under the admitted invocation cancellation without opening an SSH key', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let credentialReads = 0;
    const service = createMachineProvisionersInvocationService({ seed: {
        plugin: { id: 'fixture.compute', version: '0' },
        contribution: { id: 'snapshot', qualifiedId: 'fixture.compute/snapshot' },
        occurrenceId: 'occurrence', correlationId: 'restore', surface: 'plugin',
        signal: controller.signal, isOccurrenceCurrent: () => true, retainCleanup: () => {},
        managedBootstrapCredential: { role: 'snapshot', isCurrent: () => true,
            readBootstrapCredential: async () => { credentialReads++; return new Uint8Array(); } },
    } });
    try {
        const first = service!.waitForNativeObservation();
        await vi.advanceTimersByTimeAsync(5000);
        await first;
        const cancelled = expect(service!.waitForNativeObservation()).rejects.toMatchObject({ code: 'cancelled' });
        controller.abort();
        await cancelled;
        expect(credentialReads).toBe(0);
    } finally { vi.useRealTimers(); }
});

describe('DigitalOcean acquire consumes the admitted private guest-host lease', () => {
    async function invocation(status: number, generated = true, privateReader = true) {
        const credential = readManagedBootstrapCredential(createManagedBootstrapSshCredential({
            bootstrapPrivateKey: 'bootstrap-login-only-fixture', randomBytes: size => new Uint8Array(size).fill(7),
        }));
        const bytes = new TextEncoder().encode(credential.guestHostPrivateKey);
        const lifetime = createPluginInvocationLifetime();
        let loginReads = 0;
        const service = createMachineProvisionersInvocationService({ seed: {
            plugin: { id: 'happier.machine.digitalocean', version: '0' },
            contribution: { id: 'acquire', qualifiedId: 'happier.machine.digitalocean/acquire' },
            occurrenceId: 'occurrence', correlationId: 'invocation', surface: 'plugin',
            signal: lifetime.signal, isOccurrenceCurrent: () => true, retainCleanup: lifetime.retainCleanup,
            managedBootstrapCredential: { role: 'acquire', isCurrent: () => true,
                readBootstrapCredential: async () => { loginReads++; return new TextEncoder().encode(credential.bootstrapPrivateKey); },
                ...(privateReader ? { readGuestHostCredential: async () => bytes } : {}),
            },
        } });
        const handlers = new Map<string, PluginAccountActionHandler>();
        // Registration/context are the host boundary; lease, lifetime and leaf logic stay real.
        await activateDigitalOceanAccount({ actions: { register(id: string, handler: PluginAccountActionHandler) {
            handlers.set(id, handler); return { dispose() {} };
        } } } as unknown as PluginAccountApi);
        expect(handlers.has('acquire')).toBe(true);
        const requests: HttpRequest[] = [];
        const credentialContext = { signal: lifetime.signal, credentials: { get: async () => 'captured-private' } } as unknown as ConnectedAccountReadContext;
        const context = { invokedAtMs: lifetime.invokedAtMs, signal: lifetime.signal, services: {
            machineProvisioners: service,
            connectedAccounts: { materialize: async (_purpose: string, request: ConnectedAccountMaterializationRequest) =>
                connectedAccountRuntime.materialize(request, credentialContext) },
            http: { request: async (request: HttpRequest) => {
                requests.push(request);
                return { status, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(
                    status === 201 ? { droplet: { id: 42 } } : { id: status === 403 ? 'forbidden' : 'server_error' })) };
            } },
        } } as unknown as PluginAccountActionContext;
        const input = { managedId: 'cmvnxb7gn009mmcagisyszwlh', bootstrapPublicKey: 'ssh-ed25519 AQIDBA==',
            launch: { regionSlug: 'nyc3', sizeSlug: 's-1vcpu-1gb', imageId: 1, publicNetworking: { ipv6: false } },
            ...(generated ? { guestHostPublicKey: credential.guestHostPublicKey } : {}),
        };
        return { run: () => handlers.get('acquire')!(input, context), requests, bytes, lifetime,
            loginReads: () => loginReads, credential, input };
    }

    it.each([[201, 'bound'], [403, 'rejected'], [500, 'pending']] as const)(
        'installs retained host bytes and disposes them after native status %s', async (status, kind) => {
            const runtime = await invocation(status);
            try {
                const result = await runtime.run();
                expect(result).toMatchObject({ kind });
                expect(runtime.requests).toHaveLength(1);
                const payload = JSON.parse(new TextDecoder().decode(runtime.requests[0]!.body));
                const cloudInit = JSON.parse(payload.user_data.slice('#cloud-config\n'.length));
                expect(cloudInit.ssh_keys).toEqual({ ed25519_private: runtime.credential.guestHostPrivateKey,
                    ed25519_public: runtime.credential.guestHostPublicKey });
                expect(payload.user_data).not.toContain(runtime.credential.bootstrapPrivateKey);
                expect(runtime.bytes).toEqual(new Uint8Array(runtime.bytes.length));
                expect(runtime.loginReads()).toBe(0);
                expect(JSON.stringify({ input: runtime.input, result })).not.toContain(runtime.credential.guestHostPrivateKey);
            } finally { await runtime.lifetime.complete(); }
        });

    it('refuses a generated pin without private custody before any paid HTTP effect', async () => {
        const runtime = await invocation(201, true, false);
        try {
            await expect(runtime.run()).rejects.toMatchObject({ code: 'plugin_service_unavailable' });
            expect(runtime.requests).toEqual([]);
            expect(runtime.loginReads()).toBe(0);
        } finally { await runtime.lifetime.complete(); }
    });

    it('keeps scalar legacy creation key-only without acquiring a guest-host lease', async () => {
        const runtime = await invocation(201, false, false);
        try {
            expect(await runtime.run()).toMatchObject({ kind: 'bound', resource: { value: { dropletId: 42 } } });
            expect(runtime.requests).toHaveLength(1);
            const payload = JSON.parse(new TextDecoder().decode(runtime.requests[0]!.body));
            expect(JSON.parse(payload.user_data.slice('#cloud-config\n'.length)).ssh_keys).toBeUndefined();
            expect(runtime.loginReads()).toBe(0);
        } finally { await runtime.lifetime.complete(); }
    });
});

describe('bootstrap credential failure Action settlement', () => {
    function invocation(readFailure: unknown) {
        const lifetime = createPluginInvocationLifetime();
        let reads = 0;
        let effectAttempted = false;
        const service = createMachineProvisionersInvocationService({ seed: {
            plugin: { id: 'acme.native', version: '0' },
            contribution: { id: 'bootstrap', qualifiedId: 'acme.native/bootstrap' },
            occurrenceId: 'occurrence', correlationId: 'invocation', surface: 'plugin',
            signal: lifetime.signal, isOccurrenceCurrent: () => true, retainCleanup: lifetime.retainCleanup,
            managedBootstrapCredential: { role: 'bootstrap', isCurrent: () => true,
                // SavedSecret custody is the boundary; the byte service and Action settlement stay real.
                readBootstrapCredential: async () => { reads++; throw readFailure; },
            },
        } });
        expect(service).not.toBeNull();
        const run = async () => {
            await service!.materializeBootstrapCredential({ kind: 'bytes' });
            effectAttempted = true;
            return null;
        };
        const action = createPluginActionInvocation({ pluginId: 'acme.native', localId: 'bootstrap',
            declaration: {},
            occurrenceSignal: lifetime.signal, isCurrent: () => true });
        return { run, invoke: () => action.invoke(null, { handler: run }), lifetime,
            reads: () => reads, effectAttempted: () => effectAttempted };
    }

    it.each([
        { error: new ManagedMachineControllerError('credential_unavailable'), code: 'credential_unavailable' },
        { error: Object.assign(new Error('private-saved-secret-fixture'), { code: 'private-arbitrary-code-fixture' }),
            code: 'plugin_service_unavailable' },
    ])('retains the closed credential failure $code through Action settlement before the handler effect', async ({ error, code }) => {
        const runtime = invocation(error);
        try {
            const result = await runtime.invoke();
            expect(runtime.reads()).toBe(1);
            expect(runtime.effectAttempted()).toBe(false);
            expect(result).toMatchObject({ status: 'failed', code, data: { name: 'PluginError', code } });
            expect(JSON.stringify(result)).not.toContain('private-');
        } finally { await runtime.lifetime.complete(); }
    });

    it('preserves canonical credential PluginError identity and native detail through Action settlement', async () => {
        const error = new PluginError({ code: 'native_request_failed', details: {
            nativeCause: { httpStatusClass: '4xx', code: 'invalid_input', fields: ['image'] },
        } });
        const runtime = invocation(error);
        try {
            await expect(runtime.run()).rejects.toBe(error);
            expect(await runtime.invoke()).toMatchObject({ status: 'failed', code: error.code, data: error.data });
            expect(runtime.effectAttempted()).toBe(false);
        } finally { await runtime.lifetime.complete(); }
    });
});

describe('admitted native credential headers', () => {
    const seed = (extra: Partial<PluginInvocationServicesSeed> = {}): PluginInvocationServicesSeed => ({
        plugin: { id: 'acme.native', version: '0' },
        contribution: { id: 'native-apply', qualifiedId: 'acme.native/native-apply' },
        occurrenceId: 'occurrence', correlationId: 'invocation', surface: 'plugin',
        signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        retainCleanup() {}, ...extra,
    });

    it('renders only the invocation-admitted binding without serializing private material', async () => {
        const headers = { authorization: 'Bearer upstream-private-fixture' };
        const invocation = seed({ managedNativeCredentials: {
            role: 'nativeCredentialApply',
            bindings: new Map([['binding-a', {
                readRenderedHeaders: async () => ({ ok: true as const, headers }),
            }]]),
        } });
        const redacted: string[] = [];
        const service = createMachineProvisionersInvocationService({ seed: invocation,
            registerRawForRedaction(value) { redacted.push(value); } });
        expect(service).not.toBeNull();
        const input = { bindingKey: 'binding-a' };
        const result = await service!.materializeNativeCredentialHeaders(input);
        expect(result).toEqual({ ok: true, headers });
        expect(redacted).toContain(headers.authorization);
        await expect(service!.materializeNativeCredentialHeaders({ bindingKey: 'binding-b' }))
            .resolves.toEqual({ ok: false, code: 'native_credential_binding_unavailable' });
        // The JavaScript plugin-callable boundary must refuse malformed or
        // inherited selectors, not throw or widen the admitted request shape.
        const inherited = Object.create({ bindingKey: 'binding-a' });
        inherited.source = 'unadmitted-source';
        for (const malformed of [null, {}, { bindingKey: 'binding-a', source: 'unadmitted-source' }, inherited]) {
            await expect(Reflect.apply(service!.materializeNativeCredentialHeaders, service, [malformed]))
                .resolves.toEqual({ ok: false, code: 'native_credential_binding_unavailable' });
        }
        const serialized = JSON.stringify({ input,
            result: { kind: 'confirmed' }, history: [{ kind: 'confirmed' }],
            preset: { provisioner: 'acme.native/guest' }, metadata: {}, invocation, service });
        expect(serialized).not.toContain('upstream-private-fixture');
        expect(serialized).not.toContain('authorization');
        const ordinary = createMachineProvisionersInvocationService({ seed: seed({
            managedBootstrapCredential: { role: 'inspect', isCurrent: () => true,
                readBootstrapCredential: async () => new Uint8Array([1]) },
        }) });
        await expect(ordinary!.materializeNativeCredentialHeaders({ bindingKey: 'binding-a' }))
            .resolves.toEqual({ ok: false, code: 'native_credential_binding_unavailable' });
    });

    it('honors local cancellation during header acquisition without disclosing the material', async () => {
        const cancel = new AbortController();
        const redacted: string[] = [];
        const service = createMachineProvisionersInvocationService({ seed: seed({ signal: cancel.signal,
            managedNativeCredentials: { role: 'nativeCredentialApply',
                bindings: new Map([['binding-a', { readRenderedHeaders: async () => {
                    cancel.abort(); return { ok: true as const, headers: { authorization: 'Bearer cancelled-fixture' } };
                } }]]) },
        }), registerRawForRedaction(value) { redacted.push(value); } });
        await expect(service!.materializeNativeCredentialHeaders({ bindingKey: 'binding-a' }))
            .resolves.toEqual({ ok: false, code: 'native_credential_binding_unavailable' });
        expect(redacted).toEqual([]);
    });
});

describe('admitted native bootstrap key delivery', () => {
    it('refuses guest-host material when this invocation has only the retained bootstrap user credential', async () => {
        let bootstrapReads = 0;
        const lifetime = createPluginInvocationLifetime();
        const seed: PluginInvocationServicesSeed = { plugin: { id: 'acme.native', version: '0' },
            contribution: { id: 'bootstrap', qualifiedId: 'acme.native/bootstrap' }, occurrenceId: 'occurrence', correlationId: 'invocation',
            surface: 'plugin', signal: lifetime.signal, isOccurrenceCurrent: () => true, retainCleanup: lifetime.retainCleanup,
            managedBootstrapCredential: { role: 'bootstrap', isCurrent: () => true,
                readBootstrapCredential: async () => { bootstrapReads++; return new Uint8Array([1]); } } };
        const service = createMachineProvisionersInvocationService({ seed });
        expect(service).not.toBeNull();
        await expect(service!.materializeGuestHostCredential()).rejects.toMatchObject({ code: 'plugin_service_unavailable' });
        expect(bootstrapReads).toBe(0);
        await lifetime.complete();
    });

    it('zeros a guest-host lease acquired while local cancellation settles', async () => {
        const lifetime = createPluginInvocationLifetime();
        const material = new Uint8Array([7, 8, 9]);
        const redacted: string[] = [];
        const seed: PluginInvocationServicesSeed = { plugin: { id: 'acme.native', version: '0' },
            contribution: { id: 'acquire', qualifiedId: 'acme.native/acquire' }, occurrenceId: 'occurrence', correlationId: 'invocation',
            surface: 'plugin', signal: lifetime.signal, isOccurrenceCurrent: () => true, retainCleanup: lifetime.retainCleanup,
            managedBootstrapCredential: { role: 'acquire', isCurrent: () => true,
                readBootstrapCredential: async () => { throw new Error('Guest host must not read bootstrap user material'); },
                readGuestHostCredential: async () => { lifetime.settleContext(); return material; } } };
        const service = createMachineProvisionersInvocationService({ seed, registerRawForRedaction(value) { redacted.push(value); } });
        expect(service).not.toBeNull();
        await expect(service!.materializeGuestHostCredential()).rejects.toMatchObject({ code: 'plugin_service_unavailable' });
        expect(material).toEqual(new Uint8Array(3));
        expect(redacted).toEqual([]);
        await lifetime.complete();
    });

    it('finishes admitted credential acquisition from any provisioner role after occurrence retirement', async () => {
        let current = true;
        let admissions = 0;
        const material = new Uint8Array([4, 5, 6]);
        const seed: PluginInvocationServicesSeed = {
            plugin: { id: 'acme.native', version: '0' },
            contribution: { id: 'power', qualifiedId: 'acme.native/power' },
            occurrenceId: 'occurrence', correlationId: 'invocation', surface: 'plugin',
            signal: new AbortController().signal, isOccurrenceCurrent: () => current,
            retainCleanup() {},
            managedBootstrapCredential: { role: 'power', isCurrent: () => { admissions++; return current; },
                readBootstrapCredential: async () => { current = false; return material; } },
        };
        const service = createMachineProvisionersInvocationService({ seed });
        expect(service).not.toBeNull();
        const lease = await service!.materializeBootstrapCredential({ kind: 'bytes' });
        expect(lease).toMatchObject({ kind: 'bytes', bytes: new Uint8Array([4, 5, 6]) });
        expect(admissions).toBe(1);
        await expect(service!.materializeBootstrapCredential({ kind: 'bytes' }))
            .rejects.toMatchObject({ code: 'plugin_service_unavailable' });
        await lease.dispose();
        expect(material).toEqual(new Uint8Array(3));
    });

    it.each(['bytes', 'file'] as const)('admits each %s acquisition once, preserves disposal, and refuses a later withdrawn acquisition', async kind => {
        const root = await mkdtemp(join(tmpdir(), 'happier-key-admission-'));
        roots.push(root);
        let current = true;
        let admissions = 0;
        const material = new Uint8Array([1, 2, 3]);
        const cleanups: Readonly<{ dispose(): Promise<void> }>[] = [];
        const seed: PluginInvocationServicesSeed = { plugin: { id: 'acme.native', version: '0' },
            contribution: { id: 'inspect', qualifiedId: 'acme.native/inspect' }, occurrenceId: 'occurrence', correlationId: 'invocation',
            surface: 'plugin', signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            retainCleanup: cleanup => { cleanups.push(cleanup); },
            managedBootstrapCredential: { role: 'inspect', isCurrent: () => { admissions++; return current; },
                readBootstrapCredential: async () => { current = false; return material; } } };
        const service = createMachineProvisionersInvocationService({ seed,
            credentialFiles: createManagedServiceCredentialFileOwner({ rootDir: root }) })!;
        const lease = await service.materializeBootstrapCredential({ kind });
        expect(admissions).toBe(1);
        if (lease.kind === 'bytes') expect(lease.bytes).toEqual(new Uint8Array([1, 2, 3]));
        else expect(await readFile(lease.path)).toEqual(Buffer.from([1, 2, 3]));
        await lease.dispose();
        expect(material).toEqual(new Uint8Array(3));
        if (lease.kind === 'file') await expect(stat(lease.path)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(service.materializeBootstrapCredential({ kind })).rejects.toMatchObject({ code: 'plugin_service_unavailable' });
        expect(admissions).toBe(2);
        await Promise.all(cleanups.map(cleanup => cleanup.dispose()));
    });

    it('reopens retained material after queued lock admission so withdrawn credentials never reach another native reader', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-native-key-withdrawal-'));
        roots.push(root);
        const key = generateKeyPairSync('rsa', { modulusLength: 2048,
            privateKeyEncoding: { format: 'pem', type: 'pkcs1' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
        let available = true;
        const cleanups: Readonly<{ dispose(): Promise<void> }>[] = [];
        const seed: PluginInvocationServicesSeed = { plugin: { id: 'acme.native', version: '0' },
            contribution: { id: 'acquire', qualifiedId: 'acme.native/acquire' }, occurrenceId: 'occurrence', correlationId: 'invocation',
            surface: 'plugin', signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            retainCleanup: cleanup => { cleanups.push(cleanup); },
            managedBootstrapCredential: { role: 'acquire', isCurrent: () => true, readBootstrapCredential: async () => {
                if (!available) throw new ManagedMachineControllerError('credential_unavailable');
                return new TextEncoder().encode(key.privateKey);
            } } };
        const service = createMachineProvisionersInvocationService({ seed,
            credentialFiles: createManagedServiceCredentialFileOwner({ rootDir: root }) })!;
        const request = { relativePath: 'state/native-key' };
        let started!: () => void;
        const ready = new Promise<void>(resolve => { started = resolve; });
        let release!: () => void;
        const hold = new Promise<void>(resolve => { release = resolve; });
        const first = service.withBootstrapCredentialFile(request, async () => { started(); await hold; });
        await ready;
        let nativeEntered = false;
        const queued = service.withBootstrapCredentialFile(request, async () => { nativeEntered = true; });
        const rejected = expect(queued).rejects.toMatchObject({ code: 'credential_unavailable' });
        await new Promise(resolve => setTimeout(resolve, 50));
        available = false;
        release();
        await first;
        await rejected;
        expect(nativeEntered).toBe(false);
        await Promise.all(cleanups.map(cleanup => cleanup.dispose()));
    });
    it('joins an unawaited native reader through actual invocation completion before deleting its key', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-native-key-custody-'));
        roots.push(root);
        const key = generateKeyPairSync('rsa', { modulusLength: 2048,
            privateKeyEncoding: { format: 'pem', type: 'pkcs1' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
        const lifetime = createPluginInvocationLifetime();
        const seed: PluginInvocationServicesSeed = { plugin: { id: 'acme.native', version: '0' },
            contribution: { id: 'acquire', qualifiedId: 'acme.native/acquire' }, occurrenceId: 'occurrence', correlationId: 'invocation',
            surface: 'plugin', signal: lifetime.signal, isOccurrenceCurrent: () => true, retainCleanup: lifetime.retainCleanup,
            managedBootstrapCredential: { role: 'acquire', isCurrent: () => true,
                readBootstrapCredential: async () => new TextEncoder().encode(key.privateKey) } };
        const service = createMachineProvisionersInvocationService({ seed,
            credentialFiles: createManagedServiceCredentialFileOwner({ rootDir: root }) })!;
        let started!: () => void;
        const ready = new Promise<void>(resolve => { started = resolve; });
        let release!: () => void;
        const readDone = new Promise<void>(resolve => { release = resolve; });
        let keyPath = '';
        const unawaited = service.withBootstrapCredentialFile({ relativePath: 'native/key' }, async lease => {
            keyPath = lease.path;
            started();
            await readDone;
            await expect(readFile(keyPath, 'utf8')).resolves.toBe(key.privateKey);
        });
        await ready;
        let completed = false;
        const completion = lifetime.complete().then(() => { completed = true; });
        await Promise.resolve();
        expect(lifetime.signal.aborted).toBe(true);
        expect(completed).toBe(false);
        await expect(readFile(keyPath, 'utf8')).resolves.toBe(key.privateKey);
        release();
        await unawaited;
        await completion;
        expect(completed).toBe(true);
        await expect(stat(keyPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('derives the public sibling from the retained private key and cleans delivery after native failure without removing claims', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-native-key-delivery-'));
        roots.push(root);
        const key = generateKeyPairSync('rsa', { modulusLength: 2048,
            privateKeyEncoding: { format: 'pem', type: 'pkcs1' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
        const cleanups: Readonly<{ dispose(): Promise<void> }>[] = [];
        let admissions = 0;
        const seed: PluginInvocationServicesSeed = { plugin: { id: 'acme.native', version: '0' },
            contribution: { id: 'acquire', qualifiedId: 'acme.native/acquire' }, occurrenceId: 'occurrence', correlationId: 'invocation',
            surface: 'plugin', signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            retainCleanup: cleanup => { cleanups.push(cleanup); },
            managedBootstrapCredential: { role: 'acquire', isCurrent: () => { admissions++; return true; },
                readBootstrapCredential: async () => new TextEncoder().encode(key.privateKey) } };
        const service = createMachineProvisionersInvocationService({ seed,
            credentialFiles: createManagedServiceCredentialFileOwner({ rootDir: root }) })!;
        let keyPath = '';
        let claimPath = '';
        await expect(service.withBootstrapCredentialFile({ relativePath: 'state/crabbox/testboxes/cbx_abcdef123456/id_ed25519' }, async lease => {
            keyPath = lease.path;
            claimPath = join(dirname(keyPath), 'claim.json');
            await writeFile(claimPath, 'native-state');
            await expect(readFile(keyPath, 'utf8')).resolves.toBe(key.privateKey);
            await expect(readFile(keyPath + '.pub', 'utf8')).resolves.toMatch(/^ssh-rsa AAAA/);
            throw new Error('native operation outcome unknown');
        })).rejects.toThrow('native operation outcome unknown');
        expect(admissions).toBe(1);
        await expect(stat(keyPath)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(keyPath + '.pub')).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(claimPath, 'utf8')).resolves.toBe('native-state');
        await Promise.all(cleanups.map(cleanup => cleanup.dispose()));
        // The callback cannot select a different secret or obtain permanent
        // material; another invocation uses the same saved key and native root.
        await service.withBootstrapCredentialFile({ relativePath: 'state/crabbox/testboxes/cbx_abcdef123456/id_ed25519' }, async lease => {
            expect(lease.path).toBe(keyPath);
            await expect(readFile(lease.path, 'utf8')).resolves.toBe(key.privateKey);
        });
        expect(admissions).toBe(2);
        await expect(readFile(claimPath, 'utf8')).resolves.toBe('native-state');
    });
});
