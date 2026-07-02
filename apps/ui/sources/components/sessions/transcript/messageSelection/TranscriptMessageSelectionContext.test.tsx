import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import {
    TranscriptMessageSelectionBoundary,
    TranscriptMessageSelectionProvider,
    useTranscriptSelectionActions,
    useOptionalTranscriptSelectionState,
    useTranscriptSelectionRow,
    useTranscriptSelectionState,
} from './TranscriptMessageSelectionContext';

function SelectionHarness(props: { eligibleMessageIds: string[]; enabled?: boolean }) {
    return (
        <TranscriptMessageSelectionProvider sessionId="s1" eligibleMessageIdsInOrder={props.eligibleMessageIds} enabled={props.enabled}>
            <SelectionProbe />
        </TranscriptMessageSelectionProvider>
    );
}

function OptionalSelectionProbe() {
    const state = useOptionalTranscriptSelectionState();
    return <ProbeRoot mode={state.isSelectionMode} count={state.count} version={state.selectionVersion} />;
}

function NestedBoundaryHarness() {
    return (
        <TranscriptMessageSelectionProvider sessionId="s1" eligibleMessageIdsInOrder={['a']}>
            <TranscriptMessageSelectionBoundary sessionId="s1" eligibleMessageIdsInOrder={['b']} enabled>
                <SelectionProbe />
            </TranscriptMessageSelectionBoundary>
        </TranscriptMessageSelectionProvider>
    );
}

function SelectionProbe() {
    const state = useTranscriptSelectionState();
    const actions = useTranscriptSelectionActions();
    const rowA = useTranscriptSelectionRow('a');
    const rowB = useTranscriptSelectionRow('b');

    return (
        <ProbeRoot
            mode={state.isSelectionMode}
            count={state.count}
            selectedA={rowA.isSelected}
            selectedB={rowB.isSelected}
            version={state.selectionVersion}
        >
            <ProbeButton testID="enter-a" onPress={() => actions.enter('a')} />
            <ProbeButton testID="toggle-a" onPress={() => actions.toggle('a')} />
            <ProbeButton testID="toggle-b" onPress={() => actions.toggle('b')} />
            <ProbeButton testID="select-all" onPress={() => actions.selectAll(['a', 'b'])} />
            <ProbeButton testID="deselect-all" onPress={() => actions.deselectAll()} />
            <ProbeButton testID="exit" onPress={() => actions.exit()} />
        </ProbeRoot>
    );
}

function ProbeRoot(props: React.PropsWithChildren<Record<string, unknown>>) {
    return React.createElement('ProbeRoot', props, props.children);
}

function ProbeButton(props: { testID: string; onPress: () => void }) {
    return React.createElement('ProbeButton', props);
}

async function pressByTestId(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string): Promise<void> {
    const target = screen.find((node) => node.props?.testID === testID && typeof node.props?.onPress === 'function');
    await act(async () => {
        target.props.onPress();
    });
}

describe('TranscriptMessageSelectionProvider', () => {
    it('returns an inert optional selection state outside a provider', async () => {
        const screen = await renderScreen(<OptionalSelectionProbe />);

        expect(screen.findByType('ProbeRoot').props).toMatchObject({
            mode: false,
            count: 0,
            version: 0,
        });
    });

    it('enters selection mode and preselects the requested id', async () => {
        const screen = await renderScreen(<SelectionHarness eligibleMessageIds={['a', 'b']} />);

        expect(screen.findByType('ProbeRoot').props).toMatchObject({
            mode: false,
            count: 0,
            selectedA: false,
            version: 0,
        });

        await pressByTestId(screen, 'enter-a');

        expect(screen.findByType('ProbeRoot').props).toMatchObject({
            mode: true,
            count: 1,
            selectedA: true,
            selectedB: false,
            version: 1,
        });
    });

    it('exits selection mode when the last selected id is toggled off', async () => {
        const screen = await renderScreen(<SelectionHarness eligibleMessageIds={['a', 'b']} />);

        await pressByTestId(screen, 'enter-a');
        await pressByTestId(screen, 'toggle-b');
        expect(screen.findByType('ProbeRoot').props).toMatchObject({
            mode: true,
            count: 2,
            selectedA: true,
            selectedB: true,
            version: 2,
        });

        await pressByTestId(screen, 'toggle-b');
        expect(screen.findByType('ProbeRoot').props).toMatchObject({
            mode: true,
            count: 1,
            selectedA: true,
            selectedB: false,
            version: 3,
        });

        await pressByTestId(screen, 'toggle-a');
        expect(screen.findByType('ProbeRoot').props).toMatchObject({
            mode: false,
            count: 0,
            selectedA: false,
            selectedB: false,
            version: 4,
        });
    });

    it('exits selection mode when deselecting all selected ids', async () => {
        const screen = await renderScreen(<SelectionHarness eligibleMessageIds={['a', 'b']} />);

        await pressByTestId(screen, 'enter-a');
        await pressByTestId(screen, 'select-all');
        expect(screen.findByType('ProbeRoot').props).toMatchObject({ mode: true, count: 2, selectedA: true, selectedB: true, version: 2 });

        await pressByTestId(screen, 'deselect-all');
        expect(screen.findByType('ProbeRoot').props).toMatchObject({ mode: false, count: 0, selectedA: false, selectedB: false, version: 3 });
    });

    it('exits selection mode when disabled', async () => {
        const screen = await renderScreen(<SelectionHarness eligibleMessageIds={['a', 'b']} enabled />);

        await pressByTestId(screen, 'enter-a');
        expect(screen.findByType('ProbeRoot').props).toMatchObject({ mode: true, count: 1, selectedA: true });

        await screen.update(<SelectionHarness eligibleMessageIds={['a', 'b']} enabled={false} />);

        expect(screen.findByType('ProbeRoot').props).toMatchObject({ mode: false, count: 0, selectedA: false });
    });

    it('does not shadow an existing provider when rendered as a nested boundary', async () => {
        const screen = await renderScreen(<NestedBoundaryHarness />);

        await pressByTestId(screen, 'toggle-b');
        expect(screen.findByType('ProbeRoot').props).toMatchObject({
            mode: false,
            count: 0,
            selectedA: false,
            selectedB: false,
        });

        await pressByTestId(screen, 'enter-a');
        expect(screen.findByType('ProbeRoot').props).toMatchObject({
            mode: true,
            count: 1,
            selectedA: true,
            selectedB: false,
        });
    });

    it('prunes selected ids that disappear from the eligible id list and exits when none remain', async () => {
        const screen = await renderScreen(<SelectionHarness eligibleMessageIds={['a', 'b']} />);

        await pressByTestId(screen, 'enter-a');
        await pressByTestId(screen, 'select-all');
        expect(screen.findByType('ProbeRoot').props).toMatchObject({ mode: true, count: 2, selectedA: true, selectedB: true, version: 2 });

        await screen.update(<SelectionHarness eligibleMessageIds={['a']} />);

        expect(screen.findByType('ProbeRoot').props).toMatchObject({
            mode: true,
            count: 1,
            selectedA: true,
            selectedB: false,
            version: 3,
        });

        await screen.update(<SelectionHarness eligibleMessageIds={[]} />);

        expect(screen.findByType('ProbeRoot').props).toMatchObject({
            mode: false,
            count: 0,
            selectedA: false,
            selectedB: false,
            version: 4,
        });
    });
});
