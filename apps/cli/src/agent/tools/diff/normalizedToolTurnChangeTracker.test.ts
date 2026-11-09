import { describe, expect, it } from 'vitest';

import type { TurnChangeSet } from '@happier-dev/protocol';
import { mapCodexRolloutEventToActions } from '@happier-dev/plugins-codex/agent/rollout/projection/actions';

import { buildTurnChangeSetDiffInput } from './buildTurnChangeSetDiffInput';
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
        tracker.beginTurn({ turnId: 'host-turn-1', agentTurnId: 'provider-turn-1' });

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
                agentTurnId: 'provider-turn-1',
                providerMessageId: 'tool_diff_1',
            }),
        ]);
    });

    it('derives checkpoint metadata and exact file semantics from persisted canonical Diff messages', () => {
        const sourceTurn: TurnChangeSet = {
            sessionId: 'sess_local_1',
            turnId: 'checkpoint-turn-1',
            seqRange: { startSeqInclusive: 4, endSeqInclusive: 4 },
            status: 'completed',
            files: [{
                filePath: 'src/new-name.ts',
                previousFilePath: 'src/old-name.ts',
                changeKind: 'renamed',
                unifiedDiff: 'diff --git a/src/old-name.ts b/src/new-name.ts',
                binary: true,
                source: 'scm_checkpoint',
                confidence: 'exact',
                provider: 'scm:git',
            }],
            provider: 'scm:git',
            derivedAt: 1,
            repositoryCheckpoint: {
                version: 1,
                scopeId: 'sess_local_1:/repo',
                startRef: 'refs/happier/checkpoints/scope/turn-start/checkpoint-turn-1',
                finalRef: 'refs/happier/checkpoints/scope/turn-final/checkpoint-turn-1',
                baseRefSource: 'turn_start',
                contentConfidence: 'exact',
                attributionScope: 'shared_worktree',
                receipts: [{ id: 'checkpoint.diff_computed', ref: 'refs/happier/checkpoints/scope/turn-final/checkpoint-turn-1' }],
            },
        };
        const tracker = new NormalizedToolTurnChangeTracker({
            provider: 'claude',
            turnIdPrefix: 'claude-turn',
        });

        tracker.observeToolCall({
            callId: 'tool_diff_checkpoint',
            toolName: 'Diff',
            args: buildTurnChangeSetDiffInput({
                turnChangeSet: sourceTurn,
                source: { protocol: 'native', agent: { pluginId: 'happier.agent.claude', localId: 'claude' } },
                rawToolName: 'RepositoryCheckpointDiff',
            }),
            parentToolUseId: null,
        });

        tracker.observeToolResult({
            callId: 'tool_diff_checkpoint',
            isError: false,
        });

        const turnChangeSet = tracker.completeTurn({
            sessionId: 'sess_local_1',
            status: 'completed',
        });

        expect(turnChangeSet).toEqual(expect.objectContaining({
            sessionId: 'sess_local_1',
            turnId: 'checkpoint-turn-1',
            seqRange: { startSeqInclusive: 4, endSeqInclusive: 4 },
            status: 'completed',
            repositoryCheckpoint: expect.objectContaining({
                contentConfidence: 'exact',
                attributionScope: 'shared_worktree',
                receipts: [expect.objectContaining({ id: 'checkpoint.diff_computed' })],
            }),
            files: [
                expect.objectContaining({
                    filePath: 'src/new-name.ts',
                    previousFilePath: 'src/old-name.ts',
                    changeKind: 'renamed',
                    binary: true,
                    source: 'scm_checkpoint',
                    confidence: 'exact',
                    provider: 'scm:git',
                }),
            ],
        }));
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

    it('projects one raw Codex apply_patch envelope into exact Changed Files paths, kinds, and content', () => {
        const tracker = new NormalizedToolTurnChangeTracker({
            provider: 'codex',
            turnIdPrefix: 'codex-turn',
        });
        tracker.beginTurn({ turnId: 'host-turn-patch', agentTurnId: 'codex-turn-patch' });

        const [toolCall] = mapCodexRolloutEventToActions({
            type: 'response_item',
            payload: {
                type: 'custom_tool_call',
                name: 'apply_patch',
                call_id: 'apply-patch-1',
                input: [
                    '*** Begin Patch',
                    '*** Update File: src/updated.ts',
                    '@@',
                    '-before update',
                    '+after update',
                    '*** Add File: src/added.ts',
                    '+added content',
                    '*** Delete File: src/deleted.ts',
                    '-deleted content',
                    '*** Update File: src/old-name.ts',
                    '*** Move to: src/new-name.ts',
                    '@@',
                    '-before rename',
                    '+after rename',
                    '*** End Patch',
                ].join('\n'),
            },
        }, { debug: false });
        expect(toolCall).toMatchObject({
            type: 'tool-call',
            callId: 'apply-patch-1',
            name: 'Patch',
        });
        if (toolCall?.type !== 'tool-call') throw new Error('Expected canonical Patch tool call');

        tracker.observeToolCall({
            callId: toolCall.callId,
            toolName: toolCall.name,
            args: toolCall.input as Record<string, unknown>,
            parentToolUseId: null,
        });
        tracker.observeToolResult({
            callId: 'apply-patch-1',
            isError: false,
        });

        expect(tracker.completeTurn({
            sessionId: 'sess-patch',
            status: 'completed',
        })?.files).toEqual([
            {
                filePath: 'src/updated.ts',
                previousFilePath: null,
                changeKind: 'modified',
                unifiedDiff: '@@\n-before update\n+after update',
                oldText: 'before update',
                newText: 'after update',
                binary: undefined,
                source: 'provider_tool',
                confidence: 'exact',
                provider: 'codex',
                agentTurnId: 'codex-turn-patch',
                providerMessageId: 'apply-patch-1',
                description: null,
            },
            expect.objectContaining({
                filePath: 'src/added.ts',
                changeKind: 'added',
                unifiedDiff: '+added content',
                oldText: '',
                newText: 'added content',
            }),
            expect.objectContaining({
                filePath: 'src/deleted.ts',
                changeKind: 'deleted',
                unifiedDiff: '-deleted content',
                oldText: 'deleted content',
                newText: '',
            }),
            expect.objectContaining({
                filePath: 'src/new-name.ts',
                previousFilePath: 'src/old-name.ts',
                changeKind: 'renamed',
                unifiedDiff: '@@\n-before rename\n+after rename',
                oldText: 'before rename',
                newText: 'after rename',
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
