import { describe, expect, it } from 'vitest';

import type { TurnChangeSet } from '@happier-dev/protocol';

import { emitCanonicalTurnDiffTool } from './emitCanonicalTurnDiffTool';

describe('emitCanonicalTurnDiffTool', () => {
    it('does not emit an empty canonical Diff tool for checkpoint-only turns without file evidence', () => {
        const calls: Array<{ toolName: string; input: unknown; callId?: string }> = [];
        const results: Array<{ callId: string; output: unknown }> = [];

        const turnChangeSet: TurnChangeSet = {
            sessionId: 'session_1',
            turnId: 'turn_1',
            seqRange: { startSeqInclusive: 1, endSeqInclusive: 1 },
            status: 'completed',
            provider: 'scm:git',
            derivedAt: 1_700_000_000_000,
            files: [],
            repositoryCheckpoint: {
                version: 1,
                scopeId: 'session_1:/repo',
                startRef: 'refs/happier/checkpoints/scope/turn-start/turn_1',
                finalRef: 'refs/happier/checkpoints/scope/turn-final/turn_1',
                baseRefSource: 'turn_start',
                contentConfidence: 'exact',
                attributionScope: 'shared_worktree',
                receipts: [{ id: 'checkpoint.diff_computed', ref: 'refs/happier/checkpoints/scope/turn-final/turn_1' }],
            },
        };

        const emittedCallId = emitCanonicalTurnDiffTool({
            turnChangeSet,
            protocol: 'codex',
            rawToolName: 'RepositoryCheckpointDiff',
            sendToolCall: (params) => {
                calls.push(params);
                return 'call_1';
            },
            sendToolResult: (params) => {
                results.push(params);
            },
        });

        expect(emittedCallId).toBeNull();
        expect(calls).toEqual([]);
        expect(results).toEqual([]);
    });

    it('emits one canonical Diff tool call/result pair with turn metadata', () => {
        const calls: Array<{ toolName: string; input: unknown; callId?: string }> = [];
        const results: Array<{ callId: string; output: unknown }> = [];

        const turnChangeSet: TurnChangeSet = {
            sessionId: 'session_1',
            turnId: 'turn_1',
            seqRange: { startSeqInclusive: 1, endSeqInclusive: 4 },
            status: 'completed',
            provider: 'codex',
            derivedAt: 1_700_000_000_000,
            files: [{
                filePath: 'src/app-renamed.ts',
                previousFilePath: 'src/app.ts',
                changeKind: 'renamed',
                oldText: 'a\n',
                newText: 'b\n',
                binary: true,
                source: 'scm_checkpoint',
                confidence: 'exact',
                provider: 'scm:git',
            }],
            repositoryCheckpoint: {
                version: 1,
                scopeId: 'session_1:/repo',
                startRef: 'refs/happier/checkpoints/scope/turn-start/turn_1',
                finalRef: 'refs/happier/checkpoints/scope/turn-final/turn_1',
                baseRefSource: 'turn_start',
                contentConfidence: 'exact',
                attributionScope: 'shared_worktree',
                receipts: [{ id: 'checkpoint.diff_computed', ref: 'refs/happier/checkpoints/scope/turn-final/turn_1' }],
            },
        };

        emitCanonicalTurnDiffTool({
            turnChangeSet,
            protocol: 'codex',
            rawToolName: 'CodexDiff',
            sendToolCall: (params) => {
                calls.push(params);
                return 'call_1';
            },
            sendToolResult: (params) => {
                results.push(params);
            },
        });

        expect(calls).toEqual([
            expect.objectContaining({
                toolName: 'Diff',
                input: expect.objectContaining({
                    files: [
                        expect.objectContaining({
                            file_path: 'src/app-renamed.ts',
                            previous_file_path: 'src/app.ts',
                            change_kind: 'renamed',
                            binary: true,
                            source: 'scm_checkpoint',
                            confidence: 'exact',
                            provider: 'scm:git',
                            oldText: 'a\n',
                            newText: 'b\n',
                        }),
                    ],
                    _happier: expect.objectContaining({
                        provider: 'codex',
                        rawToolName: 'CodexDiff',
                        canonicalToolName: 'Diff',
                        workspaceMutationSignal: 'turn-change-set',
                        sessionChangeScope: 'turn',
                        turnId: 'turn_1',
                        sessionId: 'session_1',
                        confidence: 'exact',
                        source: 'scm_checkpoint',
                        repositoryCheckpoint: expect.objectContaining({
                            contentConfidence: 'exact',
                            attributionScope: 'shared_worktree',
                            receipts: [expect.objectContaining({ id: 'checkpoint.diff_computed' })],
                        }),
                    }),
                }),
                callId: expect.any(String),
            }),
        ]);
        expect(results).toEqual([{ callId: 'call_1', output: { status: 'completed' } }]);
    });

    it('uses a deterministic call id for the same turn change set when replayed', () => {
        const turnChangeSet: TurnChangeSet = {
            sessionId: 'session_1',
            turnId: 'turn_1',
            seqRange: { startSeqInclusive: 1, endSeqInclusive: 4 },
            status: 'completed',
            provider: 'codex',
            derivedAt: 1_700_000_000_000,
            files: [{
                filePath: 'src/app.ts',
                changeKind: 'modified',
                oldText: 'a\n',
                newText: 'b\n',
                binary: false,
                source: 'scm_checkpoint',
                confidence: 'exact',
                provider: 'scm:git',
            }],
            repositoryCheckpoint: {
                version: 1,
                scopeId: 'session_1:/repo',
                startRef: 'refs/happier/checkpoints/scope/turn-start/turn_1',
                finalRef: 'refs/happier/checkpoints/scope/turn-final/turn_1',
                baseRefSource: 'turn_start',
                contentConfidence: 'exact',
                attributionScope: 'shared_worktree',
                receipts: [{ id: 'checkpoint.diff_computed', ref: 'refs/happier/checkpoints/scope/turn-final/turn_1' }],
            },
        };

        const callIds: string[] = [];
        const replay = (derivedAt: number): void => {
            emitCanonicalTurnDiffTool({
                turnChangeSet: { ...turnChangeSet, derivedAt },
                protocol: 'codex',
                rawToolName: 'CodexDiff',
                sendToolCall: (params) => {
                    callIds.push(params.callId ?? '');
                    return params.callId ?? 'missing_call_id';
                },
                sendToolResult: () => {},
            });
        };

        replay(1_700_000_000_000);
        replay(1_700_000_000_999);

        expect(callIds).toHaveLength(2);
        expect(callIds[0]).toBe(callIds[1]);
        expect(callIds[0]).toMatch(/^turn-diff-/);
    });

    it('hashes the bounded emitted input instead of oversized raw file content', () => {
        const makeOversizedTurn = (oldText: string, newText: string): TurnChangeSet => ({
            sessionId: 'session_1',
            turnId: 'turn_1',
            seqRange: { startSeqInclusive: 1, endSeqInclusive: 4 },
            status: 'completed',
            provider: 'codex',
            derivedAt: 1_700_000_000_000,
            files: [{
                filePath: 'src/huge.ts',
                changeKind: 'modified',
                oldText,
                newText,
                source: 'scm_checkpoint',
                confidence: 'exact',
                provider: 'scm:git',
            }],
        });

        const emit = (turnChangeSet: TurnChangeSet): { callId: string; input: unknown } => {
            let emittedInput: unknown;
            let emittedCallId = '';
            emitCanonicalTurnDiffTool({
                turnChangeSet,
                protocol: 'codex',
                rawToolName: 'RepositoryCheckpointDiff',
                sendToolCall: (params) => {
                    emittedInput = params.input;
                    emittedCallId = params.callId ?? '';
                    return emittedCallId;
                },
                sendToolResult: () => {},
            });
            return { callId: emittedCallId, input: emittedInput };
        };

        const first = emit(makeOversizedTurn('a'.repeat(400_000), 'b'.repeat(400_000)));
        const second = emit(makeOversizedTurn('c'.repeat(400_000), 'd'.repeat(400_000)));

        expect(first.input).toEqual(second.input);
        expect(first.callId).toBe(second.callId);
    });
});
