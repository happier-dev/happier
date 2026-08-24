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
            surface: 'agent',
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
            surface: 'agent',
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

    it('preserves Agent tool-call approval context for title changes', async () => {
        const execute = vi.fn<Execute>(async () => ({ ok: true as const, result: { ok: true } }));
        const handler = createChangeTitleToolHandler({
            surface: 'agent',
            executor: { execute },
            resolveCallerPermissionMode: () => 'safe-yolo',
        });
        const approvalOrigin = {
            kind: 'transcript_tool_call' as const,
            sessionId: 'sess_1',
            toolCallId: 'pi-call-1',
            toolName: 'change_title',
        };

        await handler('sess_1', 'New title', { approvalOrigin });

        expect(execute).toHaveBeenCalledWith(
            'session.title.set',
            { sessionId: 'sess_1', title: 'New title' },
            expect.objectContaining({
                approvalOrigin,
                callerPermissionMode: 'safe-yolo',
                actionRequestId: 'pi-call-1',
            }),
        );
    });

    it('calls afterCommit and returns success when the action executes successfully', async () => {
        const afterCommit = vi.fn();
        const execute = vi.fn<Execute>(async () => ({
            ok: true as const,
            result: { ok: true, sessionId: 'sess_1', title: 'New title' },
        }));
        const handler = createChangeTitleToolHandler({
            surface: 'agent',
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

    it('calls afterCommit when the action wrote metadata so provider-native title state can sync', async () => {
        const afterCommit = vi.fn();
        const execute = vi.fn<Execute>(async () => ({
            ok: true as const,
            result: { ok: true, sessionId: 'sess_1', title: 'New title', metadataUpdated: true },
        }));
        const handler = createChangeTitleToolHandler({
            surface: 'agent',
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
        expect(afterCommit).toHaveBeenCalledWith({ sessionId: 'sess_1', title: 'New title' });
    });
});
