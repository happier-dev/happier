import { describe, expect, it } from 'vitest';

import type { TurnChangeSet } from '@happier-dev/protocol';

import { buildTurnChangeSetDiffInput } from './buildTurnChangeSetDiffInput';

function makeTurnChangeSet(file: TurnChangeSet['files'][number]): TurnChangeSet {
    return {
        sessionId: 'session_1',
        turnId: 'turn_1',
        seqRange: { startSeqInclusive: 1, endSeqInclusive: 4 },
        status: 'completed',
        provider: 'codex',
        derivedAt: 1_700_000_000_000,
        files: [file],
    };
}

describe('buildTurnChangeSetDiffInput', () => {
    it('bounds oversized file payloads and keeps metadata for on-demand retrieval', () => {
        const input = buildTurnChangeSetDiffInput({
            turnChangeSet: makeTurnChangeSet({
                filePath: 'src/huge.ts',
                changeKind: 'modified',
                oldText: `${'old\n'.repeat(100)}`,
                newText: `${'new\n'.repeat(100)}`,
                source: 'scm_checkpoint',
                confidence: 'exact',
                provider: 'scm:git',
            }),
            protocol: 'codex',
            rawToolName: 'RepositoryCheckpointDiff',
            fileBudgetBytes: 16,
            turnBudgetBytes: 16,
        });

        expect(input).toEqual(expect.objectContaining({
            files: [
                expect.objectContaining({
                    file_path: 'src/huge.ts',
                    change_kind: 'modified',
                    source: 'scm_checkpoint',
                    confidence: 'best_effort',
                    provider: 'scm:git',
                    truncated: true,
                    stats: expect.objectContaining({
                        oldTextBytes: expect.any(Number),
                        newTextBytes: expect.any(Number),
                    }),
                }),
            ],
            _happier: expect.objectContaining({
                confidence: 'best_effort',
                turnDiffTruncatedFileCount: 1,
            }),
        }));

        const file = (input.files as Array<Record<string, unknown>>)[0];
        expect(file.oldText).toBeUndefined();
        expect(file.newText).toBeUndefined();
        expect(file.unified_diff).toBeUndefined();
    });

    it('charges retained placeholder text against the shared turn budget', () => {
        const base = makeTurnChangeSet({
            filePath: 'src/first.ts',
            changeKind: 'modified',
            unifiedDiff: 'x'.repeat(1_000),
            source: 'provider_tool',
            confidence: 'exact',
            provider: 'codex',
        });
        const input = buildTurnChangeSetDiffInput({
            turnChangeSet: {
                ...base,
                files: [
                    base.files[0]!,
                    { ...base.files[0]!, filePath: 'src/second.ts', unifiedDiff: 'y'.repeat(1_000) },
                ],
            },
            protocol: 'codex',
            rawToolName: 'apply_patch',
            fileBudgetBytes: 100,
            turnBudgetBytes: 100,
        });

        const files = input.files as Array<{ unified_diff?: string; truncated?: true; stats?: unknown }>;
        const retainedBytes = files.reduce((total, file) => total + Buffer.byteLength(file.unified_diff ?? '', 'utf8'), 0);
        expect(retainedBytes).toBeLessThanOrEqual(100);
        expect(files).toEqual([
            expect.objectContaining({ truncated: true, stats: expect.any(Object) }),
            expect.objectContaining({ truncated: true, stats: expect.any(Object) }),
        ]);
        expect(files.filter((file) => file.unified_diff === undefined).length).toBeGreaterThan(0);
    });

    it('marks a bounded partial text diff as truncated and no longer exact', () => {
        const input = buildTurnChangeSetDiffInput({
            turnChangeSet: makeTurnChangeSet({
                filePath: 'src/partial.ts',
                changeKind: 'modified',
                oldText: `${'same\n'.repeat(20)}old\n${'tail\n'.repeat(20)}`,
                newText: `${'same\n'.repeat(20)}new\n${'tail\n'.repeat(20)}`,
                source: 'provider_tool',
                confidence: 'exact',
                provider: 'codex',
            }),
            protocol: 'codex',
            rawToolName: 'apply_patch',
            fileBudgetBytes: 256,
            turnBudgetBytes: 256,
        });

        expect(input).toEqual(expect.objectContaining({
            files: [expect.objectContaining({
                file_path: 'src/partial.ts',
                confidence: 'best_effort',
                truncated: true,
                stats: expect.objectContaining({
                    oldTextBytes: expect.any(Number),
                    newTextBytes: expect.any(Number),
                }),
            })],
            _happier: expect.objectContaining({ confidence: 'best_effort', turnDiffTruncatedFileCount: 1 }),
        }));
        const [file] = input.files as Array<{ unified_diff?: string; oldText?: string; newText?: string }>;
        expect(file?.unified_diff).toContain('-old\n+new');
        expect(Buffer.byteLength(file?.unified_diff ?? '', 'utf8')).toBeLessThanOrEqual(256);
        expect(file?.oldText).toBeUndefined();
        expect(file?.newText).toBeUndefined();
    });
});
