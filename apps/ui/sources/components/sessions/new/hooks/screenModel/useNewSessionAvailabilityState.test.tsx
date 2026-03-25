import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('@/hooks/auth/useCLIDetection', () => ({
    useCLIDetection: () => ({
        available: { claude: false, codex: true },
        login: {},
        authStatus: {},
        resolvedPath: {},
        resolvedCommand: {},
        resolutionSource: {},
        tmux: null,
        isDetecting: false,
        timestamp: 123,
        refresh: cliRefreshCurrent,
    }),
}));

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
    isAgentSelectableForNewSession: ({ agentId, availabilityById }: any) => availabilityById?.[agentId] !== false,
    resolveProfileAvailabilityForNewSession: () => ({ available: true }),
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
        capabilitiesRefreshA.mockClear();
        capabilitiesRefreshB.mockClear();
        cliRefreshCurrent = cliRefreshA;
        capabilitiesRefreshCurrent = capabilitiesRefreshA;
    });

    it('does not auto-switch the selected backend when CLI detection marks it unavailable', async () => {
        vi.resetModules();

        const { useNewSessionAvailabilityState } = await import('./useNewSessionAvailabilityState');

        const setBackendTarget = vi.fn();

        await renderHook(() => useNewSessionAvailabilityState({
            selectedMachineId: null,
            selectedMachine: null,
            capabilityServerId: 'server-1',
            settings: {} as any,
            agentType: 'claude' as any,
            resumeSessionId: null,
            enabledAgentIds: ['claude', 'codex'] as any,
            agentNewSessionOptionStateByAgentId: {},
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
            settings: {} as any,
            agentType: 'claude' as any,
            resumeSessionId: null,
            enabledAgentIds: ['claude', 'codex'] as any,
            agentNewSessionOptionStateByAgentId: {},
            resolvedBackendEntries: [],
            selectedBackendEntry: null,
            setBackendTarget,
            machines: [machine],
            dismissedCliWarnings: null,
            setDismissedCliWarnings: vi.fn(),
            allProfiles: [],
        }), { initialProps: { refreshSalt: 0 } });

        expect(cliRefreshA).toHaveBeenCalledTimes(1);
        expect(capabilitiesRefreshA).toHaveBeenCalledTimes(1);

        cliRefreshCurrent = cliRefreshB;
        capabilitiesRefreshCurrent = capabilitiesRefreshB;
        await hook.rerender({ refreshSalt: 1 });

        expect(cliRefreshA).toHaveBeenCalledTimes(1);
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
            settings: {} as any,
            agentType: 'claude' as any,
            resumeSessionId: null,
            enabledAgentIds: ['claude', 'codex'] as any,
            agentNewSessionOptionStateByAgentId: {},
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
        expect(capabilitiesRefreshA).toHaveBeenCalledTimes(1);

        await hook.rerender({ machine: { ...baseMachine, active: false } });
        await hook.rerender({ machine: { ...baseMachine, active: true, activeAt: Date.now() } });
        expect(cliRefreshA).toHaveBeenCalledTimes(2);
        expect(capabilitiesRefreshA).toHaveBeenCalledTimes(2);
    });
});
