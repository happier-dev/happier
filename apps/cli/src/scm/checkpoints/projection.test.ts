import { describe, expect, it } from 'vitest';

import { buildRepositoryCheckpointRefs } from './refs';
import { projectRepositoryCheckpointTurnChangeSet } from './projection';
import type { RepositoryCheckpointDiffResult } from './types';

const refs = buildRepositoryCheckpointRefs({
    scopeId: 'session-1:/repo',
    messageId: 'message-1',
    turnId: 'turn-1',
});

describe('projectRepositoryCheckpointTurnChangeSet', () => {
    it('preserves provider evidence when checkpoint diff is unavailable', () => {
        const result = projectRepositoryCheckpointTurnChangeSet({
            providerTurnChangeSet: {
                sessionId: 'session-1',
                turnId: 'turn-1',
                seqRange: { startSeqInclusive: 1, endSeqInclusive: 3 },
                status: 'completed',
                provider: 'codex',
                derivedAt: 1,
                files: [{
                    filePath: 'src/provider.ts',
                    changeKind: 'modified',
                    source: 'provider_native',
                    confidence: 'strong',
                    provider: 'codex',
                }],
            },
            checkpointDiff: {
                success: false,
                kind: 'unavailable',
                reason: 'missing_final',
                error: 'Missing final checkpoint ref.',
                baseRefSource: 'turn_start',
                contentConfidence: 'unavailable',
                attributionScope: 'unknown',
                receipts: [],
            },
            scopeId: 'session-1:/repo',
            startRef: refs.turnStart?.ref,
            finalRef: refs.turnFinal?.ref,
        });

        expect(result.files).toEqual([
            expect.objectContaining({
                filePath: 'src/provider.ts',
                source: 'provider_native',
            }),
        ]);
        expect(result.repositoryCheckpoint).toMatchObject({
            contentConfidence: 'unavailable',
            attributionScope: 'unknown',
            unavailableReason: 'missing_final',
        });
    });

    it('adds checkpoint exact evidence while keeping provider-reported evidence selectable', () => {
        const checkpointDiff: RepositoryCheckpointDiffResult = {
            success: true,
            baseRef: refs.turnStart!,
            finalRef: refs.turnFinal!,
            baseRefSource: 'turn_start',
            contentConfidence: 'exact',
            attributionScope: 'shared_worktree',
            files: [{
                filePath: 'src/checkpoint.ts',
                changeKind: 'modified',
                source: 'scm_checkpoint',
                confidence: 'exact',
                provider: 'scm:git',
            }],
            receipts: [{ id: 'checkpoint.diff_computed', ref: refs.turnFinal!.ref }],
        };

        const result = projectRepositoryCheckpointTurnChangeSet({
            providerTurnChangeSet: {
                sessionId: 'session-1',
                turnId: 'turn-1',
                seqRange: { startSeqInclusive: 1, endSeqInclusive: 3 },
                status: 'completed',
                provider: 'codex',
                derivedAt: 1,
                files: [{
                    filePath: 'src/provider.ts',
                    changeKind: 'modified',
                    source: 'provider_native',
                    confidence: 'strong',
                    provider: 'codex',
                }],
            },
            checkpointDiff,
            scopeId: 'session-1:/repo',
            startRef: refs.turnStart?.ref,
            finalRef: refs.turnFinal?.ref,
        });

        expect(result.files).toEqual([
            expect.objectContaining({ filePath: 'src/provider.ts', source: 'provider_native' }),
            expect.objectContaining({ filePath: 'src/checkpoint.ts', source: 'scm_checkpoint' }),
        ]);
        expect(result.repositoryCheckpoint).toMatchObject({
            contentConfidence: 'exact',
            attributionScope: 'shared_worktree',
        });
    });
});
