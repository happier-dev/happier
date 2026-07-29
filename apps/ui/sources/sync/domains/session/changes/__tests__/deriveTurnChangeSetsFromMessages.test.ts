import { describe, expect, it, vi } from 'vitest';

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

function makePatchMessage(): Message {
    return {
        kind: 'tool-call',
        id: 'tool_patch_1',
        localId: null,
        createdAt: 9,
        tool: {
            name: 'Patch',
            state: 'completed',
            input: {
                changes: [
                    {
                        path: 'src/app.ts',
                        kind: { type: 'update', move_path: null },
                        diff: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n',
                    },
                ],
                _happier: {
                    v: 2,
                    protocol: 'codex',
                    provider: 'codex',
                    rawToolName: 'CodexPatch',
                    canonicalToolName: 'Patch',
                    sessionChangeScope: 'turn',
                    turnId: 'turn_1',
                    sessionId: 'session_1',
                    source: 'provider_tool',
                    confidence: 'strong',
                    turnStatus: 'completed',
                    seqRange: {
                        startSeqInclusive: 1,
                        endSeqInclusive: 3,
                    },
                },
            },
            createdAt: 9,
            startedAt: 9,
            completedAt: 10,
            description: null,
            result: { status: 'completed' },
        },
        children: [],
    };
}

