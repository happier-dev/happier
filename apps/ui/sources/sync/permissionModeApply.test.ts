import { describe, expect, it, vi } from 'vitest';

import { applyPermissionModeSelection } from './permissionModeApply';

describe('applyPermissionModeSelection', () => {
    it('publishes metadata immediately when applyTiming=immediate', async () => {
        const updateSessionPermissionMode = vi.fn();
        const publishSessionPermissionModeToMetadata = vi.fn(async () => {});

        await applyPermissionModeSelection({
            sessionId: 's1',
            mode: 'safe-yolo',
            applyTiming: 'immediate',
            updateSessionPermissionMode,
            getSessionPermissionModeUpdatedAt: () => 123,
            publishSessionPermissionModeToMetadata,
        });

        expect(updateSessionPermissionMode).toHaveBeenCalledWith('s1', 'safe-yolo');
        expect(publishSessionPermissionModeToMetadata).toHaveBeenCalledWith({
            sessionId: 's1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 123,
        });
    });

    it('does not publish metadata when applyTiming=next_prompt', async () => {
        const updateSessionPermissionMode = vi.fn();
        const publishSessionPermissionModeToMetadata = vi.fn(async () => {});

        await applyPermissionModeSelection({
            sessionId: 's1',
            mode: 'read-only',
            applyTiming: 'next_prompt',
            updateSessionPermissionMode,
            getSessionPermissionModeUpdatedAt: () => 123,
            publishSessionPermissionModeToMetadata,
        });

        expect(updateSessionPermissionMode).toHaveBeenCalledWith('s1', 'read-only');
        expect(publishSessionPermissionModeToMetadata).not.toHaveBeenCalled();
    });

    it('fails closed when applyTiming=immediate but updatedAt is missing', async () => {
        const updateSessionPermissionMode = vi.fn();
        const publishSessionPermissionModeToMetadata = vi.fn(async () => {});

        await applyPermissionModeSelection({
            sessionId: 's1',
            mode: 'yolo',
            applyTiming: 'immediate',
            updateSessionPermissionMode,
            getSessionPermissionModeUpdatedAt: () => null,
            publishSessionPermissionModeToMetadata,
        });

        expect(updateSessionPermissionMode).toHaveBeenCalledWith('s1', 'yolo');
        expect(publishSessionPermissionModeToMetadata).not.toHaveBeenCalled();
    });

    it('publishes canonicalized mode instead of legacy alias tokens', async () => {
        const updateSessionPermissionMode = vi.fn();
        const publishSessionPermissionModeToMetadata = vi.fn(async () => {});

        await applyPermissionModeSelection({
            sessionId: 's1',
            mode: 'acceptEdits',
            applyTiming: 'immediate',
            updateSessionPermissionMode,
            getSessionPermissionModeUpdatedAt: () => 456,
            publishSessionPermissionModeToMetadata,
        });

        expect(updateSessionPermissionMode).toHaveBeenCalledWith('s1', 'safe-yolo');
        expect(publishSessionPermissionModeToMetadata).toHaveBeenCalledWith({
            sessionId: 's1',
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 456,
        });
    });
});
