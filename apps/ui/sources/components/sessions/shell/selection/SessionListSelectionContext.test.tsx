import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import {
    SessionListSelectionProvider,
    createSessionListSelectionStore,
    useOptionalSessionListSelectionState,
    useSessionListSelectionActions,
    useSessionListSelectionRow,
    useSessionListSelectionState,
} from './SessionListSelectionContext';

function SelectionHarness(props: Readonly<{
    scopeKey: string;
    visibleKeys: readonly string[];
    eligibleKeys?: readonly string[];
}>) {
    return (
        <SessionListSelectionProvider
            scopeKey={props.scopeKey}
            visibleOrderedKeys={props.visibleKeys}
            eligibleKeys={props.eligibleKeys}
        >
            <SelectionProbe />
        </SessionListSelectionProvider>
    );
}

function SelectionProbe() {
    const state = useSessionListSelectionState();
    const actions = useSessionListSelectionActions();
    const rowA = useSessionListSelectionRow('a');
    const rowB = useSessionListSelectionRow('b');

    return (
        <ProbeRoot
            mode={state.isSelectionMode}
            count={state.count}
            selectedA={rowA.isSelected}
            selectedB={rowB.isSelected}
            focusedKey={state.focusedKey}
            version={state.version}
        >
            <ProbeButton testID="replace-a" onPress={() => actions.replaceWith('a')} />
            <ProbeButton testID="toggle-b" onPress={() => actions.toggle('b')} />
            <ProbeButton testID="range-b" onPress={() => actions.selectRange('b')} />
            <ProbeButton testID="select-all" onPress={() => actions.selectAllVisible()} />
            <ProbeButton testID="exit" onPress={() => actions.exit()} />
        </ProbeRoot>
    );
}

function OptionalSelectionProbe() {
    const state = useOptionalSessionListSelectionState();
    return <ProbeRoot mode={state.isSelectionMode} count={state.count} version={state.version} />;
}

function OccurrenceRowProbe(props: Readonly<{ occurrenceKey: string; renders: Map<string, number> }>) {
    const row = useSessionListSelectionRow(props.occurrenceKey);
    props.renders.set(props.occurrenceKey, (props.renders.get(props.occurrenceKey) ?? 0) + 1);
    return <ProbeRoot testID={props.occurrenceKey} selected={row.isSelected} focused={row.isFocused} />;
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

describe('SessionListSelectionContext', () => {
    it('paints both selected copies while leaving unrelated mounted occurrence rows unrendered', async () => {
        const visibleOrderedKeys = ['attention:a', 'base:a', ...Array.from({ length: 998 }, (_, index) => `base:${index}`)];
        const entityKeysByOccurrenceKey = new Map(visibleOrderedKeys.map((key) => [key, key === 'attention:a' || key === 'base:a' ? 'a' : key]));
        const renders = new Map<string, number>();
        const store = createSessionListSelectionStore({ scopeKey: 'mirrors', visibleOrderedKeys, entityKeysByOccurrenceKey });
        const screen = await renderScreen(
            <SessionListSelectionProvider scopeKey="mirrors" visibleOrderedKeys={visibleOrderedKeys} entityKeysByOccurrenceKey={entityKeysByOccurrenceKey} store={store}>
                {visibleOrderedKeys.map((occurrenceKey) => <OccurrenceRowProbe key={occurrenceKey} occurrenceKey={occurrenceKey} renders={renders} />)}
            </SessionListSelectionProvider>,
        );
        await act(async () => { store.replaceWith('base:0'); });
        renders.clear();
        await act(async () => { store.toggle('base:a'); });
        expect(screen.findByTestId('attention:a')?.props).toMatchObject({ selected: true, focused: false });
        expect(screen.findByTestId('base:a')?.props).toMatchObject({ selected: true, focused: true });
        expect([...renders.keys()].sort()).toEqual(['attention:a', 'base:0', 'base:a']);
        expect(store.getSnapshot().count).toBe(2);
    });

    it('returns inert optional state outside a provider', async () => {
        const screen = await renderScreen(<OptionalSelectionProbe />);

        expect(screen.findByType('ProbeRoot').props).toMatchObject({
            mode: false,
            count: 0,
            version: 0,
        });
    });

    it('selects rows through provider actions and exposes per-row snapshots', async () => {
        const screen = await renderScreen(<SelectionHarness scopeKey="scope-a" visibleKeys={['a', 'b']} />);

        await pressByTestId(screen, 'replace-a');
        expect(screen.findByType('ProbeRoot').props).toMatchObject({
            mode: true,
            count: 1,
            selectedA: true,
            selectedB: false,
            focusedKey: 'a',
        });

        await pressByTestId(screen, 'toggle-b');
        expect(screen.findByType('ProbeRoot').props).toMatchObject({
            count: 2,
            selectedA: true,
            selectedB: true,
            focusedKey: 'b',
        });
    });

    it('clears selection when the explicit scope key changes', async () => {
        const screen = await renderScreen(<SelectionHarness scopeKey="scope-a" visibleKeys={['a', 'b']} />);

        await pressByTestId(screen, 'replace-a');
        expect(screen.findByType('ProbeRoot').props).toMatchObject({ mode: true, count: 1, selectedA: true });

        await screen.update(<SelectionHarness scopeKey="scope-b" visibleKeys={['a', 'b']} />);

        expect(screen.findByType('ProbeRoot').props).toMatchObject({
            mode: false,
            count: 0,
            selectedA: false,
            selectedB: false,
        });
    });

    it('keeps row snapshots primitive so unchanged rows can skip React updates', () => {
        const store = createSessionListSelectionStore({
            scopeKey: 'scope-a',
            visibleOrderedKeys: ['a', 'b'],
        });
        const listener = vi.fn();
        store.subscribe(listener);

        const beforeA = store.getRowSnapshot('a');
        const beforeB = store.getRowSnapshot('b');

        store.replaceWith('a');

        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getRowSnapshot('a')).not.toBe(beforeA);
        expect(store.getRowSnapshot('b')).toBe(beforeB.replace(/^0:/, '1:'));
    });
});
