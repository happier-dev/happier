import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

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

function findHostNodesByTestId(
    tree: renderer.ReactTestRenderer,
    testID: string,
    hostType: 'View' | 'Pressable' | 'ScrollView',
): renderer.ReactTestInstance[] {
    return tree.root.findAll((node) => String(node.type) === hostType && node.props?.testID === testID);
}

function findTextNodeByChildren(
    tree: renderer.ReactTestRenderer,
    children: string,
): renderer.ReactTestInstance {
    return tree.root.find((node) => String(node.type) === 'Text' && node.props?.children === children);
}

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        AppState: actual.AppState ?? {
            currentState: 'active',
            addEventListener: () => ({ remove: () => {} }),
        },
        Platform: {
            ...actual.Platform,
            OS: 'web',
            select: (value: any) => value?.web ?? value?.default,
        },
        View: ({ children, ...props }: any) => React.createElement('View', props, children),
        ScrollView: ({ children, ...props }: any) => React.createElement('ScrollView', props, children),
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
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
    }),
    StyleSheet: {
        create: (styles: any) =>
            typeof styles === 'function'
                ? styles({
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
                })
                : styles,
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
    TextInput: (props: any) => React.createElement('TextInput', props),
}));

vi.mock('@/text', () => ({
    t: (key: string, values?: Record<string, unknown>) => {
        if (key === 'session.subagents.intent.review') return 'Review';
        if (key === 'executionRuns.details.titles.executionRun') return 'Happier subagent';
        if (key === 'executionRuns.details.titles.executionRunWithIntent' && values?.intent) {
            return `${values.intent} Happier subagent`;
        }
        if (key === 'session.subagents.panel.sectionCount' && typeof values?.count === 'number') {
            return `${values.count}`;
        }
        return key;
    },
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: vi.fn(async () => undefined),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSession: () => sessionState.session,
    useSettings: () => ({}),
}));

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => sessionMachineReachabilityState,
}));

