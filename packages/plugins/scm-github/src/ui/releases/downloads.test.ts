import { describe, expect, it } from 'vitest';
import type { FileDownloadResultV1 } from '@happier-dev/plugin-sdk/protocol';
import { createForgeReleaseV1Fixture } from '@happier-dev/triage-protocol/releases/testing/v1';
import { createReleaseAssetDownloadsV1 } from './downloads.js';
import { GITHUB_RELEASE_ACTION_REFS_V1 } from './model.js';

describe('one release asset download result binding', () => {
  it.each([
    { success: true, status: 'completed', transferId: 't', destinationId: 'd', name: 'asset', sizeBytes: 4, sha256: 'a'.repeat(64) },
    { success: false, status: 'failed', error: 'Destination read-only', errorCode: 'EACCES' },
    { success: false, status: 'cancelled', error: 'Picker dismissed' },
    { success: false, status: 'unknown', error: 'Receiver settlement lost', errorCode: 'response_lost' },
  ] satisfies FileDownloadResultV1[])('retains the canonical $status result and only dispatches on intent', async result => {
    const release = createForgeReleaseV1Fixture();
    const asset = { assetId: '17', name: 'asset', label: null, contentType: 'application/octet-stream', size: 4, state: 'uploaded' };
    const requests: unknown[] = [];
    const downloads = createReleaseAssetDownloadsV1({ downloadFile: async request => { requests.push(request); return result; } });
    let notifications = 0;
    downloads.subscribe(() => { notifications++; });
    expect(requests).toHaveLength(0);
    await downloads.download(release, asset);
    const row = downloads.getSnapshot().get(asset.assetId)!;
    expect(row.result).toBe(result);
    expect(row.pending).toBe(false);
    expect(row.operation.kind).toBe(result.status === 'unknown' ? 'uncertain-write-outcome' : result.status === 'failed' ? 'failure' : 'ready');
    expect(notifications).toBe(2);
    expect(requests).toEqual([{ action: GITHUB_RELEASE_ACTION_REFS_V1.downloadAsset, input: {
      repository: release.repository, repositoryId: release.repositoryId, releaseId: release.releaseId, assetId: asset.assetId,
    } }]);
    if (result.status === 'unknown') {
      await downloads.download(release, asset);
      expect(requests).toHaveLength(1);
      expect(downloads.getSnapshot().get(asset.assetId)).toBe(row);
      expect(notifications).toBe(2);
    }
    downloads.dispose();
  });

  it('does not claim an accepted receipt saved bytes, overlap requests, or publish after retirement', async () => {
    const release = createForgeReleaseV1Fixture();
    const asset = { assetId: '17', name: 'asset', label: null, contentType: 'application/octet-stream', size: 4, state: 'uploaded' };
    const receipt: FileDownloadResultV1 = { success: true, status: 'accepted', operationId: 'o', destinationId: 'd', prepared: {
      transferId: 't', name: 'asset', sizeBytes: 4, manifestHash: `sha256:${'a'.repeat(64)}`, expiresAt: 10, endpointCandidates: [],
    } };
    let settle!: (result: FileDownloadResultV1) => void;
    let calls = 0;
    const downloads = createReleaseAssetDownloadsV1({ downloadFile: () => { calls++; return new Promise(resolve => { settle = resolve; }); } });
    const pending = downloads.download(release, asset);
    await downloads.download(release, asset);
    expect(calls).toBe(1);
    settle(receipt);
    await pending;
    expect(downloads.getSnapshot().get(asset.assetId)?.result).toBe(receipt);
    await downloads.download(release, asset);
    expect(calls).toBe(1);
    const other = downloads.download(release, { ...asset, assetId: '18' });
    downloads.dispose();
    const retired = downloads.getSnapshot();
    settle({ success: false, status: 'unknown', error: 'Lost answer' });
    await other;
    await downloads.download(release, asset);
    expect(downloads.getSnapshot()).toBe(retired);
    expect(retired.size).toBe(0);
    expect(calls).toBe(2);
  });

  it('retains thrown host uncertainty without replaying or changing another asset', async () => {
    const release = createForgeReleaseV1Fixture();
    const asset = { assetId: '17', name: 'asset', label: null, contentType: 'application/octet-stream', size: 4, state: 'uploaded' };
    const downloads = createReleaseAssetDownloadsV1({ downloadFile: async () => { throw new Error('Receiver disconnected'); } });
    await downloads.download(release, asset);
    const first = downloads.getSnapshot().get('17');
    expect(first?.result).toMatchObject({ success: false, status: 'unknown', error: 'Receiver disconnected' });
    await downloads.download(release, { ...asset, assetId: '18' });
    expect(downloads.getSnapshot().get('17')).toBe(first);
    downloads.dispose();
  });
});
