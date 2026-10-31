import { afterEach, describe, expect, it } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { useNewSessionPermissionModeState } from './useNewSessionPermissionModeState';

describe('useNewSessionPermissionModeState authored draft intent', () => {
    afterEach(standardCleanup);
    const input = {
        agentType: 'claude', backendTarget: { kind: 'backend' as const, backendId: 'claude' },
        hydratedTempAuthoringDraft: null, hydratedPersistedAuthoringDraft: null,
        selectedProfileId: null, profileMap: new Map(), enabledAgentIds: ['claude'],
        sessionDefaultPermissionModeByTargetKey: { 'agent:happier.agent.claude/claude': 'yolo' as const },
    };
    it.each(['read-only', 'default'])('protects explicit temporary %s intent from profile/backend defaults', async permissionMode => {
        const hook = await renderHook(useNewSessionPermissionModeState, {
            initialProps: { ...input, hydratedTempAuthoringDraft: { permissionMode } },
        });
        expect(hook.getCurrent().permissionMode).toBe(permissionMode);
        expect(hook.getCurrent().hasUserSelectedPermissionModeRef.current).toBe(true);
    });
    it('keeps an implicit persisted default eligible for current defaults', async () => {
        const hook = await renderHook(useNewSessionPermissionModeState, {
            initialProps: { ...input, hydratedPersistedAuthoringDraft: { permissionMode: 'default' } },
        });
        expect(hook.getCurrent().hasUserSelectedPermissionModeRef.current).toBe(false);
    });
});
