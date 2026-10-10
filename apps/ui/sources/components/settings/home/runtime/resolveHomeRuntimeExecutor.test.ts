import { describe, expect, it } from 'vitest';

import type { RemoteHost } from '@/sync/domains/remoteHosts/remoteHostModel';

import { homeRuntimeExecutorCanAct, resolveHomeRuntimeExecutor, type HomeRuntimeExecutorFacts } from './resolveHomeRuntimeExecutor';

function remoteHost(overrides: Partial<RemoteHost> = {}): RemoteHost {
    return {
        id: 'host_vps',
        name: 'Home VPS',
        ssh: { target: 'me@vps.example.test', authMode: 'agent' },
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        linkedRelayProfileId: 'profile_vps',
        linkedMachineId: 'machine_vps',
        ...overrides,
    };
}

function facts(overrides: Partial<HomeRuntimeExecutorFacts> = {}): HomeRuntimeExecutorFacts {
    return {
        serverId: 'srv_home',
        flavor: 'light',
        localBridgeAvailable: false,
        locallyHostedServerId: null,
        remoteHosts: [],
        remoteHostScope: { serverId: 'catalog_home', accountId: 'account' },
        remoteHostCatalogRevision: 4,
        scopeIdOfProfile: (profileId) => (profileId === 'profile_vps' ? 'srv_home' : null),
        ...overrides,
    };
}

describe('resolveHomeRuntimeExecutor (one executor rule for Reach, Runtime, Backups and Restart now)', () => {
    it('does not offer SSH runtime authority without the originating Account catalog revision', () => {
        const host = remoteHost();
        const unadmitted = { ...facts({ localBridgeAvailable: true, remoteHosts: [host] }),
            remoteHostScope: null, remoteHostCatalogRevision: null };
        const executor = resolveHomeRuntimeExecutor(unadmitted);
        expect(homeRuntimeExecutorCanAct(executor)).toBe(false);
    });

    it('acts locally only on the desktop that set this Home up as its own, with the system-task bridge', () => {
        expect(resolveHomeRuntimeExecutor(facts({ localBridgeAvailable: true, locallyHostedServerId: 'srv_home' })))
            .toEqual({ kind: 'hosting_desktop' });
        // The same desktop hosting another Home is not an executor for this one.
        expect(resolveHomeRuntimeExecutor(facts({ localBridgeAvailable: true, locallyHostedServerId: 'srv_other' })).kind)
            .toBe('elsewhere');
        // A web client with the same receipt has no bridge.
        expect(resolveHomeRuntimeExecutor(facts({ locallyHostedServerId: 'srv_home' })).kind).toBe('elsewhere');
    });

    it('reaches a Remote host linked to this Home over SSH from a desktop, else through its connected Machine', () => {
        const host = remoteHost();
        expect(resolveHomeRuntimeExecutor(facts({ localBridgeAvailable: true, remoteHosts: [host] })))
            .toEqual({ kind: 'remote_host', host, hostName: 'Home VPS',
                scope: { serverId: 'catalog_home', accountId: 'account' }, catalogRevision: 4 });
        expect(resolveHomeRuntimeExecutor(facts({ remoteHosts: [host] })))
            .toEqual({ kind: 'connected_machine', machineId: 'machine_vps', hostName: 'Home VPS' });
        expect(resolveHomeRuntimeExecutor(facts({ remoteHosts: [remoteHost({ linkedMachineId: null })] })))
            .toEqual({ kind: 'elsewhere', hostName: 'Home VPS' });
        // A host linked to another Home is not this Home's runtime.
        expect(resolveHomeRuntimeExecutor(facts({ localBridgeAvailable: true, remoteHosts: [remoteHost({ linkedRelayProfileId: 'profile_other' })] })))
            .toEqual({ kind: 'elsewhere', hostName: null });
    });

    it('leaves a full-flavour runtime to its deployment and offers no control without an executor', () => {
        const deployment = resolveHomeRuntimeExecutor(facts({ flavor: 'full', localBridgeAvailable: true, locallyHostedServerId: 'srv_home' }));
        expect(deployment).toEqual({ kind: 'deployment' });
        expect(homeRuntimeExecutorCanAct(deployment)).toBe(false);
        expect(homeRuntimeExecutorCanAct({ kind: 'elsewhere', hostName: null })).toBe(false);
        expect(homeRuntimeExecutorCanAct({ kind: 'hosting_desktop' })).toBe(true);
    });
});
