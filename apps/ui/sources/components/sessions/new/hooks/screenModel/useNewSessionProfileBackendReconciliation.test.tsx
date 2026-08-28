import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionModelSelectionV1Schema, type BackendTargetRefV2, type SessionModelSelectionV1 } from '@happier-dev/protocol';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { AIBackendProfileSchema, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

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
    initialBackendTarget: BackendTargetRefV2;
    compatibleEntriesByProfileId: Readonly<Record<string, readonly NewSessionSelectableBackendEntry[]>>;
    profileMap: ReadonlyMap<string, AIBackendProfile>;
    cliAvailabilityTimestamp?: number;
    cliAvailabilityByAgentId?: Readonly<Partial<Record<'claude' | 'codex', boolean | null>>>;
    cliAuthStatusByAgentId?: Readonly<Partial<Record<'claude' | 'codex', { state: 'logged_in' | 'logged_out' | 'unknown'; checkedAt: number } | null>>>;
    installableDepKeyCountByAgentId?: Readonly<Partial<Record<'claude' | 'codex', number>>>;
    selectableWithoutCliByAgentId?: Readonly<Partial<Record<'claude' | 'codex', boolean>>>;
    useProfiles?: boolean;
    applyPermissionModeSpy: ReturnType<typeof vi.fn<(mode: PermissionMode, source: 'user' | 'auto') => void>>;
    prepareSecretPromptForProfileSelectionSpy: ReturnType<typeof vi.fn<(prevProfileId: string | null) => void>>;
    resolveDefaultPermissionMode: (profile: AIBackendProfile | null) => PermissionMode;
    resolveProfileAuthoringIntent?: (profileId: string) => Readonly<{
        preferredAgentTargetKey: string | null;
        modelSelection: SessionModelSelectionV1 | null;
    }>;
    setModelSelectionForBackendTargetSpy?: ReturnType<typeof vi.fn<(backendTargetKey: string, selection: SessionModelSelectionV1 | null) => void>>;
}>;

