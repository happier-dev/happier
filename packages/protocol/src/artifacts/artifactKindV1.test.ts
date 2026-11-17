import { describe, expect, it } from 'vitest';
import { deriveArtifactCoarseKindV1, deriveArtifactKindV1, deriveArtifactStoredKindV1, tryDeriveArtifactStoredKindV1, decodeArtifactKindV1, ArtifactStoredKindV1Schema,
  frameArtifactKindWriteBatchesV1, ArtifactKindWriteBatchInputV1Schema, ArtifactKindWriteBatchResponseV1Schema,
  ArtifactKindCoverageV1Schema, deriveArtifactKindWriteItemV1, writeArtifactKindBatchesV1,
  deriveArtifactTeamResourceKindV1 } from './artifactKindV1.js';

describe('Team Artifact resource buckets', () => {
  it('partitions indexed kinds and actual Source context documents without dropping legacy or contributed rows', () => {
    const bucket = (kind: string | null, sourceContextDocument = false) =>
      deriveArtifactTeamResourceKindV1({ storedKind: kind, sourceContextDocument });
    expect(bucket('v1:prompt:prompt_doc.v2', true)).toBe('projectDocuments');
    expect(bucket('v1:prompt:prompt_doc.v2')).toBe('prompts');
    expect(bucket('v1:skill:prompt_bundle.v2', true)).toBe('prompts');
    expect(bucket('v1:other:workflow-definition.v1', true)).toBe('workflows');
    for (const kind of [null, 'prompt', 'other', 'v1:other:memory_doc.v1',
      'v1:other:contributed.test.v1', 'v1:widget_definition:widget-definition.v1']) {
      expect(bucket(kind, true)).toBe('otherArtifacts');
    }
  });
});

