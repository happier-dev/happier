import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol/auth/accountDirectory';
import { installTokenStorageTestIsolation, installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import * as profiles from '@/sync/domains/server/serverProfiles';
import { resolveTerminalApprovalTarget } from './resolveTerminalApprovalTarget';

// Native/browser storage are the only mocked boundaries; profile, credential and
// terminal destination selection all execute their real owners.
installTokenStorageWebPlatformMocks();
installTokenStorageTestIsolation('terminal_destination');

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
    let restoreStorage: () => void;
    let restoreLocks: () => void;

    beforeEach(() => {
        restoreStorage = installLocalStorageMock().restore;
        restoreLocks = installWebLockManagerMock().restore;
    });

    afterEach(() => {
        restoreLocks();
        restoreStorage();
    });

    async function establishHome(
        home: HomeConnectionDescriptorV1 = descriptor,
        descriptorAuthority: 'advisory' | 'current_connection_observation' = 'current_connection_observation',
    ) {
        const profile = await profiles.adoptHomeProfile({ descriptor: home, source: 'manual', descriptorAuthority });
        await profiles.setActiveServerId(profile.id, { scope: 'device' });
        expect(await TokenStorage.setCredentialsForServerUrl(profile.serverUrl, {
            serverId: home.homeServerIdentityId,
        }, credentials)).toBe(true);
        return { profile };
    }

    it('keeps an explicit same-identity QA link on its already authenticated runtime origin', async () => {
        await establishHome();
        expect(profiles.publishActiveServerRuntimeOrigin({
            target: profiles.captureActiveServerRuntimeTarget(),
            leaseId: 'verified-qa-connection', runtimeOrigin: qaOrigin, carrier: 'https',
        })).toBe(true);
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
        const target = await resolveTerminalApprovalTarget({
            parsed: { publicKeyB64Url: 'test-key', serverUrl: descriptor.canonicalServerUrl,
                serverIdentityId: descriptor.homeServerIdentityId },
            allowLoopbackServerOverride: false,
        });
        expect(target).toMatchObject({ endpointUrl: descriptor.canonicalServerUrl, descriptor, credentials });
    });

    it('does not borrow another Home\'s active runtime origin for an identity-matching saved profile', async () => {
        await establishHome();
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
        const target = await resolveTerminalApprovalTarget({
            parsed: { publicKeyB64Url: 'test-key', serverUrl: qaOrigin,
                serverIdentityId: descriptor.homeServerIdentityId },
            allowLoopbackServerOverride: true,
        });
        expect(target).toMatchObject({ endpointUrl: qaOrigin, credentials: null });
        expect(target.transportOptions).toBeUndefined();
    });

    it('never unlocks an identity-bound Home\'s credentials for a link that carries no identity', async () => {
        await establishHome();
        const target = await resolveTerminalApprovalTarget({
            parsed: { publicKeyB64Url: 'test-key', serverUrl: descriptor.canonicalServerUrl },
            allowLoopbackServerOverride: false,
        });
        expect(target).toEqual({ endpointUrl: descriptor.canonicalServerUrl, credentials: null });
    });

    it('refuses a supplied descriptor whose identity differs from the link destination', async () => {
        await establishHome();
        await expect(resolveTerminalApprovalTarget({
            parsed: {
                publicKeyB64Url: 'test-key', serverUrl: descriptor.canonicalServerUrl,
                serverIdentityId: descriptor.homeServerIdentityId,
                homeConnectionDescriptor: { ...descriptor, homeServerIdentityId: 'srv_other_home' },
            },
            allowLoopbackServerOverride: false,
        })).rejects.toThrow('descriptor identity does not match');
    });

    it('requires a verified transport before approving through a Home known only from advice', async () => {
        const advised: HomeConnectionDescriptorV1 = {
            ...descriptor,
            homeServerIdentityId: 'srv_advised_home',
            canonicalServerUrl: 'https://advised-home.example.test',
            endpoints: [{ kind: 'https', url: 'https://advised-home.example.test' }],
        };
        const { profile } = await establishHome(advised, 'advisory');
        expect(profile.descriptorProvenance).toBe('advisory-only');

        await expect(resolveTerminalApprovalTarget({
            parsed: { publicKeyB64Url: 'test-key', serverUrl: advised.canonicalServerUrl,
                serverIdentityId: advised.homeServerIdentityId },
            allowLoopbackServerOverride: false,
        })).rejects.toThrow('verified transport');
    });
});
