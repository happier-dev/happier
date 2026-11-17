import { createServer, type RequestListener, type ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import type { SelectedPetPackageSource } from '@/components/pets/source/resolveSelectedPetPackage';
import { usePetSpritesheetSourceResult } from './usePetSpritesheetSource';

const credentials = vi.hoisted(() => ({ token: '' }));
// Secure credential persistence is the only substituted boundary; HTTP/admission stay real.
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({ importOriginal, tokenStorage: {
        getCredentials: async () => ({ token: credentials.token }),
        getCredentialsForServerUrl: async () => ({ token: credentials.token }),
    } });
});

afterEach(standardCleanup);

it('shares account atlas loads by digest and credentials, ignores equal source objects, and does no disabled work', async () => {
    const assets: Array<{ response: ServerResponse; authorization: string | undefined }> = [];
    const handleRequest: RequestListener = (request, response) => {
        if (request.url === '/v1/account/encryption/currentness') {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify(createPlainAccountEncryptionCurrentnessFixture()));
        } else if (request.url === '/v1/account/encryption') {
            response.setHeader('content-type', 'application/json');
            response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
        } else if (request.url === '/v1/account/pets/pet-shared/spritesheet') {
            assets.push({ response, authorization: request.headers.authorization });
        } else {
            response.setHeader('content-type', 'application/json');
            response.end('{}');
        }
    };
    const http = createServer(handleRequest);
    const otherHome = createServer(handleRequest);
    const token = (accountId: string) => `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const source = (digest = 'sha256:first'): SelectedPetPackageSource => ({
        kind: 'accountPet', accountPetId: 'pet-shared', sourceKey: 'pet-shared', digest, spriteVersionNumber: 2,
    });
    const finish = (index: number, value: number) => {
        assets[index]!.response.setHeader('content-type', 'image/webp');
        assets[index]!.response.end(Buffer.from([value]));
    };
    try {
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        await new Promise<void>(resolve => otherHome.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('Missing pet atlas Home address');
        credentials.token = token('pet-atlas-owner');
        await upsertAndActivateServer({ serverUrl: `http://127.0.0.1:${address.port}`, name: 'Pet atlas sharing' });
        const first = await renderHook(usePetSpritesheetSourceResult, { initialProps: source() });
        await vi.waitFor(() => expect(assets).toHaveLength(1));
        expect(first.getCurrent().spriteVersionNumber).toBe(1); // The delivered loading fallback is a v1 built-in.
        const second = await renderHook(usePetSpritesheetSourceResult, { initialProps: source() });
        const third = await renderHook(usePetSpritesheetSourceResult, { initialProps: source() });
        await first.rerender(source());
        expect(assets).toHaveLength(1);
        await second.unmount();
        finish(0, 1);
        await vi.waitFor(() => expect(first.getCurrent()).toEqual({ status: 'ready', source: 'data:image/webp;base64,AQ==', spriteVersionNumber: 2 }));
        await vi.waitFor(() => expect(third.getCurrent()).toEqual(first.getCurrent()));
        await first.rerender(source());
        expect(first.getCurrent().status).toBe('ready');
        expect(assets).toHaveLength(1);

        await first.rerender(source('sha256:updated'));
        await vi.waitFor(() => expect(assets).toHaveLength(2));
        credentials.token = token('pet-atlas-other-account');
        const otherAccount = await renderHook(usePetSpritesheetSourceResult, { initialProps: source('sha256:updated') });
        await vi.waitFor(() => expect(assets).toHaveLength(3));
        expect(assets[1]!.authorization).not.toEqual(assets[2]!.authorization);
        finish(1, 2);
        finish(2, 3);
        await vi.waitFor(() => expect(first.getCurrent().source).toBe('data:image/webp;base64,Ag=='));
        await vi.waitFor(() => expect(otherAccount.getCurrent().source).toBe('data:image/webp;base64,Aw=='));
        const disabled = await renderHook(() => usePetSpritesheetSourceResult(source('sha256:hidden'), 'blink', { enabled: false }));
        expect(disabled.getCurrent().status).toBe('ready');
        expect(assets).toHaveLength(3);
        await first.unmount();
        await third.unmount();
        await otherAccount.unmount();
        await disabled.unmount();
        const homeFace = await renderHook(usePetSpritesheetSourceResult, { initialProps: source('sha256:home-isolation') });
        await vi.waitFor(() => expect(assets).toHaveLength(4));
        const otherAddress = otherHome.address();
        if (!otherAddress || typeof otherAddress === 'string') throw new Error('Missing second pet atlas Home address');
        await upsertAndActivateServer({ serverUrl: `http://127.0.0.1:${otherAddress.port}`, name: 'Other pet atlas Home' });
        const otherHomeFace = await renderHook(usePetSpritesheetSourceResult, { initialProps: source('sha256:home-isolation') });
        await vi.waitFor(() => expect(assets).toHaveLength(5));
        finish(3, 4);
        finish(4, 5);
        await vi.waitFor(() => expect(otherHomeFace.getCurrent().source).toBe('data:image/webp;base64,BQ=='));
        await otherHomeFace.rerender(source('sha256:missing'));
        await vi.waitFor(() => expect(assets).toHaveLength(6));
        assets[5]!.response.statusCode = 404;
        assets[5]!.response.end();
        await vi.waitFor(() => expect(otherHomeFace.getCurrent()).toMatchObject({ status: 'error', spriteVersionNumber: 1 }));
        await homeFace.unmount();
        await otherHomeFace.unmount();
    } finally {
        standardCleanup();
        http.closeAllConnections();
        otherHome.closeAllConnections();
        await new Promise<void>(resolve => http.close(() => resolve()));
        await new Promise<void>(resolve => otherHome.close(() => resolve()));
    }
});
