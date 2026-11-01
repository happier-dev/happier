import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import type { FileChangesReview } from './useFileChangesReview';

installSessionFilesViewBoundaries();
await prepareSessionFilesViewTestkit();
const { useFileChangesReview } = await import('./useFileChangesReview');
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
afterEach(async () => { await standardCleanup(); await fixture?.dispose(); });

describe('captured File changes path basis', () => {
  it.each([
    { root: '/repo', cwd: '/repo/nested', path: 'a.ts' },
    { root: '/Users/alice/repo', cwd: '/Users/alice/repo/nested/', path: 'a.ts' },
    { root: 'C:\\Users\\alice\\repo', cwd: 'C:/Users/alice/repo/nested', path: 'a.ts' },
  ])('finds a Session-local file in repository-relative captured evidence ($cwd)', async ({ root, cwd, path }) => {
    const comparison = ScmComparisonSchema.parse({ id: 'c'.repeat(64),
      source: { kind: 'turnCheckpoint', turnId: 'turn-1' }, repository: { rootPath: root }, endpoints: {},
      inventory: { state: 'complete', reasons: [], files: [{ path: 'nested/a.ts', changeKind: 'modified',
        binary: false, generated: false, lockfile: false, occurrences: [],
        evidence: { state: 'available', unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n' } }] } });
    fixture = await createSessionFilesViewFixture({ rootPath: cwd, rpc: request =>
      request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE
        ? { success: true, comparison, metadata: { sourceKey: comparison.id, source: comparison.source } }
        : undefined });
    const currentFixture = fixture;
    let review: FileChangesReview | undefined;
    function Probe() {
      review = useFileChangesReview({ scope: { machineId: 'm1', rootPath: cwd, serverId: currentFixture.home.id },
        sessionId: 's1', filePath: path, liveDiff: null, refreshLiveDiff: () => {},
        view: { changesScope: { kind: 'turn', turnId: 'turn-1' } }, onChangesScopeChange: () => {}, active: true });
      return null;
    }
    await fixture.render(<Probe />);
    await vi.waitFor(() => expect(review?.status).toBe('ready'));
    expect(review?.changed).toBe(true);
    expect(review?.menuChanges.restoreBeforeTurn).toBeTypeOf('function');
  });
});
