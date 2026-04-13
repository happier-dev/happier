import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildBackendTargetKey,
    type BackendTargetRefV1,
} from '@happier-dev/protocol';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { AIBackendProfileSchema, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';

import {
    useNewSessionProfileBackendReconciliation,
} from './useNewSessionProfileBackendReconciliation';
import type { NewSessionSelectableBackendEntry } from '@/components/sessions/new/modules/newSessionAgentSelection';

type ScheduledInteractionTask = {
    cancelled: boolean;
    callback: () => void;
};

const interactionTasks = vi.hoisted(() => [] as ScheduledInteractionTask[]);

vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        InteractionManager: {
            runAfterInteractions: (callback: () => void) => {
                const task: ScheduledInteractionTask = {
                    cancelled: false,
                    callback,
                };
                interactionTasks.push(task);
                return {
                    cancel: () => {
                        task.cancelled = true;
                    },
                };
            },
        },
    }));

function createProfile(id: string): AIBackendProfile {
    return AIBackendProfileSchema.parse({
        id,
        name: id,
        environmentVariables: [],
        defaultPermissionModeByAgent: {},
        defaultPermissionModeByTargetKey: {},
        defaultPersistenceModeByAgent: {},
        defaultPersistenceModeByTargetKey: {},
        compatibility: {},
        compatibilityByTargetKey: {},
        envVarRequirements: [],
        isBuiltIn: false,
        createdAt: 0,
        updatedAt: 0,
        version: '1.0.0',
    });
}

function shiftInteractionTask(): ScheduledInteractionTask | undefined {
    return interactionTasks.shift();
}

async function flushNextInteractionTask() {
    const task = shiftInteractionTask();
    if (!task || task.cancelled) {
        return;
    }

    await act(async () => {
        task.callback();
    });
    await flushHookEffects({ cycles: 1, turns: 2 });
}

type HarnessProps = Readonly<{
    initialSelectedProfileId: string | null;
    initialBackendTarget: BackendTargetRefV1;
    compatibleEntriesByProfileId: Readonly<Record<string, readonly NewSessionSelectableBackendEntry[]>>;
    profileMap: ReadonlyMap<string, AIBackendProfile>;
    cliAvailabilityTimestamp?: number;
    cliAvailabilityByAgentId?: Readonly<Partial<Record<'claude' | 'codex' | 'customAcp', boolean | null>>>;
    cliAuthStatusByAgentId?: Readonly<Partial<Record<'claude' | 'codex' | 'customAcp', { state: 'logged_in' | 'logged_out' | 'unknown'; checkedAt: number } | null>>>;
    installableDepKeyCountByAgentId?: Readonly<Partial<Record<'claude' | 'codex' | 'customAcp', number>>>;
    selectableWithoutCliByAgentId?: Readonly<Partial<Record<'claude' | 'codex' | 'customAcp', boolean>>>;
    useProfiles?: boolean;
    applyPermissionModeSpy: ReturnType<typeof vi.fn<(mode: PermissionMode, source: 'user' | 'auto') => void>>;
    prepareSecretPromptForProfileSelectionSpy: ReturnType<typeof vi.fn<(prevProfileId: string | null) => void>>;
    resolveDefaultPermissionMode: (profile: AIBackendProfile | null) => PermissionMode;
}>;

function useHarness(props: HarnessProps) {
    const [selectedProfileId, setSelectedProfileId] = React.useState<string | null>(props.initialSelectedProfileId);
    const [backendTarget, setBackendTarget] = React.useState<BackendTargetRefV1>(props.initialBackendTarget);
    const hasUserSelectedPermissionModeRef = React.useRef(false);
    const permissionModeRef = React.useRef<PermissionMode>('default');
    const hasUserTouchedProfileSelectionRef = React.useRef(false);

    const profileBackendReconciliation = useNewSessionProfileBackendReconciliation({
        useProfiles: props.useProfiles ?? true,
        selectedProfileId,
        setSelectedProfileId,
        profileMap: props.profileMap,
        getCompatibleProfileBackendEntries: (profile) => props.compatibleEntriesByProfileId[profile.id] ?? [],
        selectedBackendTargetKey: buildBackendTargetKey(backendTarget),
        setBackendTarget,
        cliAvailabilityTimestamp: props.cliAvailabilityTimestamp ?? 0,
        cliAvailabilityByAgentId: props.cliAvailabilityByAgentId ?? {},
        cliAuthStatusByAgentId: props.cliAuthStatusByAgentId ?? {},
        installableDepKeyCountByAgentId: props.installableDepKeyCountByAgentId ?? {},
        selectableWithoutCliByAgentId: props.selectableWithoutCliByAgentId ?? {},
        hasUserSelectedPermissionModeRef,
        permissionModeRef,
        applyPermissionMode: (mode, source) => {
            permissionModeRef.current = mode;
            props.applyPermissionModeSpy(mode, source);
        },
        resolveDefaultPermissionMode: props.resolveDefaultPermissionMode,
        prepareSecretPromptForProfileSelection: props.prepareSecretPromptForProfileSelectionSpy,
        hasUserTouchedProfileSelectionRef,
        agentType: 'codex',
    });

    return {
        ...profileBackendReconciliation,
        backendTarget,
        permissionMode: permissionModeRef.current,
        selectedProfileId,
    };
}

