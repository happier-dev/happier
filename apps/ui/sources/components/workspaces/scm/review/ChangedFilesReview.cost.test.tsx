import * as React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createThemeFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import {
    createSessionFilesViewFixture,
    fileViewSnapshot,
    installSessionFilesViewBoundaries,
    prepareSessionFilesViewTestkit,
} from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { scmFileStatusFromChange } from '@/scm/scmStatusFiles';

let cellRenders = 0;
// Hoist the native recycler boundary: the shared fixture's static imports also reach it.
vi.mock('@legendapp/list/react-native', async importOriginal => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>(),
        renderItemLimit: 25, emitViewability: false, memoizeItems: true,
        onRenderItem: () => { cellRenders += 1; } }).module;
});
installSessionFilesViewBoundaries({ renderItemLimit: 25, emitViewability: false });

describe('Review work follows file and control demand', () => {
    let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>> | undefined;
    beforeAll(prepareSessionFilesViewTestkit);
    afterEach(async () => { standardCleanup(); await fixture?.dispose(); fixture = undefined; });

    it('does no row work for idle host renders or comparison-header changes at 55,559 files', async () => {
        fixture = await createSessionFilesViewFixture();
        const { ChangedFilesReview } = await import('./ChangedFilesReview');
        const files = Array.from({ length: 55_559 }, (_, index) => scmFileStatusFromChange({
            path: `src/quiet-${index}.ts`, changeKind: 'modified', added: 1, removed: 0,
        }));
        const props = { sessionId: fixture.session.id, workspaceScope: fixture.scope, theme: createThemeFixture(),
            snapshot: fileViewSnapshot(), changedFilesViewMode: 'repository' as const,
            allRepositoryChangedFiles: files, sessionAttributedFiles: [], repositoryOnlyFiles: [],
            maxFiles: 1, maxChangedLines: 1, onFilePress() {}, initialCollapsedPaths: files.map(file => file.fullPath),
            comparisonChrome: { indexPlacement: 'phone' as const, renderBarLeading: () => null, renderHeader: () => null } };
        const screen = await renderScreen(<ChangedFilesReview {...props} />);
        try {
            cellRenders = 0;
            for (let i = 0; i < 5; i += 1) await screen.update(<ChangedFilesReview {...props} />);
            expect(cellRenders).toBe(0);
            await screen.update(<ChangedFilesReview {...props} comparisonChrome={{ ...props.comparisonChrome,
                renderHeader: () => <React.Fragment>Updated comparison title</React.Fragment> }} />);
            expect(cellRenders).toBe(0);
            await screen.pressByTestIdAsync('scm-change-collapse-src_quiet-0.ts');
            expect(cellRenders).toBe(1);
        } finally { await screen.unmount(); }
    });

    it('redraws only the changed file header when one repository file changes', async () => {
        fixture = await createSessionFilesViewFixture();
        const { ChangedFilesReview } = await import('./ChangedFilesReview');
        const files = Array.from({ length: 300 }, (_, index) => scmFileStatusFromChange({
            path: `src/change-${index}.ts`, changeKind: 'modified', added: 1, removed: 0,
        }));
        const props = { sessionId: fixture.session.id, workspaceScope: fixture.scope, theme: createThemeFixture(),
            snapshot: fileViewSnapshot(), changedFilesViewMode: 'repository' as const,
            allRepositoryChangedFiles: files, sessionAttributedFiles: [], repositoryOnlyFiles: [],
            maxFiles: 1, maxChangedLines: 1, onFilePress() {}, initialCollapsedPaths: files.map(file => file.fullPath),
            comparisonChrome: { indexPlacement: 'phone' as const, renderBarLeading: () => null, renderHeader: () => null } };
        const screen = await renderScreen(<ChangedFilesReview {...props} />);
        try {
            cellRenders = 0;
            await screen.update(<ChangedFilesReview {...props} allRepositoryChangedFiles={[
                { ...files[0]!, linesAdded: 2 }, ...files.slice(1),
            ]} />);
            expect(cellRenders).toBe(1);
            expect(screen.getTextContent()).toContain('+2');
            await screen.pressByTestIdAsync('scm-change-collapse-src_change-0.ts');
            await screen.pressByTestIdAsync('scm-change-collapse-src_change-1.ts');
            cellRenders = 0;
            await screen.update(<ChangedFilesReview {...props} allRepositoryChangedFiles={[
                { ...files[0]!, linesAdded: 3 }, ...files.slice(1),
            ]} />);
            expect(cellRenders, 'an unchanged expanded file does not consume another file\'s stats').toBe(1);
            expect(screen.getTextContent()).toContain('+3');
        } finally { await screen.unmount(); }
    });

});
