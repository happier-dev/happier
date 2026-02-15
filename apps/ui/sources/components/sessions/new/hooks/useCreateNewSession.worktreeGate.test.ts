import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/worktree/createWorktree', () => ({
    createWorktree: vi.fn(async () => ({
        success: true,
        worktreePath: '/tmp/worktree',
        branchName: 'test-branch',
    })),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function renderHook<T>(useValue: () => T): Promise<T> {
    let current: T | null = null;

    function Test() {
        current = useValue();
        return null;
    }

    await act(async () => {
        renderer.create(React.createElement(Test));
        await Promise.resolve();
    });

    if (!current) throw new Error('Hook did not render');
    return current;
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.resetModules();
});

describe('useCreateNewSession (worktree gating)', () => {
    it('does not create a worktree when session.typeSelector experiment toggle is disabled', async () => {
        const { createWorktree } = await import('@/utils/worktree/createWorktree');
        const { Modal } = await import('@/modal');
        vi.spyOn(Modal, 'alert').mockImplementation(() => {});

        const { getStorage } = await import('@/sync/domains/state/storage');
        const baseSettings = getStorage().getState().settings;
        const { useCreateNewSession } = await import('./useCreateNewSession');
        const typecheck = useCreateNewSession;

        const profile = {
            id: 'profile-test',
            name: 'Profile Test',
            description: undefined,
            environmentVariables: [],
            envVarRequirements: [{ name: 'REQUIRED_CONFIG', kind: 'config', required: true }],
            compatibility: {},
            defaultPermissionModeByAgent: {},
            isBuiltIn: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            version: '1.0.0',
        } satisfies (Parameters<typeof typecheck>[0]['profileMap'] extends Map<string, infer P> ? P : never);

        const params = {
            router: { push: vi.fn(), replace: vi.fn() },
            selectedMachineId: 'machine-1',
            selectedPath: '/repo',
            selectedMachine: { id: 'machine-1', metadata: {} },
            setIsCreating: vi.fn(),
            setIsResumeSupportChecking: vi.fn(),
            sessionType: 'worktree' as const,
            settings: {
                ...baseSettings,
                experiments: true,
                featureToggles: { 'session.typeSelector': false },
            },
            useProfiles: true,
            selectedProfileId: profile.id,
            profileMap: new Map([[profile.id, profile]]),
            recentMachinePaths: [],
            agentType: 'codex' as const,
            permissionMode: 'default' as const,
            modelMode: 'auto' as const,
            sessionPrompt: 'hi',
            resumeSessionId: '',
            agentNewSessionOptions: null,
            automationDraft: null,
            // Test fixture: only the fields used by useCreateNewSession are provided.
            machineEnvPresence: {
                isPreviewEnvSupported: true,
                isLoading: false,
                meta: { REQUIRED_CONFIG: { isSet: false } },
            } as unknown as Parameters<typeof typecheck>[0]['machineEnvPresence'],
            secrets: [],
            secretBindingsByProfileId: {},
            selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueByProfileIdByEnvVarName: {},
            selectedMachineCapabilities: null,
            targetServerId: null,
            allowedTargetServerIds: [],
        } satisfies Parameters<typeof typecheck>[0];

        const hook = await renderHook(() => useCreateNewSession(params));
        await act(async () => {
            await hook.handleCreateSession();
        });

        expect(vi.mocked(createWorktree)).toHaveBeenCalledTimes(0);
    });

    it('creates a worktree when session.typeSelector experiment toggle is enabled', async () => {
        const { createWorktree } = await import('@/utils/worktree/createWorktree');
        const { Modal } = await import('@/modal');
        vi.spyOn(Modal, 'alert').mockImplementation(() => {});

        const { getStorage } = await import('@/sync/domains/state/storage');
        const baseSettings = getStorage().getState().settings;
        const { useCreateNewSession } = await import('./useCreateNewSession');
        const typecheck = useCreateNewSession;

        const profile = {
            id: 'profile-test',
            name: 'Profile Test',
            description: undefined,
            environmentVariables: [],
            envVarRequirements: [{ name: 'REQUIRED_CONFIG', kind: 'config', required: true }],
            compatibility: {},
            defaultPermissionModeByAgent: {},
            isBuiltIn: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            version: '1.0.0',
        } satisfies (Parameters<typeof typecheck>[0]['profileMap'] extends Map<string, infer P> ? P : never);

        const params = {
            router: { push: vi.fn(), replace: vi.fn() },
            selectedMachineId: 'machine-1',
            selectedPath: '/repo',
            selectedMachine: { id: 'machine-1', metadata: {} },
            setIsCreating: vi.fn(),
            setIsResumeSupportChecking: vi.fn(),
            sessionType: 'worktree' as const,
            settings: {
                ...baseSettings,
                experiments: true,
                featureToggles: { 'session.typeSelector': true },
            },
            useProfiles: true,
            selectedProfileId: profile.id,
            profileMap: new Map([[profile.id, profile]]),
            recentMachinePaths: [],
            agentType: 'codex' as const,
            permissionMode: 'default' as const,
            modelMode: 'auto' as const,
            sessionPrompt: 'hi',
            resumeSessionId: '',
            agentNewSessionOptions: null,
            automationDraft: null,
            // Test fixture: only the fields used by useCreateNewSession are provided.
            machineEnvPresence: {
                isPreviewEnvSupported: true,
                isLoading: false,
                meta: { REQUIRED_CONFIG: { isSet: false } },
            } as unknown as Parameters<typeof typecheck>[0]['machineEnvPresence'],
            secrets: [],
            secretBindingsByProfileId: {},
            selectedSecretIdByProfileIdByEnvVarName: {},
            sessionOnlySecretValueByProfileIdByEnvVarName: {},
            selectedMachineCapabilities: null,
            targetServerId: null,
            allowedTargetServerIds: [],
        } satisfies Parameters<typeof typecheck>[0];

        const hook = await renderHook(() => useCreateNewSession(params));
        await act(async () => {
            await hook.handleCreateSession();
        });

        expect(vi.mocked(createWorktree)).toHaveBeenCalledTimes(1);
    });
});
