import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fastify from 'fastify';
import type { QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createPurposeTargetResolver } from '@/daemon/connectedServices/purposeBindings/resolveTarget';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAuthoredAccountActionRelease } from './accountPluginActions.testkit';
import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

const pluginId = 'acme.account-actions';
const service = { pluginId, localId: 'platform' };
const account = { service, accountId: 'recorded-linker' };
const origin = 'https://purpose-provider.example';
const sentinel = 'platform-http-private-sentinel';
const nativeFetch = globalThis.fetch;
const authentication = { defaultModeId: 'token', modes: [{ id: 'token', kind: 'manual' as const,
    outcomeReconciliation: 'none' as const, fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }] }] };

afterEach(() => vi.unstubAllGlobals());

async function fixture(options: Readonly<{ stream?: 'chunks' | 'held'; chunks?: number }> = {}) {
    let available = true;
    let displayName = 'Recorded linker';
    let revision = 'csr_abcdefghijklmnopqrstuv';
    let materializations = 0;
    let profileReads = 0;
    let readsAtSend = 0;
    let onMaterialize: (() => void) | undefined;
    let onFetch: (() => void) | undefined;
    const requests: { url: string; authorization: string | null }[] = [];
    const invalidations = new Set<() => void>();
    const opened = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const profile = (): QualifiedConnectedAccountProfileV4 => ({ ref: account, status: 'connected',
        authenticationModeId: 'token', revisionSemantics: 'revisioned', credentialRevision: revision,
        configurationReady: true, configurationRevision: null, kind: 'token', expiresAt: null,
        providerIdentity: null, displayName, scopes: [] });
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected selection or inventory effect'); };
    const owner = createConnectedAccountPurposeBindingOwner({
        store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
        selectTarget: unexpected,
        resolveTarget: createPurposeTargetResolver({ available: true,
            resolveService: async ref => ref.pluginId === service.pluginId && ref.localId === service.localId
                ? { service, authentication } : null,
            listAccounts: async () => { profileReads += 1; return available ? [profile()] : []; },
        }),
        resolveCredentialRevision: async () => available ? revision : null,
        materializeAccount: async ({ request, credentialRevisionBasis }) => {
            materializations += 1;
            expect(request).toEqual({ kind: 'httpHeaders', origin, headerNames: ['authorization'] });
            credentialRevisionBasis?.captureCredentialRevision(revision);
            onMaterialize?.();
            return { kind: 'httpHeaders', headers: { authorization: `Bearer ${sentinel}` } };
        },
        projectTargetAccounts: unexpected, assertTargetAccountMaterializable: unexpected,
        subscribeInvalidations(listener) { invalidations.add(listener); return { dispose() { invalidations.delete(listener); } }; },
    });
    const provider = createServer((request, response) => {
        requests.push({ url: `${origin}${request.url}`, authorization: typeof request.headers.authorization === 'string' ? request.headers.authorization : null });
        readsAtSend = profileReads;
        response.setHeader('x-echo', sentinel);
        response.once('close', () => closed.resolve());
        onFetch?.();
        if (options.stream === 'held') {
            response.flushHeaders();
            response.write('provider is waiting');
            opened.resolve();
            return;
        }
        response.end(Array.from({ length: options.stream ? options.chunks ?? 1 : 1 }, () => `π provider echoed ${sentinel}\n`).join(''));
        opened.resolve();
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback provider address');
    const closeProvider = async () => { provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve())); };
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (!String(url).startsWith(origin)) return Response.json({ features: {}, capabilities: {} });
        // The only substituted boundary is vendor location. Real native HTTP,
        // headers, body cancellation and deliberately split UTF-8 stay live.
        const response = await nativeFetch(`http://127.0.0.1:${address.port}${new URL(String(url)).pathname}`, init);
        const body = options.stream === 'chunks' && response.body ? response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) { for (const byte of chunk) controller.enqueue(new Uint8Array([byte])); },
        })) : response.body;
        return new Response(body, { status: response.status, headers: response.headers });
    }));
    const home = await mkdtemp(join(tmpdir(), 'account-purpose-http-'));
    const app = fastify();
    const homeOrigin = 'http://account-purpose-home.test';
    const accountId = 'platform-invoking-account';
    await registerAuthoredAccountActionRelease(app, accountId);
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
        settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: homeOrigin });
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
    const registry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: home,
        accountExecution: { credentials, serverUrl: homeOrigin, isCurrent: () => true },
        connectedAccounts: owner, actionFormConnectedAccounts: owner,
    }).catch(async error => { restore(); await app.close(); await closeProvider(); await rm(home, { recursive: true, force: true }); throw error; });
    try {
        await registry.activateContributionsOnDemand([{ pluginId, family: 'actions', localId: 'purpose-request' }]);
    } catch (error) {
        await registry.dispose(); restore(); await app.close(); await closeProvider(); await rm(home, { recursive: true, force: true }); throw error;
    }
    return { requests, get materializations() { return materializations; },
        get profileReads() { return profileReads; }, get readsAtSend() { return readsAtSend; },
        get subscriptions() { return invalidations.size; }, opened: opened.promise, closed: closed.promise,
        withdraw() { available = false; for (const listener of invalidations) listener(); },
        rename() { displayName = 'New display name'; for (const listener of invalidations) listener(); },
        rotate() { revision = 'csr_bcdefghijklmnopqrstuvw'; for (const listener of invalidations) listener(); },
        afterMaterialize(callback: () => void) { onMaterialize = callback; }, afterFetch(callback: () => void) { onFetch = callback; },
        invoke(input: Readonly<Record<string, unknown>> = {}) { return registry.targetActionInvocations!.invoke({ pluginId,
            localId: 'purpose-request', surface: 'cli', input: { link: { credentialRef: account }, key: 'inspect', ...input } }); },
        async dispose() { try { await closeProvider(); await registry.dispose(); } finally { restore(); await app.close(); await rm(home, { recursive: true, force: true }); } },
    };
}

