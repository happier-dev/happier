import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

const storageBoundary = vi.hoisted(() => ({ unreadable: true }));

// Secure storage is the boundary: an unreadable store throws only for a reader
// that asked to see it, exactly like the real owner (serverCredentialAccountScope.test.ts).
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: {
            getCredentialsForServerUrl: async (
                _serverUrl: string,
                options?: Readonly<{ storageReadFailure?: 'absent' | 'surface' }>,
            ) => {
                if (storageBoundary.unreadable && options?.storageReadFailure === 'surface') {
                    throw new Error('secure storage read failed');
                }
                return null;
            },
        },
        subscribeHomeCredentialMutations: () => () => undefined,
    });
});

// Load the real owners during collection, after the boundary mock is registered;
// their cold transform is not the contract under test.
const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
const { retryServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
const { useHomeAdministration } = await import('./useHomeAdministration');

afterEach(() => {
    storageBoundary.unreadable = true;
    standardCleanup();
});

describe('useHomeAdministration', () => {
    it('settles an unreadable saved credential on its own state and re-reads it on retry', async () => {
        const home = await upsertServerProfile({ name: 'Unreadable Home', serverUrl: 'https://unreadable-admin.example.test' });

        const hook = await renderHook(() => useHomeAdministration(home.id));
        // Never a spinner that cannot settle, never a sign-out claim.
        await vi.waitFor(() => {
            expect(hook.getCurrent()).toEqual({ kind: 'credential_unreadable', serverId: home.id });
        });

        storageBoundary.unreadable = false;
        act(() => {
            retryServerCredentialAccountScope(home.id);
        });
        await vi.waitFor(() => {
            expect(hook.getCurrent()).toEqual({ kind: 'signed_out', homeName: 'Unreadable Home' });
        });
    });
});
