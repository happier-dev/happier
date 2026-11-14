import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HomeConnectionDescriptorV1 } from '@happier-dev/protocol/auth/accountDirectory';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createDirectoryHttpFixture, toAccountDirectoryHomeWire } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import { AccountDirectorySession } from '@/sync/domains/accountDirectory/accountDirectorySession';
import { createPersonalHomeRelocationPromptResponder } from './personalHomeRelocationPromptResponder';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/sync/http/client', () => ({ createServerFetchAtEndpoint: () => request }));

describe('task-bound relocation Directory publication', () => {
    const fixture = createDirectoryHttpFixture();
    const target = { endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId };
    const descriptor: HomeConnectionDescriptorV1 = { ...fixture.home.connectionDescriptor, revision: 27,
        endpoints: [{ kind: 'https' as const, url: 'https://destination.test' },
            { kind: 'iroh' as const, endpointId: 'ab'.repeat(32), relayUrls: ['https://relay.test'] }] };
    beforeEach(async () => {
        request.mockReset();
        await TokenStorage.accountDirectoryAuthCredentials.set(target, { token: fixture.token });
    });
    function responder() {
        return createPersonalHomeRelocationPromptResponder({
            operationId: 'move-1', homeServerIdentityId: descriptor.homeServerIdentityId, homeLabel: 'My Home',
            session: new AccountDirectorySession(target, { capability: fixture.service.capability }),
        });
    }

    it('carries the exact descriptor through the real session to Directory PUT', async () => {
        request
            .mockResolvedValueOnce(new Response(JSON.stringify({ ...fixture.state.me, encryptionMode: fixture.state.mode })))
            .mockResolvedValueOnce(new Response(JSON.stringify({ contentEncryptionMode: 'plain', recipients: [] })))
            .mockResolvedValueOnce(new Response(JSON.stringify(toAccountDirectoryHomeWire({ ...fixture.home, label: 'My Home',
                connectionDescriptor: descriptor }))));
        await expect(responder()({ kind: 'personal_home.publish_relocation_descriptor.v1', message: '',
            data: { operationId: 'move-1', homeServerIdentityId: descriptor.homeServerIdentityId, connectionDescriptor: descriptor },
        })).resolves.toEqual({ descriptor });
        expect(JSON.parse(request.mock.calls[2][1].body)).toEqual({
            v: 1, label: { content: { t: 'plain', v: 'My Home' }, recipients: [] }, connectionDescriptor: descriptor,
        });
    });

    it('rejects another operation and a descriptor for another Home before network mutation', async () => {
        await expect(responder()({ kind: 'personal_home.read_relocation_descriptor.v1', message: '',
            data: { operationId: 'other-operation', homeServerIdentityId: descriptor.homeServerIdentityId },
        })).rejects.toThrow();
        await expect(responder()({ kind: 'personal_home.publish_relocation_descriptor.v1', message: '',
            data: { operationId: 'move-1', homeServerIdentityId: descriptor.homeServerIdentityId,
                connectionDescriptor: { ...descriptor, homeServerIdentityId: 'srv_other' } },
        })).rejects.toThrow();
        expect(request).not.toHaveBeenCalled();
    });
});
