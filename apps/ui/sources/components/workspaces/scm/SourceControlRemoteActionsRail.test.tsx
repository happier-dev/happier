import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SourceControlRemoteActionsRail } from './SourceControlRemoteActionsRail';
import {
    createThemeFixture,
    findTestInstanceByTypeWithProps,
    pressTestInstanceAsync,
    renderScreen,
} from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('SourceControlRemoteActionsRail', () => {
    const theme = createThemeFixture();

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
                        { key: 'fetch', iconName: 'arrows-clockwise', label: 'Fetch', disabled: false, onPress: onFetch },
                        { key: 'pull', iconName: 'arrow-down', label: 'Pull', disabled: false, onPress: onPull },
                    ]}
                />);

        const fetchButton = findTestInstanceByTypeWithProps(screen.tree, 'Pressable' as any, {
            accessibilityRole: 'button',
            accessibilityLabel: 'Fetch',
        });
        expect(fetchButton).toBeTruthy();

        await pressTestInstanceAsync(fetchButton, 'Fetch action');
        expect(onFetch).toHaveBeenCalledTimes(1);
    });

    it('forwards stable action test ids', async () => {
        const screen = await renderScreen(<SourceControlRemoteActionsRail
                    theme={theme}
                    actions={[
                        { key: 'fetch', iconName: 'arrows-clockwise', label: 'Fetch', disabled: false, onPress: vi.fn(), testID: 'scm-update-remote-action-fetch' },
                    ]}
                />);

        expect(screen.findByTestId('scm-update-remote-action-fetch')).toBeTruthy();
    });

    it('accepts the publish upload icon without casts', async () => {
        const onPublish = vi.fn();

        const screen = await renderScreen(<SourceControlRemoteActionsRail
                    theme={theme}
                    actions={[
                        { key: 'publish', iconName: 'upload', label: 'Publish', disabled: false, onPress: onPublish },
                    ]}
                />);

        const octicon = screen.findByType('Icon' as any);
        expect(octicon.props.name).toBe('upload');
    });
});
