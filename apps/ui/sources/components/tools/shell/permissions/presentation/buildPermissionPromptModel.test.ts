import { describe, expect, it, vi } from 'vitest';

import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';

vi.mock('@/components/tools/shell/presentation/resolveToolHeaderTextPresentation', () => ({
    resolveToolHeaderTextPresentation: () => ({
        normalizedToolName: 'edit',
        usedInferenceFallback: false,
        title: 'Edit',
        subtitle: 'file.ts',
        statusText: null,
    }),
}));

describe('buildPermissionPromptModel', () => {
    it('creates a pending ToolCall stub from the request', async () => {
        const { buildPermissionPromptModel } = await import('./buildPermissionPromptModel');

        const request: PendingPermissionRequest = {
            id: 'perm-1',
            tool: 'edit',
            kind: 'permission',
            arguments: { path: 'file.ts', replacement: 'hi' },
            createdAt: 1_234,
        };

        const model = buildPermissionPromptModel({ request, metadata: null, nowMs: 9_999 });

        expect(model.tool.name).toBe('edit');
        expect(model.tool.input).toEqual({ path: 'file.ts', replacement: 'hi' });
        expect(model.tool.permission).toEqual({ id: 'perm-1', status: 'pending' });
        expect(model.tool.createdAt).toBe(1_234);
        expect(model.tool.startedAt).toBe(1_234);
        expect(model.tool.completedAt).toBeNull();
        expect(model.tool.state).toBe('running');
    });

    it('falls back to nowMs when request.createdAt is missing', async () => {
        const { buildPermissionPromptModel } = await import('./buildPermissionPromptModel');

        const request: PendingPermissionRequest = {
            id: 'perm-2',
            tool: 'edit',
            kind: 'permission',
            arguments: { path: 'file.ts' },
            createdAt: null,
        };

        const model = buildPermissionPromptModel({ request, metadata: null, nowMs: 4_567 });
        expect(model.tool.createdAt).toBe(4_567);
    });
});
