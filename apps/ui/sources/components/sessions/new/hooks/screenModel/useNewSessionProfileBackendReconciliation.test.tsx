import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionModelSelectionV1Schema, type PersistedBackendTargetRefV2, type SessionModelSelectionV1 } from '@happier-dev/protocol';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { AIBackendProfileSchema, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

import {
    useNewSessionProfileBackendReconciliation,
} from './useNewSessionProfileBackendReconciliation';
import type { NewSessionSelectableBackendEntry } from '@/components/sessions/new/modules/newSessionAgentSelection';
import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';

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

function createMachineAgent(agentId: MachineAgent['agentId'], stale = false, state: MachineAgent['state'] = 'ready'): MachineAgent {
    return {
        agentId, title: agentId, state, stale, installed: true,
        version: null, latestVersion: null, update: null,
        signIn: { status: state === 'needsSignIn' ? 'signedOut' : 'signedIn', via: null, nativeLogin: 'unsupported', connectedServices: [] },
        platform: { supported: true },
        install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null, requiresVendorConsent: false },
        dependencies: [], job: null,
    };
}

const readyMachineAgentsById = { claude: createMachineAgent('claude'), codex: createMachineAgent('codex') };

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
    initialBackendTarget: PersistedBackendTargetRefV2;
    compatibleEntriesByProfileId: Readonly<Record<string, readonly NewSessionSelectableBackendEntry[]>>;
    profileMap: ReadonlyMap<string, AIBackendProfile>;
    machineAgentsById?: Readonly<Record<string, MachineAgent | undefined>>;
    useProfiles?: boolean;
    applyPermissionModeSpy: ReturnType<typeof vi.fn<(mode: PermissionMode, source: 'user' | 'auto') => void>>;
    prepareSecretPromptForProfileSelectionSpy: ReturnType<typeof vi.fn<(prevProfileId: string | null) => void>>;
    resolveDefaultPermissionMode: (profile: AIBackendProfile | null, target: PersistedBackendTargetRefV2) => PermissionMode;
    resolveProfileAuthoringIntent?: (profileId: string) => Readonly<{
        preferredAgentTargetKey: string | null;
        modelSelection: SessionModelSelectionV1 | null;
    }>;
    setModelSelectionForBackendTargetSpy?: ReturnType<typeof vi.fn<(backendTargetKey: string, selection: SessionModelSelectionV1 | null) => void>>;
}>;

