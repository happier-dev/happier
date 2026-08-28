import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { installNewSessionScreenModelCommonModuleMocks } from '../newSessionScreenModelTestHelpers';

installNewSessionScreenModelCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
    },
});

const cliRefreshA = vi.fn();
const cliRefreshB = vi.fn();
let cliRefreshCurrent = cliRefreshA;
const resolveProfileAvailabilityForNewSessionSpy = vi.fn<(params: unknown) => { available: boolean; reason?: string }>(() => ({ available: true }));
const useCLIDetectionSpy = vi.hoisted(() => vi.fn());
const probeSafeAgents = vi.hoisted(() => new Set<string>(['claude']));
let cliAvailableByIdCurrent: Record<string, boolean> = { claude: false, codex: true };

vi.mock('@/hooks/auth/useCLIDetection', () => ({
    useCLIDetection: (...args: unknown[]) => {
        useCLIDetectionSpy(...args);
        return {
        available: cliAvailableByIdCurrent,
        login: {},
        authStatus: {
            claude: { state: 'logged_out', checkedAt: 1 },
            codex: { state: 'logged_in', checkedAt: 1 },
        },
        resolvedPath: {},
        resolvedCommand: {},
        resolutionSource: {},
        tmux: null,
        isDetecting: false,
        timestamp: 123,
        refresh: cliRefreshCurrent,
        };
    },
}));

vi.mock('@happier-dev/agents', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/agents')>();
    return {
        ...actual,
        isAgentCliAuthBackgroundCheckSafe: (agentId: string) => probeSafeAgents.has(agentId),
    };
});

const capabilitiesRefreshA = vi.fn();
const capabilitiesRefreshB = vi.fn();
let capabilitiesRefreshCurrent = capabilitiesRefreshA;

vi.mock('@/hooks/server/useDaemonScopedMachineCapabilitiesCache', () => ({
    useDaemonScopedMachineCapabilitiesCache: () => ({
        state: { status: 'idle' },
        refresh: capabilitiesRefreshCurrent,
    }),
}));

vi.mock('@/components/sessions/new/modules/newSessionAgentSelection', () => ({
    isAgentSelectableForNewSession: ({ agentId, availabilityById, selectableWithoutCliByAgentId }: any) => (
        availabilityById?.[agentId] !== false || selectableWithoutCliByAgentId?.[agentId] === true
    ),
    resolveProfileAvailabilityForNewSession: (params: unknown) => resolveProfileAvailabilityForNewSessionSpy(params),
}));

vi.mock('@/utils/timing/runAfterInteractionsWithFallback', () => ({
    runAfterInteractionsWithFallback: (fn: () => void) => {
        fn();
        return undefined;
    },
}));

