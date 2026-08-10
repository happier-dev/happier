import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { makeSessionAgentActivityFixture, renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const BUSY_SESSION_ID = 'session-agents-busy';
const IDLE_SESSION_ID = 'session-agents-idle';

/**
 * Two agents still working, one finished. The badge counts running work only, so `2` is the value
 * that separates the intended behaviour from "total" (3) and from "recent" (1).
 */
const busySession = makeSessionAgentActivityFixture({
    sessionId: BUSY_SESSION_ID,
    subagents: [
        { key: 'alpha', title: 'Alpha', status: 'running' },
        { key: 'beta', title: 'Beta', status: 'running' },
        { key: 'gamma', title: 'Gamma', status: 'succeeded' },
    ],
});

const idleSession = makeSessionAgentActivityFixture({
    sessionId: IDLE_SESSION_ID,
    subagents: [{ key: 'gamma', title: 'Gamma', status: 'succeeded' }],
});

const sessionsById = {
    [BUSY_SESSION_ID]: busySession,
    [IDLE_SESSION_ID]: idleSession,
} as const;

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key, params) => (
                typeof params?.count === 'number' ? `${key}:${params.count}` : key
            ),
        });
    },
    storage: async () => {
        const { createStorageModuleStub, createSessionMessagesHooksMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSetting: () => 'sidebar',
            useSettings: () => ({}),
            useSession: (sessionId: string) => sessionsById[sessionId as keyof typeof sessionsById]?.session ?? null,
            ...createSessionMessagesHooksMock({
                bySessionId: {
                    ...busySession.sessionMessagesBySessionId,
                    ...idleSession.sessionMessagesBySessionId,
                },
            }),
        });
    },
});

vi.mock('@/sync/store/hooks', async (importOriginal) => {
    const { createStoreHooksModuleMock, createSessionMessagesHooksMock } = await import('@/dev/testkit/mocks/storage');
    return createStoreHooksModuleMock({
        importOriginal: importOriginal as <T>() => Promise<T>,
        overrides: createSessionMessagesHooksMock({
            bySessionId: {
                ...busySession.sessionMessagesBySessionId,
                ...idleSession.sessionMessagesBySessionId,
            },
        }),
    });
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'tablet',
}));

vi.mock('@/components/sessions/files/views/SessionRepositoryTreeBrowserView', () => ({
    SessionRepositoryTreeBrowserView: () => React.createElement('FilesView'),
}));

vi.mock('@/components/sessions/panes/git/SessionRightPanelGitView', () => ({
    SessionRightPanelGitView: () => React.createElement('GitView'),
}));

vi.mock('@/components/sessions/panes/agents/SessionRightPanelAgentsView', () => ({
    SessionRightPanelAgentsView: () => React.createElement('AgentsView'),
}));

vi.mock('@/components/sessions/panes/SessionTranscriptNavigationPane', () => ({
    SessionTranscriptNavigationPane: () => React.createElement('NavigationView'),
}));

const scopeState: any = { right: { isOpen: true, activeTabId: 'git', tabState: {} } };

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState,
        openRight: vi.fn(),
        setRightTab: vi.fn(),
        closeRight: vi.fn(),
        openDetailsTab: vi.fn(),
    }),
}));

describe('SessionRightPanel (agents tab badge)', () => {
    it('badges the Agents tab with the running-agent count and names it for a screen reader', async () => {
        // Guard against the vacuous-green trap: the fixture must produce a real derived roster, and
        // the badge must show the running subset rather than the roster size.
        const { deriveSessionSubagents } = await import('@/sync/domains/session/subagents/deriveSessionSubagents');
        const derived = deriveSessionSubagents({
            session: { metadata: { flavor: 'claude' } },
            messages: busySession.messages,
            activeExecutionRuns: [],
        });
        expect(derived).toHaveLength(3);
        expect(derived.filter((subagent) => subagent.status === 'running')).toHaveLength(2);

        const { SessionRightPanel } = await import('./SessionRightPanel');
        const screen = await renderScreen(
            <SessionRightPanel sessionId={BUSY_SESSION_ID} scopeId={`session:${BUSY_SESSION_ID}`} />,
        );

        const badge = screen.findByTestId('session-rightpanel-tab:agents:badge');
        expect(badge).not.toBeNull();
        expect(screen.getTextContent()).toContain('2');

        const agentsTab = screen.findByTestId('session-rightpanel-tab:agents');
        expect(agentsTab?.props.accessibilityLabel).toBe('session.subagents.panel.tabWithRunningCount:2');
    });

    it('shows no badge when nothing is running, and keeps the plain tab name', async () => {
        const { SessionRightPanel } = await import('./SessionRightPanel');
        const screen = await renderScreen(
            <SessionRightPanel sessionId={IDLE_SESSION_ID} scopeId={`session:${IDLE_SESSION_ID}`} />,
        );

        expect(screen.findByTestId('session-rightpanel-tab:agents:badge')).toBeNull();
        const agentsTab = screen.findByTestId('session-rightpanel-tab:agents');
        expect(agentsTab?.props.accessibilityLabel).toBe('session.subagents.panel.title');
    });
});