describe('useNewSessionProfileBackendReconciliation', () => {
    afterEach(() => {
        standardCleanup();
        interactionTasks.length = 0;
        vi.clearAllMocks();
    });

    it('ignores stale interaction callbacks after a newer profile selection', async () => {
        const applyPermissionModeSpy = vi.fn<(mode: PermissionMode, source: 'user' | 'auto') => void>();
        const prepareSecretPromptForProfileSelectionSpy = vi.fn<(prevProfileId: string | null) => void>();
        const profileA = createProfile('profile-a');
        const profileB = createProfile('profile-b');

        const hook = await renderHook(useHarness, {
            initialProps: {
                initialSelectedProfileId: null,
                initialBackendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                compatibleEntriesByProfileId: {
                    'profile-a': [{
                        target: { kind: 'builtInAgent', agentId: 'claude' },
                        targetKey: 'agent:claude',
                        builtInAgentId: 'claude',
                        family: 'builtInAgent',
                    }],
                    'profile-b': [{
                        target: { kind: 'builtInAgent', agentId: 'codex' },
                        targetKey: 'agent:codex',
                        builtInAgentId: 'codex',
                        family: 'builtInAgent',
                    }],
                },
                profileMap: new Map([
                    [profileA.id, profileA],
                    [profileB.id, profileB],
                ]),
                applyPermissionModeSpy,
                prepareSecretPromptForProfileSelectionSpy,
                resolveDefaultPermissionMode: (profile) => profile?.id === 'profile-a' ? 'read-only' : 'yolo',
            },
        });

        await act(async () => {
            hook.getCurrent().selectProfile('profile-a');
        });
        await flushHookEffects({ cycles: 1, turns: 2 });

        await act(async () => {
            hook.getCurrent().selectProfile('profile-b');
        });
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(interactionTasks).toHaveLength(2);

        await flushNextInteractionTask();

        expect(hook.getCurrent().selectedProfileId).toBe('profile-b');
        expect(hook.getCurrent().backendTarget).toEqual({ kind: 'builtInAgent', agentId: 'codex' });
        expect(applyPermissionModeSpy).not.toHaveBeenCalled();
    });

    it('uses the next selectable compatible backend when reconciling an incompatible profile backend', async () => {
        const applyPermissionModeSpy = vi.fn<(mode: PermissionMode, source: 'user' | 'auto') => void>();
        const prepareSecretPromptForProfileSelectionSpy = vi.fn<(prevProfileId: string | null) => void>();
        const profile = createProfile('profile-a');

        const hook = await renderHook(useHarness, {
            initialProps: {
                initialSelectedProfileId: profile.id,
                initialBackendTarget: { kind: 'builtInAgent', agentId: 'customAcp' },
                compatibleEntriesByProfileId: {
                    [profile.id]: [
                        {
                            target: { kind: 'builtInAgent', agentId: 'claude' },
                            targetKey: 'agent:claude',
                            builtInAgentId: 'claude',
                            family: 'builtInAgent',
                        },
                        {
                            target: { kind: 'builtInAgent', agentId: 'codex' },
                            targetKey: 'agent:codex',
                            builtInAgentId: 'codex',
                            family: 'builtInAgent',
                        },
                    ],
                },
                profileMap: new Map([[profile.id, profile]]),
                cliAvailabilityTimestamp: 1,
                cliAvailabilityByAgentId: {
                    claude: false,
                    codex: true,
                    customAcp: false,
                },
                installableDepKeyCountByAgentId: {
                    claude: 0,
                    codex: 0,
                    customAcp: 0,
                },
                applyPermissionModeSpy,
                prepareSecretPromptForProfileSelectionSpy,
                resolveDefaultPermissionMode: () => 'default',
            },
        });

        expect(hook.getCurrent().backendTarget).toEqual({ kind: 'builtInAgent', agentId: 'codex' });
    });

    it('reconciles away from a logged-out backend when another compatible backend remains selectable', async () => {
        const applyPermissionModeSpy = vi.fn<(mode: PermissionMode, source: 'user' | 'auto') => void>();
        const prepareSecretPromptForProfileSelectionSpy = vi.fn<(prevProfileId: string | null) => void>();
        const profile = createProfile('profile-a');

        const hook = await renderHook(useHarness, {
            initialProps: {
                initialSelectedProfileId: profile.id,
                initialBackendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                compatibleEntriesByProfileId: {
                    [profile.id]: [
                        {
                            target: { kind: 'builtInAgent', agentId: 'claude' },
                            targetKey: 'agent:claude',
                            builtInAgentId: 'claude',
                            family: 'builtInAgent',
                        },
                        {
                            target: { kind: 'builtInAgent', agentId: 'codex' },
                            targetKey: 'agent:codex',
                            builtInAgentId: 'codex',
                            family: 'builtInAgent',
                        },
                    ],
                },
                profileMap: new Map([[profile.id, profile]]),
                cliAvailabilityTimestamp: 1,
                cliAvailabilityByAgentId: {
                    claude: true,
                    codex: true,
                    customAcp: false,
                },
                cliAuthStatusByAgentId: {
                    claude: { state: 'logged_out', checkedAt: 1 },
                    codex: { state: 'logged_in', checkedAt: 1 },
                },
                installableDepKeyCountByAgentId: {
                    claude: 0,
                    codex: 0,
                    customAcp: 0,
                },
                applyPermissionModeSpy,
                prepareSecretPromptForProfileSelectionSpy,
                resolveDefaultPermissionMode: () => 'default',
            },
        });

        expect(hook.getCurrent().backendTarget).toEqual({ kind: 'builtInAgent', agentId: 'codex' });
    });
});
