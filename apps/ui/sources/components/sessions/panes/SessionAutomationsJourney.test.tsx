import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

import { createRootLayoutFeaturesResponse, renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { createSessionPaneScopeId } from './sessionPaneScopeId';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';

installSessionDetailsPanelCommonModuleMocks();
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

const runtime = installSessionPaneRuntimeTestHarness({
    scopeId: ({ sessionId, serverId }) => createSessionPaneScopeId(sessionId, serverId),
    features: () => createRootLayoutFeaturesResponse({ features: { workflows: { enabled: true } } }),
});
const { AppPaneScopeHost } = await import('@/components/appShell/panes/AppPaneScopeHost');
const { SessionRightPanel, SessionRightSidebarProvider } = await import('./SessionRightPanel');
const { SubjectTriggersSection } = await import('@/components/workflows/triggers/SubjectTriggersSection');

it('opens the same canonical Automations editor from Info and keeps Work free of editors', async () => {
    const scopeId = createSessionPaneScopeId('s1', runtime.serverId);
    const wrap = (chat: React.ReactElement) => <SessionRightSidebarProvider sessionId="s1" scopeId={scopeId}>
        {chat}<SessionRightPanel sessionId="s1" scopeId={scopeId} />
    </SessionRightSidebarProvider>;
    const screen = await renderScreen(<runtime.Wrapper>
        <AppPaneScopeHost scopeId={scopeId} main={<div>Chat</div>} wrapScopeContent={wrap} />
    </runtime.Wrapper>);
    try {
        await act(async () => { runtime.pane.openRight({ tabId: 'info' }); });
        await expect.poll(() => screen.findAllByProps({ testID: 'session-info-automations-summary' }).length).toBeGreaterThan(0);
        expect(screen.findAllByType(SubjectTriggersSection)).toHaveLength(0);
        await screen.pressByTestIdAsync('session-info-automations-summary');
        await expect.poll(() => runtime.pane.scopeState?.right.activeTabId).toBe('automations');
        await expect.poll(() => screen.findAllByType(SubjectTriggersSection).length).toBe(1);
        await act(async () => { runtime.pane.openRight({ tabId: 'agents' }); });
        expect(runtime.pane.scopeState?.right.activeTabId).toBe('agents');
        expect(screen.findAllByType(SubjectTriggersSection).length).toBeLessThanOrEqual(1);
    } finally {
        await screen.unmount();
    }
});