describe('deriveTurnChangeSetsFromMessages', () => {
    it('reads canonical turn-scoped Diff tool messages into turn change sets', async () => {
        vi.resetModules();
        const { deriveTurnChangeSetsFromMessages } = await import('../derivation/deriveTurnChangeSetsFromMessages');
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

    it('reads turn-scoped Patch tool messages into turn change sets', async () => {
        vi.resetModules();
        const { deriveTurnChangeSetsFromMessages } = await import('../derivation/deriveTurnChangeSetsFromMessages');
        const result = deriveTurnChangeSetsFromMessages([makePatchMessage()]);

        expect(result).toEqual([
            expect.objectContaining({
                turnId: 'turn_1',
                sessionId: 'session_1',
                files: [
                    expect.objectContaining({
                        filePath: 'src/app.ts',
                        unifiedDiff: expect.stringContaining('+++ b/src/app.ts'),
                        source: 'provider_tool',
                        confidence: 'strong',
                    }),
                ],
            }),
        ]);
    });

    it('prefers canonical Diff evidence over Patch evidence for the same turn', async () => {
        vi.resetModules();
        const { deriveTurnChangeSetsFromMessages } = await import('../derivation/deriveTurnChangeSetsFromMessages');
        const result = deriveTurnChangeSetsFromMessages([makePatchMessage(), makeDiffMessage()]);

        expect(result).toHaveLength(1);
        expect(result[0]?.files).toEqual([
            expect.objectContaining({
                filePath: 'src/app.ts',
                oldText: 'a\n',
                newText: 'b\n',
                source: 'provider_native',
            }),
        ]);
    });

    it('preserves checkpoint metadata and exact file semantics from canonical Diff messages', () => {
        const message = makeDiffMessage();
        if (message.kind !== 'tool-call') throw new Error('expected tool-call fixture');
        message.tool.input = {
            files: [
                {
                    file_path: 'src/new-name.ts',
                    previous_file_path: 'src/old-name.ts',
                    change_kind: 'renamed',
                    unified_diff: 'diff --git a/src/old-name.ts b/src/new-name.ts',
                    binary: true,
                    source: 'scm_checkpoint',
                    confidence: 'exact',
                    provider: 'scm:git',
                },
            ],
            _happier: {
                v: 2,
                protocol: 'codex',
                provider: 'scm:git',
                rawToolName: 'RepositoryCheckpointDiff',
                canonicalToolName: 'Diff',
                sessionChangeScope: 'turn',
                turnId: 'turn_checkpoint_1',
                sessionId: 'session_1',
                source: 'scm_checkpoint',
                confidence: 'exact',
                turnStatus: 'completed',
                seqRange: {
                    startSeqInclusive: 7,
                    endSeqInclusive: 7,
                },
                repositoryCheckpoint: {
                    version: 1,
                    scopeId: 'session_1:/repo',
                    startRef: 'refs/happier/checkpoints/scope/turn-start/turn_checkpoint_1',
                    finalRef: 'refs/happier/checkpoints/scope/turn-final/turn_checkpoint_1',
                    baseRefSource: 'turn_start',
                    contentConfidence: 'exact',
                    attributionScope: 'shared_worktree',
                    receipts: [
                        { id: 'checkpoint.captured', phase: 'message-start' },
                        { id: 'checkpoint.aliased', phase: 'turn-start' },
                        { id: 'checkpoint.finalized', phase: 'turn-final' },
                        { id: 'checkpoint.diff_computed', ref: 'refs/happier/checkpoints/scope/turn-final/turn_checkpoint_1' },
                    ],
                },
            },
        };

        const result = deriveTurnChangeSetsFromMessages([message]);

        expect(result).toEqual([
            expect.objectContaining({
                turnId: 'turn_checkpoint_1',
                provider: 'scm:git',
                repositoryCheckpoint: expect.objectContaining({
                    startRef: 'refs/happier/checkpoints/scope/turn-start/turn_checkpoint_1',
                    finalRef: 'refs/happier/checkpoints/scope/turn-final/turn_checkpoint_1',
                    contentConfidence: 'exact',
                    attributionScope: 'shared_worktree',
                    receipts: expect.arrayContaining([
                        expect.objectContaining({ id: 'checkpoint.diff_computed' }),
                    ]),
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
            }),
        ]);
    });

    it('keeps legacy canonical Diff payload defaults when checkpoint fields are absent', () => {
        const result = deriveTurnChangeSetsFromMessages([makeDiffMessage()]);

        expect(result[0]?.files).toEqual([
            expect.objectContaining({
                filePath: 'src/app.ts',
                changeKind: 'modified',
                source: 'provider_native',
                confidence: 'exact',
                provider: 'codex',
                agentTurnId: 'turn_1',
            }),
        ]);
        expect(result[0]?.repositoryCheckpoint).toBeUndefined();
    });

    it('reconciles provider and checkpoint Diff messages for the same turn', () => {
        const providerMessage = makeDiffMessage();
        const checkpointMessage = makeDiffMessage();
        if (checkpointMessage.kind !== 'tool-call') throw new Error('expected tool-call fixture');
        checkpointMessage.id = 'tool_checkpoint_1';
        checkpointMessage.createdAt = 12;
        checkpointMessage.tool.input = {
            files: [
                {
                    file_path: 'src/app.ts',
                    unified_diff: 'checkpoint diff',
                    source: 'scm_checkpoint',
                    confidence: 'exact',
                    provider: 'scm:git',
                },
            ],
            _happier: {
                v: 2,
                protocol: 'codex',
                provider: 'scm:git',
                rawToolName: 'RepositoryCheckpointDiff',
                canonicalToolName: 'Diff',
                sessionChangeScope: 'turn',
                turnId: 'turn_1',
                sessionId: 'session_1',
                source: 'scm_checkpoint',
                confidence: 'exact',
                turnStatus: 'completed',
                seqRange: {
                    startSeqInclusive: 0,
                    endSeqInclusive: 0,
                },
                repositoryCheckpoint: {
                    version: 1,
                    scopeId: 'session_1:/repo',
                    startRef: 'refs/happier/checkpoints/scope/turn-start/turn_1',
                    finalRef: 'refs/happier/checkpoints/scope/turn-final/turn_1',
                    baseRefSource: 'turn_start',
                    contentConfidence: 'exact',
                    attributionScope: 'shared_worktree',
                    receipts: [{ id: 'checkpoint.diff_computed' }],
                },
            },
        };

        const result = deriveTurnChangeSetsFromMessages([providerMessage, checkpointMessage]);

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual(expect.objectContaining({
            turnId: 'turn_1',
            provider: 'codex',
            seqRange: { startSeqInclusive: 1, endSeqInclusive: 4 },
            repositoryCheckpoint: expect.objectContaining({
                contentConfidence: 'exact',
                attributionScope: 'shared_worktree',
            }),
        }));
        expect(result[0]?.files).toEqual([
            expect.objectContaining({
                filePath: 'src/app.ts',
                source: 'provider_native',
                provider: 'codex',
            }),
            expect.objectContaining({
                filePath: 'src/app.ts',
                source: 'scm_checkpoint',
                provider: 'scm:git',
                unifiedDiff: 'checkpoint diff',
            }),
        ]);
    });
});
