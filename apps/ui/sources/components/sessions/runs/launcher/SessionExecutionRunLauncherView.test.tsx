import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import { installSessionHooksCommonModuleMocks } from '@/hooks/session/sessionHooksTestHelpers';

const createDefaultActionExecutorSpy = vi.fn((..._args: unknown[]) => ({
    execute: vi.fn(),
}));
const useResumeCapabilityOptionsSpy = vi.fn((..._args: unknown[]) => ({ resumeCapabilityOptions: [] }));
const useMachineCapabilitiesCacheSpy = vi.fn((..._args: unknown[]) => ({ state: { status: 'idle' } }));
const useHydrateSessionForRouteSpy = vi.fn((sessionId: string) => ({ kind: 'available', sessionId }));
const launchabilityState = vi.hoisted(() => {
    let sessionServerId = 'server-launcher';
    const listeners = new Set<(nextValue: string) => void>();

    return {
        get sessionServerId() {
            return sessionServerId;
        },
        set sessionServerId(nextValue: string) {
            sessionServerId = nextValue;
            for (const listener of listeners) {
                listener(nextValue);
            }
        },
        subscribe(listener: (nextValue: string) => void) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
});
const resolveSessionTargetServerIdSpy = vi.fn((_sessionId: string, fallbackServerId?: string | null) => fallbackServerId ?? null);
const routerPushSpy = vi.fn();
let mockSession: {
    id: string;
    active: boolean;
    metadata: {
        flavor?: string;
        agent?: string;
        machineId: string;
    };
} = {
    id: 'session-launcher',
    active: false,
    metadata: {
        flavor: 'claude',
        machineId: 'machine-launcher',
    },
};

installSessionHooksCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                push: routerPushSpy,
                replace: vi.fn(),
                back: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    },
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({
    ActivitySpinner: (props: any) => React.createElement('ActivitySpinner', props),
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => [],
}));

vi.mock('@/agents/hooks/useResumeCapabilityOptions', () => ({
    useResumeCapabilityOptions: (...args: unknown[]) => useResumeCapabilityOptionsSpy(...args),
}));

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({ machineReachable: true }),
}));

vi.mock('@/components/sessions/model/resolveSessionTargetServerId', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/sessions/model/resolveSessionTargetServerId')>();
    return {
        ...actual,
        resolveSessionTargetServerId: (...args: unknown[]) => resolveSessionTargetServerIdSpy(
            args[0] as string,
            args[1] as string | null | undefined,
        ),
    };
});

vi.mock('@/hooks/server/useMachineCapabilitiesCache', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/hooks/server/useMachineCapabilitiesCache')>();
    return {
        ...actual,
        useMachineCapabilitiesCache: (...args: unknown[]) => useMachineCapabilitiesCacheSpy(...args),
    };
});

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string) => useHydrateSessionForRouteSpy(sessionId),
}));

vi.mock('@/hooks/session/useSessionExecutionRunLaunchability', () => ({
    useSessionExecutionRunLaunchability: () => {
        const [sessionServerId, setSessionServerId] = React.useState(launchabilityState.sessionServerId);
        React.useEffect(() => launchabilityState.subscribe(setSessionServerId), []);
        return {
            canLaunchExecutionRuns: true,
            canShowExecutionRunLauncher: true,
            executionRunsBackends: {},
            executionRunsSupported: true,
            sessionServerId,
        };
    },
}));

const storageMock = createStorageModuleStub({
    useSession: () => mockSession,
    useSettings: () => ({
        executionRunsGuidanceEnabled: false,
        executionRunsGuidanceMaxChars: 0,
        executionRunsGuidanceEntries: [],
        acpCatalogSettingsV1: { v: 2, backends: [] },
    }),
});

vi.mock('@/sync/domains/state/storage', () => storageMock);

vi.mock('@/sync/ops/actions/defaultActionExecutor', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/ops/actions/defaultActionExecutor')>();
    return {
        ...actual,
        createDefaultActionExecutor: (...args: unknown[]) => createDefaultActionExecutorSpy(...args),
    };
});

