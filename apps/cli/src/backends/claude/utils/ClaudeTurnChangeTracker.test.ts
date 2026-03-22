import { describe, expect, it } from 'vitest';

import { ClaudeTurnChangeTracker } from './ClaudeTurnChangeTracker';

describe('ClaudeTurnChangeTracker', () => {
    it('upgrades local Write tool results into exact text diffs', () => {
        const tracker = new ClaudeTurnChangeTracker();

        tracker.observeToolCall({
            callId: 'tool_write_1',
            toolName: 'Write',
            args: {
                file_path: '/repo/session-changes-qa-root.txt',
                content: 'gamma\n',
            },
            parentToolUseId: null,
        });

        tracker.observeToolResult({
            callId: 'tool_write_1',
            isError: false,
            toolUseResult: {
                type: 'update',
                filePath: '/repo/session-changes-qa-root.txt',
                content: 'gamma\n',
                originalFile: 'beta\n',
                structuredPatch: [
                    {
                        oldStart: 1,
                        oldLines: 1,
                        newStart: 1,
                        newLines: 1,
                        lines: ['-beta', '+gamma'],
                    },
                ],
            },
        });

        const turnChangeSet = tracker.completeTurn({
            sessionId: 'sess_local_1',
            status: 'completed',
        });

        expect(turnChangeSet).toMatchObject({
            sessionId: 'sess_local_1',
            turnId: 'claude-turn-1',
            files: [
                {
                    filePath: '/repo/session-changes-qa-root.txt',
                    oldText: 'beta\n',
                    newText: 'gamma\n',
                    source: 'provider_tool',
                    confidence: 'exact',
                },
            ],
        });
    });

    it('advances turn ids when turns are observed without an explicit beginTurn call', () => {
        const tracker = new ClaudeTurnChangeTracker();

        tracker.observeToolCall({
            callId: 'tool_edit_1',
            toolName: 'Edit',
            args: {
                file_path: 'src/alpha.ts',
                old_string: 'old',
                new_string: 'new',
            },
            parentToolUseId: null,
        });
        tracker.observeToolResult({
            callId: 'tool_edit_1',
            isError: false,
        });

        const firstTurn = tracker.completeTurn({
            sessionId: 'sess_local_1',
            status: 'completed',
        });

        tracker.observeToolCall({
            callId: 'tool_edit_2',
            toolName: 'Edit',
            args: {
                file_path: 'src/beta.ts',
                old_string: 'before',
                new_string: 'after',
            },
            parentToolUseId: null,
        });
        tracker.observeToolResult({
            callId: 'tool_edit_2',
            isError: false,
        });

        const secondTurn = tracker.completeTurn({
            sessionId: 'sess_local_1',
            status: 'completed',
        });

        expect(firstTurn?.turnId).toBe('claude-turn-1');
        expect(secondTurn?.turnId).toBe('claude-turn-2');
    });
});
