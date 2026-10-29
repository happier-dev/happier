import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { FilesystemBrowserRow } from './FilesystemBrowserRow';
import type { FilesystemBrowserNode } from './filesystemBrowserTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({});
});

// The primary pointer (finger or precise) is a platform fact: the one boundary these rows read.
const pointer = vi.hoisted(() => ({ touch: false }));
vi.mock('@happier-dev/plugin-ui/environment', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@happier-dev/plugin-ui/environment')>()),
    isHappierTouchPrimaryPointer: () => pointer.touch,
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const folderError: FilesystemBrowserNode = {
    path: 'src',
    name: '',
    type: 'error',
    depth: 1,
    isExpanded: false,
    isLoadingChildren: false,
    parentDirectoryPath: 'src',
    errorMessage: 'EACCES',
};

/**
 * Pane-states lab 0 "N": a folder in a tree that could not be listed is one quiet line — what failed, the
 * cause, and an inline retry of that folder — never "Error / Please try again".
 */
describe('FilesystemBrowserRow folder error', () => {
    it('states what failed and why, and retries that folder', async () => {
        const onRetryError = vi.fn();
        const screen = await renderScreen(
            <FilesystemBrowserRow
                testID="tree-row-src"
                node={folderError}
                title=""
                icon={null}
                onRetryError={onRetryError}
            />,
        );

        expect(screen.findByTestId('tree-row-src-folder-error')).toBeTruthy();
        const text = screen.getTextContent();
        expect(text).toContain(t('files.repositoryFolderLoadFailed'));
        expect(text).toContain(t('errors.permissionDenied'));
        expect(text).not.toContain(t('errors.tryAgain'));
        // The raw error is QA-only, never the sentence.
        expect(screen.findByTestId('tree-row-src-folder-error-diagnostic-EACCES')).toBeTruthy();

        await act(async () => {
            screen.pressByTestId('tree-row-src-folder-error-action');
        });
        expect(onRetryError).toHaveBeenCalledWith(folderError);
    });
});

describe('FilesystemBrowserRow tree title (one line; the meaningful end stays)', () => {
    it('keeps a folder selection mixed until all of its children are selected', async () => {
        const folder: FilesystemBrowserNode = { path: 'src', name: 'src', type: 'directory', depth: 0, isExpanded: false, isLoadingChildren: false };
        function SelectedFolder() {
            const states = ['unchecked', 'mixed', 'checked'] as const;
            const [index, setIndex] = React.useState(0);
            return <FilesystemBrowserRow testID="folder-selection" node={folder} title="src" icon={null} disclosure
                selection={{ state: states[index]!, accessibilityLabel: 'Select src', onToggle: () => setIndex(current => (current + 1) % states.length) }} />;
        }
        const screen = await renderScreen(<SelectedFolder />);
        for (const checked of [false, 'mixed', true, false] as const) {
            const control = screen.findHostByTestId('folder-selection-select');
            expect(control?.props['aria-checked']).toBe(checked);
            expect(control?.props.accessibilityState?.checked).toBe(checked);
            await act(async () => { screen.pressByTestId('folder-selection-select'); });
        }
    });

    it('discloses a folder independently from its named navigation target', async () => {
        const folder: FilesystemBrowserNode = { path: 'folder.ts', name: 'folder.ts', type: 'directory', depth: 0, isExpanded: false, isLoadingChildren: false };
        const onPress = vi.fn();
        const onDisclosurePress = vi.fn();
        const targets = { onPress, onDisclosurePress };
        const screen = await renderScreen(<FilesystemBrowserRow testID="row" node={folder} title={folder.name} icon={null} disclosure {...targets} />);
        const disclosure = screen.findByTestId('row-disclosure');
        expect(disclosure).toBeTruthy();
        expect(disclosure?.props.accessibilityLabel).toBeTruthy();
        await screen.pressByTestIdAsync('row-disclosure');
        expect(onDisclosurePress).toHaveBeenCalledOnce();
        expect(onPress).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('row');
        expect(onPress).toHaveBeenCalledOnce();
    });
    const textNodes = (screen: Awaited<ReturnType<typeof renderScreen>>, value: string) =>
        screen.findAll((node) => node.props?.children === value && node.props?.numberOfLines === 1);

    it('ellipsizes a folder in the middle, keeping its last folder whole', async () => {
        const folder: FilesystemBrowserNode = { path: 'a/components/settings/modal', name: 'components/settings/modal', type: 'directory', depth: 1, isExpanded: true, isLoadingChildren: false };
        const screen = await renderScreen(
            <FilesystemBrowserRow testID="row" node={folder} title={folder.name} icon={null} disclosure density="tight" />,
        );
        const title = textNodes(screen, folder.name);
        expect(title.length).toBeGreaterThan(0);
        expect(title.some((node) => node.props.ellipsizeMode === 'middle')).toBe(true);
    });

    it('keeps a file name on one line, truncating its end', async () => {
        const file: FilesystemBrowserNode = { path: 'a/nightly-recovery.md', name: 'nightly-recovery.md', type: 'file', depth: 2, isExpanded: false, isLoadingChildren: false };
        const screen = await renderScreen(
            <FilesystemBrowserRow testID="row" node={file} title={file.name} icon={null} disclosure density="tight" />,
        );
        const title = textNodes(screen, 'nightly-recovery.md');
        expect(title.length).toBeGreaterThan(0);
        expect(title.some((node) => node.props.ellipsizeMode === 'tail')).toBe(true);
    });
});

describe('FilesystemBrowserRow subtitle (a phone Code row: lab p-code BROWSEp)', () => {
    it('sets the subtitle under the name, in the name column, with the time left at the trailing edge', async () => {
        const folder: FilesystemBrowserNode = { path: 'core', name: 'core', type: 'directory', depth: 0, isExpanded: false, isLoadingChildren: false };
        const screen = await renderScreen(
            <FilesystemBrowserRow
                testID="row"
                node={folder}
                title="core"
                icon={null}
                disclosure
                subtitle={<Text testID="row-subject">Let a beforeRetry hook change per-attempt options</Text>}
                rightElement={<Text testID="row-time">2w</Text>}
            />,
        );
        type Probe = { findAll: (predicate: (n: { props?: { testID?: string; children?: unknown; numberOfLines?: number } }) => boolean) => unknown[] };
        const holds = (node: Probe, testID: string) => node.findAll((n) => n.props?.testID === testID).length > 0;
        const titleHolds = (node: Probe) => node.findAll((n) => n.props?.children === 'core' && n.props?.numberOfLines === 1).length > 0;
        const columns = screen.findAll((node) => titleHolds(node as Probe) && holds(node as Probe, 'row-subject') && !holds(node as Probe, 'row-time'));
        // A column holds the name and the subject; the time sits outside it, so the subject never shares the name's line.
        expect(columns.length).toBeGreaterThan(0);
        expect(screen.findByTestId('row-time')).toBeTruthy();
    });
});

describe('FilesystemBrowserRow row actions (… only when the row is in play)', () => {
    const file: FilesystemBrowserNode = { path: 'a/b.ts', name: 'b.ts', type: 'file', depth: 1, isExpanded: false, isLoadingChildren: false };
    const controls: Array<{ open: boolean; triggerHidden: boolean }> = [];
    const rowActions = (control: { open: boolean; onOpenChange: (open: boolean) => void; triggerHidden: boolean }) => {
        controls.push(control);
        return <Text testID="row-actions">…</Text>;
    };
    const render = (props: Partial<React.ComponentProps<typeof FilesystemBrowserRow>> = {}) => renderScreen(
        <FilesystemBrowserRow testID="row" node={file} title={file.name} icon={null} disclosure density="tight" rowActions={rowActions} {...props} />,
    );
    const rowItem = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
        screen.findAll((node) => node.props?.testID === 'row' && typeof node.props?.onHoverIn === 'function')[0];

    it('keeps the … out of a pointer row until it is hovered, focused or selected', async () => {
        pointer.touch = false;
        const screen = await render();
        expect(screen.findAllByTestId('row-actions')).toHaveLength(0);

        await act(async () => { rowItem(screen)?.props.onHoverIn(); });
        expect(screen.findAllByTestId('row-actions').length).toBeGreaterThan(0);
        await act(async () => { rowItem(screen)?.props.onHoverOut(); });
        expect(screen.findAllByTestId('row-actions')).toHaveLength(0);

        // Keyboard focus in the row shows it; leaving the row hides it again.
        await act(async () => { rowItem(screen)?.props.onFocus?.(); });
        expect(screen.findAllByTestId('row-actions').length).toBeGreaterThan(0);
        await act(async () => { rowItem(screen)?.props.onBlur?.(); });
        expect(screen.findAllByTestId('row-actions')).toHaveLength(0);

        const focused = await render({ rowActionsRevealed: true });
        expect(focused.findAllByTestId('row-actions').length).toBeGreaterThan(0);
    });

    it('never draws the … under a finger; a long press opens the same actions', async () => {
        pointer.touch = true;
        controls.length = 0;
        const screen = await render();
        expect(screen.findAllByTestId('row-actions')).toHaveLength(0);

        await act(async () => { rowItem(screen)?.props.onLongPress?.(); });
        const last = controls.at(-1);
        expect(last?.open).toBe(true);
        expect(last?.triggerHidden).toBe(true);
        pointer.touch = false;
    });
});
