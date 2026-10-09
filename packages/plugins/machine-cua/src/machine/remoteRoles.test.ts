import { describe, expect, it } from 'vitest';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type { PluginExecSpawnRequest, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { CUA_PLUGIN } from '../manifest.js';
import type { ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { connectedAccountRuntime } from './remoteConnection.js';

const managedId = 'ac2c7f10-2a41-4af1-88ac-d64eeb18bdc7';
const name = `happier-${managedId}`;
const byocLaunch = { cloud: 'aws', region: 'us-west-2', nativeImageId: 'linux', nativeSizeId: 't3.medium', nativeLifetime: { kind: 'no-native-ttl' } };
const fleetLaunch = { namespace: 'pool', runtimeId: 'gvisor', imageId: 'image', sizeId: 'pool', nativeLease: { durationSeconds: 7200 } };
const nativeProvider = { name: 'aws', connected: true, region: 'us-west-2', ttl_hours: 0,
    kinds: [{ image: 'linux', supported: true, machine_type: 't3.medium', usd_per_hour: 0.04 }] };
function processResult(value: unknown): PluginProcessResult {
    return { termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } }, stdout: new TextEncoder().encode(JSON.stringify(value)),
        stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
}
// Pinned cua.env.v1 StartProcess boundary vector: started, binary stdout,
// successful exit and gRPC-Web trailers. Internal codecs are not substituted.
function fleetProcessResponse() {
    const frame = (payload: Uint8Array, trailer = false) => {
        const header = Buffer.alloc(5); header[0] = trailer ? 128 : 0; header.writeUInt32BE(payload.length, 1);
        return Buffer.concat([header, payload]);
    };
    return Buffer.concat([frame(Buffer.from('0a040a02082a', 'hex')), frame(Buffer.from('0a07120512030080ff', 'hex')),
        frame(Buffer.from('0a041a020800', 'hex')), frame(Buffer.from('grpc-status: 0\r\n'), true)]);
}
async function harness(options: { lostCreateReply?: boolean; cleanupFailure?: 'registry' | 'delete-reply' } = {}) {
    const actions = new Map<string, ActionHandler>();
    const processRequests: PluginExecSpawnRequest[] = [];
    const httpRequests: Parameters<HttpService['request']>[0][] = [];
    const purposes: string[] = [];
    let created = false, bound = false, released = false, secret = false, suspended = false;
    let hideCreatedOnce = false;
    const row = { provider: 'aws', id: 'i-owned', type: 'instance', sandbox: `aws:${name}`,
        machine: options.cleanupFailure ? 'relay-owned' : '', region: 'us-west-2', state: 'running', expires: '', expired: false };
    const claim = () => ({ metadata: { name, namespace: 'pool', creationTimestamp: '2026-10-09T00:00:00Z' },
        spec: { sandboxTemplateRef: { name: 'template' }, ttlSecondsAfterCreated: 7200, secretRef: { name: `cua-claim-${name}` } },
        status: { phase: bound ? 'Bound' : 'Pending', ...(bound ? { sandbox: { name: 'guest' } } : {}) } });
    // Registration, captured accounts, native processes, HTTP and retained token
    // custody are external host boundaries. Author schemas and leaf logic stay real.
    await CUA_PLUGIN.activate({ actions: { register(id: string, handler: ActionHandler) { actions.set(id, handler); return { dispose() {} }; } },
        connectedAccounts: { register() { return { dispose() {} }; } } } as unknown as PluginApi);
    const context = { invokedAtMs: Date.parse('2026-10-09T00:30:00Z'), signal: new AbortController().signal, services: {
        managedServices: { dependencies: { status: async () => ({ state: 'ready', executable: { kind: 'managedDependency', id: { pluginId: CUA_PLUGIN.manifest.id, localId: 'cua-cli' } } }) } },
        connectedAccounts: {
            async materialize(purpose: string, request: { kind: string; keys?: readonly string[] }) {
                purposes.push(purpose);
                return request.kind === 'httpHeaders' ? { kind: 'httpHeaders', headers: { authorization: 'Bearer captured-cua' } }
                    : { kind: 'environment', env: request.keys?.includes('CUA_FLEET_BASE_URL') ? { CUA_FLEET_BASE_URL: 'https://fleet.example', FLEETS_TOKEN: 'captured-cua',
                        CUA_HOME: '/native/selected', CUA_CREDENTIAL_STORE: 'file' } : { CUA_HOME: '/native/selected' } };
            },
        },
        machineProvisioners: { async materializeBootstrapCredential() { return { kind: 'bytes', bytes: new TextEncoder().encode('retained-guest-token'), async dispose() {} }; } },
        exec: { async run(request: PluginExecSpawnRequest) {
            processRequests.push(request);
            const args = request.args ?? [];
            if (args.includes('status')) {
                const resources = created && !hideCreatedOnce ? [row] : [];
                hideCreatedOnce = false;
                return processResult({ providers: [nativeProvider], resources });
            }
            if (args.includes('create')) {
                created = true;
                if (options.lostCreateReply) { hideCreatedOnce = true; throw new Error('Create response lost'); }
                return processResult({});
            }
            if (args.includes('images')) return processResult({ ref: 'ghcr.io/trycua/linux:24.04', published: true });
            if (args.includes('suspend')) { suspended = true; return processResult('Suspending'); }
            if (args.includes('info')) {
                if (!created) throw new Error('Native sandbox record not found');
                return processResult({ id: `aws:${name}`, name, location: 'aws', state: suspended ? 'suspended' : 'running',
                    status: suspended ? 'stopped' : 'ready', image: 'ghcr.io/trycua/linux:24.04',
                    ephemeral: false, expires_at: null, provider_details: { provider: 'aws', id: 'i-owned' } });
            }
            if (args.includes('ls') && args.includes('spaces')) throw new Error('Native registry read unavailable');
            if (args.includes('rm') && args.includes('sandbox')) {
                created = false;
                if (options.cleanupFailure === 'delete-reply') throw new Error('Delete response lost');
                return processResult({ deleted: `aws:${name}`, missing: false });
            }
            if (args.includes('shell')) return { ...processResult(null), stdout: new Uint8Array([0, 128, 255]) };
            throw new Error('Unexpected native IO');
        } },
        http: { async request(request: Parameters<HttpService['request']>[0]) {
            httpRequests.push(request);
            const reply = (status: number, value?: unknown) => ({ status, finalUrl: request.url, headers: {},
                body: value === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(value)) });
            if (request.url.includes('/cua.env.v1.ProcessService/StartProcess')) return { ...reply(200), body: fleetProcessResponse() };
            if (request.url.includes('warmpools')) return reply(200, { metadata: { name: 'pool', namespace: 'pool' }, spec: { sandboxTemplateRef: { name: 'template' } } });
            if (request.url.includes('templates')) return reply(200, { metadata: { name: 'template', namespace: 'pool' }, spec: { vmTemplate: {
                containerDiskImage: 'image', runtime: 'gvisor', cpuCores: 4, memory: '8Gi', services: [{ name: 'env', targetPort: 3211 }] } } });
            if (request.url.includes('/secrets')) {
                if (request.method === 'POST') { secret = true; return reply(201); }
                if (request.method === 'DELETE') { secret = false; return reply(204); }
                return reply(secret ? 200 : 404, secret ? { metadata: { name: `cua-claim-${name}`, namespace: 'pool', labels: { 'osgym.cua.ai/claim': name } },
                    data: { 'env-token': Buffer.from('retained-guest-token').toString('base64') } } : undefined);
            }
            if (request.method === 'POST') return reply(201, claim());
            if (request.method === 'DELETE') { released = true; return reply(204); }
            return reply(released || !secret ? 404 : 200, released || !secret ? undefined : claim());
        } },
    } } as unknown as PluginInvocationContext;
    async function invoke(id: string, input: unknown) {
        const action = actions.get(id);
        if (!action) throw new Error(`Missing activated role ${id}`);
        return action(input, context);
    }
    return { invoke, context, processRequests, httpRequests, purposes, bind() { bound = true; } };
}

