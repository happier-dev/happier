import { describe, expect, it } from 'vitest';

import { TurnChangeSetCollector } from './turnChangeSetCollector';

describe('TurnChangeSetCollector', () => {
    it('coalesces repeated file updates into one turn change set', () => {
        const collector = new TurnChangeSetCollector({ provider: 'codex' });
        collector.beginTurn();

        collector.observeTextDiff({
            filePath: 'src/app.ts',
            oldText: 'a\n',
            newText: 'b\n',
            source: 'provider_native',
            confidence: 'exact',
        });
        collector.observeTextDiff({
            filePath: 'src/app.ts',
            oldText: 'b\n',
            newText: 'c\n',
            source: 'provider_native',
            confidence: 'exact',
        });

        const turnChangeSet = collector.flushTurn({
            sessionId: 'session_1',
            turnId: 'turn_1',
            seqRange: { startSeqInclusive: 1, endSeqInclusive: 4 },
            status: 'completed',
        });

        expect(turnChangeSet).toEqual(expect.objectContaining({
            sessionId: 'session_1',
            turnId: 'turn_1',
            files: [
                expect.objectContaining({
                    filePath: 'src/app.ts',
                    oldText: 'a\n',
                    newText: 'c\n',
                    source: 'provider_native',
                    confidence: 'exact',
                    provider: 'codex',
                }),
            ],
        }));
    });

    it('derives per-file change evidence from unified diff snapshots', () => {
        const collector = new TurnChangeSetCollector({ provider: 'codex', snapshotUnifiedDiff: true });
        collector.beginTurn();

        collector.observeUnifiedDiffSnapshot({
            unifiedDiff: [
                'diff --git a/src/a.ts b/src/a.ts',
                '--- a/src/a.ts',
                '+++ b/src/a.ts',
                '@@ -1 +1 @@',
                '-old',
                '+new',
                'diff --git a/src/b.ts b/src/b.ts',
                '--- a/src/b.ts',
                '+++ b/src/b.ts',
                '@@ -1 +1 @@',
                '-before',
                '+after',
            ].join('\n'),
            source: 'provider_native',
            confidence: 'exact',
        });

        const turnChangeSet = collector.flushTurn({
            sessionId: 'session_1',
            turnId: 'turn_1',
            seqRange: { startSeqInclusive: 1, endSeqInclusive: 4 },
            status: 'completed',
        });

        expect(turnChangeSet?.files).toEqual([
            expect.objectContaining({ filePath: 'src/a.ts', unifiedDiff: expect.stringContaining('src/a.ts') }),
            expect.objectContaining({ filePath: 'src/b.ts', unifiedDiff: expect.stringContaining('src/b.ts') }),
        ]);
    });
});
