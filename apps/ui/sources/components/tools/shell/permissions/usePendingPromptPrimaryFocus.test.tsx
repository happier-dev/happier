import * as React from 'react';
import { View } from 'react-native';
import { afterEach, describe, expect, it } from 'vitest';
import {
    createTestSessionTranscriptSource,
    renderScreen,
    renderWithSessionTranscriptSource,
    standardCleanup,
    wrapWithSessionTranscriptSource,
} from '@/dev/testkit';
import { setPendingNavigationLanding } from '@/activity/source/pendingNavigationRuntime';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { usePendingPromptLanding, usePendingPromptPrimaryFocus } from './usePendingPromptPrimaryFocus';
import { installPermissionShellCommonModuleMocks } from './permissionShellTestHelpers';

installPermissionShellCommonModuleMocks();

describe('pending prompt landing subscription locality', () => {
    afterEach(standardCleanup);

    it('does not rerender another request when the same-Session landing token changes', async () => {
        const address = { serverId: 'home-a', sessionId: 's1' };
        const renders = { p1: 0, p2: 0 };
        function Row(props: Readonly<{ requestId: keyof typeof renders }>) {
            renders[props.requestId] += 1;
            const landing = usePendingPromptLanding(props.requestId, `message-${props.requestId}`);
            return React.createElement('PendingLandingRow', { testID: props.requestId, selected: landing !== null });
        }
        setPendingNavigationLanding(address, 'p1', 'pending', 'transcript');
        const screen = await renderWithSessionTranscriptSource(<><Row requestId="p1" /><Row requestId="p2" /></>,
            createTestSessionTranscriptSource(address));
        const initial = { ...renders };
        await React.act(async () => {
            setPendingNavigationLanding(address, 'p1', 'pending', 'transcript');
        });
        expect(screen.findHostByTestId('p1')?.props.selected).toBe(true);
        expect(screen.findHostByTestId('p2')?.props.selected).toBe(false);
        expect(renders.p1).toBeGreaterThan(initial.p1);
        expect(renders.p2).toBe(initial.p2);
    });

    it('focuses a retained primary answer when its destination is revealed after the landing arrives', async () => {
        const address = { serverId: 'home-a', sessionId: 's1' };
        const source = createTestSessionTranscriptSource(address);
        let presented = false;
        let focused = false;
        const attempts: boolean[] = [];
        // Native/browser focus cannot activate a host in a hidden destination.
        const host = { focus: () => { attempts.push(presented); if (presented) focused = true; } };
        function Answer() {
            const ref = usePendingPromptPrimaryFocus('p1', true);
            return <View ref={ref} testID="retained-answer" />;
        }
        const tree = () => wrapWithSessionTranscriptSource(
            <PluginSurfaceFocusEligibilityProvider active={presented} presentationActive={presented}>
                <Answer />
            </PluginSurfaceFocusEligibilityProvider>, source,
        );
        setPendingNavigationLanding(address, 'p1');
        const screen = await renderScreen(tree(), { createNodeMock: element =>
            element.props.testID === 'retained-answer' ? host : null });
        presented = true;
        await screen.update(tree());
        expect({ focused, attempts }).toEqual({ focused: true, attempts: [true] });
    });
});
