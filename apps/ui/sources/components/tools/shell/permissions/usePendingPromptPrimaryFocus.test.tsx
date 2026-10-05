import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
    createTestSessionTranscriptSource,
    renderWithSessionTranscriptSource,
    standardCleanup,
} from '@/dev/testkit';
import { setPendingNavigationLanding } from '@/activity/source/pendingNavigationRuntime';
import { usePendingPromptLanding } from './usePendingPromptPrimaryFocus';
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
});
