import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

// Native/browser storage are the only mocked boundaries; profile, credential and
// terminal destination selection all execute their real owners.
installTokenStorageWebPlatformMocks();

const descriptor: HomeConnectionDescriptorV1 = {
    v: 1,
    homeServerIdentityId: 'srv_shared_db_home',
    canonicalServerUrl: 'https://dev-home.example.test',
    revision: 7,
    endpoints: [{ kind: 'https', url: 'https://dev-home.example.test' }],
};
const qaOrigin = 'http://happier-agent-qa.localhost:3018';
const credentials = { token: 'test-home-token' };

describe('terminal approval destination', () => {
    let sequence = 0;
    let restoreStorage: () => void;
    let restoreLocks: () => void;
    const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;

    beforeEach(() => {
        vi.resetModules();
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = `terminal_destination_${sequence++}`;
        restoreStorage = installLocalStorageMock().restore;
        restoreLocks = installWebLockManagerMock().restore;
    });

    afterEach(() => {
        restoreLocks();
        restoreStorage();
        if (previousScope === undefined) delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        else process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
    });

    async function establishHome() {
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const profile = await profiles.adoptHomeProfile({
            descriptor, source: 'manual', descriptorAuthority: 'current_connection_observation',
        });
        await profiles.setActiveServerId(profile.id, { scope: 'device' });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        expect(await TokenStorage.setCredentialsForServerUrl(profile.serverUrl, {
            serverId: descriptor.homeServerIdentityId,
        }, credentials)).toBe(true);
        return { profiles, profile };
    }

    it('keeps an explicit same-identity QA link on its already authenticated runtime origin', async () => {
        const { profiles } = await establishHome();
        expect(profiles.publishActiveServerRuntimeOrigin({
            target: profiles.captureActiveServerRuntimeTarget(),
            leaseId: 'verified-qa-connection', runtimeOrigin: qaOrigin, carrier: 'https',
        })).toBe(true);
        const { resolveTerminalApprovalTarget } = await import('./resolveTerminalApprovalTarget');
        const target = await resolveTerminalApprovalTarget({
            parsed: { publicKeyB64Url: 'test-key', serverUrl: 'http://localhost:3018',
                serverIdentityId: descriptor.homeServerIdentityId },
            allowLoopbackServerOverride: true,
        });

        expect(target).toMatchObject({
            endpointUrl: 'http://localhost:3018', credentials, descriptor,
            transportOptions: { runtimeOrigin: qaOrigin, runtimeCarrier: 'https' },
        });
        expect(profiles.listServerProfiles().filter((p) => p.serverIdentityId === descriptor.homeServerIdentityId))
            .toHaveLength(1);
        expect(profiles.buildHomeConnectionDescriptorForProfile(profiles.getServerProfileById(profiles.getActiveServerId())!))
            .toEqual(descriptor);
    });

    it('keeps an unverified explicit destination for sign-in without forwarding saved credentials', async () => {
        await establishHome();
        const { resolveTerminalApprovalTarget } = await import('./resolveTerminalApprovalTarget');
        const target = await resolveTerminalApprovalTarget({
            parsed: { publicKeyB64Url: 'test-key', serverUrl: 'https://unverified.example.test',
                serverIdentityId: descriptor.homeServerIdentityId },
            allowLoopbackServerOverride: true,
        });
        expect(target).toMatchObject({ endpointUrl: 'https://unverified.example.test', credentials: null });
        expect(target.transportOptions).toBeUndefined();
    });

    it('retains the established transport when the link names the known canonical endpoint', async () => {
        await establishHome();
        const { resolveTerminalApprovalTarget } = await import('./resolveTerminalApprovalTarget');
        const target = await resolveTerminalApprovalTarget({
            parsed: { publicKeyB64Url: 'test-key', serverUrl: descriptor.canonicalServerUrl,
                serverIdentityId: descriptor.homeServerIdentityId },
            allowLoopbackServerOverride: false,
        });
        expect(target).toMatchObject({ endpointUrl: descriptor.canonicalServerUrl, descriptor, credentials });
    });

    it('does not borrow another Home\'s active runtime origin for an identity-matching saved profile', async () => {
        const { profiles } = await establishHome();
        const other = await profiles.adoptHomeProfile({
            descriptor: { ...descriptor, homeServerIdentityId: 'srv_other_home',
                canonicalServerUrl: 'https://other-home.example.test',
                endpoints: [{ kind: 'https', url: 'https://other-home.example.test' }] },
            source: 'manual', descriptorAuthority: 'current_connection_observation',
        });
        await profiles.setActiveServerId(other.id, { scope: 'device' });
        expect(profiles.publishActiveServerRuntimeOrigin({
            target: profiles.captureActiveServerRuntimeTarget(),
            leaseId: 'other-home-connection', runtimeOrigin: qaOrigin, carrier: 'https',
        })).toBe(true);
        const { resolveTerminalApprovalTarget } = await import('./resolveTerminalApprovalTarget');
        const target = await resolveTerminalApprovalTarget({
            parsed: { publicKeyB64Url: 'test-key', serverUrl: qaOrigin,
                serverIdentityId: descriptor.homeServerIdentityId },
            allowLoopbackServerOverride: true,
        });
        expect(target).toMatchObject({ endpointUrl: qaOrigin, credentials: null });
        expect(target.transportOptions).toBeUndefined();
    });
});
