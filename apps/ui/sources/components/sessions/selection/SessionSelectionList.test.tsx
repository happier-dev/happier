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
});
