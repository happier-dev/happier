import { describe, expect, it } from 'vitest';
import { createForgeReleaseV1Fixture } from '@happier-dev/triage-protocol/releases/testing/v1';
import { executeGithubReleaseOperationV1 } from './operations.js';
import { createStubGithubTransport, readRecordedJsonBody } from '../triage/testkit/githubTriage.test-support.js';

const stamp = '2026-10-24T10:00:00Z';
const asset = { assetId: '9', name: 'artifact.zip', label: null, contentType: 'application/zip', size: 4,
  state: 'uploaded', updatedAt: stamp, digest: 'sha256:original' } as const;
const reviewed = createForgeReleaseV1Fixture({ name: 'Release 7', body: 'Notes', repositoryVisibility: 'private',
  assets: { rows: [asset], omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null } });
const target = { repository: reviewed.repository, repositoryId: reviewed.repositoryId, releaseId: reviewed.releaseId };
const nativeAsset = { id: 9, name: asset.name, label: null, content_type: asset.contentType, size: 4,
  state: 'uploaded', updated_at: stamp, digest: asset.digest };
const nativeRelease = (overrides: Record<string, unknown> = {}) => ({ id: 7, tag_name: 'v7', target_commitish: 'main',
  name: 'Release 7', body: 'Notes', draft: true, prerelease: false, created_at: stamp, updated_at: stamp,
  published_at: null, html_url: reviewed.webUrl, assets: [nativeAsset], ...overrides });
function transport(options: { release?: Record<string, unknown>; assets?: readonly Record<string, unknown>[]; loseWrite?: boolean } = {}) {
  let published = false;
  return createStubGithubTransport({ nativeMaterialization: { kind: 'httpHeaders', headers: { authorization: 'Bearer fixture' } },
    respond: request => {
      if (new URL(request.url).pathname === '/repos/acme/widgets') return { status: 200, body: { id: 42, full_name: 'acme/widgets', private: true } };
      if (request.method === 'PATCH') {
        if (options.loseWrite) throw new Error('Response lost after the write');
        const body = readRecordedJsonBody(request);
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('Expected a JSON mutation object');
        published = 'draft' in body && body.draft === false;
        // Observed GitHub behaviour (JOURNEY-Q1, draft 422941466): a draft PATCH without tag_name drops the draft's
        // pending tag and answers with a generated `untagged-…` name.
        const untagged = !published && !('tag_name' in body) ? { tag_name: 'untagged-da5eefdb1d43cfcbac6c' } : {};
        return { status: 200, body: nativeRelease({ ...options.release, ...body, ...untagged }) };
      }
      if (request.url.includes('/assets?')) return { status: 200, body: options.assets ?? [nativeAsset] };
      return { status: 200, body: nativeRelease({ ...options.release, draft: !published }) };
    } });
}

describe('fresh reviewed draft authority at the provider operation boundary', () => {
  it('detects changed notes with an unchanged timestamp before publishing', async () => {
    const h = transport({ release: { body: 'Changed elsewhere' } });
    expect(await executeGithubReleaseOperationV1('publishReleaseDraft', { ...target, reviewed, makeLatest: 'legacy' }, h.context))
      .toMatchObject({ kind: 'conflict', reason: 'changedSinceReview', release: { body: 'Changed elsewhere' } });
    expect(h.requests.some(request => request.method === 'PATCH')).toBe(false);
  });

  it('detects asset deletion and changed content even when revision timestamps did not change', async () => {
    for (const assets of [[], [{ ...nativeAsset, digest: 'sha256:changed' }], [nativeAsset, { ...nativeAsset, id: 10 }]]) {
      const h = transport({ assets });
      expect(await executeGithubReleaseOperationV1('publishReleaseDraft', { ...target, reviewed, makeLatest: 'legacy' }, h.context))
        .toMatchObject({ kind: 'conflict' });
      expect(h.requests.some(request => request.method === 'PATCH')).toBe(false);
    }
  });

  it('rejects an incomplete or wrong-target review without writing', async () => {
    for (const snapshot of [{ ...reviewed, assets: { ...reviewed.assets, incomplete: 'pagination' } }, { ...reviewed, releaseId: '8' }]) {
      const h = transport();
      expect(await executeGithubReleaseOperationV1('publishReleaseDraft', { ...target, reviewed: snapshot, makeLatest: 'false' }, h.context))
        .toMatchObject({ kind: 'rejected' });
      expect(h.requests.some(request => request.method === 'PATCH')).toBe(false);
    }
  });

  it('publishes the exact reviewed set despite unrelated download-count changes, then reads the exact receipt', async () => {
    const h = transport({ assets: [{ ...nativeAsset, download_count: 99 }] });
    expect(await executeGithubReleaseOperationV1('publishReleaseDraft', { ...target, reviewed, makeLatest: 'false' }, h.context))
      .toMatchObject({ kind: 'confirmed', release: { releaseId: '7', draft: false } });
    const writes = h.requests.filter(request => request.method === 'PATCH');
    expect(writes).toHaveLength(1);
    expect(readRecordedJsonBody(writes[0]!)).toEqual({ draft: false, make_latest: 'false' });
    expect(Object.keys(writes[0]!.headers).some(name => name.toLowerCase() === 'if-match')).toBe(false);
    expect(h.requests.at(-1)?.url).toBe(writes[0]?.url);
  });

  it('edits only declared draft fields, keeps the draft’s tag, and preserves unknown writes without replay', async () => {
    const h = transport();
    expect(await executeGithubReleaseOperationV1('editReleaseDraft', { ...target, observedUpdatedAt: stamp, changes: { body: 'Edited' } }, h.context))
      .toMatchObject({ kind: 'confirmed', release: { body: 'Edited', draft: true, tagName: 'v7' } });
    // A body-only edit still names the draft's current tag, or GitHub forgets it.
    expect(readRecordedJsonBody(h.requests.find(request => request.method === 'PATCH')!)).toEqual({ tag_name: 'v7', body: 'Edited', draft: true });
    const lost = transport({ loseWrite: true });
    expect(await executeGithubReleaseOperationV1('publishReleaseDraft', { ...target, reviewed, makeLatest: 'legacy' }, lost.context))
      .toMatchObject({ kind: 'outcome_unknown', releaseId: '7', webUrl: reviewed.webUrl });
    expect(lost.requests.filter(request => request.method === 'PATCH')).toHaveLength(1);
  });

  it('preserves timestamp-only draft-edit semantics and rejects a stale timestamp', async () => {
    const h = transport({ release: { body: 'Reversible other edit', updated_at: '2026-10-24T11:00:00Z' } });
    expect(await executeGithubReleaseOperationV1('editReleaseDraft', { ...target, observedUpdatedAt: stamp,
      changes: { body: 'My notes' } }, h.context)).toMatchObject({ kind: 'conflict' });
    expect(h.requests.some(request => request.method === 'PATCH')).toBe(false);
  });
});
