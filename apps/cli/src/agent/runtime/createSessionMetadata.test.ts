import { describe, expect, it } from 'vitest';

import { createSessionMetadata } from './createSessionMetadata';

describe('createSessionMetadata', () => {
    it('does not seed legacy messageQueueV1 metadata', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-1',
            startedBy: 'terminal',
        });

        expect((metadata as any).messageQueueV1).toBeUndefined();
    });

    it('seeds acpSessionModeOverrideV1 when agentModeId is provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'opencode',
            machineId: 'machine-1',
            startedBy: 'terminal',
            agentModeId: 'plan',
            agentModeUpdatedAt: 123,
        } as any);

        expect((metadata as any).acpSessionModeOverrideV1).toEqual({ v: 1, updatedAt: 123, modeId: 'plan' });
    });

    it('seeds modelOverrideV1 when modelId is provided', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'codex',
            machineId: 'machine-1',
            startedBy: 'terminal',
            modelId: 'gpt-5-codex-high',
            modelUpdatedAt: 123,
        } as any);

        expect((metadata as any).modelOverrideV1).toEqual({ v: 1, updatedAt: 123, modelId: 'gpt-5-codex-high' });
    });

    it('seeds sessionLogPath for developer log discovery', () => {
        const { metadata } = createSessionMetadata({
            flavor: 'claude',
            machineId: 'machine-1',
            startedBy: 'terminal',
        } as any);

        expect(typeof (metadata as any).sessionLogPath).toBe('string');
        expect((metadata as any).sessionLogPath).toContain('/logs/');
        expect((metadata as any).sessionLogPath).toContain('.log');
    });
});
