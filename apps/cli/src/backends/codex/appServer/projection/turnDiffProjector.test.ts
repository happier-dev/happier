import { describe, expect, it, vi } from 'vitest';

import { createCodexAppServerTurnDiffProjector } from './turnDiffProjector';

describe('createCodexAppServerTurnDiffProjector', () => {
    it('emits a canonical Diff tool from file-change arrays with exact per-file text diffs', () => {
        const sendCodexMessage = vi.fn();
        const projector = createCodexAppServerTurnDiffProjector({
            session: {
                sendCodexMessage,
                sessionId: 'session-1',
            },
            readLastObservedMessageSeq: () => 7,
        });

        projector.beginTurn();
        projector.observeFileChangeToolCall({
            changes: [
                {
                    path: 'src/notes.md',
                    kind: { type: 'update', move_path: null },
                    diff: [
                        '@@ -1 +1,2 @@',
                        '-old line',
                        '+old line',
                        '+new line',
                    ].join('\n'),
                },
                {
                    path: 'src/new.txt',
                    kind: { type: 'add', move_path: null },
                    diff: 'hello\nworld\n',
                },
            ],
        });

        projector.emitCompletedTurn({
            threadId: 'thread-1',
            turnId: 'turn-1',
            completedTurnStartSeqInclusive: 3,
        });

        expect(sendCodexMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'tool-call',
                name: 'Diff',
                input: expect.objectContaining({
                    files: [
                        expect.objectContaining({
                            file_path: 'src/notes.md',
                            oldText: 'old line',
                            newText: 'old line\nnew line',
                        }),
                        expect.objectContaining({
                            file_path: 'src/new.txt',
                            oldText: '',
                            newText: 'hello\nworld\n',
                        }),
                    ],
                    _happier: expect.objectContaining({
                        provider: 'codex',
                        rawToolName: 'CodexDiff',
                        sessionChangeScope: 'turn',
                        turnId: 'turn-1',
                    }),
                }),
            }),
        );
        expect(sendCodexMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'tool-call-result',
                output: { status: 'completed' },
            }),
        );
    });
});
