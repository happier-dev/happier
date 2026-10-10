import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot, setActiveServer } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { captureActionAccountContext, captureLazyActionAccountContext } from './actionAccountContext';
import { Encryption } from '@/sync/encryption/encryption';

let homes: Awaited<ReturnType<typeof serveAccountHomes>>;
let accountMode: 'plain' | 'e2ee';
const network = vi.fn<(url: URL, init?: RequestInit) => Promise<Response>>();
beforeEach(async () => {
    retireActiveServerAccountScopeLifetime();
    accountMode = 'plain';
    homes = await serveAccountHomes({ homes: [
        { key: 'e', serverUrl: 'https://home-e.example.test', accountId: 'account-a', accountMode: 'e2ee',
            credentials: { token: 'fixture', secret: Buffer.alloc(32, 7).toString('base64url') } },
        { key: 'c', serverUrl: 'https://home-c.example.test', accountId: 'account-a' },
        { key: 'b', serverUrl: 'https://home-b.example.test', accountId: 'account-a' },
        { key: 'a', serverUrl: 'https://home-a.example.test', accountId: 'account-a' },
    ], route: () => undefined });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    network.mockReset();
    network.mockImplementation(async url => url.pathname === '/v1/account/encryption'
        ? Response.json({ mode: url.origin === 'https://home-e.example.test' ? 'e2ee' : accountMode, updatedAt: 1 }) : new Response(null, { status: 204 }));
    setRuntimeFetch(async (input, init) => network(new URL(String(input)), init));
});
afterEach(() => {
    retireActiveServerAccountScopeLifetime();
    publishAppliedActiveServerRuntimeAvailability(false);
    homes?.dispose();
});

it('retains original Account-only cleanup custody after user cancellation, but not Account retirement', async () => {
    const cancellation = new AbortController();
    const account = await captureLazyActionAccountContext(homes.homes.a!.id, cancellation.signal);
    try {
        cancellation.abort();
        expect(account.accountLifetime.isCurrent()).toBe(false);
        expect(account.accountOnlyLifetime.isCurrent()).toBe(true);
        expect(() => account.assertAccountCurrent()).not.toThrow();
        retireActiveServerAccountScopeLifetime();
        expect(account.accountOnlyLifetime.isCurrent()).toBe(false);
        expect(() => account.assertAccountCurrent()).toThrow('action_account_scope_changed');
    } finally { account.dispose(); }
});

describe('captureActionAccountContext encryption authority', () => {
    it('exposes no fabricated encryption material for a Plain Account', async () => {
        const context = await captureActionAccountContext(homes.homes.a!.id);
        try {
            expect(context.encryption).toBeNull();
            expect('secret' in context.credentials || 'encryption' in context.credentials).toBe(false);
        } finally { context.dispose(); }
    });
    it('exposes the exact encryption instance resolved for the captured E2EE Home', async () => {
        const context = await captureActionAccountContext(homes.homes.e!.id);
        try {
            expect(context.encryption).toBeInstanceOf(Encryption);
            if (!context.encryption) throw new Error('Missing Account encryption');
            const value = { literal: 'original Home', binary: [0, 255, 128] };
            expect(await context.encryption.decryptRaw(await context.encryption.encryptRaw(value))).toEqual(value);
        } finally { context.dispose(); }
    });
    it('fails an E2EE Account closed when its actual credential has no encryption material', async () => {
        accountMode = 'e2ee';
        await expect(captureActionAccountContext(homes.homes.a!.id)).rejects.toThrow('Account encryption material is unavailable');
    });
});

