import { expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

it('hands a validated transcript selection to the local export boundary', async () => {
    const selected: unknown[] = [];
    const executor = createActionExecutor({
        sessionExport: async ({ input }) => {
            selected.push(input);
            return { saved: true };
        },
    } as ActionExecutorDeps);
    const context = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    const input = { sessionId: 's1', seqs: [2, 5], format: 'markdown' };
    expect(await executor.execute('session.export', input, context)).toEqual({ ok: true, result: { saved: true } });
    expect(await executor.execute('session.export', { ...input, all: true }, context)).toMatchObject({ ok: false });
    expect(selected).toEqual([input]);
});
