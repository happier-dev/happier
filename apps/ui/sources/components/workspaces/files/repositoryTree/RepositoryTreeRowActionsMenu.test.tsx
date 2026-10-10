import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { RepositoryTreeRowActionMenuItemId } from './RepositoryTreeRowActionsMenu';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit')).createTextModuleMock({ translate: key => key }));
// Only portal placement/window measurement is substituted; menu rows and selection stay real.
vi.mock('@/components/ui/popover', async importOriginal => (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

describe('canonical repository row menu', () => {
    async function render(input: { kind: 'file' | 'directory'; downloadActionsEnabled: boolean; disableWriteActions?: boolean }) {
        const { RepositoryTreeRowActionsMenu } = await import('./RepositoryTreeRowActionsMenu');
        const selected: RepositoryTreeRowActionMenuItemId[] = [];
        const screen = await renderScreen(<RepositoryTreeRowActionsMenu path="folder.ts" kind={input.kind}
            downloadActionsEnabled={input.downloadActionsEnabled} disableWriteActions={input.disableWriteActions ?? false}
            control={{ open: true, onOpenChange: () => {}, triggerHidden: true }} onSelect={item => selected.push(item)} />);
        return { screen, selected };
    }

    it('offers file and directory downloads by actual entry kind and dispatches the selected action', async () => {
        const file = await render({ kind: 'file', downloadActionsEnabled: true });
        expect(file.screen.findByTestId('repository-tree-menuitem-download')).toBeTruthy();
        expect(file.screen.findByTestId('repository-tree-menuitem-zip')).toBeTruthy();
        await file.screen.pressByTestIdAsync('repository-tree-menuitem-download');
        await vi.waitFor(() => expect(file.selected).toEqual(['repository-tree-menuitem-download']));
        const directory = await render({ kind: 'directory', downloadActionsEnabled: true });
        expect(directory.screen.findByTestId('repository-tree-menuitem-download')).toBeNull();
        expect(directory.screen.findByTestId('repository-tree-menuitem-zip')).toBeTruthy();
    });

    it('omits unavailable transfer actions while keeping disabled writes and local Copy path truthful', async () => {
        const { screen, selected } = await render({ kind: 'file', downloadActionsEnabled: false, disableWriteActions: true });
        expect(screen.findByTestId('repository-tree-menuitem-download')).toBeNull();
        expect(screen.findByTestId('repository-tree-menuitem-zip')).toBeNull();
        expect(screen.findByTestId('repository-tree-menuitem-rename')?.props.disabled).toBe(true);
        expect(screen.findByTestId('repository-tree-menuitem-delete')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('repository-tree-menuitem-copy-path');
        await vi.waitFor(() => expect(selected).toEqual(['repository-tree-menuitem-copy-path']));
    });
});