vi.mock('@/sync/domains/reviews/reviewEngineCatalog', () => ({
    buildAvailableReviewEngineOptions: () => [],
}));

vi.mock('@/sync/domains/permissions/permissionModeOptions', () => ({
    getPermissionModeOptionsForAgentType: () => [{ value: 'read-only', label: 'read-only' }],
}));

vi.mock('@/sync/domains/actions/resolveActionInputValidationError', () => ({
    resolveActionInputValidationError: () => null,
}));

vi.mock('@/sync/domains/actions/buildExecutionRunActionDraftInputForUi', () => ({
    buildExecutionRunActionDraftInputForUi: () => ({}),
}));

vi.mock('@/sync/domains/actions/resolveExecutionRunActionDefaultPermissionMode', () => ({
    resolveExecutionRunActionDefaultPermissionMode: () => 'read-only',
}));

vi.mock('@/sync/domains/actions/resolveExecutionRunActionAllowedPermissionModes', () => ({
    resolveExecutionRunActionAllowedPermissionModes: () => [],
}));

vi.mock('@/sync/domains/session/external/resolveSessionMachineId', () => ({
    resolveSessionMachineId: () => 'machine-launcher',
}));

vi.mock('@/sync/ops/actions/resolveActionExecutionFailureMessage', () => ({
    resolveActionExecutionFailureMessage: () => null,
}));

vi.mock('@/sync/ops/sessions', () => ({
    resumeSession: vi.fn(async () => ({ type: 'success' })),
}));

vi.mock('./resolveExecutionRunLauncherBackendChoices', () => ({
    resolveExecutionRunLauncherBackendChoices: () => [],
}));

vi.mock('./resolveExecutionRunLauncherContainerStyle', () => ({
    resolveExecutionRunLauncherContainerStyle: () => ({}),
}));

vi.mock('@/components/sessions/actions/ActionInputFields', () => ({
    ActionInputFields: () => React.createElement('ActionInputFields'),
    getValueAtPath: () => undefined,
    setValueAtTopLevelPatch: () => ({}),
}));

vi.mock('@happier-dev/protocol', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/protocol')>();
    return {
        ...actual,
        getActionSpec: () => ({ id: 'review.start' }),
        resolveEffectiveActionInputFields: () => [],
    };
});

