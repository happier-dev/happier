import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    flushHookEffects,
    renderHook,
    standardCleanup,
} from '@/dev/testkit';

const createClientMock = vi.hoisted(() => vi.fn());
const authState = vi.hoisted(() => ({
    credentials: {
        token: 'token-a',
        secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => authState,
}));
vi.mock('@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource', async (
    importOriginal,
) => ({
    ...await importOriginal<
        typeof import('@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource')
    >(),
    createQualifiedConnectedAccountGroupsClient: createClientMock,
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));

const policy = {
    v: 1 as const,
    strategy: 'least_limited' as const,
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
    preTurnProbeMode: 'when_stale' as const,
    preTurnProbeOrder: 'current_first_then_candidates' as const,
    recoveryMode: 'switch_or_wait' as const,
    resumePromptMode: 'standard' as const,
};

function groupFor(
    service: Readonly<{ pluginId: string; localId: string }>,
    groupId: string,
) {
    return {
        ref: { service, groupId },
        displayName: groupId,
        policy,
        activeAccountId: null,
        revision: {
            protocol: 'v4' as const,
            generation: 1,
            runtimeStateRevision: 1,
        },
        state: {},
        members: [],
    };
}

describe('useQualifiedConnectedAccountGroups', () => {
    beforeEach(() => {
        standardCleanup();
        createClientMock.mockReset();
    });

    it('does not expose service A groups while a changed server/service/auth basis loads or fails', async () => {
        const serviceA = { pluginId: 'acme.accounts', localId: 'a' };
        const serviceB = { pluginId: 'acme.accounts', localId: 'b' };
        const groupA = groupFor(serviceA, 'group-a');
        createClientMock.mockImplementation((params: Readonly<{
            service: typeof serviceA;
        }>) => params.service.localId === 'a'
            ? {
                list: vi.fn().mockResolvedValue([groupA]),
            }
            : {
                list: vi.fn().mockRejectedValue(
                    Object.assign(new Error('unavailable'), {
                        code: 'qualified_peer_unavailable',
                    }),
                ),
            });

        const { useQualifiedConnectedAccountGroups } = await import(
            './useQualifiedConnectedAccountGroups'
        );
        const hook = await renderHook(
            (params: Readonly<{
                serverId: string;
                service: typeof serviceA;
                peer: {
                    status: 'ready';
                    transport: { protocol: 'v4' };
                    error: null;
                };
            }>) => useQualifiedConnectedAccountGroups(params),
            {
                initialProps: {
                    serverId: 'server-a',
                    service: serviceA,
                    peer: {
                        status: 'ready',
                        transport: { protocol: 'v4' },
                        error: null,
                    },
                },
            },
        );
        await flushHookEffects();
        expect(hook.getCurrent().groups.map((group) => group.ref.groupId))
            .toEqual(['group-a']);

        authState.credentials = {
            token: 'token-b',
            secret: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        };
        const changed = await hook.rerender({
            serverId: 'server-b',
            service: serviceB,
            peer: {
                status: 'ready',
                transport: { protocol: 'v4' },
                error: null,
            },
        });
        expect(changed.groups).toEqual([]);
        expect(changed.source).toEqual({ protocol: 'v4' });

        await flushHookEffects();
        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            status: 'error',
            source: { protocol: 'v4' },
            groups: [],
        }));
    });
});
