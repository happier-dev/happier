import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMachineProvisionersInvocationService } from './machineProvisioners';
import { createManagedServiceCredentialFileOwner } from './managedServiceCredentialFileOwner';
import type { PluginInvocationServicesSeed } from './types';
import { createPluginInvocationLifetime } from '../lifetime';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginActionInvocation } from '@happier-dev/protocol/plugins/actions/invocation';
import { ManagedMachineControllerError } from '@happier-dev/cli-common/machines/managed';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

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

describe('admitted native bootstrap key delivery', () => {
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
        const seed: PluginInvocationServicesSeed = { plugin: { id: 'acme.native', version: '0' },
            contribution: { id: 'acquire', qualifiedId: 'acme.native/acquire' }, occurrenceId: 'occurrence', correlationId: 'invocation',
            surface: 'plugin', signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            retainCleanup: cleanup => { cleanups.push(cleanup); },
            managedBootstrapCredential: { role: 'acquire', isCurrent: () => true,
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
        await expect(readFile(claimPath, 'utf8')).resolves.toBe('native-state');
    });
});
