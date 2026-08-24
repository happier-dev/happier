import { describe, expect, it } from 'vitest';

import { buildExecutionRunActionDraftInputForUi } from './buildExecutionRunActionDraftInputForUi';

describe('buildExecutionRunActionDraftInputForUi', () => {
    it('seeds protocol-normalized execution-run permission defaults', () => {
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
            permissionMode: 'read_only',
            base: { kind: 'none' },
        });
        expect(input).not.toHaveProperty('engineIds');
    });

    it('normalizes an explicit UI permission override for the action protocol', () => {
        const input = buildExecutionRunActionDraftInputForUi({
            actionId: 'subagents.delegate.start' as any,
            sessionId: 's1',
            defaultBackendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            defaultBackendId: 'codex',
            instructions: 'Delegate this',
            extra: { permissionMode: 'safe-yolo' },
        });

        expect(input).toMatchObject({
            sessionId: 's1',
            permissionMode: 'workspace_write',
            instructions: 'Delegate this',
        });
    });

    it('uses the writable protocol default for delegate runs', () => {
        const input = buildExecutionRunActionDraftInputForUi({
            actionId: 'subagents.delegate.start' as any,
            sessionId: 's1',
            defaultBackendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            defaultBackendId: 'codex',
            instructions: 'Delegate this',
        });

        expect(input).toMatchObject({
            sessionId: 's1',
            permissionMode: 'workspace_write',
            instructions: 'Delegate this',
        });
    });
});
