import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';

import { deriveTurnChangeSetsFromMessages } from '../derivation/deriveTurnChangeSetsFromMessages';

function makeDiffMessage(): Message {
    return {
        kind: 'tool-call',
        id: 'tool_1',
        localId: null,
        createdAt: 10,
        tool: {
            name: 'Diff',
            state: 'completed',
            input: {
                files: [
                    {
                        file_path: 'src/app.ts',
                        oldText: 'a\n',
                        newText: 'b\n',
                    },
                ],
                _happier: {
                    v: 2,
                    protocol: 'codex',
                    provider: 'codex',
                    rawToolName: 'CodexDiff',
                    canonicalToolName: 'Diff',
                    sessionChangeScope: 'turn',
                    turnId: 'turn_1',
                    sessionId: 'session_1',
                    source: 'provider_native',
                    confidence: 'exact',
                    turnStatus: 'completed',
                    seqRange: {
                        startSeqInclusive: 1,
                        endSeqInclusive: 4,
                    },
                },
            },
            createdAt: 10,
            startedAt: 10,
            completedAt: 11,
            description: null,
            result: { status: 'completed' },
        },
        children: [],
    };
}

describe('deriveTurnChangeSetsFromMessages', () => {
    it('reads canonical turn-scoped Diff tool messages into turn change sets', () => {
        const result = deriveTurnChangeSetsFromMessages([makeDiffMessage()]);

        expect(result).toEqual([
            expect.objectContaining({
                turnId: 'turn_1',
                sessionId: 'session_1',
                files: [
                    expect.objectContaining({
                        filePath: 'src/app.ts',
                        oldText: 'a\n',
                        newText: 'b\n',
                    }),
                ],
            }),
        ]);
    });
});