function useHarness(props: HarnessProps) {
    const [selectedProfileId, setSelectedProfileId] = React.useState<string | null>(props.initialSelectedProfileId);
    const [backendTarget, setBackendTarget] = React.useState<BackendTargetRefV2>(props.initialBackendTarget);
    const hasUserSelectedPermissionModeRef = React.useRef(false);
    const permissionModeRef = React.useRef<PermissionMode>('default');
    const hasUserTouchedProfileSelectionRef = React.useRef(false);

    const profileBackendReconciliation = useNewSessionProfileBackendReconciliation({
        useProfiles: props.useProfiles ?? true,
        selectedProfileId,
        setSelectedProfileId,
        profileMap: props.profileMap,
        getCompatibleProfileBackendEntries: (profile) => props.compatibleEntriesByProfileId[profile.id] ?? [],
        selectedBackendTargetKey: resolveBackendTargetKeyV2(backendTarget),
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
        resolveProfileAuthoringIntent: props.resolveProfileAuthoringIntent,
        setModelSelectionForBackendTarget: props.setModelSelectionForBackendTargetSpy,
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
        vi.useRealTimers();
    });

    it('ignores stale interaction callbacks after a newer profile selection', async () => {
        vi.useFakeTimers();
        const applyPermissionModeSpy = vi.fn<(mode: PermissionMode, source: 'user' | 'auto') => void>();
        const prepareSecretPromptForProfileSelectionSpy = vi.fn<(prevProfileId: string | null) => void>();
        const profileA = createProfile('profile-a');
        const profileB = createProfile('profile-b');

        const hook = await renderHook(useHarness, {
            initialProps: {
                initialSelectedProfileId: null,
                initialBackendTarget: { kind: 'backend', backendId: 'codex' },
                compatibleEntriesByProfileId: {
                    'profile-a': [{
                        backendTarget: { kind: 'backend', backendId: 'claude' },
                        backendTargetKey: 'backend:claude',
                        builtInAgentId: 'claude',
                        agentId: 'claude',
                        kind: 'builtInAgent',
                    }],
                    'profile-b': [{
                        backendTarget: { kind: 'backend', backendId: 'codex' },
                        backendTargetKey: 'backend:codex',
                        builtInAgentId: 'codex',
                        agentId: 'codex',
                        kind: 'builtInAgent',
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

        await act(async () => {
            await vi.runAllTimersAsync();
        });
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(hook.getCurrent().selectedProfileId).toBe('profile-b');
        expect(hook.getCurrent().backendTarget).toEqual({ kind: 'backend', backendId: 'codex' });
        expect(applyPermissionModeSpy).not.toHaveBeenCalledWith('read-only', 'auto');
    });

    it('applies the selected slim profile preferred target and exact provider model intent', async () => {
        const applyPermissionModeSpy = vi.fn<(mode: PermissionMode, source: 'user' | 'auto') => void>();
        const prepareSecretPromptForProfileSelectionSpy = vi.fn<(prevProfileId: string | null) => void>();
        const setModelSelectionForBackendTargetSpy = vi.fn<(backendTargetKey: string, selection: SessionModelSelectionV1 | null) => void>();
        const profile = createProfile('profile-a');
        const claudeTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' });
        const selection = SessionModelSelectionV1Schema.parse({
            v: 1,
            updatedAt: 200,
            ref: {
                agentTargetKey: claudeTargetKey,
                providerConnectionId: 'pc_profile',
                modelId: 'profile-model',
            },
        });
        const hook = await renderHook(useHarness, {
            initialProps: {
                initialSelectedProfileId: null,
                initialBackendTarget: { kind: 'backend', backendId: 'codex' },
                compatibleEntriesByProfileId: {
                    [profile.id]: [{
                        backendTarget: { kind: 'backend', backendId: 'claude' },
                        backendTargetKey: claudeTargetKey,
                        builtInAgentId: 'claude',
                        agentId: 'claude',
                        kind: 'builtInAgent',
                    }],
                },
                profileMap: new Map([[profile.id, profile]]),
                cliAvailabilityTimestamp: 1,
                cliAvailabilityByAgentId: { claude: true },
                installableDepKeyCountByAgentId: { claude: 0 },
                applyPermissionModeSpy,
                prepareSecretPromptForProfileSelectionSpy,
                resolveDefaultPermissionMode: () => 'default',
                resolveProfileAuthoringIntent: () => ({
                    preferredAgentTargetKey: claudeTargetKey,
                    modelSelection: selection,
                }),
                setModelSelectionForBackendTargetSpy,
            },
        });

        await act(async () => {
            hook.getCurrent().selectProfile(profile.id);
        });
        await flushHookEffects({ cycles: 1, turns: 2 });
        await flushNextInteractionTask();

        expect(hook.getCurrent().backendTarget).toEqual({ kind: 'backend', backendId: 'claude' });
        expect(setModelSelectionForBackendTargetSpy).toHaveBeenCalledWith(claudeTargetKey, selection);
    });

    it('uses the next selectable compatible backend when reconciling an incompatible profile backend', async () => {
        const applyPermissionModeSpy = vi.fn<(mode: PermissionMode, source: 'user' | 'auto') => void>();
        const prepareSecretPromptForProfileSelectionSpy = vi.fn<(prevProfileId: string | null) => void>();
        const profile = createProfile('profile-a');

        const hook = await renderHook(useHarness, {
            initialProps: {
                initialSelectedProfileId: profile.id,
                initialBackendTarget: { kind: 'backend', backendId: 'acme.review' },
                compatibleEntriesByProfileId: {
                    [profile.id]: [
                        {
                            backendTarget: { kind: 'backend', backendId: 'claude' },
                            backendTargetKey: 'backend:claude',
                            builtInAgentId: 'claude',
                            agentId: 'claude',
                            kind: 'builtInAgent',
                        },
                        {
                            backendTarget: { kind: 'backend', backendId: 'codex' },
                            backendTargetKey: 'backend:codex',
                            builtInAgentId: 'codex',
                            agentId: 'codex',
                            kind: 'builtInAgent',
                        },
                    ],
                },
                profileMap: new Map([[profile.id, profile]]),
                cliAvailabilityTimestamp: 1,
                cliAvailabilityByAgentId: {
                    claude: false,
                    codex: true,
                },
                installableDepKeyCountByAgentId: {
                    claude: 0,
                    codex: 0,
                },
                applyPermissionModeSpy,
                prepareSecretPromptForProfileSelectionSpy,
                resolveDefaultPermissionMode: () => 'default',
            },
        });

        expect(hook.getCurrent().backendTarget).toEqual({ kind: 'backend', backendId: 'codex' });
    });

    it('reconciles away from a logged-out backend when another compatible backend remains selectable', async () => {
        const applyPermissionModeSpy = vi.fn<(mode: PermissionMode, source: 'user' | 'auto') => void>();
        const prepareSecretPromptForProfileSelectionSpy = vi.fn<(prevProfileId: string | null) => void>();
        const profile = createProfile('profile-a');

        const hook = await renderHook(useHarness, {
            initialProps: {
                initialSelectedProfileId: profile.id,
                initialBackendTarget: { kind: 'backend', backendId: 'claude' },
                compatibleEntriesByProfileId: {
                    [profile.id]: [
                        {
                            backendTarget: { kind: 'backend', backendId: 'claude' },
                            backendTargetKey: 'backend:claude',
                            builtInAgentId: 'claude',
                            agentId: 'claude',
                            kind: 'builtInAgent',
                        },
                        {
                            backendTarget: { kind: 'backend', backendId: 'codex' },
                            backendTargetKey: 'backend:codex',
                            builtInAgentId: 'codex',
                            agentId: 'codex',
                            kind: 'builtInAgent',
                        },
                    ],
                },
                profileMap: new Map([[profile.id, profile]]),
                cliAvailabilityTimestamp: 1,
                cliAvailabilityByAgentId: {
                    claude: true,
                    codex: true,
                },
                cliAuthStatusByAgentId: {
                    claude: { state: 'logged_out', checkedAt: 1 },
                    codex: { state: 'logged_in', checkedAt: 1 },
                },
                installableDepKeyCountByAgentId: {
                    claude: 0,
                    codex: 0,
                },
                applyPermissionModeSpy,
                prepareSecretPromptForProfileSelectionSpy,
                resolveDefaultPermissionMode: () => 'default',
            },
        });

        expect(hook.getCurrent().backendTarget).toEqual({ kind: 'backend', backendId: 'codex' });
    });
});