describe('V2 invocation purpose through registry HTTP custody', () => {
    it('injects only the recorded dot-path credential and filters provider echoes', async () => {
        const f = await fixture();
        try {
            expect(f.requests).toEqual([]);
            expect(f.materializations).toBe(0);
            const result = await f.invoke();
            expect(result).toMatchObject({ status: 'executed', value: { status: 200 } });
            expect(f.requests).toEqual([{ url: `${origin}/projects`, authorization: `Bearer ${sentinel}` }]);
            expect(f.materializations).toBe(1);
            expect(JSON.stringify(result)).not.toContain(sentinel);
        } finally { await f.dispose(); }
    });

    it.each(['missing', 'foreign', 'origin', 'method', 'header', 'withdrawn'] as const)('denies %s with zero sends', async scenario => {
        const f = await fixture();
        try {
            if (scenario === 'withdrawn') f.withdraw();
            const result = await f.invoke(scenario === 'missing' ? { link: {} }
                : scenario === 'foreign' ? { link: { credentialRef: { ...account, accountId: 'invoker-personal' } } }
                    : scenario === 'origin' ? { key: 'wrong-origin' }
                        : scenario === 'method' ? { key: 'wrong-method' }
                            : scenario === 'header' ? { key: 'caller-auth' } : {});
            expect(result.status).not.toBe('executed');
            expect(f.requests).toEqual([]);
        } finally { await f.dispose(); }
    });

    it('retains credential redaction across streamed bytes without reading authority for every chunk', async () => {
        const reads: number[] = [];
        for (const chunks of [1, 100]) {
            const f = await fixture({ stream: 'chunks', chunks });
            try {
                const result = await f.invoke({ key: 'stream' });
                expect(result).toMatchObject({ status: 'executed', value: { status: 200 } });
                expect(JSON.stringify(result)).not.toContain(sentinel);
                expect(JSON.stringify(result)).toContain('REDACTED');
                expect(f.materializations).toBe(1);
                expect(f.requests).toHaveLength(1);
                expect(f.subscriptions).toBe(0);
                reads.push(f.profileReads - f.readsAtSend);
            } finally { await f.dispose(); }
        }
        expect(reads[1]).toBe(reads[0]);
    });

    it('keeps a presentation update live and aborts a held native body on credential withdrawal', async () => {
        const f = await fixture({ stream: 'held' });
        try {
            const result = f.invoke({ key: 'stream' });
            await f.opened;
            expect(f.subscriptions).toBe(1);
            const before = f.profileReads;
            f.rename();
            await vi.waitFor(() => expect(f.profileReads).toBeGreaterThan(before));
            expect(f.subscriptions).toBe(1);
            f.withdraw();
            expect((await result).status).not.toBe('executed');
            await f.closed;
            expect(f.subscriptions).toBe(0);
            expect(f.requests).toHaveLength(1);
        } finally { await f.dispose(); }
    });

    it('refuses withdrawal before send and checks again at the next finite admission', async () => {
        const f = await fixture();
        try {
            f.afterMaterialize(() => f.withdraw());
            expect((await f.invoke()).status).not.toBe('executed');
            expect(f.requests).toEqual([]);
        } finally { await f.dispose(); }
        const second = await fixture();
        try {
            second.afterFetch(() => second.withdraw());
            expect((await second.invoke()).status).toBe('executed');
            expect((await second.invoke()).status).not.toBe('executed');
            expect(second.requests).toHaveLength(1);
        } finally { await second.dispose(); }
    });
});