describe('Artifact coarse kind', () => {
  it('indexes library families without disclosing private header fields', () => {
    expect(deriveArtifactCoarseKindV1({ kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1', title: 'private' })).toBe('skill');
    expect(deriveArtifactCoarseKindV1({ kind: 'prompt_bundle.v2', bundleSchemaId: 'generic.v1' })).toBe('prompt');
    expect(deriveArtifactCoarseKindV1({ kind: 'prompt_doc.v2' })).toBe('prompt');
    expect(deriveArtifactCoarseKindV1({ kind: 'plugin.ui.archive' })).toBe('plugin_ui');
    expect(deriveArtifactCoarseKindV1({ kind: 'work-board.v1', v: 1, title: 'private' })).toBe('work_board');
    expect(deriveArtifactCoarseKindV1({ kind: 'widget-area-layout.v1', title: 'private' })).toBe('widget_area_layout');
    expect(deriveArtifactCoarseKindV1({ kind: 'widget-definition.v1', title: 'private' })).toBe('widget_definition');
    expect(deriveArtifactCoarseKindV1({ kind: 'widget-layout-fragment.v1', title: 'private' })).toBe('widget_layout_fragment');
    expect(deriveArtifactCoarseKindV1({ kind: 'memory_doc.v1' })).toBe('other');
    expect(deriveArtifactCoarseKindV1({ kind: 'future.unknown' })).toBe('other');
    expect(deriveArtifactCoarseKindV1({})).toBe('other');
  });

  it('retains malformed skill identity for the content reader to refuse truthfully', () => {
    expect(deriveArtifactCoarseKindV1({ kind: 'broken', bundleSchemaId: 'skills.skill_md_v1' })).toBe('skill');
  });
});
describe('Artifact exact kind hints', () => {
  it('omits only an unrepresentable optional hint while preserving strict explicit writer admission', () => {
    const header = { kind: 'x'.repeat(184) };
    expect(tryDeriveArtifactStoredKindV1(header)).toBeUndefined();
    expect(() => deriveArtifactStoredKindV1(header)).toThrow(RangeError);
    expect(ArtifactStoredKindV1Schema.safeParse(`v1:other:${header.kind}`).success).toBe(false);
    expect(tryDeriveArtifactStoredKindV1({})).toBe('v1:other:');
    expect(tryDeriveArtifactStoredKindV1({ kind: 'workflow-definition.v1' })).toBe('v1:other:workflow-definition.v1');
  });
  it('distinguishes derived complete coverage from partial positive legacy demand', () => {
    expect(ArtifactKindCoverageV1Schema.parse({ status: 'complete', unclassifiedCount: 0 })).toEqual({ status: 'complete', unclassifiedCount: 0 });
    expect(ArtifactKindCoverageV1Schema.parse({ status: 'partial', unclassifiedCount: 35000, reason: 'unclassified_legacy_rows' }).unclassifiedCount).toBe(35000);
    for (const coverage of [{ status: 'complete', unclassifiedCount: 1 },
      { status: 'partial', unclassifiedCount: 0, reason: 'unclassified_legacy_rows' },
      { status: 'partial', unclassifiedCount: 1.5, reason: 'unclassified_legacy_rows' },
      { status: 'partial', unclassifiedCount: 1, reason: 'unclassified_legacy_rows', header: 'private' }]) {
      expect(ArtifactKindCoverageV1Schema.safeParse(coverage).success).toBe(false);
    }
  });
  it('frames real inventory demand in one byte-budgeted batch without changing retained identities or ordered outcomes', () => {
    const items = Array.from({ length: 35000 }, (_, index) => ({ artifactId: `retained/${index}`,
      kind: 'v1:other:account_notice.v1', expectedHeaderVersion: 1 }));
    const framed = frameArtifactKindWriteBatchesV1(items);
    expect(framed).toHaveLength(1);
    expect(ArtifactKindWriteBatchInputV1Schema.parse(framed[0]).items).toEqual(items);
    expect(frameArtifactKindWriteBatchesV1([])).toEqual([]);
    expect(ArtifactKindWriteBatchResponseV1Schema.parse({ items: [
      { artifactId: 'retained/1', success: true },
      { artifactId: 'retained/2', success: false, error: 'version-mismatch' },
    ] }).items.map(item => item.artifactId)).toEqual(['retained/1', 'retained/2']);
    expect(ArtifactKindWriteBatchResponseV1Schema.safeParse({ items: [
      { artifactId: 'retained/2', success: false, error: 'version-mismatch', currentHeader: 'private' },
    ] }).success).toBe(false);
  });
  it('labels a legacy row once: an already-classified approval row without a known state is not rewritten', () => {
    const approval = { kind: 'approval_request.v1', approvalStatus: 'executed', sessionId: 's1' };
    expect(deriveArtifactKindWriteItemV1({ artifactId: 'a', header: { kind: 'prompt_doc.v2' }, headerVersion: 3 }))
      .toEqual({ artifactId: 'a', kind: 'v1:prompt:prompt_doc.v2', expectedHeaderVersion: 3 });
    expect(deriveArtifactKindWriteItemV1({ artifactId: 'a', header: approval, headerVersion: 1, storedKindClassified: true }))
      .toMatchObject({ approvalState: 'executed', approvalSessionId: 's1' });
    expect(deriveArtifactKindWriteItemV1({ artifactId: 'a', header: { kind: 'approval_request.v1' }, headerVersion: 1, storedKindClassified: true })).toBeUndefined();
    expect(deriveArtifactKindWriteItemV1({ artifactId: 'a', header: { kind: 'approval_request.v1' }, headerVersion: 1 })).toBeDefined();
  });
  it('writes framed labels in order and stops on a refused or malformed batch', async () => {
    const items = [{ artifactId: 'a', kind: 'v1:other:', expectedHeaderVersion: 1 }];
    const answer = (data: unknown, status = 200) => async () => ({ status, data });
    expect(await writeArtifactKindBatchesV1([], answer(null))).toBe('written');
    expect(await writeArtifactKindBatchesV1(items, answer({ items: [{ artifactId: 'a', success: true }] }))).toBe('written');
    expect(await writeArtifactKindBatchesV1(items, answer({ items: [{ artifactId: 'a', success: false, error: 'version-mismatch' }] }))).toBe('write_refused');
    expect(await writeArtifactKindBatchesV1(items, answer({ items: [] }))).toBe('write_unavailable');
    expect(await writeArtifactKindBatchesV1(items, answer({ error: 'not_found' }, 404))).toBe('write_unavailable');
  });
  it('keeps exact header kinds independent of coarse bundle priority and admits legacy writes', () => {
    expect(deriveArtifactKindV1({ kind: 'prompt_bundle.v2', bundleSchemaId: 'skills.skill_md_v1', title: 'Private' }))
      .toEqual({ kind: 'skill', kindHint: 'prompt_bundle.v2' });
    expect(deriveArtifactStoredKindV1({ kind: 'account_notice.v1' })).toBe('v1:other:account_notice.v1');
    expect(decodeArtifactKindV1('v1:other:account_notice.v1')).toEqual({ kind: 'other', kindHint: 'account_notice.v1', classified: true });
    expect(decodeArtifactKindV1('v1:other:')).toEqual({ kind: 'other', kindHint: null, classified: true });
    expect(decodeArtifactKindV1('other')).toEqual({ kind: 'other', kindHint: null, classified: false });
    expect(decodeArtifactKindV1(null)).toEqual({ kind: null, kindHint: null, classified: false });
    expect(ArtifactStoredKindV1Schema.safeParse('v1:unknown:role.v1').success).toBe(false);
    expect(ArtifactStoredKindV1Schema.safeParse('other').success).toBe(true);
    expect(decodeArtifactKindV1('v1:other:vendor:role.v1').kindHint).toBe('vendor:role.v1');
    expect(deriveArtifactStoredKindV1({ kind: 'x'.repeat(182) })).toHaveLength(191);
    expect(() => deriveArtifactStoredKindV1({ kind: 'x'.repeat(183) })).toThrow(RangeError);
    expect(ArtifactStoredKindV1Schema.safeParse(`v1:other:${'x'.repeat(183)}`).success).toBe(false);
    expect(ArtifactStoredKindV1Schema.safeParse(deriveArtifactStoredKindV1({ kind: '💡'.repeat(182) })).success).toBe(true);
  });
});
