import { describe, expect, it } from 'vitest';

import type { TurnChangeSet } from '@happier-dev/protocol';

import { emitCanonicalTurnDiffTool } from './emitCanonicalTurnDiffTool';

describe('emitCanonicalTurnDiffTool', () => {
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
});
