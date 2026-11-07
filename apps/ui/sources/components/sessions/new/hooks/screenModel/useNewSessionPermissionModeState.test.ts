import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { ManagedDefaultsV1Schema, type ManagedSessionDefaultsContext } from '@happier-dev/protocol/teams/managedDefaults';
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

    it('hydrates a persisted permission choice after mount without replacing a later personal choice', async () => {
        const initialProps: Parameters<typeof useNewSessionPermissionModeState>[0] = {
            ...input, sessionDefaultPermissionModeByTargetKey: {},
        };
        const hook = await renderHook(useNewSessionPermissionModeState, { initialProps });
        await hook.rerender({ ...initialProps, hydratedPersistedAuthoringDraft: { permissionMode: 'safe-yolo' } });
        expect(hook.getCurrent().permissionMode).toBe('safe-yolo');
        expect(hook.getCurrent().hasUserSelectedPermissionModeRef.current).toBe(true);
        await act(async () => { hook.getCurrent().handlePermissionModeChange('read-only'); });
        await hook.rerender({ ...initialProps, hydratedPersistedAuthoringDraft: { permissionMode: 'yolo' } });
        expect(hook.getCurrent().permissionMode).toBe('read-only');
    });

    const managedDefaults: ManagedSessionDefaultsContext = {
        teamDefaults: ManagedDefaultsV1Schema.parse({
            team: { permissionModeByAgentTargetKey: { 'agent:happier.agent.claude/claude': 'read-only' } },
            groups: {},
        }),
    };

    it.each(['yolo', 'default'] as const)('hydrates Team defaults after mount and preserves a later personal %s choice', async (permissionMode) => {
        const initialProps: Parameters<typeof useNewSessionPermissionModeState>[0] = {
            ...input, sessionDefaultPermissionModeByTargetKey: {},
            hydratedPersistedAuthoringDraft: { permissionMode: 'default' },
        };
        const hook = await renderHook(useNewSessionPermissionModeState, { initialProps });
        await hook.rerender({ ...initialProps, managedDefaults });
        expect(hook.getCurrent().permissionMode).toBe('read-only');
        await act(async () => { hook.getCurrent().handlePermissionModeChange(permissionMode); });
        expect(hook.getCurrent().permissionMode).toBe(permissionMode);
        await hook.rerender({ ...initialProps, managedDefaults: { ...managedDefaults, homeDefaults: {} } });
        expect(hook.getCurrent().permissionMode).toBe(permissionMode);
    });

    it('enforces a hydrated policy lock against draft and later user choices', async () => {
        const initialProps: Parameters<typeof useNewSessionPermissionModeState>[0] = {
            ...input, hydratedTempAuthoringDraft: { permissionMode: 'safe-yolo' },
        };
        const hook = await renderHook(useNewSessionPermissionModeState, { initialProps });
        const locked: ManagedSessionDefaultsContext = {
            policyDefaults: { organization: 'Example', locked: true, values: managedDefaults.teamDefaults!.team },
        };
        await hook.rerender({ ...initialProps, managedDefaults: locked });
        expect(hook.getCurrent().permissionMode).toBe('read-only');
        expect(hook.getCurrent().permissionModeLock).toEqual({ organization: 'Example' });
        await act(async () => { hook.getCurrent().handlePermissionModeChange('yolo'); });
        expect(hook.getCurrent().permissionMode).toBe('read-only');
        await hook.rerender(initialProps);
        expect(hook.getCurrent().permissionMode).toBe('safe-yolo');
        expect(hook.getCurrent().permissionModeLock).toBeNull();
    });
});