describe('SessionExecutionRunLauncherView', () => {
    beforeEach(() => {
        createDefaultActionExecutorSpy.mockClear();
        useResumeCapabilityOptionsSpy.mockClear();
        useMachineCapabilitiesCacheSpy.mockClear();
        useHydrateSessionForRouteSpy.mockClear();
        resolveSessionTargetServerIdSpy.mockClear();
        mockSession = {
            id: 'session-launcher',
            active: false,
            metadata: {
                flavor: 'claude',
                machineId: 'machine-launcher',
            },
        };
        launchabilityState.sessionServerId = 'server-launcher';
    });

    afterEach(() => {
        standardCleanup();
    });

    it('threads the session server id into the machine capabilities cache request', async () => {
        const { SessionExecutionRunLauncherView } = await import('./SessionExecutionRunLauncherView');
        await renderScreen(React.createElement(SessionExecutionRunLauncherView, {
            sessionId: 'session-launcher',
            presentation: 'panel',
        }));

        const cacheRequest = (useMachineCapabilitiesCacheSpy.mock.calls as Array<[{
            serverId?: string;
        }]>).at(-1)?.[0];
        expect(cacheRequest).toMatchObject({
            serverId: 'server-launcher',
            request: { requests: [{ id: 'tool.executionRuns', params: { sessionId: 'session-launcher' } }] },
        });
        expect(resolveSessionTargetServerIdSpy).not.toHaveBeenCalled();
        const executorConfig = createDefaultActionExecutorSpy.mock.calls.at(-1)?.[0] as {
            resolveServerIdForSessionId: (sessionId: string) => string | null;
        };
        expect(executorConfig.resolveServerIdForSessionId('session-launcher')).toBe('server-launcher');
    });

    it('uses caller-provided route hydration state without issuing a second hydration request', async () => {
        const { SessionExecutionRunLauncherView } = await import('./SessionExecutionRunLauncherView');
        const screen = await renderScreen(React.createElement(SessionExecutionRunLauncherView, {
            sessionId: 'session-launcher',
            presentation: 'panel',
            routeHydrationState: { kind: 'loading', sessionId: 'session-launcher', reason: 'store-miss' },
        }));

        expect(useHydrateSessionForRouteSpy).not.toHaveBeenCalled();
        expect(screen.findAllByType('ActivitySpinner')).toHaveLength(1);
    });

    it('re-resolves the launcher session server when the launchability hook changes', async () => {
        const { SessionExecutionRunLauncherView } = await import('./SessionExecutionRunLauncherView');
        const screen = await renderScreen(React.createElement(SessionExecutionRunLauncherView, {
            sessionId: 'session-launcher',
            presentation: 'panel',
        }));

        await act(async () => {
            launchabilityState.sessionServerId = 'server-reactive';
            screen.tree.update(React.createElement(SessionExecutionRunLauncherView, {
                sessionId: 'session-launcher',
                presentation: 'panel',
            }));
        });

        const cacheRequest = (useMachineCapabilitiesCacheSpy.mock.calls as Array<[{
            serverId?: string;
        }]>).at(-1)?.[0];
        expect(cacheRequest).toMatchObject({
            serverId: 'server-reactive',
        });
        const executorConfig = createDefaultActionExecutorSpy.mock.calls.at(-1)?.[0] as {
            resolveServerIdForSessionId: (sessionId: string) => string | null;
        };
        expect(executorConfig.resolveServerIdForSessionId('session-launcher')).toBe('server-reactive');
        await screen.unmount();
    });

    it('does not synthesize a built-in default backend target when the session helper yields no backend default', async () => {
        mockSession = {
            id: 'session-launcher',
            active: false,
            metadata: {
                flavor: 'not-a-real-agent',
                machineId: 'machine-launcher',
            },
        };
        const { SessionExecutionRunLauncherView } = await import('./SessionExecutionRunLauncherView');
        await renderScreen(React.createElement(SessionExecutionRunLauncherView, {
            sessionId: 'session-launcher',
            presentation: 'panel',
            initialIntent: 'delegate',
        }));

        expect(useResumeCapabilityOptionsSpy).toHaveBeenCalled();
        const hookArgs = useResumeCapabilityOptionsSpy.mock.calls.at(-1)?.[0] as {
            agentId?: unknown;
        };
        expect(hookArgs).toMatchObject({
            agentId: null,
        });
    });

    it('preserves an external Agent identity from legacy session metadata for resume support', async () => {
        mockSession = {
            id: 'session-launcher',
            active: false,
            metadata: {
                agent: 'acme.agent',
                machineId: 'machine-launcher',
            },
        };
        const { SessionExecutionRunLauncherView } = await import('./SessionExecutionRunLauncherView');
        await renderScreen(React.createElement(SessionExecutionRunLauncherView, {
            sessionId: 'session-launcher',
            presentation: 'panel',
            initialIntent: 'delegate',
        }));

        const hookArgs = useResumeCapabilityOptionsSpy.mock.calls.at(-1)?.[0] as {
            agentId?: unknown;
        };
        expect(hookArgs).toMatchObject({
            agentId: 'acme.agent',
        });
    });

    it('reuses the accepted choice key for an exact external Agent target', async () => {
        const { resolveInitialExecutionRunBackendTargetKey } = await import('./SessionExecutionRunLauncherView');
        const target = {
            kind: 'agent' as const,
            identity: { pluginId: 'acme.agent', localId: 'runner' },
        };

        expect(resolveInitialExecutionRunBackendTargetKey(target, [{
            backendTarget: target,
            targetKey: 'agent:acme.agent/runner',
            backendId: 'acme.agent/runner',
            agentId: 'acme.agent/runner',
            title: 'Acme Runner',
            disabled: false,
        }])).toBe('agent:acme.agent/runner');
    });

});
