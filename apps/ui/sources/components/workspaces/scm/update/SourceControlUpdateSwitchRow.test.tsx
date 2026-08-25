import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { createThemeFixture, pressTestInstance, renderScreen, type RenderScreenResult } from '@/dev/testkit';

import type { SourceControlUpdateTheme } from './SourceControlUpdateControls';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

/**
 * Stand in for the bundler's platform resolution: on web `@/components/ui/forms/Switch`
 * resolves to `Switch.web`, which is the implementation that carries `role="switch"` into
 * the DOM. Vitest has no `.web.tsx` extension resolution, so the swap is made explicitly.
 */
vi.mock('@/components/ui/forms/Switch', async () => await import('@/components/ui/forms/Switch.web'));

function themeFixture(): SourceControlUpdateTheme {
    return createThemeFixture() as unknown as SourceControlUpdateTheme;
}

/** Query the way an assistive technology does: find the control by ROLE, then read its name. */
function findSwitchControls(screen: RenderScreenResult): ReactTestInstance[] {
    return screen.findAll((node) => (
        node.props?.role === 'switch' || node.props?.accessibilityRole === 'switch'
    ));
}

describe('SourceControlUpdateSwitchRow (web)', () => {
    it('announces the switch by the row label instead of as a bare switch', async () => {
        const { SourceControlUpdateSwitchRow } = await import('./SourceControlUpdateSwitchRow');

        const screen = await renderScreen(
            <SourceControlUpdateSwitchRow
                theme={themeFixture()}
                testID="scm-publish-push-current-branch-switch"
                label="Push current branch"
                value
                onValueChange={() => {}}
            />,
        );

        const switches = findSwitchControls(screen);
        expect(switches).toHaveLength(1);
        expect(switches[0]!.props['aria-label'] ?? switches[0]!.props.accessibilityLabel)
            .toBe('Push current branch');
    });

    it('keeps the row testID addressable for the update tab', async () => {
        const { SourceControlUpdateSwitchRow } = await import('./SourceControlUpdateSwitchRow');

        const screen = await renderScreen(
            <SourceControlUpdateSwitchRow
                theme={themeFixture()}
                testID="scm-publish-push-current-branch-switch"
                label="Push current branch"
                value={false}
                onValueChange={() => {}}
            />,
        );

        expect(screen.findByTestId('scm-publish-push-current-branch-switch')).toBeTruthy();
    });

    // The row now renders through `Item`, which places the accessory in a slot it can also make
    // non-interactive. A switch that is named but no longer togglable would be a worse row than
    // the one this replaced, so the activation path is asserted, not assumed.
    it('still toggles when the switch is activated', async () => {
        const { SourceControlUpdateSwitchRow } = await import('./SourceControlUpdateSwitchRow');
        const onValueChange = vi.fn();

        const screen = await renderScreen(
            <SourceControlUpdateSwitchRow
                theme={themeFixture()}
                testID="scm-publish-push-current-branch-switch"
                label="Push current branch"
                value={false}
                onValueChange={onValueChange}
            />,
        );

        pressTestInstance(findSwitchControls(screen)[0], 'push current branch switch');
        expect(onValueChange).toHaveBeenCalledWith(true);
    });

    it('still reports the switch as disabled when the row is disabled', async () => {
        const { SourceControlUpdateSwitchRow } = await import('./SourceControlUpdateSwitchRow');

        const screen = await renderScreen(
            <SourceControlUpdateSwitchRow
                theme={themeFixture()}
                testID="scm-publish-push-current-branch-switch"
                label="Push current branch"
                value
                disabled
                onValueChange={() => {}}
            />,
        );

        const switches = findSwitchControls(screen);
        expect(switches).toHaveLength(1);
        expect(switches[0]!.props.disabled).toBe(true);
    });
});
