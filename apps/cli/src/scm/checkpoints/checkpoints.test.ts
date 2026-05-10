import { beforeEach, describe, expect, it } from 'vitest';

import { resolveRepositoryCheckpointAvailability } from './availability';
import { pruneRepositoryCheckpointRefs } from './cleanup';
import { REPOSITORY_CHECKPOINT_RECEIPT_IDS } from './receipts';
import { buildRepositoryCheckpointRef, buildRepositoryCheckpointRefs } from './refs';
import { scmDiffSummaryCacheStore } from '@/agent/executionRuns/tasks/scmDiffSummary/cache/cacheStore';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('repository checkpoint primitives', () => {
    beforeEach(() => {
        scmDiffSummaryCacheStore.clear();
    });

    it('builds stable namespace-contained hidden refs with base64url scope encoding', () => {
        const refs = buildRepositoryCheckpointRefs({
            scopeId: 'session/one?with punctuation',
            messageId: 'message/1',
            turnId: 'turn-2',
        });

        expect(refs.encodedScope).toBe(Buffer.from('session/one?with punctuation', 'utf8').toString('base64url'));
        expect(refs.messageStart?.ref).toBe(`refs/happier/checkpoints/${refs.encodedScope}/message-start/message/1`);
        expect(refs.turnStart?.ref).toBe(`refs/happier/checkpoints/${refs.encodedScope}/turn-start/turn-2`);
        expect(refs.turnFinal?.ref).toBe(`refs/happier/checkpoints/${refs.encodedScope}/turn-final/turn-2`);
        expect(refs.messageStart?.ref).not.toContain('session/one');
    });

    it('rejects checkpoint ids that are not valid hidden Git ref suffixes', () => {
        for (const turnId of ['turn:2', '../turn', 'turn.lock', 'bad?name', '@{bad}', '.hidden']) {
            expect(() => buildRepositoryCheckpointRefs({ scopeId: 'session-safe', turnId })).toThrow(
                'checkpointId is not a safe checkpoint ref id',
            );
        }
    });

    it('rejects checkpoint phases outside the CHKPT-1 capture set', () => {
        expect(() => buildRepositoryCheckpointRefs({
            scopeId: 'session-safe',
            turnId: 'turn-1',
        }).turnFinal).not.toThrow();

        expect(() => buildRepositoryCheckpointRef({
            scopeId: 'session-safe',
            phase: 'custom' as never,
            checkpointId: 'turn-1',
        })).toThrow('checkpoint phase is not supported');
    });

    it('declares every FD-0051 checkpoint receipt id in one module', () => {
        expect(REPOSITORY_CHECKPOINT_RECEIPT_IDS).toEqual({
            captured: 'checkpoint.captured',
            aliased: 'checkpoint.aliased',
            finalized: 'checkpoint.finalized',
            diffComputed: 'checkpoint.diff_computed',
            cleanupPruned: 'checkpoint.cleanup_pruned',
        });
    });

    it('returns structured availability instead of throwing for unsupported repository states', () => {
        expect(resolveRepositoryCheckpointAvailability({
            context: {
                cwd: '/not-a-repo',
                projectKey: 'project:/not-a-repo',
                detection: { isRepo: false, rootPath: null, mode: null },
            },
        })).toMatchObject({ available: false, reason: 'not_repo' });

        expect(resolveRepositoryCheckpointAvailability({
            context: {
                cwd: '/repo',
                projectKey: 'project:/repo',
                detection: { isRepo: true, rootPath: '/repo', mode: '.sl' },
            },
        })).toMatchObject({ available: false, reason: 'unsupported_scm' });

        expect(resolveRepositoryCheckpointAvailability({
            context: {
                cwd: '/repo',
                projectKey: 'project:/repo',
                detection: { isRepo: true, rootPath: null, mode: '.git' },
            },
        })).toMatchObject({ available: false, reason: 'missing_repo_root' });

        expect(resolveRepositoryCheckpointAvailability({
            context: {
                cwd: '/repo',
                projectKey: 'project:/repo',
                detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
            },
        })).toMatchObject({ available: true, repoRoot: '/repo' });
    });

    it('prunes only refs inside the requested checkpoint scope and retention window', async () => {
        const nowMs = Date.UTC(2026, 4, 4);
        const scopeId = 'session-cleanup';
        const currentRefs = buildRepositoryCheckpointRefs({ scopeId, turnId: 'current' });
        const oldRefs = buildRepositoryCheckpointRefs({ scopeId, turnId: 'old' });
        const oldMessageRef = buildRepositoryCheckpointRefs({ scopeId, messageId: 'message-old' }).messageStart;
        const otherScopeRef = buildRepositoryCheckpointRefs({ scopeId: 'other-session', turnId: 'old' }).turnFinal;
        const deletedRefs: string[] = [];

        const result = await pruneRepositoryCheckpointRefs({
            scopeId,
            refs: [
                { ref: currentRefs.turnFinal!.ref, committedAtMs: nowMs },
                { ref: currentRefs.turnStart!.ref, committedAtMs: nowMs },
                { ref: oldRefs.turnFinal!.ref, committedAtMs: nowMs - (31 * DAY_MS) },
                { ref: oldRefs.turnStart!.ref, committedAtMs: nowMs - (31 * DAY_MS) },
                { ref: oldMessageRef!.ref, committedAtMs: nowMs - (31 * DAY_MS) },
                { ref: otherScopeRef!.ref, committedAtMs: nowMs - (31 * DAY_MS) },
                { ref: 'refs/heads/user-branch', committedAtMs: nowMs - (31 * DAY_MS) },
            ],
            nowMs,
            maxAgeMs: 30 * DAY_MS,
            maxFinalizedTurns: 100,
            deleteRef: async (ref) => {
                deletedRefs.push(ref);
            },
        });

        expect(result.success).toBe(true);
        expect(deletedRefs).toEqual([
            oldRefs.turnFinal!.ref,
            oldRefs.turnStart!.ref,
            oldMessageRef!.ref,
        ]);
        expect(result.receipts).toEqual([{
            id: 'checkpoint.cleanup_pruned',
            prunedCount: 3,
            refs: deletedRefs,
        }]);
    });

    it('applies cleanup receipts to dependent diff-summary cache entries before returning', async () => {
        const nowMs = Date.UTC(2026, 4, 4);
        const scopeId = 'session-cleanup';
        const oldRefs = buildRepositoryCheckpointRefs({ scopeId, turnId: 'old' });

        scmDiffSummaryCacheStore.set({
            keyInput: {
                source: {
                    kind: 'turnCheckpoint',
                    checkpointReceiptId: 'checkpoint.diff_computed',
                    checkpointRef: oldRefs.turnFinal!.ref,
                },
                summarySchemaVersion: 1,
                resolvedSelector: { catalogId: 'profile:fast-summary' },
            },
            checkpointRef: oldRefs.turnFinal!.ref,
            value: {
                success: true,
                summaryMarkdown: '## Summary\n\nOld checkpoint.',
                sourceKey: 'turnCheckpoint:old:checkpoint.diff_computed',
                checkpointReceiptId: 'checkpoint.diff_computed',
                metadata: {
                    source: { kind: 'turnCheckpoint' },
                    sourceKey: 'turnCheckpoint:old:checkpoint.diff_computed',
                    checkpointReceiptId: 'checkpoint.diff_computed',
                },
            },
        });

        await pruneRepositoryCheckpointRefs({
            scopeId,
            refs: [
                { ref: oldRefs.turnFinal!.ref, committedAtMs: nowMs - (31 * DAY_MS) },
            ],
            nowMs,
            maxAgeMs: 30 * DAY_MS,
            maxFinalizedTurns: 100,
            deleteRef: async () => {},
        });

        expect(scmDiffSummaryCacheStore.get({
            source: {
                kind: 'turnCheckpoint',
                checkpointReceiptId: 'checkpoint.diff_computed',
                checkpointRef: oldRefs.turnFinal!.ref,
            },
            summarySchemaVersion: 1,
            resolvedSelector: { catalogId: 'profile:fast-summary' },
        })).toBeNull();
    });
});
