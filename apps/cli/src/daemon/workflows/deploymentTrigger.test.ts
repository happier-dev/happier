import { describe, expect, it } from 'vitest';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';
import { shouldDeployPushRange, summarizeDeploymentPushCommitMessages, type DeploymentPushRangeEvidence } from './deploymentPushFilter';

const range = { kind: 'revisionRange' as const, baseOid: 'a'.repeat(40), headOid: 'c'.repeat(40) };
function evidence(paths: readonly string[], messages = ['ordinary change']): DeploymentPushRangeEvidence {
  return { range, comparison: ScmComparisonSchema.parse({ id: 'comparison', source: range,
    repository: { rootPath: '/repo' }, endpoints: { before: range.baseOid, after: range.headOid }, inventory: { state: 'complete', reasons: [],
      files: paths.map(path => ({ path, changeKind: 'modified', binary: false, generated: false, lockfile: false,
        evidence: { state: 'available', unifiedDiff: '' }, occurrences: [] })) } }),
    history: { complete: true, ...range, totalCount: messages.length, ...summarizeDeploymentPushCommitMessages(messages) } };
}

describe('controller push deployment filters', () => {
  it('uses the exact net file inventory with ordered exclusions and last matching rule wins', () => {
    const input = evidence(['app/private/keep.ts']);
    expect(shouldDeployPushRange({ ...input, paths: ['app/**', '!app/private/**'] })).toBe(false);
    expect(shouldDeployPushRange({ ...input, paths: ['app/**', '!app/private/**', 'app/private/keep.ts'] })).toBe(true);
    expect(shouldDeployPushRange({ ...evidence(['docs/guide.md']), paths: ['app/**'] })).toBe(false);
    expect(shouldDeployPushRange({ ...evidence(['app/main.ts']), paths: ['!docs/**'] })).toBe(true);
  });

  it('suppresses only a complete exact range whose every commit carries a skip marker', () => {
    expect(shouldDeployPushRange(evidence(['app/main.ts'], ['one [skip ci]', 'two [skip cd]']))).toBe(false);
    expect(shouldDeployPushRange(evidence(['app/main.ts'], ['one [skip ci]', 'ordinary change']))).toBe(true);
    expect(shouldDeployPushRange(evidence(['app/main.ts'], []))).toBe(true);
  });

  it('deploys when file or commit evidence is unavailable, partial, shallow or belongs to another range', () => {
    const input = evidence(['docs/guide.md'], ['[skip ci]']);
    for (const altered of [
      { ...input, comparison: null },
      { ...input, comparison: { ...input.comparison!, inventory: { ...input.comparison!.inventory, state: 'incomplete' as const, reasons: ['partial'] } } },
      { ...input, comparison: { ...input.comparison!, inventory: { ...input.comparison!.inventory,
        files: input.comparison!.inventory.files.map(file => ({ ...file, evidence: { state: 'unavailable' as const, reason: 'partial' } })) } } },
      { ...input, comparison: { ...input.comparison!, endpoints: { before: range.baseOid, after: 'd'.repeat(40) } } },
      { ...input, history: null },
      { ...input, history: { ...input.history!, complete: false } },
      { ...input, history: { ...input.history!, headOid: 'd'.repeat(40) } },
      { ...input, history: { ...input.history!, totalCount: input.history!.commitCount + 1 } },
    ]) expect(shouldDeployPushRange({ ...altered, paths: ['app/**'] })).toBe(true);
  });

  it('includes both sides of a rename when deciding affected paths', () => {
    const input = evidence(['docs/new.md']);
    const file = { ...input.comparison!.inventory.files[0]!, previousPath: 'app/old.ts', changeKind: 'renamed' };
    expect(shouldDeployPushRange({ ...input, comparison: { ...input.comparison!, inventory: {
      ...input.comparison!.inventory, files: [file] } }, paths: ['app/**'] })).toBe(true);
  });
});