describe('activated Cua remote contributions', () => {
    it('selects native setup from revision-tracked configuration, never a rotating credential field', async () => {
        const context = { configuration: { values: { nativeHome: '/native/selected' } },
            credentials: { async get(key: string) { return key === 'native-home' ? '/native/different' : null; } } } as unknown as ConnectedAccountReadContext;
        for (const kind of ['cloud', 'cua'] as const) {
            expect(await connectedAccountRuntime(kind).materialize({ kind: 'environment', keys: ['CUA_HOME'] }, context))
                .toEqual({ kind: 'environment', env: { CUA_HOME: '/native/selected' } });
        }
    });
    it('acquires and privately bootstraps exact BYOC compute with both captured purposes and deletes only that created identity', async () => {
        const h = await harness();
        const options = await h.invoke('byoc-options', { cloud: 'aws' });
        expect(options).toMatchObject({ choices: [{ launch: byocLaunch, nativeFacts: {
            size: { id: 't3.medium' }, image: { id: 'linux' }, location: { id: 'us-west-2' },
        } }] });
        const acquired = await h.invoke('byoc-acquire', { launch: byocLaunch, managedId });
        const resource = { cloud: 'aws', nativeResourceId: 'i-owned', sandboxId: `aws:${name}`, ownedAttachmentIds: [] };
        expect(acquired).toMatchObject({ kind: 'bound', resource: { value: resource } });
        expect(await h.invoke('byoc-bootstrap', { resource })).toMatchObject({ kind: 'native', transport: { contributionRef: { localId: 'byoc' } } });
        expect(await h.invoke('byoc-reconcile', { correlation: { managedId, requestId: 'submitted', launch: byocLaunch } }))
            .toMatchObject({ kind: 'bound', resource: { value: resource } });
        expect(await h.invoke('byoc-exec', { resource, argv: ['printf', 'native'], timeoutMs: 987654 })).toMatchObject({ stdoutBase64: 'AID/' });
        expect(h.processRequests.find(request => request.args?.includes('shell'))).toMatchObject({ timeoutMs: 987654 });
        expect(new Set(h.purposes)).toEqual(new Set(['cloud-account', 'cua-account']));
        expect(h.processRequests.every(request => request.env?.CUA_HOME === '/native/selected')).toBe(true);
        expect(await h.invoke('byoc-destroy', { resource })).toEqual({ kind: 'confirmed' });
        expect(h.processRequests.filter(request => request.args?.includes('rm')).map(request => request.args)).toEqual([
            ['--json', '--embedded', 'sandbox', 'rm', `aws:${name}`, '--force'],
        ]);
    });
    it('keeps a pending Fleet claim, binds by reads without renewal, and releases the claim and its private Secret while retaining the pool', async () => {
        const h = await harness();
        expect(await h.invoke('fleet-options', { namespace: 'pool', nativeLease: fleetLaunch.nativeLease })).toMatchObject({ choices: [{ nativeFacts: {
            size: { cpuCores: 4 }, image: { id: 'image' }, location: { id: 'pool' },
        } }] });
        const resource = { namespace: 'pool', claimId: name };
        expect(await h.invoke('fleet-acquire', { launch: fleetLaunch, managedId })).toMatchObject({ kind: 'pending', nativeOperationRef: { value: resource } });
        const secret = h.httpRequests.find(request => request.method === 'POST' && request.url.endsWith('/secrets'));
        expect(secret && JSON.parse(new TextDecoder().decode(secret.body))).toMatchObject({ stringData: { 'env-token': 'retained-guest-token' } });
        h.bind();
        const before = h.httpRequests.length;
        expect(await h.invoke('fleet-reconcile', { nativeOperation: resource })).toMatchObject({ kind: 'bound', resource: { value: { ...resource, sandboxId: 'guest' } } });
        expect(await h.invoke('fleet-reconcile', { correlation: { managedId, requestId: 'submitted', launch: fleetLaunch } }))
            .toMatchObject({ kind: 'bound', resource: { value: { ...resource, sandboxId: 'guest' } } });
        expect(await h.invoke('fleet-inspect', { resource })).toMatchObject({ availability: 'present', nativeExpiry: Date.parse('2026-10-09T02:00:00Z') });
        expect(h.httpRequests.slice(before).every(request => request.method === 'GET')).toBe(true);
        expect(await h.invoke('fleet-bootstrap', { resource: { ...resource, sandboxId: 'guest' } })).toMatchObject({ kind: 'native' });
        expect(await h.invoke('fleet-exec', { resource: { ...resource, sandboxId: 'guest' }, argv: ['printf', 'native'], timeoutMs: 987654 }))
            .toMatchObject({ stdoutBase64: 'AID/', stderrBase64: '', termination: { observed: { kind: 'exit', exitCode: 0 } } });
        expect(h.httpRequests.find(request => request.url.includes('/StartProcess'))).toMatchObject({ timeoutMs: 987654,
            headers: { authorization: 'Bearer captured-cua', 'x-cua-env-authorization': 'Bearer retained-guest-token' } });
        expect(await h.invoke('fleet-destroy', { nativeOperation: resource })).toEqual({ kind: 'confirmed' });
        expect(h.httpRequests.filter(request => request.method === 'DELETE').every(request => /\/(osgymsandboxclaims|secrets)\//.test(request.url))).toBe(true);
        expect(h.processRequests).toEqual([]);
    });
    it('cancels the exact pending BYOC allocation after alias resolution and a lost create reply', async () => {
        const h = await harness({ lostCreateReply: true });
        const acquired = await h.invoke('byoc-acquire', { launch: byocLaunch, managedId });
        expect(acquired).toMatchObject({ kind: 'pending' });
        if (acquired.kind !== 'pending') throw new Error('Expected retained operation');
        expect(await h.invoke('byoc-destroy', { nativeOperation: acquired.nativeOperationRef.value })).toEqual({ kind: 'confirmed' });
        expect(h.processRequests.filter(request => request.args?.includes('create'))).toHaveLength(1);
        expect(h.processRequests.filter(request => request.args?.includes('rm')).map(request => request.args))
            .toEqual([['--json', '--embedded', 'sandbox', 'rm', `aws:${name}`, '--force']]);
    });
    it('confirms retained Stop from the native suspended observation', async () => {
        const h = await harness();
        await h.invoke('byoc-acquire', { launch: byocLaunch, managedId });
        const resource = { cloud: 'aws', nativeResourceId: 'i-owned', sandboxId: `aws:${name}`, ownedAttachmentIds: [] };
        expect(await h.invoke('byoc-power', { resource, intent: 'stop' })).toEqual({ kind: 'confirmed' });
        expect(await h.invoke('byoc-inspect', { resource })).toMatchObject({ availability: 'present', power: 'stopped' });
    });
    it.each(['registry', 'delete-reply'] as const)('keeps cleanup unconfirmed after %s failure consumes native qualification records (CD9)', async cleanupFailure => {
        const h = await harness({ cleanupFailure });
        const acquired = await h.invoke('byoc-acquire', { launch: byocLaunch, managedId });
        expect(acquired).toMatchObject({ kind: 'bound' });
        if (acquired.kind !== 'bound') throw new Error('Expected exact retained resource');
        const resource = acquired.resource.value;
        expect(await h.invoke('byoc-destroy', { resource })).toEqual({ kind: 'unknown', code: 'cua_cleanup_incomplete' });
        const retryStart = h.processRequests.length;
        expect(await h.invoke('byoc-destroy', { resource })).toEqual({ kind: 'unknown', code: 'cua_cleanup_incomplete' });
        expect(await h.invoke('byoc-inspect', { resource })).toMatchObject({ availability: 'unavailable' });
        // The caller retains vendor ID/cloud and reviewed region for the existing
        // recovery detail/manual-responsibility path; absence is never inferred.
        expect(resource).toMatchObject({ cloud: 'aws', nativeResourceId: 'i-owned',
            sandboxId: `aws:${name}`, spaceId: 'relay:relay-owned' });
        expect(h.processRequests.slice(retryStart).every(request => request.args?.includes('status'))).toBe(true);
        expect(h.processRequests.filter(request => request.args?.includes('rm')).map(request => request.args))
            .toEqual([['--json', '--embedded', 'sandbox', 'rm', `aws:${name}`, '--force']]);
        expect(h.processRequests.some(request => request.args?.includes('sweep'))).toBe(false);
    });
});
