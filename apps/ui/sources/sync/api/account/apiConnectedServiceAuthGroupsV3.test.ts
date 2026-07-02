import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';

vi.mock('@/utils/timing/time', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/timing/time')>();
    const immediate = async <T,>(callback: () => Promise<T>): Promise<T> => await callback();
    return {
        ...actual,
        backoff: immediate,
        backoffForever: immediate,
    };
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

const credentials: AuthCredentials = { token: 't', secret: 's' };

function mockServerConfig() {
    vi.doMock('@/sync/domains/server/serverRuntime', () => ({
        getActiveServerSnapshot: () => ({
            serverId: 'test',
            serverUrl: 'https://api.example.test',
            kind: 'custom',
            generation: 1,
        }),
    }));
}

function isServerReadinessProbeUrl(url: string): boolean {
    return url === 'https://api.example.test/health' || url === 'https://api.example.test/v1/auth/ping';
}

function createGroupResponse(overrides: Record<string, unknown> = {}) {
    const now = 1_700_000_000_000;
    return {
        v: 1,
        serviceId: 'anthropic',
        groupId: 'primary',
        displayName: 'Primary',
        policy: { v: 1 },
        activeProfileId: 'work',
        generation: 1,
        state: {},
        createdAt: now,
        updatedAt: now,
        members: [
            {
                v: 1,
                serviceId: 'anthropic',
                groupId: 'primary',
                profileId: 'work',
                priority: 10,
                enabled: true,
                state: {},
                createdAt: now,
                updatedAt: now,
            },
        ],
        ...overrides,
    };
}

function resolveNonHealthCall(fetchMock: ReturnType<typeof vi.fn>, expectedUrl: string): RequestInit {
    const call = fetchMock.mock.calls.find(([input]) => String(input) === expectedUrl);
    const init = call?.[1];
    if (!init) {
        throw new Error(`Expected fetch call for ${expectedUrl}`);
    }
    return init;
}

describe('apiConnectedServiceAuthGroupsV3', () => {
    it('lists auth groups from the v3 connected-service endpoint', async () => {
        mockServerConfig();
        const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
            const url = String(input);
            if (url === 'https://api.example.test/health') {
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            return { ok: true, status: 200, json: async () => ({ groups: [createGroupResponse()] }) };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { listConnectedServiceAuthGroupsV3 } = await import('./apiConnectedServiceAuthGroupsV3');
        const result = await listConnectedServiceAuthGroupsV3(credentials, { serviceId: 'anthropic' });

        expect(result.groups).toEqual([
            expect.objectContaining({
                serviceId: 'anthropic',
                groupId: 'primary',
                activeProfileId: 'work',
            }),
        ]);
        const init = resolveNonHealthCall(fetchMock, 'https://api.example.test/v3/connect/anthropic/groups');
        expect(init.method).toBe('GET');
        expect((init.headers as Headers).get('Authorization')).toBe('Bearer t');
    });

    it('creates auth groups with initial members and parses the returned group', async () => {
        mockServerConfig();
        const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
            const url = String(input);
            if (url === 'https://api.example.test/health') {
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            return { ok: true, status: 200, json: async () => ({ group: createGroupResponse() }) };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { createConnectedServiceAuthGroupV3 } = await import('./apiConnectedServiceAuthGroupsV3');
        const result = await createConnectedServiceAuthGroupV3(credentials, {
            serviceId: 'anthropic',
            groupId: 'primary',
            displayName: 'Primary',
            activeProfileId: 'work',
            members: [{ profileId: 'work', priority: 10, enabled: true }],
        });

        expect(result.group.members[0]?.profileId).toBe('work');
        const init = resolveNonHealthCall(fetchMock, 'https://api.example.test/v3/connect/anthropic/groups');
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({
            groupId: 'primary',
            activeProfileId: 'work',
            members: [{ profileId: 'work', priority: 10, enabled: true }],
        }));
    });

    it('posts active profile switches with an explicit cooldown override flag', async () => {
        mockServerConfig();
        const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
            const url = String(input);
            if (url === 'https://api.example.test/health') {
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            return { ok: true, status: 200, json: async () => ({ group: createGroupResponse({ activeProfileId: 'backup' }) }) };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { setConnectedServiceAuthGroupActiveProfileV3 } = await import('./apiConnectedServiceAuthGroupsV3');
        await setConnectedServiceAuthGroupActiveProfileV3(credentials, {
            serviceId: 'anthropic',
            groupId: 'primary',
            profileId: 'backup',
            expectedGeneration: 1,
            overrideRuntimeCooldown: true,
        });

        const init = resolveNonHealthCall(fetchMock, 'https://api.example.test/v3/connect/anthropic/groups/primary/active-profile');
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({
            profileId: 'backup',
            expectedGeneration: 1,
            overrideRuntimeCooldown: true,
        });
    });

    it('preserves structured connected-service group errors from 4xx responses', async () => {
        mockServerConfig();
        const resetAtMs = 1_780_000_000_000;
        const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
            const url = String(input);
            if (url === 'https://api.example.test/health') {
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            return {
                ok: false,
                status: 409,
                json: async () => ({ error: 'connect_group_profile_runtime_cooldown', resetAtMs }),
            };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { listConnectedServiceAuthGroupsV3 } = await import('./apiConnectedServiceAuthGroupsV3');

        await expect(listConnectedServiceAuthGroupsV3(credentials, { serviceId: 'anthropic' })).rejects.toMatchObject({
            canTryAgain: false,
            message: 'connect_group_profile_runtime_cooldown',
            code: 'connect_group_profile_runtime_cooldown',
            status: 409,
            resetAtMs,
        });
    });

    it('preserves retryable structured connected-service group errors from 5xx responses', async () => {
        mockServerConfig();
        const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
            const url = String(input);
            if (isServerReadinessProbeUrl(url)) {
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            return {
                ok: false,
                status: 500,
                json: async () => ({ code: 'FST_ERR_RESPONSE_SERIALIZATION', message: 'Response does not match schema' }),
            };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { listConnectedServiceAuthGroupsV3 } = await import('./apiConnectedServiceAuthGroupsV3');

        await expect(listConnectedServiceAuthGroupsV3(credentials, { serviceId: 'anthropic' })).rejects.toMatchObject({
            canTryAgain: true,
            code: 'connected_service_request_failed',
            status: 500,
        });
    });

    it('treats deleting an already missing group as idempotent', async () => {
        mockServerConfig();
        const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
            const url = String(input);
            if (url === 'https://api.example.test/health') {
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            return { ok: false, status: 404, json: async () => ({ error: 'connect_auth_group_not_found' }) };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { deleteConnectedServiceAuthGroupV3 } = await import('./apiConnectedServiceAuthGroupsV3');
        await expect(deleteConnectedServiceAuthGroupV3(credentials, {
            serviceId: 'anthropic',
            groupId: 'primary',
        })).resolves.toBe(false);

        const init = resolveNonHealthCall(fetchMock, 'https://api.example.test/v3/connect/anthropic/groups/primary');
        expect(init.method).toBe('DELETE');
    });
});
