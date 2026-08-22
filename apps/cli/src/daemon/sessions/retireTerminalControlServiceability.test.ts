import { beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

import { retireExactTerminalControlServiceability } from './retireTerminalControlServiceability';

describe('retireExactTerminalControlServiceability', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('retires a plain Session projection with token-only credentials', async () => {
        const get = vi.spyOn(axios, 'get')
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    session: createSessionRecordFixture({
                        id: 'session-plain-123',
                        encryptionMode: 'plain',
                        metadataLayoutVersion: 0,
                        metadata: JSON.stringify({
                            path: '/repo',
                            terminal: {
                                mode: 'tmux',
                                controlServiceabilityV1: {
                                    v: 1,
                                    attachmentId: 'attachment-1',
                                    state: 'servable',
                                    observedAt: 1,
                                },
                            },
                        }),
                        metadataVersion: 4,
                        agentState: null,
                        agentStateVersion: 0,
                        dataEncryptionKey: null,
                    }),
                },
            } as never)
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    mode: 'plain',
                    version: 1,
                    signingKeyFingerprint: null,
                    contentKeyFingerprint: null,
                    updatedAt: 1,
                },
            } as never);
        const patch = vi.spyOn(axios, 'patch').mockResolvedValueOnce({
            status: 200,
            data: {
                success: true,
                metadataLayoutVersion: 1,
                sharedMetadata: { version: 5 },
                agentState: { version: 0 },
            },
        } as never);

        await expect(retireExactTerminalControlServiceability({
            credentials: {
                token: 'token-only',
                encryption: null,
            },
            sessionId: 'session-plain-123',
            attachmentId: 'attachment-1',
            terminalMode: 'tmux',
        })).resolves.toBe('retired');

        expect(get).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session-plain-123'),
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer token-only',
                }),
            }),
        );
        expect(patch).toHaveBeenCalledWith(
            expect.stringContaining('/v2/sessions/session-plain-123'),
            expect.objectContaining({
                mode: 'owner_migration',
                target: expect.objectContaining({
                    ownerMetadata: expect.objectContaining({ t: 'plain' }),
                }),
            }),
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer token-only',
                }),
            }),
        );
        const request = patch.mock.calls[0]?.[1] as {
            target?: { ownerMetadata?: { t?: unknown; v?: unknown } };
        };
        expect(request.target?.ownerMetadata).toMatchObject({
            t: 'plain',
            v: {
                runtime: {
                    terminal: {
                        mode: 'tmux',
                        controlServiceabilityV1: {
                            v: 1,
                            attachmentId: 'attachment-1',
                            state: 'unknown',
                            reason: 'attachment_retired',
                            retired: true,
                        },
                    },
                },
            },
        });
    });
});
