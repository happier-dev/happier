import * as React from 'react';
import { Platform } from 'react-native';
import { describe, expect, it } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { MultiPaneHost } from './MultiPaneHost';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('MultiPaneHost (overlayStack hidden right)', () => {
    it('keeps the right pane mounted when hidden behind an overlay details pane', async () => {
        const tracker = createMountTracker();

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<MultiPaneHost
                    main={<Main />}
                    rightPane={<Tracked tracker={tracker} name="right" />}
                    detailsPane={<Tracked tracker={tracker} name="details" />}
                    layout={{ kind: 'overlayStack', right: 'hidden', details: 'overlay' }}
                    rightDockWidthPx={360}
                    detailsDockWidthPx={520}
                    onCloseRight={() => {}}
                    onCloseDetails={() => {}}
                    onCommitRightDockWidthPx={() => {}}
                    onCommitDetailsDockWidthPx={() => {}}
                />)).tree;

        expect(tracker.mounts.right).toBe(1);
        expect(tracker.unmounts.right ?? 0).toBe(0);

        act(() => {
            tree!.update(
                <MultiPaneHost
                    main={<Main />}
                    rightPane={<Tracked tracker={tracker} name="right" />}
                    detailsPane={null}
                    layout={{ kind: 'overlayStack', right: 'overlay', details: 'hidden' }}
                    rightDockWidthPx={360}
                    detailsDockWidthPx={520}
                    onCloseRight={() => {}}
                    onCloseDetails={() => {}}
                    onCommitRightDockWidthPx={() => {}}
                    onCommitDetailsDockWidthPx={() => {}}
                />,
            );
        });

        expect(tracker.mounts.right).toBe(1);
        expect(tracker.unmounts.right ?? 0).toBe(0);
    });

    it('makes a parked right pane inert to pointer, keyboard, and accessibility interaction', async () => {
        const tree = (await renderScreen(<MultiPaneHost
                    main={<Main />}
                    rightPane={<Tracked tracker={createMountTracker()} name="right" />}
                    detailsPane={<Tracked tracker={createMountTracker()} name="details" />}
                    layout={{ kind: 'overlayStack', right: 'hidden', details: 'overlay' }}
                    rightDockWidthPx={360}
                    detailsDockWidthPx={520}
                    onCloseRight={() => {}}
                    onCloseDetails={() => {}}
                    onCommitRightDockWidthPx={() => {}}
                    onCommitDetailsDockWidthPx={() => {}}
                />)).tree;

        const parkedPane = tree.findByTestId('multi-pane-right-parked');
        if (!parkedPane) throw new Error('expected parked right pane');
        expect(parkedPane.props.pointerEvents).toBe('none');

        if (Platform.OS === 'web') {
            expect(parkedPane.props.inert).toBe(true);
            expect(parkedPane.props['aria-hidden']).toBe(true);
        } else {
            expect(parkedPane.props.accessibilityElementsHidden).toBe(true);
            expect(parkedPane.props.importantForAccessibility).toBe('no-hide-descendants');
        }
    });
});

type MountTracker = {
    mounts: Record<string, number>;
    unmounts: Record<string, number>;
};

function createMountTracker(): MountTracker {
    return { mounts: {}, unmounts: {} };
}

function Tracked(props: Readonly<{ tracker: MountTracker; name: string }>) {
    React.useEffect(() => {
        props.tracker.mounts[props.name] = (props.tracker.mounts[props.name] ?? 0) + 1;
        return () => {
            props.tracker.unmounts[props.name] = (props.tracker.unmounts[props.name] ?? 0) + 1;
        };
    }, [props.name, props.tracker]);
    return React.createElement(props.name);
}

function Main() {
    return React.createElement('Main');
}