vi.mock('@/sync/store/hooks', () => ({
    useSessionMessages: () => ({ messages: [] }),
    useSessionMessagesReducerState: () => ({
        sidechains: new Map([
            ['toolu_1', [{ id: 'sidechain-msg-1', role: 'agent', text: 'Alpha is validating the auth flow now.', tool: null, event: null }]],
        ]),
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

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushSpy }),
}));

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
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionRightPanelAgentsView sessionId="s1" scopeId="session:s1" />);
        });

        expect(findHostNodesByTestId(tree!, 'session-agents-section-active', 'View')).toHaveLength(1);
        expect(findHostNodesByTestId(tree!, 'session-agents-section-recent', 'View')).toHaveLength(1);
        expect(findHostNodesByTestId(tree!, 'session-rightpanel-agents-scroll', 'ScrollView')).toHaveLength(1);
        expect(findHostNodesByTestId(tree!, 'session-agents-section-count:session-agents-section-active', 'View')).toHaveLength(1);
        expect(findHostNodesByTestId(tree!, 'session-agents-section-count:session-agents-section-recent', 'View')).toHaveLength(1);
        expect(findHostNodesByTestId(tree!, 'session-subagent-row:agent_team_member:team-1:alpha', 'View').length).toBeGreaterThan(0);
        expect(findHostNodesByTestId(tree!, 'session-subagent-row:execution_run:run_1', 'View').length).toBeGreaterThan(0);

        const [openPreview] = findHostNodesByTestId(tree!, 'session-subagent-row:agent_team_member:team-1:alpha', 'View');
        await act(async () => {
            openPreview.props.onClick();
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
        const [openFull] = findHostNodesByTestId(tree!, 'session-subagent-open-full:execution_run:run_1', 'Pressable');
        await act(async () => {
            openFull.props.onPress();
        });
        expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/message/tool-msg-2');

        const [openAdvanced] = findHostNodesByTestId(tree!, 'session-subagent-open-advanced:execution_run:run_1', 'Pressable');
        await act(async () => {
            openAdvanced.props.onPress();
        });
        expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/runs/run_1');
    });

    it('keeps launch actions collapsed by default when the session already has agents and expands them on demand', async () => {
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionRightPanelAgentsView sessionId="s1" scopeId="session:s1" />);
        });

        expect(findHostNodesByTestId(tree!, 'session-subagents-launch-section', 'View')).toHaveLength(1);
        expect(findHostNodesByTestId(tree!, 'session-subagents-launch-section-toggle', 'Pressable')).toHaveLength(1);
        expect(findHostNodesByTestId(tree!, 'session-subagent-launch-execution-run', 'View')).toHaveLength(0);

        const [toggle] = findHostNodesByTestId(tree!, 'session-subagents-launch-section-toggle', 'Pressable');
        await act(async () => {
            toggle.props.onPress();
        });

        expect(findHostNodesByTestId(tree!, 'session-subagent-launch-execution-run', 'View')).toHaveLength(1);
        const [reviewLaunch] = findHostNodesByTestId(tree!, 'session-subagent-launch-execution-run:review', 'Pressable');
        await act(async () => {
            reviewLaunch.props.onPress();
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
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionRightPanelAgentsView sessionId="s1" scopeId="session:s1" />);
        });

        const [launchSection] = findHostNodesByTestId(tree!, 'session-subagents-launch-section', 'View');
        expect(launchSection.props.style).toMatchObject({
            gap: 10,
        });
        expect(launchSection.props.style.borderWidth).toBeUndefined();
        expect(launchSection.props.style.borderRadius).toBeUndefined();
        expect(launchSection.props.style.backgroundColor).toBeUndefined();
        expect(launchSection.props.style.paddingHorizontal).toBeUndefined();
        expect(launchSection.props.style.paddingVertical).toBeUndefined();

        expect(findTextNodeByChildren(tree!, 'session.subagents.panel.launchSectionTitle').props.style).toMatchObject({
            fontSize: 14,
            textTransform: 'uppercase',
        });
        expect(findTextNodeByChildren(tree!, 'session.subagents.panel.active').props.style).toMatchObject({
            fontSize: 14,
            textTransform: 'uppercase',
        });
        expect(findTextNodeByChildren(tree!, 'session.subagents.panel.recent').props.style).toMatchObject({
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

        expect(tab.title).toBe('Review Happier subagent');
    });

    it('opens execution-run rows into the shared subagent transcript details pane', async () => {
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionRightPanelAgentsView sessionId="s1" scopeId="session:s1" />);
        });

        const [openExecutionRunPreview] = findHostNodesByTestId(tree!, 'session-subagent-row:execution_run:run_1', 'View');
        await act(async () => {
            openExecutionRunPreview.props.onClick();
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
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionRightPanelAgentsView sessionId="s1" scopeId="session:s1" />);
        });

        const [toggle] = findHostNodesByTestId(tree!, 'session-subagents-launch-section-toggle', 'Pressable');
        await act(async () => {
            toggle.props.onPress();
        });

        const [launchTeam] = findHostNodesByTestId(tree!, 'session-subagent-launch-claude-team', 'Pressable');
        const [launchTeammate] = findHostNodesByTestId(tree!, 'session-subagent-launch-claude-teammate', 'Pressable');

        await act(async () => {
            launchTeam.props.onPress();
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
            launchTeammate.props.onPress();
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

        const [addTeammateToTeam] = findHostNodesByTestId(tree!, 'session-subagent-team-add:team-1', 'Pressable');
        await act(async () => {
            addTeammateToTeam.props.onPress();
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
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionRightPanelAgentsView sessionId="s1" scopeId="session:s1" />);
        });

        expect(tree!.root.findAllByProps({ testID: 'session-subagent-activity:agent_team_member:team-1:alpha' }).length).toBeGreaterThan(0);
        expect(tree!.root.findByProps({ testID: 'session-subagent-activity:agent_team_member:team-1:alpha' }).props.children).toContain(
            'Alpha is validating the auth flow now.',
        );
    });

    it('keeps Happier subagent launch shortcuts available when the session is inactive but resumable', async () => {
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

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionRightPanelAgentsView sessionId="s1" scopeId="session:s1" />);
        });

        expect(findHostNodesByTestId(tree!, 'session-subagent-launch-execution-run', 'View')).toHaveLength(0);
        const [toggle] = findHostNodesByTestId(tree!, 'session-subagents-launch-section-toggle', 'Pressable');
        await act(async () => {
            toggle.props.onPress();
        });
        expect(findHostNodesByTestId(tree!, 'session-subagent-launch-execution-run', 'View')).toHaveLength(1);
        expect(findHostNodesByTestId(tree!, 'session-subagent-launch-claude-team', 'Pressable')).toHaveLength(1);
    });

    it('still hides Happier subagent launch shortcuts when the session is inactive and not resumable', async () => {
        sessionState.session = {
            id: 's1',
            active: false,
            metadata: {
                flavor: 'claude',
            },
        };
        sessionExecutionRunsSupportedState.supported = true;
        executionRunsBackendsState.backends = { claude: { available: true, intents: ['review', 'plan', 'delegate'] } };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionRightPanelAgentsView sessionId="s1" scopeId="session:s1" />);
        });

        expect(findHostNodesByTestId(tree!, 'session-subagent-launch-execution-run', 'View')).toHaveLength(0);
        const [toggle] = findHostNodesByTestId(tree!, 'session-subagents-launch-section-toggle', 'Pressable');
        await act(async () => {
            toggle.props.onPress();
        });
        expect(findHostNodesByTestId(tree!, 'session-subagent-launch-execution-run', 'View')).toHaveLength(0);
        expect(findHostNodesByTestId(tree!, 'session-subagent-launch-claude-team', 'Pressable')).toHaveLength(1);
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

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionRightPanelAgentsView sessionId="s1" scopeId="session:s1" />);
        });

        expect(findHostNodesByTestId(tree!, 'session-subagent-launch-execution-run', 'View')).toHaveLength(0);
        const [toggle] = findHostNodesByTestId(tree!, 'session-subagents-launch-section-toggle', 'Pressable');
        await act(async () => {
            toggle.props.onPress();
        });
        expect(findHostNodesByTestId(tree!, 'session-subagent-launch-claude-team', 'Pressable')).toHaveLength(1);
    });
});
