import { beforeEach, describe, expect, it, vi } from 'vitest';

const readMachineControlTargetForSessionMock = vi.hoisted(() => vi.fn());
const resolvePreferredServerIdForSessionIdMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineControlTargetForSession: (sessionId: string) => readMachineControlTargetForSessionMock(sessionId),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) => resolvePreferredServerIdForSessionIdMock(sessionId),
}));

import { resolveSessionFileSuggestionScope } from './resolveSessionFileSuggestionScope';

describe('resolveSessionFileSuggestionScope', () => {
    beforeEach(() => {
        readMachineControlTargetForSessionMock.mockReset();
        resolvePreferredServerIdForSessionIdMock.mockReset();
    });

    it('uses the machine-visible workspace root and preferred server', () => {
        readMachineControlTargetForSessionMock.mockReturnValue({
            machineId: 'machine-1',
            basePath: '/machine/worktree',
            agentBasePath: '/agent/worktree',
            confidence: 'reachable',
        });
        resolvePreferredServerIdForSessionIdMock.mockReturnValue('server-2');

        expect(resolveSessionFileSuggestionScope(' session-1 ')).toEqual({
            machineId: 'machine-1',
            path: '/machine/worktree',
            serverId: 'server-2',
        });
        expect(readMachineControlTargetForSessionMock).toHaveBeenCalledWith('session-1');
        expect(resolvePreferredServerIdForSessionIdMock).toHaveBeenCalledWith('session-1');
    });

    it('fails closed when the session cannot resolve a routable machine workspace', () => {
        readMachineControlTargetForSessionMock.mockReturnValue(null);

        expect(resolveSessionFileSuggestionScope('session-1')).toBeNull();
        expect(resolvePreferredServerIdForSessionIdMock).not.toHaveBeenCalled();
    });
});
