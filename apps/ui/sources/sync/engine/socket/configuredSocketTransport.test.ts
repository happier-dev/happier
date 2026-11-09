import { describe, expect, it } from 'vitest';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { bindAccountEncryptionObservation, readAccountEncryptionObservationBinding, type AccountEncryptionObservationBinding } from '@/sync/http/accountEncryptionObservationBinding';
import { StaleServerGenerationError } from '@/sync/http/client';
import { createConfiguredSocketRequest } from './configuredSocketTransport';

const credentials = { token: 'configured-socket-token' };
const settled = createPlainAccountEncryptionCurrentnessFixture();
const createBinding = (name: string): AccountEncryptionObservationBinding => ({ credentials, credentialScopeKey: name,
    serverId: name, endpointUrl: `https://${name}.test`, runtimeOrigin: `https://${name}.test`, homeCarrierEndpointId: null,
    isCurrent: () => true, read: async () => settled, peek: () => settled });

describe('createConfiguredSocketRequest', () => {
    it('borrows only the binding of the transport it sends through', async () => {
        const sent: string[] = [];
        const socketBinding = createBinding('socket');
        const embedBinding = createBinding('embed');
        let embedRequest: ((path: string) => Promise<Response>) | null = null;
        let embedWindow = false;
        const request = createConfiguredSocketRequest({
            readEmbedRequest: () => embedRequest,
            isEmbedWindow: () => embedWindow,
            socket: {
                request: async (path: string) => { sent.push(`socket${path}`); return Response.json({}); },
                getAccountEncryptionObservationBinding: () => socketBinding,
            },
        });
        await request('/a');
        expect(readAccountEncryptionObservationBinding(request, credentials)).toBe(socketBinding);

        embedRequest = bindAccountEncryptionObservation(async (path: string) => { sent.push(`embed${path}`); return Response.json({}); }, embedBinding);
        await request('/b');
        expect(readAccountEncryptionObservationBinding(request, credentials)).toBe(embedBinding);

        // An embed window without its scope neither sends nor borrows the app socket's mode.
        embedRequest = null;
        embedWindow = true;
        await expect(request('/c')).rejects.toBeInstanceOf(StaleServerGenerationError);
        expect(readAccountEncryptionObservationBinding(request, credentials)).toBeNull();
        expect(sent).toEqual(['socket/a', 'embed/b']);
    });
});
