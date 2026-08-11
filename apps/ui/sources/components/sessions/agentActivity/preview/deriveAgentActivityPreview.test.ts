import { describe, expect, it } from 'vitest';

import type { Message, ToolCall } from '@/sync/domains/messages/messageTypes';

import {
    AGENT_ACTIVITY_PREVIEW_LINE_MAX_CHARS,
    AGENT_ACTIVITY_PREVIEW_STEP_LIMIT,
    deriveAgentActivityPreview,
} from './deriveAgentActivityPreview';

/**
 * The preview is a BOUNDED look at one sidechain, inside a popover that opens above a keyboard.
 *
 * The test that matters most is the size one: a preview whose cost grows with the transcript is a
 * transcript, and this surface has a 520pt height budget it shares with a goal block and a task
 * list. The second is discrimination — three agents must produce three different previews, because
 * "every agent shows the same thing" is precisely how the workflow collapse defect looked from the
 * UI end.
 */

function toolMessage(over: Readonly<{
    id: string;
    createdAt?: number;
    name?: string;
    description?: string | null;
    state?: ToolCall['state'];
    permission?: ToolCall['permission'];
}>): Message {
    return {
        kind: 'tool-call',
        id: over.id,
        localId: null,
        createdAt: over.createdAt ?? 1,
        children: [],
        tool: {
            id: over.id,
            name: over.name ?? 'Read',
            state: over.state ?? 'completed',
            input: {},
            createdAt: over.createdAt ?? 1,
            startedAt: null,
            completedAt: null,
            description: over.description ?? null,
            ...(over.permission ? { permission: over.permission } : null),
        },
    };
}

function agentText(id: string, text: string, createdAt = 1): Message {
    return { kind: 'agent-text', id, localId: null, createdAt, text };
}

describe('deriveAgentActivityPreview', () => {
    it('shows the newest steps, newest last, bounded by the step limit', () => {
        const preview = deriveAgentActivityPreview([
            toolMessage({ id: 't1', name: 'Read', createdAt: 1 }),
            toolMessage({ id: 't2', name: 'Grep', createdAt: 2 }),
            toolMessage({ id: 't3', name: 'Edit', createdAt: 3 }),
            toolMessage({ id: 't4', name: 'Bash', createdAt: 4 }),
            toolMessage({ id: 't5', name: 'Write', createdAt: 5 }),
        ]);

        expect(preview.steps.map((step) => step.name)).toEqual(['Edit', 'Bash', 'Write']);
        expect(preview.steps).toHaveLength(AGENT_ACTIVITY_PREVIEW_STEP_LIMIT);
    });

    it('does not grow with transcript length', () => {
        const short = deriveAgentActivityPreview([
            toolMessage({ id: 't1', createdAt: 1 }),
            agentText('m1', 'done', 2),
        ]);
        const long = deriveAgentActivityPreview([
            ...Array.from({ length: 400 }, (_unused, index) => toolMessage({
                id: `t${index}`,
                createdAt: index + 1,
            })),
            agentText('m1', 'done', 500),
        ]);

        expect(long.steps.length).toBeLessThanOrEqual(AGENT_ACTIVITY_PREVIEW_STEP_LIMIT);
        expect(long.steps.length).toBeGreaterThanOrEqual(short.steps.length);
        expect(JSON.stringify(long).length).toBeLessThan(1200);
    });

    it('bounds one runaway line rather than letting it fill the popover', () => {
        const preview = deriveAgentActivityPreview([
            agentText('m1', `${'x'.repeat(5000)}`, 1),
        ]);

        expect(preview.lastLine).not.toBeNull();
        expect(preview.lastLine!.length).toBeLessThanOrEqual(AGENT_ACTIVITY_PREVIEW_LINE_MAX_CHARS + 1);
    });

    it('collapses a multi-line tail to one line', () => {
        const preview = deriveAgentActivityPreview([
            agentText('m1', 'first\n\nsecond   third', 1),
        ]);

        expect(preview.lastLine).toBe('first second third');
    });

    it('reads the newest usable line and skips empty ones', () => {
        const preview = deriveAgentActivityPreview([
            agentText('m1', 'useful', 1),
            agentText('m2', '   ', 2),
        ]);

        expect(preview.lastLine).toBe('useful');
    });

    it('surfaces a pending permission, which is a person being waited on', () => {
        const preview = deriveAgentActivityPreview([
            toolMessage({
                id: 't1',
                name: 'Bash',
                state: 'running',
                permission: { id: 'p1', status: 'pending' },
            }),
        ]);

        expect(preview.pendingPermission).toBe(true);
    });

    it('does not report a resolved permission as pending', () => {
        const preview = deriveAgentActivityPreview([
            toolMessage({
                id: 't1',
                name: 'Bash',
                permission: { id: 'p1', status: 'approved' },
            }),
        ]);

        expect(preview.pendingPermission).toBe(false);
    });

    it('prefers the tool description over the bare tool name for a step detail', () => {
        const preview = deriveAgentActivityPreview([
            toolMessage({ id: 't1', name: 'Read', description: 'sources/app.tsx' }),
        ]);

        expect(preview.steps[0]).toMatchObject({ name: 'Read', detail: 'sources/app.tsx' });
    });

    it('is empty for a sidechain that has arrived with nothing in it', () => {
        const preview = deriveAgentActivityPreview([]);

        expect(preview).toEqual({ steps: [], lastLine: null, pendingPermission: false, isEmpty: true });
    });

    it('distinguishes three different agents rather than collapsing them', () => {
        const previews = [
            deriveAgentActivityPreview([toolMessage({ id: 'a', name: 'Read', description: 'a.ts' })]),
            deriveAgentActivityPreview([toolMessage({ id: 'b', name: 'Grep', description: 'b.ts' })]),
            deriveAgentActivityPreview([agentText('c', 'wrote the report')]),
        ];

        const rendered = previews.map((preview) => JSON.stringify(preview));
        expect(new Set(rendered).size).toBe(3);
    });
});
