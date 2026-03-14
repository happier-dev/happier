import { describe, expect, it } from 'vitest';

import { buildExecutionRunActionDraftInputForUi } from './buildExecutionRunActionDraftInputForUi';

describe('buildExecutionRunActionDraftInputForUi', () => {
    it('seeds UI-normalized execution-run permission defaults while preserving protocol review defaults', () => {
        const input = buildExecutionRunActionDraftInputForUi({
            actionId: 'review.start' as any,
            sessionId: 's1',
            defaultBackendTarget: { kind: 'builtInAgent', agentId: 'claude' },
            defaultBackendId: 'claude',
            instructions: '',
        });

        expect(input).toMatchObject({
            sessionId: 's1',
            changeType: 'uncommitted',
            permissionMode: 'read-only',
            base: { kind: 'none' },
        });
        expect(input).not.toHaveProperty('engineIds');
    });

    it('keeps an explicit UI permission override instead of replacing it', () => {
        const input = buildExecutionRunActionDraftInputForUi({
            actionId: 'subagents.delegate.start' as any,
            sessionId: 's1',
            defaultBackendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            defaultBackendId: 'codex',
            instructions: 'Delegate this',
            extra: { permissionMode: 'read-only' },
        });

        expect(input).toMatchObject({
            sessionId: 's1',
            permissionMode: 'read-only',
            instructions: 'Delegate this',
        });
    });
});
