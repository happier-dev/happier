import { describe, expect, it } from 'vitest';

import { deriveExternalSessionTranscriptRefreshCursorIdentity } from './resolveExternalSessionTranscriptRefreshBinding';

const authority = {
    machineId: 'machine-1',
    sessionId: 'session-1',
    link: {
        generation: 'link-generation-1',
        remoteSessionId: 'remote-session-1',
    },
    source: {
        qualifiedIdentity: {
            v: 1 as const,
            agent: {
                pluginId: 'happier.codex',
                localId: 'codex',
            },
            source: {
                kind: 'codexHome',
                contractVersion: 1 as const,
            },
        },
        generation: 'source-generation-1',
    },
    contributionGeneration: 'contribution-generation-1',
};

describe('secure refresh cursor binding identity', () => {
    it('is deterministic, non-reversible on the wire, and bound to the full cursor and authority tuple', () => {
        const key = new Uint8Array(32).fill(7);
        const cursor =
            'happier_external_cursor_v1:eyJuYXRpdmVDdXJzb3IiOiIvcHJpdmF0ZS9hZ2VudC90cmFuc2NyaXB0Lmpzb25sOjIwNDgifQ';
        const identity = deriveExternalSessionTranscriptRefreshCursorIdentity({
            key,
            cursor,
            authority,
        });

        expect(identity).toMatch(/^external_session_cursor_binding_v1:[0-9a-f]{64}$/);
        expect(identity).toBe(deriveExternalSessionTranscriptRefreshCursorIdentity({
            key,
            cursor,
            authority,
        }));
        expect(identity).not.toContain(cursor);
        expect(identity).not.toContain('/private/agent/transcript.jsonl:2048');
        expect(deriveExternalSessionTranscriptRefreshCursorIdentity({
            key,
            cursor: `${cursor}x`,
            authority,
        })).not.toBe(identity);
        expect(deriveExternalSessionTranscriptRefreshCursorIdentity({
            key,
            cursor,
            authority: {
                ...authority,
                link: {
                    ...authority.link,
                    generation: 'link-generation-2',
                },
            },
        })).not.toBe(identity);
    });
});
