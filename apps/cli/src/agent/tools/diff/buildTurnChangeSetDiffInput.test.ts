import { describe, expect, it } from 'vitest';

import type { TurnChangeSet } from '@happier-dev/protocol';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';

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
    it.each(['file', 'turn'] as const)('keeps concurrent hosted Session %s budgets independent of the host', async limitingBudget => {
        const keys = ['HAPPIER_TURN_DIFF_FILE_BUDGET_BYTES', 'HAPPIER_TURN_DIFF_TURN_BUDGET_BYTES'] as const;
        const previous = keys.map(key => process.env[key]);
        for (const key of keys) process.env[key] = '8192';
        const diff = 'changed line\n'.repeat(100);
        const params = {
            turnChangeSet: makeTurnChangeSet({ filePath: 'src/large.ts', changeKind: 'modified',
                unifiedDiff: diff, source: 'provider_tool', confidence: 'exact', provider: 'codex' }),
            source: { protocol: 'native', agent: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            rawToolName: 'apply_patch',
        } as const;
        try {
            const inputs = await Promise.all([true, false].map(limited => runAddedHostedSession({
                environment: {
                    NODE_ENV: 'test',
                    HAPPIER_TURN_DIFF_FILE_BUDGET_BYTES: limited && limitingBudget === 'file' ? '16' : '16384',
                    HAPPIER_TURN_DIFF_TURN_BUDGET_BYTES: limited && limitingBudget === 'turn' ? '16' : '32768',
                },
                workingDirectory: limited ? '/limited' : '/preserved', end: () => {},
            }, async () => {
                await Promise.resolve();
                const scoped = buildTurnChangeSetDiffInput(params);
                const explicit = buildTurnChangeSetDiffInput({ ...params, fileBudgetBytes: 8192, turnBudgetBytes: 8192 });
                return { scoped, explicit };
            })));
            expect(inputs[0]?.scoped).toMatchObject({ files: [{ truncated: true }],
                _happier: { turnDiffTruncatedFileCount: 1 } });
            expect(inputs[0]?.scoped.files).not.toEqual([expect.objectContaining({ unified_diff: diff })]);
            expect(inputs[1]?.scoped.files).toEqual([expect.objectContaining({ unified_diff: diff, confidence: 'exact' })]);
            for (const input of inputs) {
                expect(input.explicit.files).toEqual([expect.objectContaining({ unified_diff: diff, confidence: 'exact' })]);
            }
        } finally {
            keys.forEach((key, index) => {
                if (previous[index] === undefined) delete process.env[key];
                else process.env[key] = previous[index];
            });
        }
    });

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
            source: { protocol: 'native', agent: { pluginId: 'happier.agent.codex', localId: 'codex' } },
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
            source: { protocol: 'native', agent: { pluginId: 'happier.agent.codex', localId: 'codex' } },
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
            source: { protocol: 'native', agent: { pluginId: 'happier.agent.codex', localId: 'codex' } },
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
