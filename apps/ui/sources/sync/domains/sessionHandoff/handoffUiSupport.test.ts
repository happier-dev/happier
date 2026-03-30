import { beforeEach, describe, expect, it, vi } from 'vitest';

const readMachineTargetForSessionMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: (...args: unknown[]) => readMachineTargetForSessionMock(...args),
}));

import { canHandoffConversation } from './handoffUiSupport';

describe('handoffUiSupport', () => {
    beforeEach(() => {
        readMachineTargetForSessionMock.mockReset();
        readMachineTargetForSessionMock.mockReturnValue(null);
    });

    it('returns true for a persisted claude session with a machine id', () => {
        expect(
            canHandoffConversation({
                sessionId: 'sess_1',
                session: {
                    metadata: {
                        flavor: 'claude',
                        machineId: 'machine_1',
                        claudeSessionId: 'claude_session_1',
                    },
                },
            }),
        ).toBe(true);
    });

    it('returns true for a persisted claude session with a machine id even when vendor handoff id is missing', () => {
        expect(
            canHandoffConversation({
                sessionId: 'sess_1',
                session: {
                    metadata: {
                        flavor: 'claude',
                        machineId: 'machine_1',
                    },
                },
            }),
        ).toBe(false);
    });

    it('returns true for a direct opencode session with a machine id', () => {
        expect(
            canHandoffConversation({
                sessionId: 'sess_1',
                session: {
                    metadata: {
                        flavor: 'opencode',
                        machineId: 'machine_1',
                        directSessionV1: { source: 'opencode' },
                        opencodeSessionId: 'opencode_session_1',
                    },
                },
            }),
        ).toBe(true);
    });

    it('returns true when a direct session stores machine id under directSessionV1 even if metadata machine id is missing', () => {
        expect(
            canHandoffConversation({
                sessionId: 'sess_1',
                session: {
                    metadata: {
                        flavor: 'opencode',
                        directSessionV1: { v: 1, providerId: 'opencode', machineId: 'machine_1', remoteSessionId: 'remote_1', source: 'opencode' },
                        opencodeSessionId: 'opencode_session_1',
                    },
                },
            }),
        ).toBe(true);
    });

    it('returns true when the reachable session target exists even if metadata machine id is missing', () => {
        readMachineTargetForSessionMock.mockReturnValue({
            machineId: 'machine_rebound',
            basePath: '/workspace/repo',
        });

        expect(
            canHandoffConversation({
                sessionId: 'sess_1',
                session: {
                    metadata: {
                        flavor: 'claude',
                        claudeSessionId: 'claude_session_1',
                    },
                },
            }),
        ).toBe(true);
    });

    it('returns false when the session has no reachable machine target', () => {
        expect(
            canHandoffConversation({
                sessionId: 'sess_1',
                session: {
                    metadata: {
                        flavor: 'claude',
                        claudeSessionId: 'claude_session_1',
                    },
                },
            }),
        ).toBe(false);
    });

    it('returns false when the provider does not support handoff', () => {
        expect(
            canHandoffConversation({
                sessionId: 'sess_1',
                session: {
                    metadata: {
                        flavor: 'pi',
                        machineId: 'machine_1',
                    },
                },
            }),
        ).toBe(false);
    });

    it('returns true for a codex app-server session with a machine id', () => {
        expect(
            canHandoffConversation({
                sessionId: 'sess_1',
                session: {
                    metadata: {
                        flavor: 'codex',
                        machineId: 'machine_1',
                    },
                },
            }),
        ).toBe(false);
    });
});
