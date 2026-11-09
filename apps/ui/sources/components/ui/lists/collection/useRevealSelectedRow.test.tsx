import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { useRevealSelectedRow } from './useRevealSelectedRow';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Rows(props: Readonly<{ selectedKey: string | null; keys: readonly string[]; reveal?: boolean }>) {
    const present = props.selectedKey !== null && props.keys.includes(props.selectedKey);
    const selectedRef = useRevealSelectedRow(props.selectedKey, present, props.reveal);
    return React.createElement('View', null, props.keys.map((key) => (
        React.createElement('Row', { key, testID: key, ref: key === props.selectedKey ? selectedRef : undefined })
    )));
}

describe('useRevealSelectedRow', () => {
    it('leaves pointer selections and their later arrivals alone, then reveals a keyboard selection once', async () => {
        const reveal = vi.fn();
        const createNodeMock = (element: { props?: { testID?: string } }) => ({ scrollIntoView: () => reveal(element.props?.testID) });
        const screen = await renderScreen(<Rows selectedKey="m2" keys={['m1']} reveal={false} />, { createNodeMock: createNodeMock as never });
        await screen.update(<Rows selectedKey="m2" keys={['m1', 'm2']} reveal={false} />);
        expect(reveal).not.toHaveBeenCalled();
        await screen.update(<Rows selectedKey="m2" keys={['m1', 'm2']} reveal />);
        expect(reveal).toHaveBeenCalledExactlyOnceWith('m2');
        await screen.update(<Rows selectedKey="m2" keys={['m1', 'm2']} reveal />);
        expect(reveal).toHaveBeenCalledTimes(1);
    });

    it('scrolls the selected row into view when it is selected, and again only when the selection or its presence changes', async () => {
        const reveal = vi.fn();
        const createNodeMock = (element: { props?: { testID?: string } }) => ({ revealedBy: element.props?.testID, scrollIntoView: () => reveal(element.props?.testID) });
        const keys = ['m1', 'm2', 'm3'];
        const screen = await renderScreen(React.createElement(Rows, { selectedKey: 'm2', keys }), { createNodeMock: createNodeMock as never });
        expect(reveal).toHaveBeenCalledTimes(1);
        expect(reveal).toHaveBeenLastCalledWith('m2');

        // The row list re-rendering (presence ticks, summaries) leaves the person's own scroll alone.
        await screen.update(React.createElement(Rows, { selectedKey: 'm2', keys: [...keys] }));
        expect(reveal).toHaveBeenCalledTimes(1);

        await screen.update(React.createElement(Rows, { selectedKey: 'm3', keys }));
        expect(reveal).toHaveBeenCalledTimes(2);
        expect(reveal).toHaveBeenLastCalledWith('m3');
    });

    it('waits for a selected row that is not there yet (the list is still loading) and reveals it once it arrives', async () => {
        const reveal = vi.fn();
        const createNodeMock = (element: { props?: { testID?: string } }) => ({ scrollIntoView: () => reveal(element.props?.testID) });
        const screen = await renderScreen(React.createElement(Rows, { selectedKey: 'm9', keys: ['m1'] }), { createNodeMock: createNodeMock as never });
        expect(reveal).not.toHaveBeenCalled();
        await screen.update(React.createElement(Rows, { selectedKey: 'm9', keys: ['m1', 'm9'] }));
        expect(reveal).toHaveBeenCalledWith('m9');
    });
});
