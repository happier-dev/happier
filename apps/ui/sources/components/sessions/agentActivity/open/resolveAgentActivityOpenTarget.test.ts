import { describe, expect, it } from 'vitest';

import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

import {
    isNavigableAgentActivityOpenTarget,
    resolveAgentActivityOpenTarget,
    type AgentActivityOpenTargetEntry,
} from './resolveAgentActivityOpenTarget';

/**
 * One question, asked of every kind, in both directions.
 *
 * The pane and the popover each used to answer "can this row be opened" for themselves, and every
 * defect in the corridor was one of those answers being wrong in one of the two directions: a
 * headline-only row announced as a button over a handler that returned silently (A9), and — the
 * equal and opposite defect this table also pins — a row that genuinely resolves a destination
 * being drawn read-only. Enumerating the kinds here is what makes both directions provable.
 */

const SESSION_ID = 'sess_1';

function subagent(over: Partial<SessionSubagent> = {}): SessionSubagent {
    return {
        id: 'sub_1',
        kind: 'subagent_sidechain',
        status: 'running',
        display: { title: 'researcher' },
        transcript: { sidechainId: 'tool_use_1', toolMessageRouteId: 'msg_1' },
        recipient: null,
        capabilities: {
            canOpen: true,
            canSend: false,
            canStop: false,
            canLaunchChild: false,
            canDelete: false,
            canOpenAdvancedRun: false,
        },
        timestamps: {},
        ...over,
    };
}

function entry(over: Partial<AgentActivityOpenTargetEntry> = {}): AgentActivityOpenTargetEntry {
    return { id: 'entry_1', kind: 'subagent', title: 'researcher', ...over };
}

describe('resolveAgentActivityOpenTarget', () => {
    it('sends a locally derived subagent to the EXISTING session-subagent route', () => {
        const local = subagent();
        const target = resolveAgentActivityOpenTarget({
            sessionId: SESSION_ID,
            entry: entry({ subagentId: local.id, sidechainId: 'tool_use_1' }),
            subagent: local,
        });

        expect(target).toEqual({
            kind: 'subagent',
            entryId: 'entry_1',
            title: 'researcher',
            subagent: local,
            route: '/session/sess_1/message/msg_1',
            sidechainId: 'tool_use_1',
        });
        expect(isNavigableAgentActivityOpenTarget(target)).toBe(true);
    });

    it('sends an execution run to its run route, with no sidechain to preview', () => {
        const local = subagent({
            id: 'run_sub',
            kind: 'execution_run',
            transcript: {},
            runRef: { runId: 'run_9' },
        });
        const target = resolveAgentActivityOpenTarget({
            sessionId: SESSION_ID,
            entry: entry({ id: 'entry_run', kind: 'execution_run', subagentId: local.id }),
            subagent: local,
        });

        expect(target).toMatchObject({
            kind: 'subagent',
            route: '/session/sess_1/runs/run_9',
            sidechainId: null,
        });
    });

    it('opens a team member through the same one route helper', () => {
        const local = subagent({ id: 'mate', kind: 'agent_team_member' });
        const target = resolveAgentActivityOpenTarget({
            sessionId: SESSION_ID,
            entry: entry({ id: 'entry_mate', kind: 'agent_team_member', subagentId: local.id }),
            subagent: local,
        });

        expect(target).toMatchObject({ kind: 'subagent', route: '/session/sess_1/message/msg_1' });
    });

    it('gives a workflow agent with an imported sidechain a by-id sidechain target', () => {
        const target = resolveAgentActivityOpenTarget({
            sessionId: SESSION_ID,
            entry: entry({
                id: 'workflow_agent:wf_1:a1',
                kind: 'workflow_agent',
                title: 'reviewer',
                sidechainId: 'wf_1/a1',
            }),
            subagent: null,
        });

        expect(target).toEqual({
            kind: 'sidechain',
            entryId: 'workflow_agent:wf_1:a1',
            title: 'reviewer',
            sidechainId: 'wf_1/a1',
        });
        // It can be inspected in place, but there is no owning tool message and therefore nowhere
        // to navigate: advertising a destination here is exactly the dead control A9 forbids.
        expect(isNavigableAgentActivityOpenTarget(target)).toBe(false);
    });

    it('refuses every kind that resolves nothing', () => {
        const cases: readonly (readonly [string, ReturnType<typeof resolveAgentActivityOpenTarget>])[] = [
            ['workflow agent with no imported sidechain', resolveAgentActivityOpenTarget({
                sessionId: SESSION_ID,
                entry: entry({ id: 'wa', kind: 'workflow_agent' }),
                subagent: null,
            })],
            ['workflow run', resolveAgentActivityOpenTarget({
                sessionId: SESSION_ID,
                entry: entry({ id: 'wr', kind: 'workflow_run', runId: 'wf_1' }),
                subagent: null,
            })],
            ['background task', resolveAgentActivityOpenTarget({
                sessionId: SESSION_ID,
                entry: entry({ id: 'background_task:t1', kind: 'background_task' }),
                subagent: null,
            })],
            ['completion-only native subagent', resolveAgentActivityOpenTarget({
                sessionId: SESSION_ID,
                entry: entry({ id: 'co', subagentId: 'co_sub' }),
                subagent: subagent({
                    id: 'co_sub',
                    transcript: {},
                    nativeRef: { lifecycle: 'completion_only' },
                }),
            })],
            ['headline-only entry with no local subagent', resolveAgentActivityOpenTarget({
                sessionId: SESSION_ID,
                entry: entry({ id: 'headline', subagentId: 'missing' }),
                subagent: null,
            })],
            ['blank session id', resolveAgentActivityOpenTarget({
                sessionId: '   ',
                entry: entry({ subagentId: 'sub_1' }),
                subagent: subagent(),
            })],
        ];

        for (const [label, target] of cases) {
            expect(target, label).toBeNull();
        }
    });

    it('prefers the subagent route over a bare sidechain when an entry has both', () => {
        const local = subagent();
        const target = resolveAgentActivityOpenTarget({
            sessionId: SESSION_ID,
            entry: entry({ subagentId: local.id, sidechainId: 'tool_use_1' }),
            subagent: local,
        });

        // The existing route is the richer destination (overview card, structured result,
        // composer). A sidechain target for the same agent would be a second, poorer answer.
        expect(target?.kind).toBe('subagent');
    });

    it('does not claim a sidechain target from whitespace', () => {
        expect(resolveAgentActivityOpenTarget({
            sessionId: SESSION_ID,
            entry: entry({ id: 'wa', kind: 'workflow_agent', sidechainId: '   ' }),
            subagent: null,
        })).toBeNull();
    });
});
