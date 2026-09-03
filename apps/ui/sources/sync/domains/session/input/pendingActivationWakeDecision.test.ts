import { describe, expect, it } from 'vitest';

import { resolvePendingActivationWakeOwner, shouldDelegatePendingActivationToDaemon } from './pendingActivationWakeDecision';

describe('resolvePendingActivationWakeOwner', () => {
    it.each([
        [2, true, 'daemon'],
        [2, false, 'ui'],
        [2, undefined, 'ui'],
        [1, true, 'ui'],
        [undefined, true, 'ui'],
        [undefined, undefined, 'ui'],
    ] as const)('uses daemon only for server V2 plus the exact machine bit (%s, %s)', (protocolVersion, daemonSupported, expected) => {
        expect(resolvePendingActivationWakeOwner({
            pendingInputProtocolVersion: protocolVersion,
            daemonPendingSessionActivationSupported: daemonSupported,
        })).toBe(expected);
    });

    it('queries the session server and exact wake target machine', async () => {
        const getServerFeaturesSnapshot = async (params?: { serverId?: string }) => ({
            status: 'ready' as const,
            features: { capabilities: { session: { pendingInput: { protocolVersion: 2 } } }, features: {} },
        });
        const requested: string[] = [];
        const delegated = await shouldDelegatePendingActivationToDaemon({
            session: { serverId: 'server-owned', metadata: { machineId: 'old-machine' } } as any,
            machineId: 'exact-target',
            getServerFeaturesSnapshot: async (params) => {
                expect(params).toEqual({ serverId: 'server-owned' });
                return getServerFeaturesSnapshot(params) as any;
            },
            getMachine: (machineId) => {
                requested.push(machineId);
                return { daemonState: { daemonPendingSessionActivationSupported: machineId === 'exact-target' } } as any;
            },
        });
        expect(delegated).toBe(true);
        expect(requested).toEqual(['exact-target']);
    });

    it('ignores sticky metadata after daemon downgrade and delegates only for current daemon state', async () => {
        const session = { serverId: 'server-owned', metadata: { machineId: 'exact-target' } } as any;
        const getServerFeaturesSnapshot = async () => ({
            status: 'ready' as const,
            features: { capabilities: { session: { pendingInput: { protocolVersion: 2 } } }, features: {} },
        });

        await expect(shouldDelegatePendingActivationToDaemon({
            session,
            getServerFeaturesSnapshot: getServerFeaturesSnapshot as any,
            getMachine: () => ({
                metadata: { daemonPendingSessionActivationSupported: true },
                daemonState: null,
            }) as any,
        })).resolves.toBe(false);

        await expect(shouldDelegatePendingActivationToDaemon({
            session,
            getServerFeaturesSnapshot: getServerFeaturesSnapshot as any,
            getMachine: () => ({
                metadata: { daemonPendingSessionActivationSupported: true },
                daemonState: { daemonPendingSessionActivationSupported: true },
            }) as any,
        })).resolves.toBe(true);
    });
});
