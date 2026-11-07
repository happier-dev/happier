import { describe, expect, it } from 'vitest';
import { createForgeReleaseV1Fixture } from '@happier-dev/triage-protocol/releases/testing/v1';
import { createGithubReleaseReadsV1 } from './reads.js';
import { reconcileReleasePageV1 } from './mapping.js';
import { PluginError } from '@happier-dev/plugin-sdk';

const page = (rows = [createForgeReleaseV1Fixture()]) => ({ rows, omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null });
describe('release producer semantic and request cost contracts', () => {
  it('keeps mounted invocation refusals intact with their codes and diagnostics', async () => {
    const input = { repository: createForgeReleaseV1Fixture().repository };
    const refusal = new PluginError({ code: 'unavailable', details: { layer: 'placement', phase: 'admission' },
      diagnostics: [{ code: 'plugin_action_origin_unavailable', severity: 'error' }] });
    const refused = createGithubReleaseReadsV1({ invoke: async () => { throw refusal; } });
    const failure = await refused.read('listReleases', input);
    expect(failure).toMatchObject({ kind: 'unavailable', failure: { class: 'unsupportedContract', code: 'plugin_action_origin_unavailable' } });
    refused.dispose();
  });

  it('keeps invocation refusals distinct from invalid results and intact provider failures', async () => {
    const input = { repository: createForgeReleaseV1Fixture().repository };
    const invalid = createGithubReleaseReadsV1({ invoke: async () => ({ kind: 'value', value: { rows: [] } }) });
    expect(await invalid.read('listReleases', input)).toMatchObject({ kind: 'unavailable',
      failure: { class: 'unsupportedContract', code: 'github_release_invalid_result', detail: expect.stringContaining('listReleases') } });
    const providerFailure = { kind: 'unavailable', failure: { class: 'permission', code: 'github_forbidden', detail: 'contents=read' } };
    const provider = createGithubReleaseReadsV1({ invoke: async () => providerFailure });
    expect(await provider.read('listReleases', input)).toEqual(providerFailure);
    invalid.dispose(); provider.dispose();
  });

  it('retains equal 200/304 values, changed rows and asset identity across a thousand releases and reorder', async () => {
    const baseline = page(Array.from({ length: 1000 }, (_, i) => createForgeReleaseV1Fixture({ releaseId: String(i + 1) })));
    const copy = () => page(baseline.rows.map(row => ({ ...row, assets: { ...row.assets, rows: [...row.assets.rows] } })));
    expect(reconcileReleasePageV1(baseline, copy())).toBe(baseline);
    const changed = copy();
    changed.rows[27] = { ...changed.rows[27]!, body: 'New notes' };
    const next = reconcileReleasePageV1(baseline, changed);
    expect(next.rows.filter((row, index) => row !== baseline.rows[index])).toHaveLength(1);
    expect(next.rows[27]?.assets).toBe(baseline.rows[27]?.assets);
    const reversed = reconcileReleasePageV1(baseline, { ...baseline, rows: [...baseline.rows].reverse() });
    expect(reversed.rows[0]).toBe(baseline.rows.at(-1));
  });

  it('shares latest demand, publishes no equal semantic values and recovers a cold 304 only once', async () => {
    let calls = 0;
    let status: 'value' | 'notModified' = 'value';
    const invoke = async () => { calls++; await Promise.resolve(); return status === 'value'
      ? { kind: 'value', value: createForgeReleaseV1Fixture(), validator: '"v"' } : { kind: 'notModified', validator: '"v"' }; };
    const reads = createGithubReleaseReadsV1({ invoke });
    const input = { repository: createForgeReleaseV1Fixture().repository, repositoryId: '42' };
    let publications = 0;
    const unsubscribe = reads.subscribeSemantic('readLatestRelease', input, () => publications++);
    const [a, b] = await Promise.all([reads.read('readLatestRelease', input), reads.read('readLatestRelease', input)]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    for (let i = 0; i < 3; i++) await reads.read('readLatestRelease', input);
    status = 'notModified';
    expect(await reads.read('readLatestRelease', input)).toBe(a);
    expect(publications).toBe(1);
    unsubscribe(); reads.dispose();
    const cold = createGithubReleaseReadsV1({ invoke });
    const before = calls;
    expect(await cold.read('readLatestRelease', input)).toMatchObject({ kind: 'unavailable' });
    expect(calls - before).toBe(2);
    cold.dispose();
  });

  it('retracts retained private values on authority retirement', async () => {
    const release = createForgeReleaseV1Fixture({ repositoryVisibility: 'private' });
    const reads = createGithubReleaseReadsV1({ invoke: async () => ({ kind: 'value', value: release }) });
    const input = { repository: release.repository, repositoryId: release.repositoryId };
    let notifications = 0;
    reads.subscribeSemantic('readLatestRelease', input, () => notifications++);
    await reads.read('readLatestRelease', input);
    reads.dispose();
    expect(reads.peek('readLatestRelease', input)).toBeUndefined();
    expect(notifications).toBe(2); // The admitted value, then its actual retirement.
    expect(await reads.read('readLatestRelease', input)).toMatchObject({ kind: 'unavailable' });
  });
});
