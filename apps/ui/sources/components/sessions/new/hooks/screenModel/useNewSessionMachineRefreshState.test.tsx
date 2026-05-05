import { describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderHook } from '@/dev/testkit';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';

import { useNewSessionMachineRefreshState } from './useNewSessionMachineRefreshState';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HookParams = Parameters<typeof useNewSessionMachineRefreshState>[0];

function makeMachine(input: Readonly<{
    id: string;
    metadata?: Partial<NonNullable<Machine['metadata']>>;
}>): Machine {
    const base = createMachineFixture({ id: input.id });
    return {
        ...base,
        metadata: {
            ...(base.metadata ?? {}),
            ...(input.metadata ?? {}),
        } as NonNullable<Machine['metadata']>,
    };
}

function createSession(input: Readonly<{
    id: string;
    machineId: string;
    path: string;
    updatedAt?: number;
}>): Session {
    return {
        id: input.id,
        seq: 1,
        createdAt: 1,
        updatedAt: input.updatedAt ?? 1,
        active: true,
        activeAt: 1,
        metadata: {
            machineId: input.machineId,
            path: input.path,
            homeDir: '/Users/test',
            host: 'host.local',
            flavor: 'claude',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

function renderMachineRefreshState(initialProps: HookParams) {
    return renderHook((props: HookParams) => useNewSessionMachineRefreshState(props), {
        initialProps,
    });
}

describe('useNewSessionMachineRefreshState', () => {
    it('includes previous session paths in the selected machine path suggestions', async () => {
        const initialProps = {
            capabilityServerId: 'server-a',
            selectedMachineId: 'machine-1',
            machines: [makeMachine({ id: 'machine-1', metadata: { homeDir: '/Users/test' } })],
            recentMachinePaths: [],
            favoriteMachines: [],
            useEnhancedSessionWizard: false,
            refreshMachineEnvPresence: vi.fn(),
            sessions: [
                createSession({
                    id: 'session-1',
                    machineId: 'machine-1',
                    path: '/Users/test/Development/atlas',
                    updatedAt: 25,
                }),
            ],
        };

        const hook = await renderMachineRefreshState(initialProps);

        expect(hook.getCurrent().recentPaths).toEqual(['/Users/test/Development/atlas']);

        await hook.unmount();
    });
});
