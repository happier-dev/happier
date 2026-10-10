import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, withPopoverWebGlobals } from '@/dev/testkit';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { t } from '@/text';

vi.mock('react-native-safe-area-context', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-native-safe-area-context')>(),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
}));
installSessionDetailsPanelNonRnModuleMocks({
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/session/s1' }).module,
});
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

const runtime = installSessionPaneRuntimeTestHarness({ scopeId: 'session:s1' });
let restoreWebGlobals: (() => void) | undefined;
beforeEach(() => { restoreWebGlobals = withPopoverWebGlobals(); });
afterEach(() => { restoreWebGlobals?.(); restoreWebGlobals = undefined; });

describe('SessionHeaderWorkStrip (lab session-C)', () => {
    it('hides while the Work tab is open beside the session, and returns when it closes or another tab shows', async () => {
        const { SessionHeaderWorkStrip } = await import('./SessionHeaderWorkStrip');
        const strip = <SessionHeaderWorkStrip sessionId="s1" serverId={runtime.serverId} scopeId="session:s1"
            summary={{ outstanding: 3, needsYou: 1, stalled: 0, sessions: 2, runs: 1 }} />;
        const working = () => t('sessionWork.strip.stillWorking', { count: 3 });
        const screen = await renderScreen(<runtime.Wrapper>{strip}</runtime.Wrapper>);
        expect(screen.getTextContent()).toContain(working());
        await act(async () => runtime.pane.openRight({ tabId: 'agents' }));
        await act(async () => screen.update(<runtime.Wrapper>{strip}</runtime.Wrapper>));
        expect(screen.getTextContent()).not.toContain(working());
        await act(async () => runtime.pane.setRightTab('git'));
        await act(async () => screen.update(<runtime.Wrapper>{strip}</runtime.Wrapper>));
        expect(screen.getTextContent()).toContain(working());
    });
});
