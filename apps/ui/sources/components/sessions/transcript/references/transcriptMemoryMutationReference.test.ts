import { createElement } from 'react';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { describe, expect, it } from 'vitest';
import { createTestSessionTranscriptSource, renderWithSessionTranscriptSource } from '@/dev/testkit/sessionTranscriptSource';
import { createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import * as transcript from './transcriptToolResultCardModel';
import { TranscriptToolResultCard } from './TranscriptToolResultCard';

const artifactId = 'memory-document';
const revision = { headerVersion: 2, bodyVersion: 14 };
const receipt = {
    changes: [{ kind: 'changed', factId: 'current-fact', previousFactId: 'previous-fact' }],
    undo: { artifactId, bodyVersion: 13, expectedRevision: revision },
};
const result = { ok: true, artifactId, factId: 'current-fact', revision, receipt };
const direct = `mcp__happier__${getActionSpec('memory.remember').bindings?.mcpToolName}`;
const tool = createToolCallMessageFixture().tool;

describe('transcript Memory receipts', () => {
    it.each([
        { name: direct, input: {}, result },
        { name: 'mcp__happier__action_execute', input: { actionId: 'memory.remember', input: {} },
            result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, result }) }] } },
    ])('shows the owner’s exact committed receipt for $name', (call) => {
        const completed = { ...tool, ...call, state: 'completed' as const };
        expect(transcript.readTranscriptToolResultCardKind(completed)).toBe('memory-mutation');
        expect(transcript.readTranscriptMemoryMutationReference(completed)).toMatchObject({ artifactId, revision, receipt });
    });

    it('does not present an older tool output or a refused write as a receipt', () => {
        const { receipt: _receipt, ...olderResult } = result;
        for (const output of [olderResult, { ok: false, errorCode: 'version_mismatch', result }]) {
            expect(transcript.readTranscriptMemoryMutationReference({ ...tool, name: direct, state: 'completed', result: output })).toBeNull();
        }
    });

    it('renders a retained receipt without offering Undo in a read-only transcript', async () => {
        const completed = { ...tool, name: direct, result, state: 'completed' as const };
        const screen = await renderWithSessionTranscriptSource(createElement(TranscriptToolResultCard, {
            tool: completed, serverId: 'source-home', mediaPreviewEnabled: false,
        }), createTestSessionTranscriptSource({ serverId: 'source-home' }));
        expect(screen.findByTestId('transcript-memory-receipt')).not.toBeNull();
        expect(screen.findByTestId('transcript-memory-receipt-undo')).toBeNull();
    });
});
