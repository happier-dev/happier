import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

// Keep the real Home publisher, credential owner, connection manager and Sync.
// Only external Socket.IO, secure storage and native crypto SDKs are adapted.
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
vi.mock('@more-tech/react-native-libsodium', () => import('libsodium-wrappers'));
vi.mock('@/platform/cryptoRandom', () => import('@/platform/cryptoRandom.node'));
vi.mock('@/platform/digest', () => import('@/platform/digest.node'));
vi.mock('@/platform/hmacSha512', () => import('@/platform/hmacSha512.node'));
vi.mock('@/platform/randomUUID', () => import('@/platform/randomUUID.node'));
const secureStore = vi.hoisted(() => new Map<string, string>());
vi.mock('expo-secure-store', () => ({
    getItemAsync: async (key: string) => secureStore.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { secureStore.set(key, value); },
    deleteItemAsync: async (key: string) => { secureStore.delete(key); },
}));

const { AuthProvider, getCurrentAuth } = await import('./AuthContext');
const profiles = await import('@/sync/domains/server/serverProfiles');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const connection = await import('@/sync/runtime/orchestration/connectionManager');
let restored: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
const previousStorageScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => {
    standardCleanup();
    await connection.disconnectActiveServerConnection();
    await restored?.dispose();
    restored = undefined;
    secureStore.clear();
    profiles.resetServerProfilesRuntimeForTests();
    if (previousStorageScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
    else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousStorageScope;
});

describe('AuthContext descriptor publication', () => {
    it('applies a focused Home descriptor published before or after mount while retaining legacy custody', async () => {
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = 'auth_context_descriptor_revision';
        profiles.resetServerProfilesRuntimeForTests();
        const endpoint = 'https://descriptor-context.test';
        const homeServerIdentityId = 'srv_descriptor_context';
        const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'descriptor-account' })).toString('base64url')}.signature`,
            secret: Buffer.alloc(32, 8).toString('base64url') };
        const currentness = createAccountEncryptionCurrentnessFixtureForCredentials(credentials);
        restored = await restoreServerAccountForTest({
            serverUrl: endpoint, serverIdentityId: homeServerIdentityId, credentials,
            request: async (url) => {
                const pathname = new URL(String(url)).pathname;
                if (pathname === '/v1/account/encryption/currentness') return Response.json(currentness);
                if (pathname === '/v1/account/encryption') {
                    return Response.json({ mode: currentness.mode, updatedAt: currentness.updatedAt });
                }
                return null;
            },
        });
        const before = connection.getAppliedActiveServerSnapshot();
        const descriptor = { v: 1 as const, homeServerIdentityId, canonicalServerUrl: endpoint, revision: 1,
            endpoints: [{ kind: 'https' as const, url: endpoint }] };
        await profiles.adoptHomeProfile({ descriptor, source: 'qr', descriptorAuthority: 'current_connection_observation' });
        const startup = getActiveServerSnapshot();
        expect(startup.connectionDescriptorRevision).toBe(1);
        expect(startup.generation).toBeGreaterThan(before.generation);
        const screen = await renderScreen(React.createElement(AuthProvider, {
            initialCredentials: credentials, children: React.createElement(React.Fragment),
        }));
        try {
            await vi.waitFor(() => {
                expect(connection.getAppliedActiveServerSnapshot()).toMatchObject({
                    serverId: startup.serverId, generation: startup.generation,
                });
                expect(getActiveServerSnapshot().carrier).toBe('https');
            });
            await act(async () => {
                expect(await profiles.reconcileServerProfileHomeConnectionDescriptor({ serverUrl: endpoint,
                    observedServerIdentityId: homeServerIdentityId, descriptor: { ...descriptor, revision: 2 },
                })).toMatchObject({ kind: 'applied' });
            });
            const selected = getActiveServerSnapshot();
            expect(selected.connectionDescriptorRevision).toBe(2);
            expect(selected.generation).toBeGreaterThan(startup.generation);
            await vi.waitFor(() => expect(connection.getAppliedActiveServerSnapshot()).toMatchObject({
                serverId: selected.serverId, generation: selected.generation,
            }));
            expect(getCurrentAuth()?.credentials).toEqual(credentials);
            expect(getCurrentAuth()?.isAuthenticated).toBe(true);
        } finally { await screen.unmount(); }
    });
});
