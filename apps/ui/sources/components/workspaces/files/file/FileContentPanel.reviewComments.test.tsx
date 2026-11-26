import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import { buildReviewCommentFixture } from '@/dev/testkit/fixtures/reviewComments';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

// Native presentation and HTTP/RPC are boundaries; the panel, diff, anchors and cards remain real.
installSessionFilesViewBoundaries();
await prepareSessionFilesViewTestkit();
const { FileContentPanel } = await import('./FileContentPanel');
const { ReviewFindingAnchorContext } = await import('@/components/reviews/ReviewFindingAnchor');

let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
afterEach(async () => { standardCleanup(); await fixture?.dispose(); fixture = undefined; });

it.each([{ renamed: false, authoring: true }, { renamed: true, authoring: true }, { renamed: false, authoring: false }])(
    'keeps saved Review lines and file notes on a File page %j', async ({ renamed, authoring }) => {
    fixture = await createSessionFilesViewFixture();
    const filePath = 'total.ts';
    const previousFilePath = renamed ? 'old-total.ts' : undefined;
    const human = buildReviewCommentFixture({ id: 'human-line', reviewId: 'review', roundOrdinal: 1,
        author: { kind: 'user', userId: 'alice' }, body: 'Saved human line comment',
        anchor: { kind: 'line', filePath: previousFilePath ?? filePath, line: 2, side: renamed ? 'before' : 'after' } });
    const finding = buildReviewCommentFixture({ id: 'finding-line', reviewId: 'review', roundOrdinal: 1,
        engineId: 'codex', findingSeverity: 'high', anchor: { kind: 'line', filePath, line: 2, side: 'after' },
        finding: { id: 'line', title: 'Line finding', summary: 'Addition is required', severity: 'high', category: 'correctness' } });
    const fileNote = buildReviewCommentFixture({ id: 'human-file', reviewId: 'review', roundOrdinal: 1,
        author: { kind: 'user', userId: 'alice' }, body: 'Saved whole-file note',
        anchor: { kind: 'file', filePath: previousFilePath ?? filePath } });
    const fileFinding = buildReviewCommentFixture({ id: 'finding-file', reviewId: 'review', roundOrdinal: 1,
        engineId: 'claude', findingSeverity: 'medium', anchor: { kind: 'file', filePath: previousFilePath ?? filePath },
        finding: { id: 'file', title: 'Whole-file finding', summary: 'Check the whole file', severity: 'medium', category: 'correctness' } });
    const foreign = buildReviewCommentFixture({ id: 'foreign', body: 'Other file must stay hidden', anchor: { kind: 'file', filePath: 'other.ts' } });
    const draft: ReviewCommentDraft = { id: 'local-draft', filePath, source: 'diff',
        anchor: { kind: 'diffLine', side: 'after', startLine: 2, oldLine: null, newLine: 2 }, body: 'Existing local draft', createdAt: 1,
        snapshot: { selectedLines: ['  return 2;'], beforeContext: [], afterContext: [] } };
    const onOpen = vi.fn();
    const screen = await fixture.render(<ReviewFindingAnchorContext.Provider value={onOpen}>
        <FileContentPanel theme={createThemeFixture()} displayMode="diff" sessionId="" workspaceScope={fixture.scope}
            filePath={filePath} diffContent={'@@ -1,3 +1,3 @@\n function total() {\n-  return 1;\n+  return 2;\n }\n'}
            fileContent={null} language="typescript" selectedLineKeys={new Set()} lineSelectionEnabled={false}
            onToggleLine={() => {}} reviewCommentsEnabled={authoring} reviewCommentDrafts={[draft]}
            reviewComments={[human, finding, fileNote, fileFinding, foreign]} previousFilePath={previousFilePath} />
    </ReviewFindingAnchorContext.Provider>);
    if (authoring) await vi.waitFor(() => expect(screen.getTextContent()).toContain('Existing local draft'));
    else expect(screen.getTextContent()).not.toContain('Existing local draft');
    expect(screen.getTextContent()).toContain('Saved human line comment');
    expect(screen.getTextContent()).toContain('Saved whole-file note');
    expect(screen.getTextContent()).not.toContain('Other file must stay hidden');
    expect(screen.getTextContent().split('Line finding')).toHaveLength(2);
    expect(screen.getTextContent().split('Whole-file finding')).toHaveLength(2);
    await screen.pressByTestIdAsync('review-finding-anchor:finding-line');
    await screen.pressByTestIdAsync('review-finding-anchor:finding-file');
    expect(onOpen.mock.calls).toEqual([['finding-line'], ['finding-file']]);
    await screen.unmount();
});
