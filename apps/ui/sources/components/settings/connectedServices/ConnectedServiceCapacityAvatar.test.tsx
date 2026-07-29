import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ConnectedServiceCapacityAvatar } from './ConnectedServiceCapacityAvatar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-svg', () => ({
    Svg: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Svg', props, props.children),
    Circle: (props: Record<string, unknown>) => React.createElement('Circle', props, null),
}));

function renderAvatar(element: React.ReactElement): ReactTestRenderer {
    let tree: ReactTestRenderer | null = null;
    act(() => {
        tree = create(element);
    });
    if (tree === null) throw new Error('ConnectedServiceCapacityAvatar did not mount');
    return tree;
}

describe('ConnectedServiceCapacityAvatar', () => {
    it('renders the center label and one concentric ring per limit (no brand glyph / dot)', () => {
        const tree = renderAvatar(
            <ConnectedServiceCapacityAvatar
                rings={[{ ratio: 0.2, tone: 'danger' }, { ratio: 0.7, tone: 'success' }]}
                centerLabel="20"
                testID="av"
                accessibilityLabel="20% capacity"
            />,
        );

        expect(tree.root.findByProps({ testID: 'av:capacity' }).props.children).toBe('20');
        expect(tree.root.findByProps({ accessibilityLabel: '20% capacity' })).toBeTruthy();
        // 2 limits -> 2 track + 2 progress arcs.
        expect(tree.root.findAllByType('Circle' as never).length).toBe(4);
        // No brand badge / status dot exist anymore.
        expect(tree.root.findAllByProps({ testID: 'av:health-dot' }).length).toBe(0);
        expect(tree.root.findAllByProps({ testID: 'av:badge' }).length).toBe(0);
    });

    it('hides the center label when null and renders a faint single track for no limits', () => {
        const tree = renderAvatar(
            <ConnectedServiceCapacityAvatar rings={[]} centerLabel={null} testID="av" />,
        );

        expect(tree.root.findAllByProps({ testID: 'av:capacity' }).length).toBe(0);
        // Empty rings -> a single faint track arc (1 track + 1 progress).
        expect(tree.root.findAllByType('Circle' as never).length).toBe(2);
    });

    it('renders a loading indicator (not an empty/"no usage" ring) while a snapshot loads', () => {
        // A slow load must read as "loading", not "no usage": the center shows a
        // spinner and the numeric capacity label is suppressed even if one is
        // passed, so a pending snapshot never looks like a genuinely-empty avatar.
        const tree = renderAvatar(
            <ConnectedServiceCapacityAvatar rings={[]} centerLabel="0" loading testID="av" />,
        );

        expect(tree.root.findByProps({ testID: 'av:loading' })).toBeTruthy();
        expect(tree.root.findAllByProps({ testID: 'av:capacity' }).length).toBe(0);
    });
});
