import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { SourceControlRemoteActionsRail } from './SourceControlRemoteActionsRail';
import { renderScreen } from '@/dev/testkit';


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

    it('renders nothing when there are no actions', async () => {
        const { tree } = await renderScreen(<SourceControlRemoteActionsRail theme={theme} actions={[]} />);
        expect(tree.toJSON()).toBeNull();
    });

    it('renders actions and invokes handlers', async () => {
        const onFetch = vi.fn();
        const onPull = vi.fn();

        const screen = await renderScreen(<SourceControlRemoteActionsRail
                    theme={theme}
                    actions={[
                        { key: 'fetch', iconName: 'sync', label: 'Fetch', disabled: false, onPress: onFetch },
                        { key: 'pull', iconName: 'arrow-down', label: 'Pull', disabled: false, onPress: onPull },
                    ]}
                />);

        const buttons = screen.findAllByProps({ accessibilityRole: 'button' });
        expect(buttons.length).toBe(2);
        act(() => {
            buttons.find((button: any) => button.props?.onPress === onFetch)?.props.onPress();
        });
        expect(onFetch).toHaveBeenCalledTimes(1);
    });

    it('accepts the publish upload icon without casts', async () => {
        const onPublish = vi.fn();

        const screen = await renderScreen(<SourceControlRemoteActionsRail
                    theme={theme}
                    actions={[
                        { key: 'publish', iconName: 'upload', label: 'Publish', disabled: false, onPress: onPublish },
                    ]}
                />);

        const octicon = screen.findByType('Octicons' as any);
        expect(octicon.props.name).toBe('upload');
    });
});
