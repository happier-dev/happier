import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { projectSessionSelectionRows } from './projectSessionSelectionRows';
import { SessionSelectionList } from './SessionSelectionList';
import { SelectionListSearchHeader } from '@/components/ui/selectionList/SelectionListSearchHeader';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
afterEach(standardCleanup);

describe('shared Session selection list', () => {
    it('keeps the chosen address, skips a disabled image row on ArrowDown, and closes on Escape', async () => {
        const candidates = ['first', 'disabled', 'last'].map(id => ({ ...createSessionFixture({
            id, metadata: { host: 'machine', path: '/project', name: id },
        }), serverId: 'home-a' }));
        const rows = projectSessionSelectionRows(candidates).map(row => row.address.sessionId === 'disabled'
            ? { ...row, disabledReason: "Agent can't read images" } : row);
        const chosen = vi.fn();
        const closed = vi.fn();
        const screen = await renderScreen(<SessionSelectionList rows={rows} title="Sessions" testID="chooser"
            searchPlaceholder="Search" emptyStateLabel="Empty" selectedOptionId={rows[0].id}
            maxHeight={400} onSelectSession={chosen} onRequestClose={closed} />);
        const key = async (value: string) => { await act(async () => {
            // Exercise the shared input's public event boundary; its DOM keydown adapter
            // has separate real-DOM coverage in SelectionListSearchHeader.webKeydownBridge.
            const input = screen.findByType<typeof SelectionListSearchHeader>(SelectionListSearchHeader);
            input.props.onKeyPress?.({ nativeEvent: { key: value }, preventDefault() {}, stopPropagation() {} });
        }); };
        await key('ArrowDown');
        await key('Enter');
        expect(chosen).toHaveBeenCalledWith({ serverId: 'home-a', sessionId: 'last' });
        await key('Escape');
        expect(closed).toHaveBeenCalledOnce();
    });

    it('in multiple mode toggles the tapped row through the caller and never chooses it; single mode still chooses', async () => {
        const candidates = ['first', 'second'].map(id => ({ ...createSessionFixture({
            id, metadata: { host: 'machine', path: '/project', name: id },
        }), serverId: 'home-a' }));
        const rows = projectSessionSelectionRows(candidates);
        const chosen = vi.fn();
        const toggled = vi.fn();
        const leading = [{ id: 'new-session', label: 'New session' }];
        const render = (mode?: React.ComponentProps<typeof SessionSelectionList>['selectionMode']) => renderScreen(
            <SessionSelectionList rows={rows} title="Sessions" testID="chooser" searchPlaceholder="Search"
                emptyStateLabel="Empty" maxHeight={400} leadingOptions={leading} selectionMode={mode}
                onSelectSession={chosen} onRequestClose={vi.fn()} />);
        const multiple = await render({ kind: 'multiple', selectedIds: new Set([rows[0].id]), onToggle: toggled });
        expect(multiple.findByTestId('chooser-option-new-session')).toBeNull();
        expect(multiple.findByProps({ testID: 'session-list-selection-checkbox-first' }).props.checked).toBe(true);
        expect(multiple.findByProps({ testID: 'session-list-selection-checkbox-second' }).props.checked).toBe(false);
        await multiple.pressByTestIdAsync('chooser-option-second');
        expect(toggled).toHaveBeenCalledWith({ serverId: 'home-a', sessionId: 'second' });
        expect(chosen).not.toHaveBeenCalled();
        standardCleanup();

        const single = await render();
        expect(single.findAllByTestId('session-list-selection-checkbox-first')).toHaveLength(0);
        await single.pressByTestIdAsync('chooser-option-second');
        expect(chosen).toHaveBeenCalledWith({ serverId: 'home-a', sessionId: 'second' });
        expect(toggled).toHaveBeenCalledOnce();
    });
});
