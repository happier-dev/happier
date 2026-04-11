import { describe, expect, it } from 'vitest';

import { resolveThisComputerSetupFollowUp } from './useThisComputerSetupTask';

describe('resolveThisComputerSetupFollowUp', () => {
    it('still routes unauthenticated failures to auth follow-up', () => {
        expect(resolveThisComputerSetupFollowUp({
            protocolVersion: 1,
            taskId: 'task-1',
            ok: false,
            error: {
                code: 'not_authenticated',
                message: 'sign in required',
            },
        })).toBe('auth');
    });

    it('does not route missing machine ids to a manual approval follow-up for local setup', () => {
        expect(resolveThisComputerSetupFollowUp({
            protocolVersion: 1,
            taskId: 'task-1',
            ok: false,
            error: {
                code: 'machine_id_unavailable',
                message: 'machine id missing',
            },
        })).toBeNull();
    });
});
