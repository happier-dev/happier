import { describe, expect, it } from 'vitest';

import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

import { resolveSessionSubagentFullRoute } from './resolveSessionSubagentFullRoute';

function createBaseSubagent(overrides: Partial<SessionSubagent>): SessionSubagent {
    return {
        id: 'subagent:test',
        kind: 'subagent_sidechain',
        status: 'running',
        display: { title: 'Test' },
        transcript: {},
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
        ...overrides,
    };
}

describe('resolveSessionSubagentFullRoute', () => {
    it('routes execution runs to the transcript route when a transcript route id exists', () => {
        const route = resolveSessionSubagentFullRoute({
            sessionId: 's1',
            subagent: createBaseSubagent({
                id: 'execution_run:run_1',
                kind: 'execution_run',
                transcript: { toolMessageRouteId: 'tool-msg-1' },
                runRef: { runId: 'run_1' },
            }),
        });

        expect(route).toBe('/session/s1/message/tool-msg-1');
    });

    it('falls back to the advanced run details screen when no transcript route exists', () => {
        const route = resolveSessionSubagentFullRoute({
            sessionId: 's1',
            subagent: createBaseSubagent({
                id: 'execution_run:run_1',
                kind: 'execution_run',
                runRef: { runId: 'run_1' },
            }),
        });

        expect(route).toBe('/session/s1/runs/run_1');
    });

    it('routes task-like subagents to the message details screen when a transcript route id exists', () => {
        const route = resolveSessionSubagentFullRoute({
            sessionId: 's1',
            subagent: createBaseSubagent({
                id: 'subagent_sidechain:toolu_1',
                transcript: { toolMessageRouteId: 'tool-msg-1' },
            }),
        });

        expect(route).toBe('/session/s1/message/tool-msg-1');
    });

    it('returns null when no routable resource exists', () => {
        const route = resolveSessionSubagentFullRoute({
            sessionId: 's1',
            subagent: createBaseSubagent({
                id: 'subagent_sidechain:missing',
                transcript: {},
            }),
        });

        expect(route).toBeNull();
    });
});
