import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const stopRunSpy = vi.fn(async () => ({ ok: true }));
const sendMessageSpy = vi.fn(async () => undefined);
const modalAlertSpy = vi.fn();

vi.mock('react-native', () => ({
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    Platform: {
        OS: 'web',
        select: (value: { web?: unknown; default?: unknown }) => value.web ?? value.default,
    },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#fff',
                surfaceHigh: '#f5f5f5',
                divider: '#ddd',
                text: '#000',
                textSecondary: '#666',
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
}));

vi.mock('@/text', () => ({
    t: (key: string, values?: Record<string, unknown>) => {
        if (key === 'session.subagents.kind.execution_run') return 'Subagent';
        if (key === 'session.subagents.kind.agent_team_member') return 'Team agent';
        if (key === 'session.subagents.intent.review') return 'Review';
        if (key === 'session.subagents.panel.typeFact' && values?.value) return `Type: ${values.value}`;
        if (key === 'session.subagents.panel.providerFact' && values?.value) return `Provider: ${values.value}`;
        if (key === 'session.subagents.panel.intentFact' && values?.value) return `Intent: ${values.value}`;
        return key;
    },
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunStop: stopRunSpy,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: sendMessageSpy,
    },
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: modalAlertSpy,
    },
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>) => void promise,
}));

function findPressableByTestId(tree: renderer.ReactTestRenderer, testID: string): renderer.ReactTestInstance {
    const match = tree.root.findAllByProps({ testID })[0];
    if (!match) {
        throw new Error(`Missing Pressable ${testID}`);
    }
    return match;
}

function findHostNodesByTestId(
    tree: renderer.ReactTestRenderer,
    testID: string,
    hostType: 'View' | 'Pressable',
): renderer.ReactTestInstance[] {
    return tree.root.findAll((node) => String(node.type) === hostType && node.props?.testID === testID);
}

