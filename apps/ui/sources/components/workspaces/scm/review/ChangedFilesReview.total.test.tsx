import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { createThemeFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import {
    createSessionFilesViewFixture,
    fileViewSnapshot,
    installSessionFilesViewBoundaries,
    prepareSessionFilesViewTestkit,
} from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { scmFileStatusFromChange } from '@/scm/scmStatusFiles';
import type { ChangedFilesReviewCoverage } from './ChangedFilesReview';

vi.mock('@legendapp/list/react-native', async importOriginal => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>(), renderItemLimit: 25,
        emitViewability: false, memoizeItems: true }).module;
});
installSessionFilesViewBoundaries({ renderItemLimit: 25, emitViewability: false });
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
await prepareSessionFilesViewTestkit();
afterEach(async () => { standardCleanup(); await fixture?.dispose(); fixture = undefined; });

it('counts a captured comparison by its total, not its loaded page: "10 / 6004" beside "0 of 6004 viewed" (U8 R6 CF1)', async () => {
    fixture = await createSessionFilesViewFixture();
    const { ChangedFilesReview } = await import('./ChangedFilesReview');
    const { ChangedFilesReviewIndex } = await import('./ChangedFilesReviewIndex');
    const files = Array.from({ length: 10 }, (_, index) => scmFileStatusFromChange({ path: `large-${index}.txt`, changeKind: 'added', added: 1, removed: 0 }));
    const coverages: ChangedFilesReviewCoverage[] = [];
    const screen = await renderScreen(<ChangedFilesReview sessionId={fixture.session.id} workspaceScope={fixture.scope} theme={createThemeFixture()}
        snapshot={fileViewSnapshot()} changedFilesViewMode="repository" allRepositoryChangedFiles={files} sessionAttributedFiles={[]}
        repositoryOnlyFiles={[]} maxFiles={100} maxChangedLines={100_000} onFilePress={() => {}} fileViewedTotal={6004}
        activeReviewFile={{ key: 'large-review', presented: true }}
        comparisonChrome={{ indexPlacement: 'rail', renderBarLeading: () => null,
            renderHeader: coverage => { coverages.push(coverage); return null; } }} />);
    try {
        expect(coverages.at(-1)?.fileCount).toBe(6004);
        expect(screen.findAllByType(ChangedFilesReviewIndex).every(index => index.props.totalFiles === 6004)).toBe(true);
    } finally { await screen.unmount(); }
});
