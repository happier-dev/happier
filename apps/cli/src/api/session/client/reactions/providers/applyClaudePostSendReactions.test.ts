import { describe, expect, it, vi } from 'vitest';

const { writeSessionStateFieldWithMetadataPortBestEffortMock } = vi.hoisted(() => ({
    writeSessionStateFieldWithMetadataPortBestEffortMock: vi.fn(),
}));

vi.mock('@/agent/runtime/state/writeSessionStateFieldWithMetadataPort', () => ({
    writeSessionStateFieldWithMetadataPortBestEffort: (...args: unknown[]) =>
        writeSessionStateFieldWithMetadataPortBestEffortMock(...args),
}));

import { applyClaudePostSendReactions } from './applyClaudePostSendReactions';

describe('applyClaudePostSendReactions', () => {
    it('routes Claude summary title reactions through the session-state metadata wrapper', () => {
        const port = {
            sessionId: 'session-1',
            updateAgentState: vi.fn(),
            updateMetadata: vi.fn(),
            getMetadataSnapshot: vi.fn(() => null),
            usageObservationPublisher: { publish: vi.fn() },
        };

        applyClaudePostSendReactions(port as never, {
            summary: {
                text: 'Claude title',
                updatedAt: 123,
            },
        });

        expect(writeSessionStateFieldWithMetadataPortBestEffortMock).toHaveBeenCalledWith({
            sessionId: 'session-1',
            fieldId: 'display.title',
            value: {
                title: 'Claude title',
                updatedAt: 123,
            },
            updateMetadata: port.updateMetadata,
            reason: 'reconciliation',
            metadataReason: 'mirror_claude_summary',
        });
        expect(port.updateMetadata).not.toHaveBeenCalled();
    });
});