describe('SessionSubagentRow', () => {
    it('renders a non-button web row wrapper for clickable rows with nested action buttons', async () => {
        const { SessionSubagentRow } = await import('./SessionSubagentRow');
        const onOpenPreview = vi.fn();

        const subagent: SessionSubagent = {
            id: 'execution_run:run_web',
            kind: 'execution_run',
            status: 'running',
            display: { title: 'run_web', providerLabel: 'Codex' },
            transcript: { toolMessageRouteId: 'message_web', sidechainId: 'toolu_web', toolId: 'toolu_web' },
            runRef: { runId: 'run_web', backendId: 'codex', intent: 'review' },
            recipient: { kind: 'execution_run', runId: 'run_web', label: 'Web review' },
            capabilities: { canOpen: true, canSend: true, canStop: true, canLaunchChild: false, canDelete: false, canOpenAdvancedRun: true },
            timestamps: {},
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <SessionSubagentRow
                    sessionId="s1"
                    subagent={subagent}
                    onOpenPreview={onOpenPreview}
                    onOpenFull={vi.fn()}
                    onOpenAdvanced={vi.fn()}
                />,
            );
        });

        expect(findHostNodesByTestId(tree!, 'session-subagent-row:execution_run:run_web', 'Pressable')).toHaveLength(0);
        const [row] = findHostNodesByTestId(tree!, 'session-subagent-row:execution_run:run_web', 'View');
        expect(row).toBeTruthy();
        expect(row.props.accessibilityRole).toBeUndefined();
        expect(row.props.tabIndex).toBe(0);

        await act(async () => {
            row.props.onClick?.({ stopPropagation: vi.fn(), nativeEvent: { stopPropagation: vi.fn() } });
        });

        expect(onOpenPreview).toHaveBeenCalledTimes(1);
    });

    it('renders send/open-full/stop actions for execution runs', async () => {
        const { SessionSubagentRow } = await import('./SessionSubagentRow');
        const onOpenPreview = vi.fn();
        const onOpenFull = vi.fn();
        const onOpenAdvanced = vi.fn();

        const subagent: SessionSubagent = {
            id: 'execution_run:run_1',
            kind: 'execution_run',
            status: 'running',
            display: { title: 'run_1', providerLabel: 'Codex' },
            transcript: { toolMessageRouteId: 'message_1', sidechainId: 'toolu_1', toolId: 'toolu_1' },
            runRef: { runId: 'run_1', backendId: 'codex', intent: 'review' },
            recipient: { kind: 'execution_run', runId: 'run_1', label: 'Code review' },
            capabilities: { canOpen: true, canSend: true, canStop: true, canLaunchChild: false, canDelete: false, canOpenAdvancedRun: true },
            timestamps: {},
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <SessionSubagentRow
                    sessionId="s1"
                    subagent={subagent}
                    onOpenPreview={onOpenPreview}
                    onOpenFull={onOpenFull}
                    onOpenAdvanced={onOpenAdvanced}
                />,
            );
        });

        expect(findHostNodesByTestId(tree!, 'session-subagent-main:execution_run:run_1', 'View')).toHaveLength(1);
        expect(findHostNodesByTestId(tree!, 'session-subagent-actions:execution_run:run_1', 'View')).toHaveLength(1);
        expect(findHostNodesByTestId(tree!, 'session-subagent-footer:execution_run:run_1', 'View')).toHaveLength(1);

        const factRow = tree!.root.findAllByProps({ testID: 'session-subagent-facts:execution_run:run_1' })[0];
        const factTexts = factRow.findAllByType('Text').map((node) => node.props.children).join(' ');
        expect(factTexts).toContain('Type: Subagent');
        expect(factTexts).toContain('Provider: Codex');
        expect(factTexts).toContain('Intent: Review');

        await act(async () => {
            findPressableByTestId(tree!, 'session-subagent-open-advanced:execution_run:run_1').props.onPress();
        });
        expect(onOpenAdvanced).toHaveBeenCalledTimes(1);

        await act(async () => {
            findPressableByTestId(tree!, 'session-subagent-send:execution_run:run_1').props.onPress();
        });
        expect(onOpenPreview).toHaveBeenCalledTimes(1);
        expect(onOpenFull).toHaveBeenCalledTimes(0);

        await act(async () => {
            await findPressableByTestId(tree!, 'session-subagent-stop:execution_run:run_1').props.onPress();
        });
        expect(stopRunSpy).toHaveBeenCalledWith('s1', { runId: 'run_1' });
    });

    it('sends structured shutdown commands for Claude teammates', async () => {
        const { SessionSubagentRow } = await import('./SessionSubagentRow');

        const subagent: SessionSubagent = {
            id: 'agent_team_member:qa-team:alpha',
            kind: 'agent_team_member',
            status: 'running',
            display: { title: 'alpha', providerLabel: 'Claude', groupKey: 'qa-team', groupLabel: 'qa-team' },
            transcript: { toolMessageRouteId: 'message_2', sidechainId: 'toolu_2', toolId: 'toolu_2' },
            recipient: { kind: 'agent_team_member', teamId: 'qa-team', memberId: 'alpha@qa-team', memberLabel: 'alpha' },
            capabilities: { canOpen: true, canSend: true, canStop: false, canLaunchChild: false, canDelete: true, canOpenAdvancedRun: false },
            timestamps: {},
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <SessionSubagentRow
                    sessionId="s1"
                    subagent={subagent}
                    onOpenPreview={vi.fn()}
                    onOpenFull={vi.fn()}
                    onOpenAdvanced={null}
                />,
            );
        });

        await act(async () => {
            await findPressableByTestId(tree!, 'session-subagent-delete:agent_team_member:qa-team:alpha').props.onPress();
        });

        expect(sendMessageSpy).toHaveBeenCalledWith(
            's1',
            'Shutdown teammate alpha · qa-team',
            'Shutdown teammate alpha · qa-team',
            expect.objectContaining({
                happier: {
                    kind: 'subagent_command.v1',
                    payload: expect.objectContaining({
                        kind: 'agent_team_member_delete',
                        teamId: 'qa-team',
                        memberId: 'alpha@qa-team',
                    }),
                },
            }),
        );
    });
});
