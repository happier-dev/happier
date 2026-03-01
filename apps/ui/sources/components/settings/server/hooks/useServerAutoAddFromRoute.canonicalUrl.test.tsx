import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/domains/server/serverConfig', () => ({
    validateServerUrl: () => ({ valid: true, error: null }),
}));

const upsertServerProfileMock = vi.fn((..._args: unknown[]) => ({
    id: 'p0',
    serverUrl: 'http://example.test',
    name: 'Example',
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: 0,
}));
const removeServerProfileMock = vi.fn((..._args: unknown[]) => undefined);
vi.mock('@/sync/domains/server/serverProfiles', () => ({
    upsertServerProfile: (...args: unknown[]) => upsertServerProfileMock(...args),
    removeServerProfile: (...args: unknown[]) => removeServerProfileMock(...args),
}));

const getServerFeaturesSnapshotMock = vi.fn(async (..._args: unknown[]) => ({
    status: 'ready',
    features: {
        features: {},
        capabilities: { server: { canonicalServerUrl: 'https://canonical.example.test' } },
    },
}));
vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getServerFeaturesSnapshot: (...args: unknown[]) => getServerFeaturesSnapshotMock(...args),
}));

describe('useServerAutoAddFromRoute (canonical URL adoption)', () => {
    beforeEach(() => {
        upsertServerProfileMock.mockReset();
        removeServerProfileMock.mockReset();
        getServerFeaturesSnapshotMock.mockReset();
    });

    it('adopts canonicalServerUrl from /v1/features without prompting', async () => {
        upsertServerProfileMock
            .mockReturnValueOnce({ id: 'p1', serverUrl: 'http://127.0.0.1:3005', name: 'Local', createdAt: 0, updatedAt: 0, lastUsedAt: 0 })
            .mockReturnValueOnce({ id: 'p2', serverUrl: 'https://canonical.example.test', name: 'Local', createdAt: 0, updatedAt: 0, lastUsedAt: 0 });

        const onSwitchServerById = vi.fn(async () => {});
        const onAfterSuccess = vi.fn();

        const { useServerAutoAddFromRoute } = await import('./useServerAutoAddFromRoute');

        function Probe() {
            useServerAutoAddFromRoute({
                enabled: true,
                url: 'http://127.0.0.1:3005',
                validateServerReachable: async () => true,
                setError: vi.fn(),
                onSwitchServerById,
                onAfterSuccess,
                source: 'url',
            });
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
        });

        expect(getServerFeaturesSnapshotMock).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'p1' }));
        expect(removeServerProfileMock).toHaveBeenCalledWith('p1');
        expect(onSwitchServerById).toHaveBeenCalledWith('p2', expect.anything());
        expect(onAfterSuccess).toHaveBeenCalled();
    });

    it('does not auto-adopt a canonicalServerUrl with a different host when the input URL looks shareable', async () => {
        upsertServerProfileMock.mockReturnValueOnce({ id: 'p1', serverUrl: 'http://public.example.test', name: 'Public', createdAt: 0, updatedAt: 0, lastUsedAt: 0 });

        getServerFeaturesSnapshotMock.mockResolvedValueOnce({
            status: 'ready',
            features: {
                features: {},
                capabilities: { server: { canonicalServerUrl: 'https://canonical.example.test' } },
            },
        });

        const onSwitchServerById = vi.fn(async () => {});
        const onAfterSuccess = vi.fn();

        const { useServerAutoAddFromRoute } = await import('./useServerAutoAddFromRoute');

        function Probe() {
            useServerAutoAddFromRoute({
                enabled: true,
                url: 'http://public.example.test',
                validateServerReachable: async () => true,
                setError: vi.fn(),
                onSwitchServerById,
                onAfterSuccess,
                source: 'url',
            });
            return null;
        }

        await act(async () => {
            renderer.create(React.createElement(Probe));
        });

        expect(removeServerProfileMock).not.toHaveBeenCalled();
        expect(onSwitchServerById).toHaveBeenCalledWith('p1', expect.anything());
        expect(onAfterSuccess).toHaveBeenCalled();
    });
});
