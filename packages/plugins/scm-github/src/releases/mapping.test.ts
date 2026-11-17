import { describe, expect, it } from 'vitest';
import { createForgeReleaseV1Fixture } from '@happier-dev/triage-protocol/releases/testing/v1';
import type { ForgeReleaseAssetPageV1 } from '@happier-dev/triage-protocol/releases/v1';
import { projectGithubReleaseAssetFactsV1 } from './mapping.js';

describe('release asset summary facts', () => {
  const complete = createForgeReleaseV1Fixture({ assets: {
    rows: [{ assetId: '9', name: 'app.zip', label: null, contentType: 'application/zip', size: 4, state: 'uploaded', downloadCount: 12 }],
    omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null,
  } }).assets;

  it('distinguishes a real zero from incomplete data and unknown download counts', () => {
    expect(projectGithubReleaseAssetFactsV1({ ...complete, rows: [] })).toEqual({ assetCount: 0, downloadCount: 0 });
    expect(projectGithubReleaseAssetFactsV1(complete)).toEqual({ assetCount: 1, downloadCount: 12 });
    const { downloadCount: _downloadCount, ...unknown } = complete.rows[0]!;
    expect(projectGithubReleaseAssetFactsV1({ ...complete, rows: [unknown] })).toEqual({ assetCount: 1, downloadCount: null });
    const incomplete: readonly ForgeReleaseAssetPageV1[] = [
      { ...complete, rows: [], incomplete: 'pagination' },
      { ...complete, incomplete: 'pagination' },
      { ...complete, omittedRowCount: 1 },
      { ...complete, projectionTruncated: true },
      { ...complete, continuation: 'next-assets' },
      { ...complete, rows: [...complete.rows, ...complete.rows] },
    ];
    for (const assets of incomplete) {
      expect(projectGithubReleaseAssetFactsV1(assets)).toEqual({ assetCount: null, downloadCount: null });
    }
  });
});
