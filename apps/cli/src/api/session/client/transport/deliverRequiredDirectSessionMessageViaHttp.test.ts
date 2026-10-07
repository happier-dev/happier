import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deliverRequiredDirectSessionMessageViaHttp } from './deliverRequiredDirectSessionMessageViaHttp';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

vi.mock('axios');

describe('deliverRequiredDirectSessionMessageViaHttp', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetAllMocks();
    });

    it('keeps the released direct-message HTTP serializer outside the durable transcript outbox', async () => {
        vi.mocked(axios.post).mockResolvedValue({
            data: {
                ok: true,
                message: { id: 'message-1', seq: 7, localId: 'local-1' },
            },
        });

        await expect(runWithServerHttpBaseUrl('https://server.example', () => deliverRequiredDirectSessionMessageViaHttp({
            token: 'token',
            sessionId: 'session/one',
            message: { t: 'plain', v: { role: 'agent', content: 'hello' } },
            localId: 'local-1',
            sidechainId: 'sidechain-1',
            messageRole: 'agent',
            sessionEventType: 'ready',
        }))).resolves.toEqual({ id: 'message-1', seq: 7, localId: 'local-1' });

        expect(axios.post).toHaveBeenCalledWith(
            'https://server.example/v2/sessions/session%2Fone/messages',
            {
                content: { t: 'plain', v: { role: 'agent', content: 'hello' } },
                localId: 'local-1',
                sidechainId: 'sidechain-1',
                messageRole: 'agent',
                sessionEventType: 'ready',
            },
            expect.objectContaining({
                headers: expect.objectContaining({ 'Idempotency-Key': 'local-1' }),
            }),
        );
    });
});
