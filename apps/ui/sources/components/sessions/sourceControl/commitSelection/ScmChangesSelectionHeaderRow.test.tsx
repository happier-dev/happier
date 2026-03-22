import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { findTestInstanceByTypeContainingText, renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    View: 'View',
                    Pressable: 'Pressable',
                    Platform: {
                        select: (value: any) => value?.default ?? null,
                    },
                }
    );
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/text', async () => {
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
});

describe('ScmChangesSelectionHeaderRow', () => {
    it('renders selected/total and triggers All/None actions', async () => {
        const { ScmChangesSelectionHeaderRow } = await import('./ScmChangesSelectionHeaderRow');
        const onSelectAll = vi.fn();
        const onSelectNone = vi.fn();

        const screen = await renderScreen(
            <ScmChangesSelectionHeaderRow
                theme={{ colors: { divider: '#000', textSecondary: '#aaa', textLink: '#09f', surfaceHigh: '#222' } }}
                selectedCount={2}
                totalCount={5}
                onSelectAll={onSelectAll}
                onSelectNone={onSelectNone}
            />,
        );

        expect(findTestInstanceByTypeContainingText(screen.tree, 'Text', 'Selected 2')).toBeTruthy();
        expect(findTestInstanceByTypeContainingText(screen.tree, 'Text', 'Total 5')).toBeTruthy();

        const pressables = screen.findAllByType('Pressable' as any);
        expect(pressables).toHaveLength(2);

        act(() => {
            pressables[0]!.props.onPress();
            pressables[1]!.props.onPress();
        });

        expect(onSelectAll).toHaveBeenCalledTimes(1);
        expect(onSelectNone).toHaveBeenCalledTimes(1);
    });

    it('does not render a noisy "Selected 0" line when nothing is selected', async () => {
        const { ScmChangesSelectionHeaderRow } = await import('./ScmChangesSelectionHeaderRow');

        const screen = await renderScreen(
            <ScmChangesSelectionHeaderRow
                theme={{ colors: { divider: '#000', textSecondary: '#aaa', textLink: '#09f', surfaceHigh: '#222' } }}
                selectedCount={0}
                totalCount={5}
            />,
        );

        expect(findTestInstanceByTypeContainingText(screen.tree, 'Text', 'Selected 0')).toBeFalsy();
        expect(findTestInstanceByTypeContainingText(screen.tree, 'Text', 'Total 5')).toBeTruthy();
    });
});
