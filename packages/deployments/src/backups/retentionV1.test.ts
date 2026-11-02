import { describe, expect, it } from 'vitest';
import * as owner from './retentionV1.js';
const buildResticRetentionArgsV1 = (...args: unknown[]) => {
    const implementation = Reflect.get(owner, 'buildResticRetentionArgsV1');
    expect(implementation, 'buildResticRetentionArgsV1 is the required owner behavior').toBeTypeOf('function');
    return implementation(...args);
};
const selectResticForgetCandidatesV1 = (...args: unknown[]) => {
    const implementation = Reflect.get(owner, 'selectResticForgetCandidatesV1');
    expect(implementation, 'selectResticForgetCandidatesV1 is the required owner behavior').toBeTypeOf('function');
    return implementation(...args);
};

const snapshot = (id: string, hostname = 'happier-env-env-one', tags = ['happier', 'env:env-one', 'kind:dump', 'src:main']) =>
    ({ id: id.repeat(64), tree: 'f'.repeat(64), hostname, tags, paths: ['/db.dump'], time: '2026-10-28T16:00:00Z' });

describe('restic-owned retention', () => {
    it('uses only person-selected positive keep flags and represents Keep everything as an explicit no-op', () => {
        expect(buildResticRetentionArgsV1({ kind: 'keepEverything' })).toEqual([]);
        expect(buildResticRetentionArgsV1({ kind: 'keep', monthly: 3, last: 2 })).toEqual(['--keep-last', '2', '--keep-monthly', '3']);
    });

    it('interprets native dry-run policy decisions and excludes exact protected recovery points', () => {
        expect(selectResticForgetCandidatesV1({ stdout: '', exitCode: 0, environmentId: 'env-one', protectedSnapshotIds: [] })).toEqual([]);
        expect(selectResticForgetCandidatesV1({ stdout: JSON.stringify([{ remove: null }]), exitCode: 0, environmentId: 'env-one', protectedSnapshotIds: [] })).toEqual([]);
        const stdout = JSON.stringify([{ host: 'happier-env-env-one', tags: snapshot('a').tags,
            keep: [snapshot('a')], remove: [snapshot('b'), snapshot('b'), snapshot('c'), snapshot('c')] }]);
        expect(selectResticForgetCandidatesV1({ stdout, exitCode: 0, environmentId: 'env-one', protectedSnapshotIds: ['b'.repeat(64)] }))
            .toEqual(['c'.repeat(64)]);
    });

    it('refuses failed native policy and any foreign/ambiguous deletion candidate', () => {
        expect(Reflect.get(owner, 'selectResticForgetCandidatesV1')).toBeTypeOf('function');
        for (const remove of [[snapshot('a', 'foreign')], [snapshot('a', undefined, ['env:env-one'])],
            [{ ...snapshot('a'), id: 'latest' }], [snapshot('a'), snapshot('a', 'foreign')]]) {
            const stdout = JSON.stringify([{ host: 'happier-env-env-one', tags: snapshot('a').tags, keep: [], remove }]);
            expect(() => selectResticForgetCandidatesV1({ stdout, exitCode: 0, environmentId: 'env-one', protectedSnapshotIds: [] })).toThrow();
        }
        expect(() => selectResticForgetCandidatesV1({ stdout: '[]', exitCode: 1, environmentId: 'env-one', protectedSnapshotIds: [] })).toThrow();
    });
});
