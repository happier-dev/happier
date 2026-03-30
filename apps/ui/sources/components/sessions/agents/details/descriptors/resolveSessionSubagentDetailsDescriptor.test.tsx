import { describe, expect, it } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';

async function resolveDescriptor(subagent: SessionSubagent, message: Message | null = null) {
    const module = await import('./resolveSessionSubagentDetailsDescriptor');
    return module.resolveSessionSubagentDetailsDescriptor({ subagent, message });
}

describe('resolveSessionSubagentDetailsDescriptor', () => {
    it('routes execution runs with transcript messages to the shared tool transcript descriptor', async () => {
        const descriptor = await resolveDescriptor({
            id: 'execution_run:run_1',
            kind: 'execution_run',
            status: 'running',
            display: { title: 'Code review', providerLabel: 'Codex' },
            transcript: { toolMessageRouteId: 'tool-msg-1', sidechainId: 'toolu_1', toolId: 'toolu_1' },
            runRef: { runId: 'run_1', backendId: 'codex' },
            recipient: { kind: 'execution_run', runId: 'run_1', label: 'Code review' },
            capabilities: { canOpen: true, canSend: true, canStop: true, canLaunchChild: false, canDelete: false, canOpenAdvancedRun: true },
            timestamps: {},
        }, {
            id: 'tool-msg-1',
            kind: 'tool-call',
            localId: null,
            tool: {
                id: 'toolu_1',
                name: 'SubAgentRun',
                state: 'running',
                input: {},
                result: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: null,
                description: null,
            },
            children: [],
            createdAt: 1,
        } as Message);

        expect(descriptor.id).toBe('tool_transcript');
    });

    it('routes execution runs without transcript messages to the execution-run descriptor', async () => {
        const descriptor = await resolveDescriptor({
            id: 'execution_run:run_2',
            kind: 'execution_run',
            status: 'running',
            display: { title: 'Code review', providerLabel: 'Codex' },
            transcript: {},
            runRef: { runId: 'run_2', backendId: 'codex' },
            recipient: { kind: 'execution_run', runId: 'run_2', label: 'Code review' },
            capabilities: { canOpen: true, canSend: true, canStop: true, canLaunchChild: false, canDelete: false, canOpenAdvancedRun: true },
            timestamps: {},
        });

        expect(descriptor.id).toBe('execution_run');
    });

    it('routes tool-backed subagents to the shared transcript descriptor', async () => {
        const descriptor = await resolveDescriptor({
            id: 'subagent_sidechain:toolu_2',
            kind: 'subagent_sidechain',
            status: 'running',
            display: { title: 'Search repo', providerLabel: 'SubAgent' },
            transcript: { toolMessageRouteId: 'tool-msg-2', sidechainId: 'toolu_2', toolId: 'toolu_2' },
            recipient: null,
            capabilities: { canOpen: true, canSend: false, canStop: false, canLaunchChild: false, canDelete: false, canOpenAdvancedRun: false },
            timestamps: {},
        });

        expect(descriptor.id).toBe('tool_transcript');
    });
});
