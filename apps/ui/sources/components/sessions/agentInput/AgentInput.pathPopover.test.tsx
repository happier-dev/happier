import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, flushHookEffects } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' }, {
            useWindowDimensions: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }),
        });
    },
});
const runtime = installSessionPaneRuntimeTestHarness();
let AgentInput: typeof import('./AgentInput')['AgentInput'];
let Popover: typeof import('@/components/ui/popover')['Popover'];
let FloatingOverlay: typeof import('@/components/ui/overlays/FloatingOverlay')['FloatingOverlay'];
beforeEach(async () => {
    ({ AgentInput } = await import('./AgentInput'));
    ({ Popover } = await import('@/components/ui/popover'));
    ({ FloatingOverlay } = await import('@/components/ui/overlays/FloatingOverlay'));
    storage.setState({ settings: { ...storage.getState().settings,
        agentInputEnterToSend: true, agentInputActionBarLayout: 'wrap', agentInputChipDensity: 'labels',
        sessionPermissionModeApplyTiming: 'immediate' } });
});

describe('AgentInput (path popover)', () => {
    it.each([
        { kind: 'path' as const, maxHeightCap: 540, maxWidthCap: 520 },
        { kind: 'machine' as const, maxHeightCap: 500, maxWidthCap: 480 },
        { kind: 'resume' as const, maxHeightCap: 460, maxWidthCap: 420 },
    ])('opens the shared content popover from the $kind chip when a $kind popover is provided', async ({ kind, maxHeightCap, maxWidthCap }) => {
        const onRoute = vi.fn();
        const config = {
            renderContent: () => React.createElement('View', { testID: `${kind}-popover-content` }),
            boundaryRef: null, maxHeightCap, maxWidthCap,
        };
        const props: Partial<React.ComponentProps<typeof AgentInput>> = kind === 'path'
            ? { pathPopover: config, onPathClick: onRoute, currentPath: '/Users/leeroy/project' }
            : kind === 'machine'
                ? { machinePopover: config, onMachineClick: onRoute, machineName: 'Builder' }
                : { resumePopover: config, onResumeClick: onRoute, resumeSessionId: null };
        const screen = await renderScreen(<AgentInput value="" placeholder="Type"
            onChangeText={() => {}} onSend={() => {}} autocompleteKinds={[]}
            autocompleteSuggestions={async () => []} {...props}
        />, {
            wrapper: runtime.Wrapper,
            // OS layout/ref measurement is the native boundary; all popover and overlay logic is real.
            createNodeMock: (element) => ({
                testID: element.props.testID,
                measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(20, 20, 140, 44),
                measure: (callback: (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void) => callback(20, 20, 140, 44, 20, 20),
            }),
        });
        await screen.pressByTestIdAsync(`agent-input-${kind}-chip`);
        await flushHookEffects();
        expect(onRoute).not.toHaveBeenCalled();
        const open = screen.root.findAllByType(Popover).find(node => node.props.open);
        expect(open).toBeDefined();
        const anchorRef = open?.props.anchorRef;
        if (!anchorRef) throw new Error('Expected the open chip popover to have an anchor ref');
        expect(anchorRef.current).not.toBeNull();
        expect(open?.props.boundaryRef).toBeNull();
        expect(open?.props.maxHeightCap).toBe(maxHeightCap);
        expect(open?.props.maxWidthCap).toBe(maxWidthCap);
        expect(screen.findByTestId(`${kind}-popover-content`)).toBeTruthy();
        expect(screen.findAllByType(FloatingOverlay).some(node => node.props.scrollEnabled === true)).toBe(true);

        // A second press closes the same intent without navigating to a fallback route.
        await screen.pressByTestIdAsync(`agent-input-${kind}-chip`);
        expect(screen.root.findAllByType(Popover).some(node => node.props.open)).toBe(false);
        expect(onRoute).not.toHaveBeenCalled();
    });
});
