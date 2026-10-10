import { describe, expect, it } from 'vitest';

import {
    parseDecryptedSessionMetadata,
    parsePlainSessionMetadata,
} from './parsePlainSessionPayload';

describe('parsePlainSessionMetadata metadata privacy layout', () => {
    it('uses the canonical shared-envelope read projection for layout v1', () => {
        expect(parsePlainSessionMetadata(JSON.stringify({
            v: 1,
            summary: { text: 'Safe title', updatedAt: 10 },
        }), 1)).toEqual({
            v: 1,
            summary: { text: 'Safe title', updatedAt: 10 },
        });
    });

    it('drops unknown fields without admitting private authority from layout-v1 stored data', () => {
        expect(parsePlainSessionMetadata(JSON.stringify({
            v: 1,
            summary: { text: 'Safe title', updatedAt: 10 },
            path: '/malicious-private-path',
            futurePrivateAuthority: { token: 'never-admit' },
        }), 1)).toEqual({ v: 1, summary: { text: 'Safe title', updatedAt: 10 } });
        expect(parsePlainSessionMetadata(JSON.stringify({ v: 1, bot: { kind: 'bot', future: true } }), 1))
            .toEqual({ v: 1, bot: { kind: 'bot' } });
        expect(parsePlainSessionMetadata(JSON.stringify({ v: 1, bot: { kind: 'ordinary' } }), 1)).toBeNull();
    });

    it('distinguishes absent legacy layout from present invalid null', () => {
        const legacy = JSON.stringify({
            path: '/legacy-owner-path',
            machineId: 'legacy-machine',
        });
        expect(parsePlainSessionMetadata(legacy, undefined)).not.toBeNull();
        expect(parsePlainSessionMetadata(legacy, 0)).not.toBeNull();
        expect(parsePlainSessionMetadata(legacy, null)).toBeNull();
    });

    it('keeps the released legacy parser only when the layout is absent', () => {
        expect(parsePlainSessionMetadata(JSON.stringify({
            path: '/legacy-owner-path',
            machineId: 'legacy-machine',
        }))).toEqual({
            path: '/legacy-owner-path',
            host: '',
            machineId: 'legacy-machine',
        });
    });

    it('applies the same known-field boundary after E2EE decryption', () => {
        expect(parseDecryptedSessionMetadata({
            v: 1,
            publicAgentState: {
                completedRequests: {
                    request_1: {
                        tool: 'permission',
                        createdAt: 1,
                        completedAt: 2,
                        status: 'approved',
                    },
                },
            },
        }, 1)).toEqual({
            v: 1,
            publicAgentState: {
                completedRequests: {
                    request_1: {
                        tool: 'permission',
                        createdAt: 1,
                        completedAt: 2,
                        status: 'approved',
                    },
                },
            },
        });

        expect(parseDecryptedSessionMetadata({
            v: 1,
            summary: { text: 'Safe title', updatedAt: 10 },
            resumeToken: 'private-authority',
        }, 1)).toEqual({ v: 1, summary: { text: 'Safe title', updatedAt: 10 } });
    });

    it('keeps layout-zero decrypted metadata on the released parser', () => {
        expect(parseDecryptedSessionMetadata({
            path: '/legacy-owner-path',
            machineId: 'legacy-machine',
        }, 0)).toEqual({
            path: '/legacy-owner-path',
            host: '',
            machineId: 'legacy-machine',
        });
    });
});
