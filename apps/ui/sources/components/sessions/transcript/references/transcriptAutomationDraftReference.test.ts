import { createElement } from 'react';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { describe, expect, it } from 'vitest';
import { createTestSessionTranscriptSource, renderWithSessionTranscriptSource } from '@/dev/testkit/sessionTranscriptSource';
import { createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { TranscriptToolResultCard } from './TranscriptToolResultCard';

const actionId = 'workflow.trigger.add';
const tool = createToolCallMessageFixture().tool;
const automationId = 'ci-automation';
const triggerId = 'ci-weekday-trigger';
const set = {
    automationId, revision: 7, name: 'Check CI', enabled: true, health: 'available',
    triggers: [{
        id: triggerId, revision: 2, kind: 'schedule', enabled: false, createdAt: 10, updatedAt: 20,
        nextRunAt: null, triggerDefinitionEnvelope: null,
        schedule: { kind: 'cron', scheduleExpr: '0 9 * * 1-5', everyMs: null, timezone: 'Europe/Amsterdam' },
    }],
};

function completed(result: unknown, generic = false) {
    return {
        ...tool,
        name: generic ? 'mcp__happier__action_execute' : `mcp__happier__${getActionSpec(actionId).bindings?.mcpToolName}`,
        input: generic ? { actionId, input: {} } : {},
        state: 'completed' as const,
        result,
    };
}

describe('transcript Automation drafts', () => {
    it('renders only the acknowledged paused trigger from a completed Action', async () => {
        const result = WorkflowTriggerWriteResultV1Schema.parse({ set, triggerId, triggerRevision: 2 });
        const screen = await renderWithSessionTranscriptSource(createElement(TranscriptToolResultCard, {
            tool: completed({ content: [{ type: 'text', text: JSON.stringify({ ok: true, result }) }] }, true),
            serverId: 'source-home', mediaPreviewEnabled: false,
        }), createTestSessionTranscriptSource({ serverId: 'source-home' }));
        expect(screen.findByTestId('transcript-automation-draft')).not.toBeNull();
        expect(screen.findByTestId('transcript-automation-draft-enable')).toBeNull();
    });

    it('does not offer a draft for an active trigger or a refused save', async () => {
        const result = { set: { ...set, triggers: [{ ...set.triggers[0], enabled: true }] }, triggerId };
        for (const output of [result, { ok: false, errorCode: 'version_mismatch', result: { set, triggerId } }]) {
            const screen = await renderWithSessionTranscriptSource(createElement(TranscriptToolResultCard, {
                tool: completed(output), mediaPreviewEnabled: false,
            }));
            expect(screen.findByTestId('transcript-automation-draft')).toBeNull();
        }
    });
});
