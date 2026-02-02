import { describe, expect, it, vi } from 'vitest';

vi.mock('@/configuration', () => ({
    configuration: { serverUrl: 'http://example.invalid' },
}));

import axios from 'axios';
import { fetchSessionSnapshotUpdateFromServer } from './snapshotSync';

describe('snapshotSync.fetchSessionSnapshotUpdateFromServer', () => {
    it('falls back to scanning /v2/sessions when the single-session route is missing (404 Not found)', async () => {
        const getSpy = vi.spyOn(axios, 'get');
        getSpy
            .mockResolvedValueOnce({
                status: 404,
                data: { error: 'Not found', path: '/v2/sessions/s1', method: 'GET' },
            } as any)
            .mockResolvedValueOnce({
                status: 200,
                data: { sessions: [{ id: 's1', metadataVersion: 0, agentStateVersion: 0 }], hasNext: false, nextCursor: null },
            } as any);

        const res = await fetchSessionSnapshotUpdateFromServer({
            token: 't',
            sessionId: 's1',
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
            currentMetadataVersion: 999,
            currentAgentStateVersion: 999,
        });

        expect(res).toEqual({});
        expect(getSpy).toHaveBeenCalledTimes(2);
        expect(String(getSpy.mock.calls[0]?.[0])).toContain('/v2/sessions/s1');
        expect(String(getSpy.mock.calls[1]?.[0])).toContain('/v2/sessions');
    });

    it('does not scan /v2/sessions when the session is missing (404 Session not found)', async () => {
        const getSpy = vi.spyOn(axios, 'get');
        getSpy.mockResolvedValueOnce({
            status: 404,
            data: { error: 'Session not found' },
        } as any);

        const res = await fetchSessionSnapshotUpdateFromServer({
            token: 't',
            sessionId: 's1',
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy',
            currentMetadataVersion: 999,
            currentAgentStateVersion: 999,
        });

        expect(res).toEqual({});
        expect(getSpy).toHaveBeenCalledTimes(1);
        expect(String(getSpy.mock.calls[0]?.[0])).toContain('/v2/sessions/s1');
    });
});

