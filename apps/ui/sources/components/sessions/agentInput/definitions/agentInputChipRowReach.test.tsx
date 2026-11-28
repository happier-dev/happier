import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { readHitFrameReach } from '@/dev/testkit/harness/hitFrameReach';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

import { AgentInputChipRowReach, resolveAgentInputChipRailHitReach } from './agentInputChipRowReach';
import { createPermissionActionChip } from './createPermissionActionChip';
import { KeyboardShortcutLabelsContext } from '@/keyboard/shortcutLabels';

const CHIP_HEIGHT = 32;

function permissionChip() {
    return createPermissionActionChip({
        anchorRef: { current: null },
        tint: '#000',
        showLabel: false,
        label: null,
        chipStyle: () => ({ height: CHIP_HEIGHT, width: 38 }),
        textStyle: {},
        onPress: () => {},
    });
}

describe('AgentInputChipRowReach', () => {
    // #1033 live: the chip's command and key went to a DOM `title` the web renderer drops, so hovering showed nothing.
    it('shows the shared tooltip with the effective command binding on hover, and hides it once the chip is pressed', async () => {
        const screen = await renderScreen(<KeyboardShortcutLabelsContext.Provider value={{ 'permission.open': 'Cmd+J' }}>
            {permissionChip()}
        </KeyboardShortcutLabelsContext.Provider>);
        const help = () => screen.findByTestId('agent-input-permission-chip-help');
        await act(async () => { help()?.props.onHoverIn?.(); });
        expect(screen.findByTestId('agent-input-permission-chip-help-tooltip')?.props.label).toBe('Permissions (Cmd+J)');
        await act(async () => { help()?.props.onPointerDown?.(); });
        expect(screen.findByTestId('agent-input-permission-chip-help-tooltip')).toBeNull();
        await act(async () => { help()?.props.onHoverOut?.(); });
        await act(async () => { help()?.props.onHoverIn?.(); });
        expect(screen.findByTestId('agent-input-permission-chip-help-tooltip')).toBeTruthy();
    });

    it('names an unbound command without a key', async () => {
        // The tooltip host carries the same label its bubble shows.
        const screen = await renderScreen(permissionChip());
        expect(screen.findByTestId('agent-input-permission-chip-help')?.props.accessibilityLabel).toBe('Permissions');
    });
    // A wrapping rail's chips are 6 px apart in a line and 1 px apart between lines and rails: each chip takes
    // half of every gap, so neighbours on any side meet instead of overlapping by the target's full reach.
    it('limits a chip to the reach its rail declares, and leaves a chip outside any rail its full reach', async () => {
        const inRail = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
                <AgentInputChipRowReach reach={resolveAgentInputChipRailHitReach(6)}>{permissionChip()}</AgentInputChipRowReach>
            </HappierUiPlatformProvider>,
        );
        expect(readHitFrameReach(inRail.findByTestId('agent-input-permission-chip')!)).toEqual({ top: 0.5, bottom: 0.5, left: 3, right: 3 });

        const alone = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
                <AgentInputChipRowReach reach={undefined}>{permissionChip()}</AgentInputChipRowReach>
            </HappierUiPlatformProvider>,
        );
        const lone = readHitFrameReach(alone.findByTestId('agent-input-permission-chip')!);
        expect(lone?.bottom).toBe(6);
    });
});
