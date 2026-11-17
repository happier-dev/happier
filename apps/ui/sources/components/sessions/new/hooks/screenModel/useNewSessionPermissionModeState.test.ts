import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { ManagedDefaultsV1Schema, type ManagedSessionDefaultsContext } from '@happier-dev/protocol/teams/managedDefaults';
import { useNewSessionPermissionModeState } from './useNewSessionPermissionModeState';
import { seedAndOpenNewSession } from '../../newSessionSeedComposer';
import { readNewSessionDraftFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

describe('useNewSessionPermissionModeState authored draft intent', () => {
    afterEach(standardCleanup);
    afterEach(resetSessionDraftRepositoryForTests);
    const input = {
        agentType: 'claude', backendTarget: { kind: 'backend' as const, backendId: 'claude' },
        hydratedTempAuthoringDraft: null, hydratedPersistedAuthoringDraft: null,
        selectedProfileId: null, profileMap: new Map(), enabledAgentIds: ['claude'],
        sessionDefaultPermissionModeByTargetKey: { 'agent:happier.agent.claude/claude': 'yolo' as const },
    };
    it('opens a browser investigation with Ask despite remembered yolo and leaves the reader free to change it', async () => {
        const initialProps: Parameters<typeof useNewSessionPermissionModeState>[0] = input;
        const hook = await renderHook(useNewSessionPermissionModeState, { initialProps });
        expect(hook.getCurrent().permissionMode).toBe('yolo');
        const scope = { serverId: 'browser-investigation-server', accountId: 'browser-investigation-account' };
        const draftId = 'browser-investigation';
        const outcome = seedAndOpenNewSession({
            seed: { prompt: 'Investigate this browser exception', permissionMode: 'default',
                forgeEvidence: { v: 1, items: [{ source: { kind: 'alert', label: 'Browser exception' },
                    author: { kind: 'process' }, text: 'Untrusted application exception evidence' }] } },
            scope, isCurrent: () => true, createDraftId: () => draftId, navigateToNewSession: () => {},
        });
        expect(outcome.kind).toBe('opened');
        const draft = readNewSessionDraftFromRepository({ scope, draftId });
        expect(draft).toMatchObject({ permissionMode: 'default', permissionModeExplicit: true });
        await hook.rerender({ ...initialProps, hydratedPersistedAuthoringDraft: draft,
            persistedPermissionModeExplicit: draft?.permissionModeExplicit });
        expect(hook.getCurrent().permissionMode).toBe('default');
        await act(() => hook.getCurrent().handlePermissionModeChange('yolo'));
        expect(hook.getCurrent().permissionMode).toBe('yolo');
    });
    it('updates the native sandbox preview when the execution machine changes without changing approval intent', async () => {
        const initialProps: Parameters<typeof useNewSessionPermissionModeState>[0] = {
            ...input, nativeSandboxAvailable: true,
            machineIsolation: { environment: 'managed-guest', provisionerId: 'example.machine/guest' },
        };
        const hook = await renderHook(useNewSessionPermissionModeState, { initialProps });
        expect(hook.getCurrent().nativeSandbox.value).toBe('off');
        expect(hook.getCurrent().permissionMode).toBe('yolo');
        await hook.rerender({ ...initialProps, machineIsolation: null });
        expect(hook.getCurrent().nativeSandbox.value).toBeUndefined();
        expect(hook.getCurrent().permissionMode).toBe('yolo');
    });
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
        expect(hook.getCurrent().permissionModeSource).toBe('team');
        await act(async () => { hook.getCurrent().handlePermissionModeChange(permissionMode); });
        expect(hook.getCurrent().permissionMode).toBe(permissionMode);
        expect(hook.getCurrent().permissionModeSource).toBe('explicit');
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
