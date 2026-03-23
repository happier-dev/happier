import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from '../sessionDetailsPanelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const openDetailsTabSpy = vi.fn();
const routerPushSpy = vi.fn();
let SessionRightPanelAgentsView: typeof import('./SessionRightPanelAgentsView').SessionRightPanelAgentsView;
const sessionState = vi.hoisted(() => ({
    session: { id: 's1', metadata: { flavor: 'claude' } } as any,
}));
const sessionExecutionRunsSupportedState = vi.hoisted(() => ({ supported: true }));
const executionRunsBackendsState = vi.hoisted(() => ({
    backends: { claude: { available: true, intents: ['review', 'plan', 'delegate'] } } as Record<string, unknown> | null,
}));
const sessionMachineReachabilityState = vi.hoisted(() => ({
    machineReachable: true,
    machineOnline: true,
    machineRpcTargetAvailable: true,
}));
const directSessionRuntimeState = vi.hoisted(() => ({
    directSessionLink: null as null | {
        v: 1;
        providerId: string;
        machineId: string;
        remoteSessionId: string;
        source: 'provider';
    },
    status: null as null | { runnerActive?: boolean },
}));

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (value: any) => value?.web ?? value?.default,
            },
            View: ({ children, ...props }: any) => React.createElement('View', props, children),
            ScrollView: ({ children, ...props }: any) => React.createElement('ScrollView', props, children),
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    surface: '#fff',
                    surfaceHigh: '#f5f5f5',
                    divider: '#ddd',
                    text: '#000',
                    textSecondary: '#666',
                    shadow: { color: '#000' },
                    accent: {
                        blue: '#007AFF',
                        green: '#34C759',
                        orange: '#FF9500',
                        yellow: '#FFCC00',
                        red: '#FF3B30',
                        indigo: '#5856D6',
                        purple: '#AF52DE',
                    },
                },
            },
        });
    },
    icons: async () => ({
        Ionicons: 'Ionicons',
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, values?: Record<string, unknown>) => {
                if (key === 'session.subagents.intent.review') return 'Review';
                if (key === 'executionRuns.details.titles.executionRun') return 'Subagent';
                if (key === 'executionRuns.details.titles.executionRunWithIntent' && values?.intent) {
                    return `${values.intent} Subagent`;
                }
                if (key === 'session.subagents.panel.sectionCount' && typeof values?.count === 'number') {
                    return `${values.count}`;
                }
                return key;
            },
        });
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useSession: () => sessionState.session,
            useSettings: () => ({}),
        });
    },
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
    TextInput: (props: any) => React.createElement('TextInput', props),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: vi.fn(async () => undefined),
    },
}));

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => sessionMachineReachabilityState,
}));

vi.mock('@/sync/store/hooks', () => ({
    useSessionMessages: () => ({ messages: [] }),
    useSessionMessagesReducerState: () => ({
        sidechains: new Map([
            ['toolu_1', [
                {
                    id: 'sidechain-msg-1',
                    role: 'agent',
                    text: 'Alpha is validating the auth flow now.',
                    tool: {
                        permission: {
                            id: 'perm-alpha',
                            status: 'pending',
                            kind: 'permission',
                        },
                    },
                    event: null,
                },
            ]],
        ]),
        permissions: new Map(),
    }),
}));

const subagents: readonly SessionSubagent[] = [
    {
        id: 'agent_team_member:team-1:alpha',
        kind: 'agent_team_member',
        status: 'running',
        display: { title: 'alpha', providerLabel: 'Claude', groupKey: 'team-1', groupLabel: 'team-1' },
        transcript: { toolMessageRouteId: 'tool-msg-1', sidechainId: 'toolu_1', toolId: 'toolu_1' },
        recipient: { kind: 'agent_team_member', teamId: 'team-1', memberId: 'alpha@team-1', memberLabel: 'alpha' },
        capabilities: { canOpen: true, canSend: true, canStop: false, canLaunchChild: false, canDelete: true, canOpenAdvancedRun: false },
        timestamps: {},
    },
    {
        id: 'execution_run:run_1',
        kind: 'execution_run',
        status: 'succeeded',
        display: { title: 'Code review', providerLabel: 'Codex' },
        transcript: { toolMessageRouteId: 'tool-msg-2', sidechainId: 'call_2', toolId: 'call_2' },
        runRef: { runId: 'run_1', backendId: 'codex' },
        recipient: null,
        capabilities: { canOpen: true, canSend: false, canStop: false, canLaunchChild: false, canDelete: false, canOpenAdvancedRun: true },
        timestamps: {},
    },
];

