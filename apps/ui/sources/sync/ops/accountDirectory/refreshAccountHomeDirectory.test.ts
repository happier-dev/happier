import { describe, expect, it, vi } from 'vitest';

const adoptHomeProfileMock = vi.hoisted(() => vi.fn(async (params: unknown) => params));
const getActiveServerSnapshotMock = vi.hoisted(() => vi.fn(() => ({ serverId: 'focused', serverUrl: 'https://focused.test', generation: 1 })));

vi.mock('@/sync/domains/server/serverProfiles', () => ({ adoptHomeProfile: adoptHomeProfileMock }));
vi.mock('@/sync/domains/server/serverRuntime', () => ({ getActiveServerSnapshot: getActiveServerSnapshotMock }));

describe('refreshAccountHomeDirectory', () => {
    it('adopts directory homes without reading or changing focused Home state', async () => {
        const { refreshAccountHomeDirectory } = await import('./refreshAccountHomeDirectory');
        const session = {
            refresh: vi.fn(async () => ({
                endpoint: 'https://directory.test', status: 'ready', account: null, preferredHomeServerIdentityId: 'home-1', refreshedAtMs: 1, error: null,
                homes: [{
                    homeServerIdentityId: 'home-1', canonicalServerUrl: 'https://home.test', label: 'Home', createdAt: 1, updatedAt: 1,
                    connectionDescriptor: { v: 1, homeServerIdentityId: 'home-1', canonicalServerUrl: 'https://home.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.test' }] },
                }],
            })),
        };

        await refreshAccountHomeDirectory(session as never);
        expect(adoptHomeProfileMock).toHaveBeenCalledWith(expect.objectContaining({
            source: 'account-directory',
            preserveUserLabel: true,
        }));
        expect(getActiveServerSnapshotMock).not.toHaveBeenCalled();
    });
});
