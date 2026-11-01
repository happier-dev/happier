import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit';

describe('createActionExecutor', () => {
    it('rejects disabled actions before executing', async () => {
        let enabled = true;
        const executionRunStart = vi.fn(async () => ({
            runId: 'review-run', callId: 'review-call', sidechainId: 'review-call',
        }));
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            executionRunStart,
            reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
            isActionEnabled: (actionId, context) =>
                actionId !== 'review.start' || context?.surface !== 'voice' || enabled,
        }));
        const execute = () => executor.execute('review.start', {
            sessionId: 'session-1', engineIds: ['codex'], instructions: 'Review this task.',
        }, { surface: 'voice', authority: 'present_user', actionCaller: { kind: 'host' } });

        await expect(execute()).resolves.toMatchObject({
            ok: true,
            result: { results: [{ ok: true, result: { runId: 'review-run' } }] },
        });

        executionRunStart.mockClear();
        enabled = false;
        await expect(execute()).resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
        expect(executionRunStart).not.toHaveBeenCalled();
    });
});
