import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { findTestInstanceByTypeContainingText, pressTestInstance, renderScreen } from '@/dev/testkit';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import { installSourceControlCommitSelectionCommonModuleMocks } from './sourceControlCommitSelectionTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const selectionHeaderTheme = createThemeFixture();

installSourceControlCommitSelectionCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: any) => {
                if (key === 'files.sourceControlOperations.selection') return `Selected ${params?.count ?? 0}`;
                if (key === 'files.repositoryChangedFiles') return `Total ${params?.count ?? 0}`;
                if (key === 'files.sourceControlOperations.clear') return 'Clear';
                if (key === 'common.all') return 'All';
                return key;
            },
        });
    },
});

describe('ScmChangesSelectionHeaderRow', () => {
    it('renders selected/total and triggers All/None actions', async () => {
        const { ScmChangesSelectionHeaderRow } = await import('./ScmChangesSelectionHeaderRow');
        const onSelectAll = vi.fn();
        const onSelectNone = vi.fn();

        const screen = await renderScreen(
            <ScmChangesSelectionHeaderRow
                theme={selectionHeaderTheme}
                selectedCount={2}
                totalCount={5}
                onSelectAll={onSelectAll}
                onSelectNone={onSelectNone}
            />,
        );

        expect(findTestInstanceByTypeContainingText(screen.tree, 'Text', 'Selected 2')).toBeTruthy();
        expect(findTestInstanceByTypeContainingText(screen.tree, 'Text', 'Total 5')).toBeTruthy();

        const selectAllButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'All');
        const selectNoneButton = findTestInstanceByTypeContainingText(screen, 'Pressable', 'Clear');

        expect(selectAllButton).toBeTruthy();
        expect(selectNoneButton).toBeTruthy();

        pressTestInstance(selectAllButton!, 'files.selectAll');
        pressTestInstance(selectNoneButton!, 'files.selectNone');

        expect(onSelectAll).toHaveBeenCalledTimes(1);
        expect(onSelectNone).toHaveBeenCalledTimes(1);
    });

    it('does not render a noisy "Selected 0" line when nothing is selected', async () => {
        const { ScmChangesSelectionHeaderRow } = await import('./ScmChangesSelectionHeaderRow');

        const screen = await renderScreen(
            <ScmChangesSelectionHeaderRow
                theme={selectionHeaderTheme}
                selectedCount={0}
                totalCount={5}
            />,
        );

        expect(findTestInstanceByTypeContainingText(screen.tree, 'Text', 'Selected 0')).toBeFalsy();
        expect(findTestInstanceByTypeContainingText(screen.tree, 'Text', 'Total 5')).toBeTruthy();
    });
});