describe('useNewSessionAvailabilityState', () => {
    beforeEach(() => {
        cliRefreshA.mockClear();
        cliRefreshB.mockClear();
        resolveProfileAvailabilityForNewSessionSpy.mockClear();
        useCLIDetectionSpy.mockClear();
        capabilitiesRefreshA.mockClear();
        capabilitiesRefreshB.mockClear();
        cliRefreshCurrent = cliRefreshA;
        capabilitiesRefreshCurrent = capabilitiesRefreshA;
        cliAvailableByIdCurrent = { claude: false, codex: true };
    });

    it('does not auto-switch the selected backend when CLI detection marks it unavailable', async () => {
        vi.resetModules();

        const { useNewSessionAvailabilityState } = await import('./useNewSessionAvailabilityState');

        const setBackendTarget = vi.fn();

        await renderHook(() => useNewSessionAvailabilityState({
            selectedMachineId: null,
            selectedMachine: null,
            capabilityServerId: 'server-1',
            externalSessionsFeatureEnabled: false,
            settings: {} as any,
            agentType: 'claude' as any,
            resumeSessionId: null,
            backendNewSessionOptionStateByTargetKey: {},
            resolvedBackendEntries: [
                {
                    family: 'builtInAgent',
                    builtInAgentId: 'claude',
                    target: { kind: 'builtInAgent', agentId: 'claude' },
                    targetKey: 'agent:claude',
                    title: 'Claude',
                } as any,
                {
                    family: 'builtInAgent',
                    builtInAgentId: 'codex',
                    target: { kind: 'builtInAgent', agentId: 'codex' },
                    targetKey: 'agent:codex',
                    title: 'Codex',
                } as any,
            ],
            selectedBackendEntry: {
                family: 'builtInAgent',
                builtInAgentId: 'claude',
                target: { kind: 'builtInAgent', agentId: 'claude' },
                targetKey: 'agent:claude',
                title: 'Claude',
            } as any,
            setBackendTarget,
            machines: [],
            dismissedCliWarnings: null,
            setDismissedCliWarnings: vi.fn(),
            allProfiles: [],
        }));

        expect(setBackendTarget).not.toHaveBeenCalled();
    });

    it('keeps direct-browse agents selectable without detected CLI when sessions.direct is enabled', async () => {
        vi.resetModules();
        cliAvailableByIdCurrent = { claude: false, codex: false };

        const { useNewSessionAvailabilityState } = await import('./useNewSessionAvailabilityState');

        const hook = await renderHook(() => useNewSessionAvailabilityState({
            selectedMachineId: 'machine-1',
            selectedMachine: {
                id: 'machine-1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: Date.now(),
                revokedAt: null,
                metadata: null,
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 1,
            } satisfies Machine,
            capabilityServerId: 'server-1',
            settings: {} as any,
            agentType: 'claude' as any,
            resumeSessionId: null,
            backendNewSessionOptionStateByTargetKey: {},
            resolvedBackendEntries: [],
            selectedBackendEntry: null,
            setBackendTarget: vi.fn(),
            machines: [],
            dismissedCliWarnings: null,
            setDismissedCliWarnings: vi.fn(),
            allProfiles: [],
            externalSessionsFeatureEnabled: true,
        } as any));

        expect(hook.getCurrent().isAgentSelectable('codex' as any)).toBe(true);
    });

    it('does not re-run the initial probe refresh when refresh callback identities churn', async () => {
        vi.resetModules();

        const { useNewSessionAvailabilityState } = await import('./useNewSessionAvailabilityState');

        const setBackendTarget = vi.fn();
        const machine: Machine = {
            id: 'm1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: Date.now(),
            revokedAt: null,
            metadata: null,
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 1,
        };

        const hook = await renderHook((props: { refreshSalt: number }) => useNewSessionAvailabilityState({
            selectedMachineId: 'm1',
            selectedMachine: machine,
            capabilityServerId: 'server-1',
            externalSessionsFeatureEnabled: false,
            settings: {} as any,
            agentType: 'claude' as any,
            resumeSessionId: null,
            backendNewSessionOptionStateByTargetKey: {},
            resolvedBackendEntries: [],
            selectedBackendEntry: null,
            setBackendTarget,
            machines: [machine],
            dismissedCliWarnings: null,
            setDismissedCliWarnings: vi.fn(),
            allProfiles: [],
        }), { initialProps: { refreshSalt: 0 } });

        expect(cliRefreshA).toHaveBeenCalledTimes(1);
        expect(cliRefreshA.mock.calls[0]?.[0]).toEqual({ bypassCache: true });
        expect(capabilitiesRefreshA).toHaveBeenCalledTimes(1);

        cliRefreshCurrent = cliRefreshB;
        capabilitiesRefreshCurrent = capabilitiesRefreshB;
        await hook.rerender({ refreshSalt: 1 });

        expect(cliRefreshA).toHaveBeenCalledTimes(1);
        expect(cliRefreshA.mock.calls[0]?.[0]).toEqual({ bypassCache: true });
        expect(capabilitiesRefreshA).toHaveBeenCalledTimes(1);
        expect(cliRefreshB).toHaveBeenCalledTimes(0);
        expect(capabilitiesRefreshB).toHaveBeenCalledTimes(0);
    });

    it('re-runs the initial probe refresh when the machine transitions offline → online', async () => {
        vi.resetModules();

        const { useNewSessionAvailabilityState } = await import('./useNewSessionAvailabilityState');

        const baseMachine: Machine = {
            id: 'm1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            // Ensure offline even with online-grace logic (activeAt must be old + active=false)
            activeAt: 1,
            revokedAt: null,
            metadata: null,
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 1,
        };

        const hook = await renderHook((props: { machine: Machine }) => useNewSessionAvailabilityState({
            selectedMachineId: props.machine.id,
            selectedMachine: props.machine,
            capabilityServerId: 'server-1',
            externalSessionsFeatureEnabled: false,
            settings: {} as any,
            agentType: 'claude' as any,
            resumeSessionId: null,
            backendNewSessionOptionStateByTargetKey: {},
            resolvedBackendEntries: [],
            selectedBackendEntry: null,
            setBackendTarget: vi.fn(),
            machines: [props.machine],
            dismissedCliWarnings: null,
            setDismissedCliWarnings: vi.fn(),
            allProfiles: [],
        }), { initialProps: { machine: baseMachine } });

        expect(cliRefreshA).toHaveBeenCalledTimes(0);
        expect(capabilitiesRefreshA).toHaveBeenCalledTimes(0);

        await hook.rerender({ machine: { ...baseMachine, active: true, activeAt: Date.now() } });
        expect(cliRefreshA).toHaveBeenCalledTimes(1);
        expect(cliRefreshA.mock.calls[0]?.[0]).toEqual({ bypassCache: true });
        expect(capabilitiesRefreshA).toHaveBeenCalledTimes(1);

        await hook.rerender({ machine: { ...baseMachine, active: false } });
        await hook.rerender({ machine: { ...baseMachine, active: true, activeAt: Date.now() } });
        expect(cliRefreshA).toHaveBeenCalledTimes(2);
        expect(cliRefreshA.mock.calls[1]?.[0]).toEqual({ bypassCache: true });
        expect(capabilitiesRefreshA).toHaveBeenCalledTimes(2);
    });

    it('passes CLI auth status into profile availability resolution', async () => {
        vi.resetModules();

        const { useNewSessionAvailabilityState } = await import('./useNewSessionAvailabilityState');

        await renderHook(() => useNewSessionAvailabilityState({
            selectedMachineId: null,
            selectedMachine: null,
            capabilityServerId: 'server-1',
            externalSessionsFeatureEnabled: false,
            settings: {} as any,
            agentType: 'claude' as any,
            resumeSessionId: null,
            backendNewSessionOptionStateByTargetKey: {},
            resolvedBackendEntries: [
                {
                    family: 'builtInAgent',
                    builtInAgentId: 'claude',
                    target: { kind: 'builtInAgent', agentId: 'claude' },
                    targetKey: 'agent:claude',
                    title: 'Claude',
                } as any,
            ],
            selectedBackendEntry: null,
            setBackendTarget: vi.fn(),
            machines: [],
            dismissedCliWarnings: null,
            setDismissedCliWarnings: vi.fn(),
            allProfiles: [{ id: 'profile-1' }] as any,
        }));

        expect(resolveProfileAvailabilityForNewSessionSpy).toHaveBeenCalled();
        expect((resolveProfileAvailabilityForNewSessionSpy.mock.calls[0]?.[0] as any)).toEqual(expect.objectContaining({
            authStatusById: expect.objectContaining({
                claude: { state: 'logged_out', checkedAt: 1 },
                codex: { state: 'logged_in', checkedAt: 1 },
            }),
        }));
        expect(useCLIDetectionSpy).toHaveBeenCalledWith(null, expect.objectContaining({
            autoDetect: false,
            includeLoginStatus: true,
            includeLoginStatusForAgentIds: ['claude'],
            serverId: 'server-1',
        }));
    });

    it('resolves an installed Agent dependency from the selected machine projection', async () => {
        vi.resetModules();

        const {
            clearProjectedAgentUiBehaviorDescriptors,
            publishProjectedAgentUiBehaviorDescriptors,
        } = await import('@/agents/registry/agentUiBehaviorProjection');
        const { useNewSessionAvailabilityState } = await import('./useNewSessionAvailabilityState');
        const machine: Machine = {
            id: 'machine-1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: Date.now(),
            revokedAt: null,
            metadata: null,
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 1,
        };

        clearProjectedAgentUiBehaviorDescriptors();
        publishProjectedAgentUiBehaviorDescriptors({
            machineId: machine.id,
            descriptorsByAgentId: {
                'acme.reviewer': {
                    newSession: { relevantInstallableDepKeys: ['acme.cli'] },
                },
            },
        });

        const hook = await renderHook(() => useNewSessionAvailabilityState({
            selectedMachineId: machine.id,
            selectedMachine: machine,
            capabilityServerId: 'server-1',
            externalSessionsFeatureEnabled: false,
            settings: {} as any,
            staticAgentId: null,
            runtimeCarrierAgentId: 'acme.reviewer',
            resumeSessionId: null,
            backendNewSessionOptionStateByTargetKey: {},
            resolvedBackendEntries: [],
            selectedBackendEntry: null,
            setBackendTarget: vi.fn(),
            machines: [machine],
            dismissedCliWarnings: null,
            setDismissedCliWarnings: vi.fn(),
            allProfiles: [],
            pluginProjectionV2: {
                familiesById: {
                    managedDependencies: {
                        entriesById: {
                            'acme.cli': {
                                id: 'acme.cli',
                                pluginId: 'acme.tools',
                                key: 'acme.cli',
                                capabilityId: 'dep.acme.cli',
                                sourceKind: 'npm',
                                display: {
                                    name: 'Acme CLI',
                                    subtitle: 'Tools for Acme workspaces',
                                },
                                description: 'Install the Acme command-line tools.',
                                ui: {
                                    iconName: 'terminal',
                                    setupUrl: 'https://docs.acme.test/setup',
                                },
                                defaultPolicy: {
                                    autoInstallWhenNeeded: false,
                                    autoUpdateMode: 'manual',
                                },
                                experimental: false,
                            },
                        },
                    },
                },
            } as any,
        } as any));

        expect(hook.getCurrent().wizardInstallableDeps).toHaveLength(1);
        expect(hook.getCurrent().wizardInstallableDeps[0]?.entry).toEqual(expect.objectContaining({
            key: 'acme.cli',
            capabilityId: 'dep.acme.cli',
            title: 'Acme CLI',
            subtitle: 'Tools for Acme workspaces',
            setupUrl: 'https://docs.acme.test/setup',
        }));

        clearProjectedAgentUiBehaviorDescriptors();
    });

    it('keeps temporary CLI banner dismissals across hook remounts (same app session)', async () => {
        vi.resetModules();

        const { useNewSessionAvailabilityState } = await import('./useNewSessionAvailabilityState');

        const setDismissedCliWarnings = vi.fn();
        const machine: Machine = {
            id: 'm1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: Date.now(),
            revokedAt: null,
            metadata: null,
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 1,
        };

        const hookA = await renderHook(() => useNewSessionAvailabilityState({
            selectedMachineId: machine.id,
            selectedMachine: machine,
            capabilityServerId: 'server-1',
            externalSessionsFeatureEnabled: false,
            settings: {} as any,
            agentType: 'claude' as any,
            resumeSessionId: null,
            backendNewSessionOptionStateByTargetKey: {},
            resolvedBackendEntries: [],
            selectedBackendEntry: null,
            setBackendTarget: vi.fn(),
            machines: [machine],
            dismissedCliWarnings: null,
            setDismissedCliWarnings,
            allProfiles: [],
        }));

        expect(hookA.getCurrent().isCliBannerDismissed('claude' as any)).toBe(false);

        await act(async () => {
            hookA.getCurrent().dismissCliBanner('claude' as any, 'temporary');
        });
        await hookA.rerender();

        expect(hookA.getCurrent().isCliBannerDismissed('claude' as any)).toBe(true);
        expect(setDismissedCliWarnings).not.toHaveBeenCalled();

        await hookA.unmount();

        const hookB = await renderHook(() => useNewSessionAvailabilityState({
            selectedMachineId: machine.id,
            selectedMachine: machine,
            capabilityServerId: 'server-1',
            externalSessionsFeatureEnabled: false,
            settings: {} as any,
            agentType: 'claude' as any,
            resumeSessionId: null,
            backendNewSessionOptionStateByTargetKey: {},
            resolvedBackendEntries: [],
            selectedBackendEntry: null,
            setBackendTarget: vi.fn(),
            machines: [machine],
            dismissedCliWarnings: null,
            setDismissedCliWarnings,
            allProfiles: [],
        }));

        expect(hookB.getCurrent().isCliBannerDismissed('claude' as any)).toBe(true);
    });

    it('treats temporary CLI banner dismissals as machine-scoped', async () => {
        vi.resetModules();

        const { useNewSessionAvailabilityState } = await import('./useNewSessionAvailabilityState');

        const setDismissedCliWarnings = vi.fn();
        const baseMachine: Machine = {
            id: 'm1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: Date.now(),
            revokedAt: null,
            metadata: null,
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 1,
        };

        const hookA = await renderHook(() => useNewSessionAvailabilityState({
            selectedMachineId: baseMachine.id,
            selectedMachine: baseMachine,
            capabilityServerId: 'server-1',
            externalSessionsFeatureEnabled: false,
            settings: {} as any,
            agentType: 'claude' as any,
            resumeSessionId: null,
            backendNewSessionOptionStateByTargetKey: {},
            resolvedBackendEntries: [],
            selectedBackendEntry: null,
            setBackendTarget: vi.fn(),
            machines: [baseMachine],
            dismissedCliWarnings: null,
            setDismissedCliWarnings,
            allProfiles: [],
        }));

        await act(async () => {
            hookA.getCurrent().dismissCliBanner('claude' as any, 'temporary');
        });
        await hookA.rerender();

        expect(hookA.getCurrent().isCliBannerDismissed('claude' as any)).toBe(true);
        await hookA.unmount();

        const otherMachine: Machine = { ...baseMachine, id: 'm2' };
        const hookB = await renderHook(() => useNewSessionAvailabilityState({
            selectedMachineId: otherMachine.id,
            selectedMachine: otherMachine,
            capabilityServerId: 'server-1',
            externalSessionsFeatureEnabled: false,
            settings: {} as any,
            agentType: 'claude' as any,
            resumeSessionId: null,
            backendNewSessionOptionStateByTargetKey: {},
            resolvedBackendEntries: [],
            selectedBackendEntry: null,
            setBackendTarget: vi.fn(),
            machines: [otherMachine],
            dismissedCliWarnings: null,
            setDismissedCliWarnings,
            allProfiles: [],
        }));

        expect(hookB.getCurrent().isCliBannerDismissed('claude' as any)).toBe(false);
    });

    describe('installed Agent resume picker', () => {
        const installedAgentMachine: Machine = {
            id: 'machine-1',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: Date.now(),
            revokedAt: null,
            metadata: null,
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 1,
        };

        async function renderWithProjectedAgent(sessionOpenOperations: readonly string[]) {
            vi.resetModules();
            vi.doMock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
                useDaemonMergedProjectionInputs: () => ({
                    phase: 'ready',
                    inputs: {
                        pluginProjectionV2: {
                            generation: 4,
                            agentsById: {
                                'acme.reviewer': {
                                    id: 'acme.reviewer',
                                    identity: { pluginId: 'acme.tools', localId: 'reviewer' },
                                    capabilities: { sessions: { open: sessionOpenOperations } },
                                },
                            },
                        },
                    },
                }),
            }));

            const { useNewSessionAvailabilityState } = await import('./useNewSessionAvailabilityState');
            return renderHook(() => useNewSessionAvailabilityState({
                selectedMachineId: installedAgentMachine.id,
                selectedMachine: installedAgentMachine,
                capabilityServerId: 'server-1',
                externalSessionsFeatureEnabled: false,
                settings: {} as any,
                // An installed Agent has no bundled catalog backing, so the
                // static catalog id is null and only the runtime carrier names it.
                staticAgentId: null,
                runtimeCarrierAgentId: 'acme.reviewer',
                resumeSessionId: null,
                backendNewSessionOptionStateByTargetKey: {},
                resolvedBackendEntries: [],
                selectedBackendEntry: null,
                setBackendTarget: vi.fn(),
                machines: [installedAgentMachine],
                dismissedCliWarnings: null,
                setDismissedCliWarnings: vi.fn(),
                allProfiles: [],
            } as any));
        }

        it('offers the resume picker for an installed Agent whose current projection declares resume', async () => {
            const hook = await renderWithProjectedAgent(['create', 'resume']);
            expect(hook.getCurrent().showResumePicker).toBe(true);
        });

        it('withholds the resume picker when the same installed Agent does not declare resume', async () => {
            const hook = await renderWithProjectedAgent(['create']);
            expect(hook.getCurrent().showResumePicker).toBe(false);
        });
    });
});
