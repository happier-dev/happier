import { describe, expect, it, vi } from 'vitest';

const {
    runHostSessionRuntimePlanMock,
} = vi.hoisted(() => ({
    runHostSessionRuntimePlanMock: vi.fn(),
}));

vi.mock('@/agent/runtime/session/loop/lifecycle', async (importOriginal) => {
    const actual = await importOriginal<object>();
    return {
        ...actual,
        runHostSessionRuntimePlan: (...args: unknown[]) => runHostSessionRuntimePlanMock(...args),
    };
});

import { runCodex } from './session';

describe('runCodex', () => {
    it('runs the real Codex session-plan owner through the shared session loop', async () => {
        await runCodex({
            credentials: { token: 't' },
            startedBy: 'terminal',
            directory: '/tmp/codex',
        });

        expect(runHostSessionRuntimePlanMock).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'hostSessionRuntimePlan',
            providerId: 'codex',
            opts: expect.objectContaining({
                credentials: { token: 't' },
                startedBy: 'terminal',
                directory: '/tmp/codex',
            }),
            config: expect.objectContaining({
                agentMessageType: 'codex',
                createSessionRuntime: expect.any(Function),
            }),
        }));
    });
});