vi.mock('@/hooks/session/useSessionSubagents', () => ({
    useSessionSubagents: () => ({
        subagents,
        participantTargets: [],
        sidechainIds: [],
    }),
}));

vi.mock('@/hooks/server/useSessionExecutionRunsSupported', () => ({
    useSessionExecutionRunsSupported: () => sessionExecutionRunsSupportedState.supported,
}));

vi.mock('@/hooks/server/useExecutionRunsBackendsForSession', () => ({
    useExecutionRunsBackendsForSession: () => executionRunsBackendsState.backends,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/components/sessions/model/useDirectSessionRuntime', () => ({
    useDirectSessionRuntime: () => directSessionRuntimeState,
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        openDetailsTab: openDetailsTabSpy,
    }),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'tablet',
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
        router: { push: routerPushSpy },
    });
    return routerMock.module;
});

describe('SessionRightPanelAgentsView', () => {
    beforeAll(async () => {
        ({ SessionRightPanelAgentsView } = await import('./SessionRightPanelAgentsView'));
    }, 120_000);

    beforeEach(() => {
        openDetailsTabSpy.mockReset();
        routerPushSpy.mockReset();
        sessionState.session = { id: 's1', metadata: { flavor: 'claude' } };
        sessionExecutionRunsSupportedState.supported = true;
        executionRunsBackendsState.backends = { claude: { available: true, intents: ['review', 'plan', 'delegate'] } };
        sessionMachineReachabilityState.machineReachable = true;
        sessionMachineReachabilityState.machineOnline = true;
        sessionMachineReachabilityState.machineRpcTargetAvailable = true;
        directSessionRuntimeState.directSessionLink = null;
        directSessionRuntimeState.status = null;
    });

    it('renders active and recent sections and opens preview/full routes from agent rows', async () => {
        const screen = await renderScreen(<SessionRightPanelAgentsView sessionId="s1" scopeId="session:s1" />);

        expect(screen.findByTestId('session-agents-section-active')).toBeTruthy();
        expect(screen.findByTestId('session-agents-section-recent')).toBeTruthy();
        expect(screen.findByTestId('session-rightpanel-agents-scroll')).toBeTruthy();
        expect(screen.findByTestId('session-agents-section-count:session-agents-section-active')).toBeTruthy();
        expect(screen.findByTestId('session-agents-section-count:session-agents-section-recent')).toBeTruthy();
        expect(screen.findByTestId('session-subagent-row:agent_team_member:team-1:alpha')).toBeTruthy();
        expect(screen.findByTestId('session-subagent-row:execution_run:run_1')).toBeTruthy();

        await act(async () => {
            screen.pressByTestId('session-subagent-row:agent_team_member:team-1:alpha');
        });
        expect(openDetailsTabSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                key: 'subagent:agent_team_member:team-1:alpha',
                kind: 'subagent',
                title: 'alpha',
                subtitle: expect.any(String),
                resource: { kind: 'subagent', subagentId: 'agent_team_member:team-1:alpha' },
            }),
            { intent: 'preview' },
        );
        await act(async () => {
            screen.pressByTestId('session-subagent-open-full:execution_run:run_1');
        });
        expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/message/tool-msg-2');

        await act(async () => {
            screen.pressByTestId('session-subagent-open-advanced:execution_run:run_1');
        });
        expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/runs/run_1');
    });

    it('keeps launch actions collapsed by default when the session already has agents and expands them on demand', async () => {
        const screen = await renderScreen(<SessionRightPanelAgentsView sessionId="s1" scopeId="session:s1" />);

        expect(screen.findByTestId('session-subagents-launch-section')).toBeTruthy();
        expect(screen.findByTestId('session-subagents-launch-section-toggle')).toBeTruthy();
        expect(screen.findByTestId('session-subagent-launch-execution-run')).toBeNull();

        await act(async () => {
            screen.pressByTestId('session-subagents-launch-section-toggle');
        });

        expect(screen.findByTestId('session-subagent-launch-execution-run')).toBeTruthy();
        await act(async () => {
            screen.pressByTestId('session-subagent-launch-execution-run:review');
        });

        expect(openDetailsTabSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                key: 'execution-run-launcher:review',
                kind: 'executionRunLauncher',
                resource: {
                    kind: 'executionRunLauncher',
                    intent: 'review',
                },
            }),
            { intent: 'preview' },
        );
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('uses a minimal outer launch section shell and uppercase 14px section headings', async () => {
        const screen = await renderScreen(<SessionRightPanelAgentsView sessionId="s1" scopeId="session:s1" />);

        const launchSection = screen.findByTestId('session-subagents-launch-section');
        const launchSectionTitle = screen.findByTestId('session-subagents-launch-section-title');
        const activeSection = screen.findByTestId('session-agents-section-active');
        const recentSection = screen.findByTestId('session-agents-section-recent');

        expect(launchSection).toBeTruthy();
        expect(launchSectionTitle).toBeTruthy();
        expect(activeSection).toBeTruthy();
        expect(recentSection).toBeTruthy();

        if (!launchSection || !launchSectionTitle || !activeSection || !recentSection) {
            throw new Error('expected session subagent section nodes');
        }

        expect(launchSection.props.style).toMatchObject({
            gap: 10,
        });
        expect(launchSection.props.style.borderWidth).toBeUndefined();
        expect(launchSection.props.style.borderRadius).toBeUndefined();
        expect(launchSection.props.style.backgroundColor).toBeUndefined();
        expect(launchSection.props.style.paddingHorizontal).toBeUndefined();
        expect(launchSection.props.style.paddingVertical).toBeUndefined();

        expect(launchSectionTitle.findAllByType('Text')[0].props.style).toMatchObject({
            fontSize: 14,
            textTransform: 'uppercase',
        });
        expect(activeSection.findAllByType('Text')[0].props.style).toMatchObject({
            fontSize: 14,
            textTransform: 'uppercase',
        });
        expect(recentSection.findAllByType('Text')[0].props.style).toMatchObject({
            fontSize: 14,
            textTransform: 'uppercase',
        });
    });

    it('uses a human-friendly details-tab title for execution runs even when the subagent display title is a raw run id', async () => {
        const { createSessionSubagentDetailsTab } = await import('@/components/sessions/agents/navigation/createSessionSubagentDetailsTab');

        const tab = createSessionSubagentDetailsTab({
            id: 'execution_run:run_42',
            kind: 'execution_run',
            status: 'running',
            display: { title: 'run_42', providerLabel: 'Codex' },
            transcript: { toolMessageRouteId: 'tool-msg-42', sidechainId: 'toolu_42', toolId: 'toolu_42' },
            runRef: { runId: 'run_42', backendId: 'codex', intent: 'review' },
            recipient: null,
            capabilities: { canOpen: true, canSend: false, canStop: true, canLaunchChild: false, canDelete: false, canOpenAdvancedRun: true },
            timestamps: {},
        } as SessionSubagent);

        expect(tab.title).toBe('Review Subagent');
    });

    it('opens execution-run rows into the shared subagent transcript details pane', async () => {
        const screen = await renderScreen(<SessionRightPanelAgentsView sessionId="s1" scopeId="session:s1" />);

        await act(async () => {
            screen.pressByTestId('session-subagent-row:execution_run:run_1');
        });

        expect(openDetailsTabSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                key: 'subagent:execution_run:run_1',
                kind: 'subagent',
                title: 'Code review',
                resource: { kind: 'subagent', subagentId: 'execution_run:run_1' },
            }),
            { intent: 'preview' },
        );
    });

    it('renders compact Claude launch actions and opens launcher previews in the details pane', async () => {
        const screen = await renderScreen(<SessionRightPanelAgentsView sessionId="s1" scopeId="session:s1" />);

        await act(async () => {
            screen.pressByTestId('session-subagents-launch-section-toggle');
        });

        await act(async () => {
            screen.pressByTestId('session-subagent-launch-claude-team');
        });
        expect(openDetailsTabSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                key: 'claude-subagent-launcher:team',
                kind: 'claudeSubagentLauncher',
                resource: {
                    kind: 'claudeSubagentLauncher',
                    mode: 'team',
                },
            }),
            { intent: 'preview' },
        );

        await act(async () => {
            screen.pressByTestId('session-subagent-launch-claude-teammate');
        });
        expect(openDetailsTabSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                key: 'claude-subagent-launcher:member:team-1',
                kind: 'claudeSubagentLauncher',
                resource: {
                    kind: 'claudeSubagentLauncher',
                    mode: 'member',
                    initialTeamId: 'team-1',
                },
            }),
            { intent: 'preview' },
        );

        await act(async () => {
            screen.pressByTestId('session-subagent-team-add:team-1');
        });
        expect(openDetailsTabSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                key: 'claude-subagent-launcher:member:team-1',
                kind: 'claudeSubagentLauncher',
                resource: {
                    kind: 'claudeSubagentLauncher',
                    mode: 'member',
                    initialTeamId: 'team-1',
                },
            }),
            { intent: 'preview' },
        );
    });

    it('renders the latest loaded sidechain activity preview for subagent rows', async () => {
        const screen = await renderScreen(<SessionRightPanelAgentsView sessionId="s1" scopeId="session:s1" />);

        expect(screen.findByTestId('session-subagent-activity:agent_team_member:team-1:alpha')?.props.children).toContain(
            'Alpha is validating the auth flow now.',
        );
    });

    it('marks subagent rows that are blocked waiting for permission', async () => {
        const screen = await renderScreen(<SessionRightPanelAgentsView sessionId="s1" scopeId="session:s1" />);

        expect(screen.findByTestId('session-subagent-permission-blocked:agent_team_member:team-1:alpha')).toBeTruthy();
    });

    it('keeps Subagent launch shortcuts available when the session is inactive but resumable', async () => {
        sessionState.session = {
            id: 's1',
            active: false,
            metadata: {
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
        };
        sessionExecutionRunsSupportedState.supported = true;
        executionRunsBackendsState.backends = { claude: { available: true, intents: ['review', 'plan', 'delegate'] } };

        const screen = await renderScreen(<SessionRightPanelAgentsView sessionId="s1" scopeId="session:s1" />);

        expect(screen.findByTestId('session-subagent-launch-execution-run')).toBeNull();
        await act(async () => {
            screen.pressByTestId('session-subagents-launch-section-toggle');
        });
        expect(screen.findByTestId('session-subagent-launch-execution-run')).toBeTruthy();
        expect(screen.findByTestId('session-subagent-launch-claude-team')).toBeTruthy();
    });

    it('keeps the Subagent launch card visible while live execution-run backends are still loading for an active local session', async () => {
        sessionState.session = {
            id: 's1',
            active: true,
            metadata: {
                flavor: 'claude',
            },
        };
        sessionExecutionRunsSupportedState.supported = false;
        executionRunsBackendsState.backends = null;

        const screen = await renderScreen(<SessionRightPanelAgentsView sessionId="s1" scopeId="session:s1" />);

        await act(async () => {
            screen.pressByTestId('session-subagents-launch-section-toggle');
        });

        expect(screen.findByTestId('session-subagent-launch-execution-run')).toBeTruthy();
    });

    it('still hides Subagent launch shortcuts when the session is inactive and not resumable', async () => {
        sessionState.session = {
            id: 's1',
            active: false,
            metadata: {
                flavor: 'claude',
            },
        };
        sessionExecutionRunsSupportedState.supported = true;
        executionRunsBackendsState.backends = { claude: { available: true, intents: ['review', 'plan', 'delegate'] } };

        const screen = await renderScreen(<SessionRightPanelAgentsView sessionId="s1" scopeId="session:s1" />);

        expect(screen.findByTestId('session-subagent-launch-execution-run')).toBeNull();
        await act(async () => {
            screen.pressByTestId('session-subagents-launch-section-toggle');
        });
        expect(screen.findByTestId('session-subagent-launch-execution-run')).toBeNull();
        expect(screen.findByTestId('session-subagent-launch-claude-team')).toBeTruthy();
    });

    it('hides execution-run launch shortcuts for linked direct sessions until the runner is locally active', async () => {
        sessionState.session = {
            id: 's1',
            active: true,
            metadata: {
                flavor: 'claude',
                directSessionV1: {
                    v: 1,
                    providerId: 'claude',
                    machineId: 'machine-1',
                    remoteSessionId: 'remote-session-1',
                    source: 'provider',
                },
            },
        };
        directSessionRuntimeState.directSessionLink = {
            v: 1,
            providerId: 'claude',
            machineId: 'machine-1',
            remoteSessionId: 'remote-session-1',
            source: 'provider',
        };
        directSessionRuntimeState.status = { runnerActive: false };

        const screen = await renderScreen(<SessionRightPanelAgentsView sessionId="s1" scopeId="session:s1" />);

        expect(screen.findByTestId('session-subagent-launch-execution-run')).toBeNull();
        await act(async () => {
            screen.pressByTestId('session-subagents-launch-section-toggle');
        });
        expect(screen.findByTestId('session-subagent-launch-claude-team')).toBeTruthy();
    });
});