function useHarness(props: HarnessProps) {
    const [selectedProfileId, setSelectedProfileId] = React.useState<string | null>(props.initialSelectedProfileId);
    const [backendTarget, setBackendTarget] = React.useState<PersistedBackendTargetRefV2>(
        () => props.initialBackendTarget,
    );
    const hasUserSelectedPermissionModeRef = React.useRef(false);
    const permissionModeRef = React.useRef<PermissionMode>('default');
    const resolveDefaultPermissionMode = React.useCallback((profile: AIBackendProfile | null) =>
        props.resolveDefaultPermissionMode(profile, backendTarget), [props.resolveDefaultPermissionMode, backendTarget]);
    const applyPermissionMode = React.useCallback((mode: PermissionMode, source: 'user' | 'auto') => {
        permissionModeRef.current = mode;
        props.applyPermissionModeSpy(mode, source);
    }, [props.applyPermissionModeSpy]);

    const getCompatibleProfileBackendEntries = React.useCallback((profile: AIBackendProfile) =>
        props.compatibleEntriesByProfileId[profile.id] ?? [], [props.compatibleEntriesByProfileId]);
    const profileBackendReconciliation = useNewSessionProfileBackendReconciliation({
        useProfiles: props.useProfiles ?? true,
        selectedProfileId,
        setSelectedProfileId,
        profileMap: props.profileMap,
        getCompatibleProfileBackendEntries,
        selectedBackendTargetKey: resolveBackendTargetKeyV2(backendTarget),
        setBackendTarget,
        machineAgentsById: props.machineAgentsById ?? readyMachineAgentsById,
        hasUserSelectedPermissionModeRef,
        permissionModeRef,
        applyPermissionMode,
        resolveDefaultPermissionMode,
        prepareSecretPromptForProfileSelection: props.prepareSecretPromptForProfileSelectionSpy,
        agentType: backendTarget.kind === 'backend' ? backendTarget.backendId : backendTarget.identity.localId,
        resolveProfileAuthoringIntent: props.resolveProfileAuthoringIntent,
        setModelSelectionForBackendTarget: props.setModelSelectionForBackendTargetSpy,
    });

    return {
        ...profileBackendReconciliation,
        backendTarget,
        setBackendTarget,
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
                        backendTargetKey: 'agent:happier.agent.claude/claude',
                        builtInAgentId: 'claude',
                        agentId: 'claude',
                        kind: 'builtInAgent',
                    }],
                    'profile-b': [{
                        backendTarget: { kind: 'backend', backendId: 'codex' },
                        backendTargetKey: 'agent:happier.agent.codex/codex',
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

        // The first Agent change may apply its valid defaults immediately; only late callbacks are stale.
        applyPermissionModeSpy.mockClear();
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

    it.each([false, true])('applies the exact model intent and selects the preferred Agent only while current (stale=%s)', async (stale) => {
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
                machineAgentsById: { claude: createMachineAgent('claude', stale), codex: createMachineAgent('codex') },
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

        expect(hook.getCurrent().backendTarget).toEqual({ kind: 'backend', backendId: stale ? 'codex' : 'claude' });
        expect(setModelSelectionForBackendTargetSpy).toHaveBeenCalledWith(claudeTargetKey, selection);
    });

    it('resolves delayed permission defaults for the newly preferred target', async () => {
        const profile = createProfile('profile-codex');
        const applyPermissionModeSpy = vi.fn<(mode: PermissionMode, source: 'user' | 'auto') => void>();
        const codexTargetKey = 'agent:happier.agent.codex/codex';
        const hook = await renderHook(useHarness, {
            initialProps: {
                initialSelectedProfileId: null,
                initialBackendTarget: { kind: 'backend', backendId: 'claude' },
                compatibleEntriesByProfileId: { [profile.id]: [{
                    backendTarget: { kind: 'backend', backendId: 'codex' },
                    backendTargetKey: codexTargetKey, builtInAgentId: 'codex', agentId: 'codex', kind: 'builtInAgent',
                }] },
                profileMap: new Map([[profile.id, profile]]),
                applyPermissionModeSpy,
                prepareSecretPromptForProfileSelectionSpy: vi.fn(),
                resolveDefaultPermissionMode: (_profile, target) => resolveBackendTargetKeyV2(target) === codexTargetKey ? 'default' : 'yolo',
                resolveProfileAuthoringIntent: () => ({ preferredAgentTargetKey: codexTargetKey, modelSelection: null }),
            },
        });
        await act(async () => { hook.getCurrent().selectProfile(profile.id); });
        await flushHookEffects({ cycles: 1, turns: 2 });
        await flushNextInteractionTask();
        expect(hook.getCurrent().backendTarget).toEqual({ kind: 'backend', backendId: 'codex' });
        expect(applyPermissionModeSpy).toHaveBeenLastCalledWith('default', 'auto');
        expect(applyPermissionModeSpy).not.toHaveBeenCalledWith('yolo', 'auto');
    });

    it('does not leave deferred backend intent after selecting the already selected profile', async () => {
        const profile = createProfile('profile-a');
        const claude = { kind: 'backend' as const, backendId: 'claude' };
        const codex = { kind: 'backend' as const, backendId: 'codex' };
        const prepareSecretPromptForProfileSelectionSpy = vi.fn();
        const hook = await renderHook(useHarness, { initialProps: {
            initialSelectedProfileId: profile.id, initialBackendTarget: claude,
            compatibleEntriesByProfileId: { [profile.id]: [
                { backendTarget: claude, backendTargetKey: 'agent:happier.agent.claude/claude', builtInAgentId: 'claude', agentId: 'claude', kind: 'builtInAgent' },
                { backendTarget: codex, backendTargetKey: 'agent:happier.agent.codex/codex', builtInAgentId: 'codex', agentId: 'codex', kind: 'builtInAgent' },
            ] },
            profileMap: new Map([[profile.id, profile]]), applyPermissionModeSpy: vi.fn(), prepareSecretPromptForProfileSelectionSpy,
            resolveDefaultPermissionMode: () => 'default',
            resolveProfileAuthoringIntent: () => ({ preferredAgentTargetKey: 'agent:happier.agent.claude/claude', modelSelection: null }),
        } });
        await act(async () => { hook.getCurrent().selectProfile(profile.id); });
        await flushHookEffects({ cycles: 1, turns: 2 });
        await act(async () => { hook.getCurrent().setBackendTarget(codex); });
        await flushHookEffects({ cycles: 1, turns: 2 });
        await flushNextInteractionTask();
        expect(hook.getCurrent().backendTarget).toEqual(codex);
        expect(prepareSecretPromptForProfileSelectionSpy).toHaveBeenCalledWith(profile.id);
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
                            backendTargetKey: 'agent:happier.agent.claude/claude',
                            builtInAgentId: 'claude',
                            agentId: 'claude',
                            kind: 'builtInAgent',
                        },
                        {
                            backendTarget: { kind: 'backend', backendId: 'codex' },
                            backendTargetKey: 'agent:happier.agent.codex/codex',
                            builtInAgentId: 'codex',
                            agentId: 'codex',
                            kind: 'builtInAgent',
                        },
                    ],
                },
                profileMap: new Map([[profile.id, profile]]),
                machineAgentsById: { codex: createMachineAgent('codex') },
                applyPermissionModeSpy,
                prepareSecretPromptForProfileSelectionSpy,
                resolveDefaultPermissionMode: () => 'default',
            },
        });

        expect(hook.getCurrent().backendTarget).toEqual({ kind: 'backend', backendId: 'codex' });
    });

    it.each([
        { stale: true, state: 'ready' },
        { stale: false, state: 'needsSignIn' },
    ] satisfies ReadonlyArray<Pick<MachineAgent, 'stale' | 'state'>>)(
        'retains a compatible authored Agent while inventory is stale or sign-in is required (%s)', async (unavailable) => {
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
                            backendTargetKey: 'agent:happier.agent.claude/claude',
                            builtInAgentId: 'claude',
                            agentId: 'claude',
                            kind: 'builtInAgent',
                        },
                        {
                            backendTarget: { kind: 'backend', backendId: 'codex' },
                            backendTargetKey: 'agent:happier.agent.codex/codex',
                            builtInAgentId: 'codex',
                            agentId: 'codex',
                            kind: 'builtInAgent',
                        },
                    ],
                },
                profileMap: new Map([[profile.id, profile]]),
                machineAgentsById: {
                    claude: createMachineAgent('claude', unavailable.stale, unavailable.state),
                    codex: createMachineAgent('codex'),
                },
                applyPermissionModeSpy,
                prepareSecretPromptForProfileSelectionSpy,
                resolveDefaultPermissionMode: () => 'default',
            },
        });

        expect(hook.getCurrent().backendTarget).toEqual({ kind: 'backend', backendId: 'claude' });
    });
});