describe('captureLazyActionAccountContext encryption on demand', () => {
    it('returns committed self-revocation without opening the now-inaccessible Artifact', async () => {
        const revoked = { artifactId: 'artifact', ownerAccountId: 'owner', access: null, grants: [], changed: true };
        network.mockImplementation(async (_url, init) => init?.method === 'DELETE'
            ? Response.json(revoked) : Response.json({ error: 'Artifact not found' }, { status: 404 }));
        const context = await captureLazyActionAccountContext(homes.homes.a!.id);
        try {
            await expect(context.artifactAccessGrants.remove({ artifactId: 'artifact', principal: { kind: 'account', accountId: 'account-a' } })).resolves.toEqual(revoked);
            expect(network.mock.calls).toHaveLength(1);
            expect(network.mock.calls[0]?.[1]?.method).toBe('DELETE');
            expect(storage.getState().artifacts.artifact).toBeUndefined();
        } finally { context.dispose(); }
    });
    it('binds the Home and Account without reading the encryption mode or deriving keys', async () => {
        const context = await captureLazyActionAccountContext(homes.homes.e!.id);
        try {
            expect(context.accountId).toBe('account-a');
            expect(network).not.toHaveBeenCalled();
            const first = await context.resolveAccountEncryption();
            expect(await context.resolveAccountEncryption()).toBe(first);
            expect(first.accountMode).toBe('e2ee');
            expect(first.encryption).toBeInstanceOf(Encryption);
            expect(network.mock.calls.filter(([url]) => url.pathname === '/v1/account/encryption')).toHaveLength(1);
        } finally { context.dispose(); }
    });
    it('fails a mode-dependent operation closed when the Account encryption mode cannot be read', async () => {
        network.mockRejectedValue(new Error('encryption_mode_unavailable'));
        const context = await captureLazyActionAccountContext(homes.homes.a!.id);
        try {
            await expect(context.resolveAccountEncryption()).rejects.toThrow('encryption_mode_unavailable');
            await expect(context.fetchArtifact('artifact-a')).rejects.toThrow('encryption_mode_unavailable');
            expect(network.mock.calls.every(([url]) => url.pathname === '/v1/account/encryption')).toBe(true);
        } finally { context.dispose(); }
    });
});

describe('captureActionAccountContext transport authority', () => {
    it('preserves a mutation acknowledgement when retirement arrives during the response', async () => {
        const response = Response.json({ committed: true });
        network.mockImplementation(async () => { retireActiveServerAccountScopeLifetime(); return response; });
        const context = await captureLazyActionAccountContext(homes.homes.a!.id);
        try {
            await expect(context.request('/v1/artifacts', { method: 'POST', body: '{}' })).resolves.toBe(response);
            expect(context.accountLifetime.isCurrent()).toBe(false);
            await expect(context.request('/v1/artifacts', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'action_account_scope_changed' });
        } finally { context.dispose(); }
    });
    it('does not return read content when its Account retires while awaiting the response', async () => {
        network.mockImplementation(async () => { retireActiveServerAccountScopeLifetime(); return Response.json({ private: true }); });
        const context = await captureLazyActionAccountContext(homes.homes.a!.id);
        try { await expect(context.request('/v1/artifacts')).rejects.toMatchObject({ code: 'action_account_scope_changed' }); }
        finally { context.dispose(); }
    });
    it('does not retire the mounted Home lifetime while the next Home is only staged', async () => {
        const mountedA = captureActiveServerAccountScopeLifetime();
        expect(mountedA?.isCurrent()).toBe(true);
        await setActiveServer({ serverId: homes.homes.b!.id });
        const stagedB = await captureLazyActionAccountContext(homes.homes.b!.id);
        const appliedA = await captureLazyActionAccountContext(homes.homes.a!.id);
        try {
            expect(captureActiveServerAccountScopeLifetime()).toBe(mountedA);
            expect(() => appliedA.assertCurrent()).not.toThrow();
            storage.setState({ profileScope: { serverId: homes.homes.b!.id, accountId: 'account-a' } });
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            const establishedB = await captureLazyActionAccountContext(homes.homes.b!.id);
            try {
                await setActiveServer({ serverId: homes.homes.a!.id });
                expect(() => establishedB.assertCurrent()).not.toThrow();
                publishAppliedActiveServerRuntimeAvailability(false);
                expect(() => establishedB.assertCurrent()).toThrow('action_account_scope_changed');
            } finally { establishedB.dispose(); }
        } finally { stagedB.dispose(); appliedA.dispose(); }
    });
    it('keeps applied, staged, and background Homes on their scoped target transport during a focus switch', async () => {
        await setActiveServer({ serverId: homes.homes.b!.id });
        const contexts = await Promise.all(['a', 'b', 'c'].map(key => captureLazyActionAccountContext(homes.homes[key]!.id)));
        try {
            await Promise.all(contexts.map((context, i) => context.request('/action-' + i)));
            expect(network.mock.calls.filter(([url]) => url.pathname.startsWith('/action-')).map(([url]) => url.origin).sort())
                .toEqual(['https://home-a.example.test', 'https://home-b.example.test', 'https://home-c.example.test']);
            expect(network.mock.calls.filter(([url]) => url.pathname.startsWith('/action-')).every(([, init]) => new Headers(init?.headers).get('Authorization')?.startsWith('Bearer '))).toBe(true);
        } finally { contexts.forEach(context => context.dispose()); }
    });
});
