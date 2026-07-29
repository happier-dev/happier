import { describe, expect, it, vi } from 'vitest';

import type { ActionExecuteResult, ActionExecutorContext } from '@happier-dev/protocol';

import { createFrontDoorRuntimeActionExecutor } from './frontDoorRuntimeActionExecutor';

type ExecuteFn = (actionId: string, input: unknown, context?: ActionExecutorContext) => Promise<ActionExecuteResult>;

function fakeExecutor(execute: ExecuteFn) {
    return { execute: execute as never };
}

describe('createFrontDoorRuntimeActionExecutor', () => {
    it('routes runtime-action dispatch through ActionExecutor.execute with the supplied actionId/input/context', async () => {
        const execute = vi.fn<ExecuteFn>(async () => ({ ok: true, result: { state: 'ok' } }));
        const bridge = createFrontDoorRuntimeActionExecutor(fakeExecutor(execute));

        const context: ActionExecutorContext = { surface: 'ui', defaultSessionId: 'session-a' };
        await bridge({ actionId: 'localServices.launcher.start' as never, input: { targetId: 't1' }, context });

        expect(execute).toHaveBeenCalledExactlyOnceWith(
            'localServices.launcher.start',
            { targetId: 't1' },
            context,
        );
    });

    it('unwraps the raw runtime result on success so consumers parse the same payload as the legacy direct path', async () => {
        const bridge = createFrontDoorRuntimeActionExecutor(
            fakeExecutor(async () => ({ ok: true, result: { snapshot: { id: 'svc-1' } } })),
        );

        const result = await bridge({ actionId: 'localServices.actions.stopManaged' as never, input: {}, context: { surface: 'ui' } });

        expect(result).toEqual({ snapshot: { id: 'svc-1' } });
    });

    it('returns the failure envelope verbatim (fail-closed) when the front door denies the action', async () => {
        const bridge = createFrontDoorRuntimeActionExecutor(
            fakeExecutor(async () => ({ ok: false, errorCode: 'action_disabled', error: 'action_disabled' })),
        );

        const result = await bridge({ actionId: 'browser.diagnostics.eval' as never, input: {}, context: { surface: 'agent' } });

        expect(result).toEqual({ ok: false, errorCode: 'action_disabled', error: 'action_disabled' });
    });
});
