import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SourceControlRemoteActionsRail } from './SourceControlRemoteActionsRail';
import {
    createThemeFixture,
    findTestInstanceByTypeWithProps,
    pressTestInstanceAsync,
    renderScreen,
} from '@/dev/testkit';
import { hitAreaOverlap, readHitArea } from '@/dev/testkit/harness/hitFrameReach';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';


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

    // 34 px buttons sit 2 px apart: unbounded, each reaches 5 px sideways and neighbours overlap by 8.
    it('splits the rail gap between neighbouring buttons so their hit areas never overlap', async () => {
        const screen = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
                <SourceControlRemoteActionsRail
                    theme={theme}
                    actions={[
                        { key: 'fetch', iconName: 'arrows-clockwise', label: 'Fetch', disabled: false, onPress: vi.fn(), testID: 'fetch' },
                        { key: 'pull', iconName: 'arrow-down', label: 'Pull', disabled: false, onPress: vi.fn(), testID: 'pull' },
                    ]}
                />
            </HappierUiPlatformProvider>,
        );
        const drawn = { width: 34, height: 34 };
        const fetch = readHitArea(screen.findByTestId('fetch')!, drawn);
        const pull = readHitArea(screen.findByTestId('pull')!, drawn);
        expect(hitAreaOverlap(fetch, pull, { axis: 'horizontal', gap: 2 })).toBe(0);
        expect(fetch.height).toBe(44);
    });
});
