import * as React from 'react';
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
