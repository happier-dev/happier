import { describe, expect, it } from 'vitest';

describe('createApprovedPermissionHandler', () => {
    it('returns an approval decision for any tool call', async () => {
        const mod = await import('./permissionHandler');
        const handler = mod.createApprovedPermissionHandler();

        await expect(handler.handleToolCall()).resolves.toEqual({ decision: 'approved' });
    });
});
