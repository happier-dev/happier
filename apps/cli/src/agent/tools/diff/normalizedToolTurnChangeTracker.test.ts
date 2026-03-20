import { describe, expect, it } from 'vitest';

import { NormalizedToolTurnChangeTracker } from './normalizedToolTurnChangeTracker';

describe('NormalizedToolTurnChangeTracker', () => {
    it('upgrades write tool results with normalized file mutation evidence into exact text diffs', () => {
        const tracker = new NormalizedToolTurnChangeTracker({
            provider: 'claude',
            turnIdPrefix: 'claude-turn',
        });

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
            result: {
                fileMutation: {
                    kind: 'update',
                    filePath: '/repo/session-changes-qa-root.txt',
                    oldText: 'beta\n',
                    newText: 'gamma\n',
                },
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

    it('normalizes explicit Diff tool calls into exact canonical file changes', () => {
        const tracker = new NormalizedToolTurnChangeTracker({
            provider: 'claude',
            turnIdPrefix: 'claude-turn',
        });

        tracker.observeToolCall({
            callId: 'tool_diff_1',
            toolName: 'Diff',
            args: {
                files: [
                    {
                        file_path: 'src/diff.ts',
                        oldText: 'before',
                        newText: 'after',
                    },
                ],
            },
            parentToolUseId: null,
        });

        tracker.observeToolResult({
            callId: 'tool_diff_1',
            isError: false,
        });

        const turnChangeSet = tracker.completeTurn({
            sessionId: 'sess_local_1',
            status: 'completed',
        });

        expect(turnChangeSet?.files).toEqual([
            expect.objectContaining({
                filePath: 'src/diff.ts',
                oldText: 'before',
                newText: 'after',
                source: 'provider_tool',
                confidence: 'exact',
            }),
        ]);
    });

    it('advances turn ids when turns are observed without an explicit beginTurn call', () => {
        const tracker = new NormalizedToolTurnChangeTracker({
            provider: 'claude',
            turnIdPrefix: 'claude-turn',
        });

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

    it('accepts lower-case tool names and file path aliases for shared extraction', () => {
        const tracker = new NormalizedToolTurnChangeTracker({
            provider: 'claude',
            turnIdPrefix: 'claude-turn',
        });

        tracker.observeToolCall({
            callId: 'tool_edit_alias_1',
            toolName: 'edit',
            args: {
                filePath: 'src/alias.ts',
                old_string: 'before',
                new_string: 'after',
            },
            parentToolUseId: null,
        });
        tracker.observeToolResult({
            callId: 'tool_edit_alias_1',
            isError: false,
        });

        const turnChangeSet = tracker.completeTurn({
            sessionId: 'sess_local_1',
            status: 'completed',
        });

        expect(turnChangeSet?.files).toEqual([
            expect.objectContaining({
                filePath: 'src/alias.ts',
                oldText: 'before',
                newText: 'after',
            }),
        ]);
    });

    it('reads camel-case MultiEdit edit pairs from normalized tool inputs', () => {
        const tracker = new NormalizedToolTurnChangeTracker({
            provider: 'claude',
            turnIdPrefix: 'claude-turn',
        });

        tracker.observeToolCall({
            callId: 'tool_multiedit_1',
            toolName: 'MultiEdit',
            args: {
                filePath: 'src/multi.ts',
                edits: [
                    {
                        oldText: 'old value',
                        newText: 'new value',
                    },
                ],
            },
            parentToolUseId: null,
        });
        tracker.observeToolResult({
            callId: 'tool_multiedit_1',
            isError: false,
        });

        const turnChangeSet = tracker.completeTurn({
            sessionId: 'sess_local_1',
            status: 'completed',
        });

        expect(turnChangeSet?.files).toEqual([
            expect.objectContaining({
                filePath: 'src/multi.ts',
                oldText: 'old value',
                newText: 'new value',
                description: 'MultiEdit',
            }),
        ]);
    });
});
