import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandler } from '@/api/rpc/types';
import { registerScmHandlers } from './scm';

// Authentication persistence is the external boundary; RPC/Action dispatch stay real.
vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readStoredCredentials: async () => null,
}));

describe('SCM diff-summary RPC admission', () => {
    it('rejects unauthenticated saved-result reads and edits through the same Action admission', async () => {
        const handlers = new Map<string, RpcHandler>();
        registerScmHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, '/workspace');
        for (const [method, request] of [
            ['scm.diffSummary.result.list', {}],
            ['scm.diffSummary.result.clear', { results: [] }],
            ['scm.diffSummary.result.read', { cwd: '/workspace', resultId: 'saved' }],
            ['scm.diffSummary.result.edit', { cwd: '/workspace', resultId: 'saved', expectedRevision: 0, edit: { kind: 'renameWalkthrough', title: 'Manual title' } }],
        ] as const) {
            const handler = handlers.get(method);
            expect(handler).toBeDefined();
            if (!handler) continue;
            await expect(handler(request)).resolves.toMatchObject({ ok: false, errorCode: 'not_authenticated' });
        }
    });
    it('provides the canonical RPC operation and rejects unauthenticated generation', async () => {
        const handlers = new Map<string, RpcHandler>();
        registerScmHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, '/workspace');
        const handler = handlers.get(RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE);
        expect(handler).toBeDefined();
        if (!handler) return;
        await expect(handler({ sessionId: 'session-1', cwd: '/workspace', source: { kind: 'workingTree' } }))
            .resolves.toMatchObject({ ok: false, errorCode: 'not_authenticated' });
        const capture = handlers.get(RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE);
        expect(capture).toBeDefined();
        if (!capture) return;
        await expect(capture({ sessionId: 'session-1', cwd: '/workspace', source: { kind: 'workingTree' } }))
            .resolves.toMatchObject({ ok: false, errorCode: 'not_authenticated' });
    });
});
