import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries({ platformOS: 'web' });
await prepareSessionFilesViewTestkit();
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

it('opens a phone-picked captured file through the host while retaining the desktop stream', async () => {
    const comparison = ScmComparisonSchema.parse({ id: 'e'.repeat(64), source: { kind: 'workingTree' },
        repository: { rootPath: '/unprojected' }, endpoints: {}, inventory: { state: 'complete', reasons: [], files: [{
            path: 'a.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
            occurrences: [{ id: 'a-change', alias: 'a-change', path: 'a.ts', position: 0,
                before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 } }],
            evidence: { state: 'available', unifiedDiff: '@@ -1 +1 @@\n-before\n+captured\n' },
        }] } });
    fixture = await createSessionFilesViewFixture({ rootPath: '/unprojected', rpc: request =>
        request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE ? { success: true, comparison,
            metadata: { sourceKey: comparison.id, source: comparison.source } } : undefined });
    const { ReviewChangesHost } = await import('./ReviewChangesHost');
    const { WorkspaceScmReviewBody } = await import('@/components/projects/scm/WorkspaceScmReviewBody');
    const { ChangedFilesReviewPhoneFileControl } = await import('@/components/workspaces/scm/review/ChangedFilesReviewPhoneFileControl');
    const onOpenFile = vi.fn();
    const screen = await fixture.render(<ReviewChangesHost reviewId="phone-captured" roundOrdinal={1}
        scope={{ serverId: fixture.scope.serverId, accountId: 'alice' }}
        capture={{ target: { kind: 'machine', machineId: 'm1' }, input: { cwd: '/unprojected', comparisonId: comparison.id, source: comparison.source } }}
        comments={[]} view="files" onSelectView={() => {}} onOpenComment={() => {}} onOpenFile={onOpenFile} />);
    const measure = async (width: number) => await act(async () => screen.findByType(WorkspaceScmReviewBody)
        .findAll(node => typeof node.props.onLayout === 'function')[0]?.props.onLayout({ nativeEvent: { layout: { width, height: 700 } } }));
    await vi.waitFor(() => expect(screen.findAllByType(WorkspaceScmReviewBody)).toHaveLength(1));
    await measure(390);
    await vi.waitFor(() => expect(screen.findAllByType(ChangedFilesReviewPhoneFileControl)).toHaveLength(1));
    await act(async () => screen.findByType(ChangedFilesReviewPhoneFileControl).props.onFocusPath('a.ts'));
    expect(onOpenFile).toHaveBeenCalledWith('a.ts');
    await measure(1440);
    await vi.waitFor(() => expect(screen.findAllByType(ChangedFilesReviewPhoneFileControl)).toHaveLength(0));
    expect(screen.getTextContent()).toContain('captured');
});
