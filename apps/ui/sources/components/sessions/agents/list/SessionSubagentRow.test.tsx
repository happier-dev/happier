import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { renderScreen } from '@/dev/testkit';
import { createSessionAgentActivityRowForTest, installSessionSubagentCommonModuleMocks } from '@/components/sessions/agents/sessionSubagentTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const stopRunSpy = vi.fn(async () => ({ ok: true }));
const submitMessageSpy = vi.fn(async () => undefined);

installSessionSubagentCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string, values?: Record<string, unknown>) => {
            if (key === 'session.subagents.kind.execution_run') return 'Subagent';
            if (key === 'session.subagents.kind.agent_team_member') return 'Team agent';
            if (key === 'session.subagents.intent.review') return 'Review';
            if (key === 'session.subagents.panel.typeFact' && values?.value) return `Type: ${values.value}`;
            if (key === 'session.subagents.panel.providerFact' && values?.value) return `Provider: ${values.value}`;
            if (key === 'session.subagents.panel.intentFact' && values?.value) return `Intent: ${values.value}`;
            return key;
        } });
    },
});

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunStop: stopRunSpy,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        submitMessage: submitMessageSpy,
    },
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>) => void promise,
}));

describe('SessionSubagentRow', () => {
    it('announces a selectable disclosure through the shared button row', async () => {
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

        const screen = await renderScreen(<SessionSubagentRow
                    sessionId="s1"
                    serverId="server-a"
                    row={createSessionAgentActivityRowForTest(subagent)}
                    onPress={onOpenPreview}
                    expanded
                    onOpenFull={vi.fn()}
                    onOpenAdvanced={vi.fn()}
                />);

        const row = screen.findByTestId('session-subagent-row:execution_run:run_web');
        expect(row).toBeTruthy();
        if (!row) {
            throw new Error('Expected execution-run row to be present');
        }
        expect(row.props.accessibilityRole).toBe('button');
        expect(row.props.accessibilityState).toMatchObject({ selected: true, expanded: true });

        await screen.pressByTestIdAsync('session-subagent-row:execution_run:run_web');

        expect(onOpenPreview).toHaveBeenCalledTimes(1);
    });

    it('keeps a row to its summary and offers its operations from the row menu (right-click / long-press)', async () => {
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

        const screen = await renderScreen(<SessionSubagentRow
                    sessionId="s1"
                    serverId="server-a"
                    row={createSessionAgentActivityRowForTest(subagent)}
                    onPress={onOpenPreview}
                    onOpenFull={onOpenFull}
                    onOpenAdvanced={onOpenAdvanced}
                />);

        // No strip of buttons on the row: the summary is the row (agents lab AG1), and its
        // operations wait, closed, in the row's menu.
        expect(screen.findByTestId('session-subagent-stop:execution_run:run_1')).toBeNull();
        const menu = screen.findByTestId('session-subagent-actions:execution_run:run_1');
        expect(menu?.props.open).toBe(false);
        expect(menu?.props.items.map((item: { id: string }) => item.id)).toEqual(['open-full', 'advanced', 'stop']);

        await act(async () => { menu?.props.onSelect('advanced'); });
        expect(onOpenAdvanced).toHaveBeenCalledTimes(1);
        expect(onOpenPreview).not.toHaveBeenCalled();

        await act(async () => { menu?.props.onSelect('stop'); });
        expect(stopRunSpy).toHaveBeenCalledWith('s1', { runId: 'run_1' }, { serverId: 'server-a' });
    });

    it('does not expose Run stop without an exact Home', async () => {
        const { SessionSubagentRow } = await import('./SessionSubagentRow');
        const subagent: SessionSubagent = {
            id: 'execution_run:unqualified',
            kind: 'execution_run',
            status: 'running',
            display: { title: 'unqualified', providerLabel: 'Codex' },
            transcript: { toolMessageRouteId: 'message_1', sidechainId: 'toolu_1', toolId: 'toolu_1' },
            runRef: { runId: 'run_unqualified', backendId: 'codex', intent: 'review' },
            recipient: { kind: 'execution_run', runId: 'run_unqualified', label: 'Unqualified run' },
            capabilities: { canOpen: true, canSend: true, canStop: true, canLaunchChild: false, canDelete: false, canOpenAdvancedRun: true },
            timestamps: {},
        };

        const screen = await renderScreen(<SessionSubagentRow
            sessionId="s1"
            row={createSessionAgentActivityRowForTest(subagent)}
            onPress={vi.fn()}
            onOpenFull={vi.fn()}
            onOpenAdvanced={vi.fn()}
        />);

        const ids = screen.findByTestId('session-subagent-actions:execution_run:unqualified')?.props.items.map((item: { id: string }) => item.id);
        expect(ids).not.toContain('stop');
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

        const screen = await renderScreen(<SessionSubagentRow
                    sessionId="s1"
                    row={createSessionAgentActivityRowForTest(subagent)}
                    onPress={vi.fn()}
                    onOpenFull={vi.fn()}
                    onOpenAdvanced={null}
                />);

        await act(async () => { screen.findByTestId('session-subagent-actions:agent_team_member:qa-team:alpha')?.props.onSelect('delete'); });

        expect(submitMessageSpy).toHaveBeenCalledWith(
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
                        memberLabel: 'alpha',
                    }),
                },
            }),
            { callerSurface: 'subagent_command', forceImmediate: true },
        );
    });
});
