import { describe, expect, it, vi } from 'vitest';

import { createChangeTitleToolHandler } from './createChangeTitleToolHandler';

describe('createChangeTitleToolHandler', () => {
    type Execute = Parameters<typeof createChangeTitleToolHandler>[0]['executor']['execute'];

    it('returns a failure result when the action executor result payload is ok=false', async () => {
        const afterCommit = vi.fn();
        const execute = vi.fn<Execute>(async () => ({
            ok: true as const,
            result: { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' },
        }));
        const handler = createChangeTitleToolHandler({
            surface: 'session_agent',
            executor: {
                execute,
            },
            afterCommit,
        });

        await expect(handler('sess_1', 'New title')).resolves.toEqual({
            success: false,
            error: 'not_authenticated',
        });
        expect(afterCommit).not.toHaveBeenCalled();
    });

    it('passes through approval_request_created results without calling afterCommit', async () => {
        const afterCommit = vi.fn();
        const execute = vi.fn<Execute>(async () => ({
            ok: true as const,
            result: { kind: 'approval_request_created', requestId: 'req_1' },
        }));
        const handler = createChangeTitleToolHandler({
            surface: 'session_agent',
            executor: {
                execute,
            },
            afterCommit,
        });

        await expect(handler('sess_1', 'New title')).resolves.toEqual({
            kind: 'approval_request_created',
            requestId: 'req_1',
        });
        expect(afterCommit).not.toHaveBeenCalled();
    });

    it('calls afterCommit and returns success when the action executes successfully', async () => {
        const afterCommit = vi.fn();
        const execute = vi.fn<Execute>(async () => ({
            ok: true as const,
            result: { ok: true, sessionId: 'sess_1', title: 'New title' },
        }));
        const handler = createChangeTitleToolHandler({
            surface: 'session_agent',
            executor: {
                execute,
            },
            afterCommit,
        });

        await expect(handler('sess_1', 'New title')).resolves.toEqual({
            success: true,
            title: 'New title',
        });
        expect(afterCommit).toHaveBeenCalledTimes(1);
    });
});
