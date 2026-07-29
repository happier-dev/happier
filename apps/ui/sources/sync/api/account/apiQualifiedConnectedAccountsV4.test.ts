import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    parseQualifiedConnectedAccountV4StructuredQueryValue,
    QualifiedConnectedAccountGroupRefSchema,
    QualifiedConnectedAccountServiceRefSchema,
} from '@happier-dev/protocol';

vi.mock('@/utils/timing/time', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/timing/time')>();
    return {
        ...actual,
        backoff: async <T,>(callback: () => Promise<T>): Promise<T> => await callback(),
    };
});

const credentials: AuthCredentials = { token: 'token', secret: 'secret' };
const service = {
    pluginId: 'acme.connected-accounts-conformance',
    localId: 'vault',
} as const;
const groupRef = { service, groupId: 'primary' } as const;

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

function isServerReadinessProbe(pathname: string): boolean {
    return pathname === '/health' || pathname === '/v1/auth/ping';
}

function makeGroup(overrides: Record<string, unknown> = {}) {
    return {
        v: 1,
        ref: groupRef,
        displayName: 'Primary',
        policy: {
            v: 1,
            strategy: 'least_limited',
            autoSwitch: false,
            switchOn: {
                usageLimit: true,
                authExpired: true,
                accountChanged: true,
                refreshFailure: false,
            },
            cooldownMs: 30_000,
            honorProviderResetsAt: true,
            autoRestorePrimaryWhenReset: false,
            maxSwitchesPerTurn: 1,
            maxSwitchesPerSessionHour: 3,
            softSwitchRemainingPercent: 15,
            probeIfSnapshotOlderThanMs: 300_000,
            preTurnProbeMode: 'when_stale',
            preTurnProbeOrder: 'current_first_then_candidates',
            recoveryMode: 'switch_or_wait',
            resumePromptMode: 'standard',
        },
        activeConnectedAccountId: 'work',
        generation: 3,
        runtimeStateRevision: 7,
        state: {},
        createdAt: 1,
        updatedAt: 2,
        members: [{
            v: 1,
            connectedAccountId: 'work',
            priority: 100,
            enabled: true,
            state: {},
            createdAt: 1,
            updatedAt: 2,
        }],
        ...overrides,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('apiQualifiedConnectedAccountsV4', () => {
    it('lists groups for a novel qualified service without flattening its identity', async () => {
        mockServerConfig();
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (isServerReadinessProbe(url.pathname)) {
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            expect(url.pathname).toBe('/v4/connect/qualified/groups');
            expect(parseQualifiedConnectedAccountV4StructuredQueryValue(
                QualifiedConnectedAccountServiceRefSchema,
                url.searchParams.get('service') ?? '',
            )).toEqual(service);
            return {
                ok: true,
                status: 200,
                json: async () => ({ groups: [makeGroup()] }),
            };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { listQualifiedConnectedAccountGroupsV4 } = await import('./apiQualifiedConnectedAccountsV4');
        const result = await listQualifiedConnectedAccountGroupsV4(credentials, { service });

        expect(result.groups[0]?.ref).toEqual(groupRef);
    });

    it('threads the current runtime-state revision through member, policy, and active-account mutations', async () => {
        mockServerConfig();
        const observed: Array<{ path: string; method: string; body: unknown }> = [];
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            if (isServerReadinessProbe(url.pathname)) {
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            observed.push({
                path: url.pathname,
                method: init?.method ?? 'GET',
                body: init?.body ? JSON.parse(String(init.body)) : null,
            });
            return {
                ok: true,
                status: 200,
                json: async () => ({ group: makeGroup({ runtimeStateRevision: 8 }) }),
            };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const {
            addQualifiedConnectedAccountGroupMemberV4,
            patchQualifiedConnectedAccountGroupV4,
            setQualifiedConnectedAccountGroupActiveAccountV4,
        } = await import('./apiQualifiedConnectedAccountsV4');

        await addQualifiedConnectedAccountGroupMemberV4(credentials, {
            group: groupRef,
            connectedAccountId: 'backup',
            priority: 200,
            enabled: true,
            expectedRuntimeStateRevision: 7,
        });
        await patchQualifiedConnectedAccountGroupV4(credentials, {
            service,
            groupId: 'primary',
            policy: { autoSwitch: true },
            expectedRuntimeStateRevision: 7,
        });
        await setQualifiedConnectedAccountGroupActiveAccountV4(credentials, {
            group: groupRef,
            connectedAccountId: 'backup',
            expectedGeneration: 3,
            expectedRuntimeStateRevision: 7,
        });

        expect(observed).toEqual([
            {
                path: '/v4/connect/qualified/group/members',
                method: 'POST',
                body: {
                    group: groupRef,
                    connectedAccountId: 'backup',
                    priority: 200,
                    enabled: true,
                    expectedRuntimeStateRevision: 7,
                },
            },
            expect.objectContaining({
                path: '/v4/connect/qualified/group',
                method: 'PATCH',
                body: expect.objectContaining({
                    service,
                    groupId: 'primary',
                    policy: expect.objectContaining({ autoSwitch: true }),
                    expectedRuntimeStateRevision: 7,
                }),
            }),
            {
                path: '/v4/connect/qualified/group/active-account',
                method: 'POST',
                body: {
                    group: groupRef,
                    connectedAccountId: 'backup',
                    expectedGeneration: 3,
                    expectedRuntimeStateRevision: 7,
                },
            },
        ]);
    });

    it('surfaces revision conflicts and unsupported peers without a legacy mutation fallback', async () => {
        mockServerConfig();
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (isServerReadinessProbe(url.pathname)) {
                return { ok: true, status: 200, json: async () => ({ ok: true }) };
            }
            const encoded = url.searchParams.get('group');
            if (encoded) {
                expect(parseQualifiedConnectedAccountV4StructuredQueryValue(
                    QualifiedConnectedAccountGroupRefSchema,
                    encoded,
                )).toEqual(groupRef);
            }
            return {
                ok: false,
                status: 409,
                json: async () => ({
                    error: 'connect_group_runtime_state_revision_conflict',
                    runtimeStateRevision: 9,
                }),
            };
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { deleteQualifiedConnectedAccountGroupV4 } = await import('./apiQualifiedConnectedAccountsV4');
        await expect(deleteQualifiedConnectedAccountGroupV4(credentials, {
            group: groupRef,
            expectedRuntimeStateRevision: 7,
        })).rejects.toMatchObject({
            code: 'connect_group_runtime_state_revision_conflict',
            status: 409,
            runtimeStateRevision: 9,
        });
        const groupRequests = fetchMock.mock.calls.filter(([input]) =>
            new URL(String(input)).pathname === '/v4/connect/qualified/group'
        );
        expect(groupRequests).toHaveLength(1);
    });
});
