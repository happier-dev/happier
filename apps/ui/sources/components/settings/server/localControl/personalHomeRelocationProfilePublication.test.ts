import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol/auth/accountDirectory';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';

installTokenStorageWebPlatformMocks();

describe('relocation without Account Directory', () => {
    let restore: (() => void) | undefined;
    afterEach(() => { restore?.(); vi.resetModules(); });

    it('retains the exact mixed destination descriptor and user label without changing focus', async () => {
        const storage = installLocalStorageMock();
        restore = storage.restore;
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const { createPersonalHomeRelocationProfilePublication, createPersonalHomeRelocationPromptResponderWithPublication } = await import('./personalHomeRelocationPromptResponder');
        const source = await profiles.adoptHomeProfile({
            descriptor: { v: 1, homeServerIdentityId: 'srv_move', canonicalServerUrl: 'https://home.test', revision: 2,
                endpoints: [{ kind: 'https', url: 'https://source.test' }] },
            source: 'manual', suggestedName: 'My Home', descriptorAuthority: 'current_connection_observation',
        });
        await profiles.setActiveServerId(source.id);
        const focus = profiles.getActiveServerSnapshot();
        const descriptor: HomeConnectionDescriptorV1 = { v: 1, homeServerIdentityId: 'srv_move', canonicalServerUrl: 'https://home.test', revision: 27,
            endpoints: [{ kind: 'https' as const, url: 'https://destination.test' },
                { kind: 'iroh' as const, endpointId: 'ab'.repeat(32), relayUrls: ['https://relay.test'], directAddresses: ['192.168.1.2:4242'] }] };
        const responder = createPersonalHomeRelocationPromptResponderWithPublication({
            operationId: 'move-1', homeServerIdentityId: 'srv_move', homeLabel: 'My Home',
            publication: createPersonalHomeRelocationProfilePublication(source),
        });
        await expect(responder({ kind: 'personal_home.publish_relocation_descriptor.v1', message: '',
            data: { operationId: 'move-1', homeServerIdentityId: 'srv_move', connectionDescriptor: descriptor },
        })).resolves.toEqual({ descriptor });
        expect(profiles.getServerProfileById(source.id)?.homeConnectionDescriptor).toEqual(descriptor);
        expect(profiles.getServerProfileById(source.id)?.name).toBe(source.name);
        expect(profiles.getActiveServerSnapshot().serverId).toBe(focus.serverId);
        await expect(responder({ kind: 'personal_home.read_relocation_descriptor.v1', message: '',
            data: { operationId: 'move-1', homeServerIdentityId: 'srv_move' },
        })).resolves.toEqual({ descriptor });
    });
});
