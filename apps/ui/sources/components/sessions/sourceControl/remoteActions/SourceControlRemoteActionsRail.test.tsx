import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { SourceControlRemoteActionsRail } from './SourceControlRemoteActionsRail';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('SourceControlRemoteActionsRail', () => {
    const theme = {
        colors: {
            divider: '#333',
            surface: '#111',
            surfaceHigh: '#222',
            text: '#eee',
            textSecondary: '#aaa',
        },
    } as any;

    it('renders nothing when there are no actions', () => {
        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(<SourceControlRemoteActionsRail theme={theme} actions={[]} />);
        });
        expect(tree!.toJSON()).toBeNull();
    });

    it('renders actions and invokes handlers', () => {
        const onFetch = vi.fn();
        const onPull = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SourceControlRemoteActionsRail
                    theme={theme}
                    actions={[
                        { key: 'fetch', iconName: 'sync', label: 'Fetch', disabled: false, onPress: onFetch },
                        { key: 'pull', iconName: 'arrow-down', label: 'Pull', disabled: false, onPress: onPull },
                    ]}
                />
            );
        });

        const buttons = (tree! as any).root.findAll((node: any) => node.props?.accessibilityRole === 'button');
        expect(buttons.length).toBe(2);
        act(() => {
            buttons[0].props.onPress();
        });
        expect(onFetch).toHaveBeenCalledTimes(1);
    });

    it('accepts the publish upload icon without casts', () => {
        const onPublish = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SourceControlRemoteActionsRail
                    theme={theme}
                    actions={[
                        { key: 'publish', iconName: 'upload', label: 'Publish', disabled: false, onPress: onPublish },
                    ]}
                />
            );
        });

        const octicon = (tree! as any).root.findByType('Octicons' as any);
        expect(octicon.props.name).toBe('upload');
    });
});
