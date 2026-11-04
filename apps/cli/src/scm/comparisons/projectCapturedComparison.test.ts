import { describe, expect, it } from 'vitest';
import type { ScmComparison } from '@happier-dev/protocol/scm/comparison';
import { WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES } from '@happier-dev/protocol/machines/workspaceFiles';
import { projectCapturedComparison } from './projectCapturedComparison';
import { EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES_V2 } from '@happier-dev/protocol/actions/externalActionApi';
import { encryptLegacy, encodeBase64 } from '@/api/encryption';

function capture(count: number, patch = '@@ -1 +1,2 @@\n-before\n+after\n+é😀\n') {
  const comparison: ScmComparison = { id: 'a'.repeat(64), source: { kind: 'workingTree' },
    repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [],
      files: Array.from({ length: count }, (_, index) => ({ path: `src/file-${index}.ts`, changeKind: 'modified',
        binary: false, generated: false, lockfile: false, occurrences: [], evidence: { state: 'available', unifiedDiff: patch } })) } };
  return { comparison, metadata: { source: comparison.source, sourceKey: comparison.id } };
}

describe('captured comparison wire projection', () => {
  it('retains a 20 MB capture supported by the current socket transport', () => {
    const result = projectCapturedComparison(capture(1, 'x'.repeat(20_000_000)));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.comparison.inventory.files[0]?.evidence.unifiedDiff).toHaveLength(20_000_000);
  });

  it('fits a boundary-sized retained response through authenticated RPC encryption and socket ACK framing', () => {
    const retained = capture(1, '');
    const empty = { success: true, comparison: retained.comparison, metadata: retained.metadata };
    const framingBytes = Buffer.byteLength(JSON.stringify(empty), 'utf8');
    retained.comparison.inventory.files[0]!.evidence.unifiedDiff = 'x'.repeat(WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES - framingBytes);
    const result = projectCapturedComparison(retained);
    expect(result.success).toBe(true);
    const encoded = encodeBase64(encryptLegacy({ v: 2, k: 'res', c: '0'.repeat(32), r: result }, new Uint8Array(32)));
    const ack = `43${Number.MAX_SAFE_INTEGER + 1}${JSON.stringify([{ v: 1, result: encoded }])}`;
    expect(Buffer.byteLength(ack, 'utf8')).toBeLessThanOrEqual(EXTERNAL_ACTION_RELAY_RESPONSE_SOCKET_MIN_BUFFER_BYTES_V2);
    retained.comparison.inventory.files[0]!.evidence.unifiedDiff += 'x';
    expect(projectCapturedComparison(retained)).toMatchObject({ success: false, errorCode: 'DIFF_UNAVAILABLE' });
  });

  it('returns all 14,592 file metadata entries without sending retained patches', () => {
    const retained = capture(14_592, '@@ -1 +1 @@\n-before\n+' + 'é😀'.repeat(2400) + '\n');
    expect(retained.comparison.inventory.files.reduce((bytes, file) => bytes
      + Buffer.byteLength(file.evidence.unifiedDiff ?? '', 'utf8'), 0)).toBeGreaterThan(184 * 1024 * 1024);
    const result = projectCapturedComparison(retained, { kind: 'index' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.page).toEqual({ totalFiles: 14_592, nextCursor: null });
    expect(result.comparison.inventory.files).toHaveLength(14_592);
    expect(result.comparison.inventory.files[0]).toMatchObject({ evidence: { state: 'deferred' }, linesAdded: 1, linesRemoved: 1 });
    expect(JSON.stringify(result)).not.toContain('unifiedDiff');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES);
    expect(retained.comparison.inventory.files[0]?.evidence.state).toBe('available');
  });

  it('pages metadata at the socket byte boundary and preserves source coverage', () => {
    const retained = capture(5);
    retained.comparison.inventory.files.forEach(file => {
      file.path = 'é'.repeat(Math.ceil(WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES / 8)) + file.path;
    });
    const first = projectCapturedComparison(retained, { kind: 'index' });
    expect(first.success).toBe(true);
    if (!first.success || !first.page?.nextCursor) throw new Error('Expected a bounded first page');
    expect(first.comparison.inventory.state).toBe('complete');
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES);
    const next = projectCapturedComparison(retained, { kind: 'index', cursor: first.page.nextCursor });
    expect(next.success && next.comparison.inventory.files.length + first.comparison.inventory.files.length).toBe(5);
  });

  it('selects an absolute opened path and never mutates the retained evidence', () => {
    const retained = capture(14_592);
    const result = projectCapturedComparison(retained, { kind: 'index', path: '/repo/src/file-14591.ts' });
    expect(result.success && result.comparison.inventory.files.map(file => file.path)).toEqual(['src/file-14591.ts']);
    expect(result.success && result.page).toEqual({ totalFiles: 1, nextCursor: null });
    expect(retained.comparison.inventory.files[14591]?.evidence).toEqual({ state: 'available', unifiedDiff: '@@ -1 +1,2 @@\n-before\n+after\n+é😀\n' });
  });

  it('returns an empty index when a requested file has no change in the captured source', () => {
    const result = projectCapturedComparison(capture(3), { kind: 'index', path: '/repo/unchanged.ts' });
    expect(result).toMatchObject({ success: true, comparison: { inventory: { state: 'complete', files: [] } },
      page: { totalFiles: 0, nextCursor: null } });
  });

  it('defers partial retained patches while preserving their reason and patchless unavailable states', () => {
    const retained = capture(2);
    retained.comparison.inventory.files[0]!.evidence = { state: 'unavailable', reason: 'source_patch_truncated', unifiedDiff: '@@ -1 +1 @@\n-before\n+partial\n' };
    retained.comparison.inventory.files[1]!.evidence = { state: 'unavailable', reason: 'source_patch_missing' };
    const result = projectCapturedComparison(retained, { kind: 'index' });
    expect(result.success && result.comparison.inventory.files.map(file => file.evidence)).toEqual([
      { state: 'deferred', reason: 'source_patch_truncated' },
      { state: 'unavailable', reason: 'source_patch_missing' },
    ]);
  });

  it('refuses oversized legacy evidence and an individual oversized metadata entry', () => {
    const retained = capture(1, 'x'.repeat(WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES));
    expect(projectCapturedComparison(retained)).toMatchObject({ success: false, errorCode: 'DIFF_UNAVAILABLE' });
    retained.comparison.inventory.files[0]!.path = 'x'.repeat(WORKSPACE_FILE_RPC_MAX_RESPONSE_UTF8_BYTES);
    expect(projectCapturedComparison(retained, { kind: 'index' })).toMatchObject({ success: false, errorCode: 'DIFF_UNAVAILABLE' });
  });
});
