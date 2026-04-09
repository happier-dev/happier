import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { installSessionHooksCommonModuleMocks } from '@/hooks/session/sessionHooksTestHelpers';

const createDefaultActionExecutorSpy = vi.fn((..._args: unknown[]) => ({
    execute: vi.fn(),
}));
const useMachineCapabilitiesCacheSpy = vi.fn((..._args: unknown[]) => ({ state: { status: 'idle' } }));
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
const mockSession = {
    id: 'session-launcher',
    active: false,
    metadata: {
        flavor: 'claude',
        machineId: 'machine-launcher',
    },
};

installSessionHooksCommonModuleMocks({
    reactNative: async () => createReactNativeWebMock(),
    router: async () => createExpoRouterMock({
        router: {
            push: routerPushSpy,
            replace: vi.fn(),
            back: vi.fn(),
            setParams: vi.fn(),
        },
    }).module,
});

vi.mock('react-native-unistyles', async () => createUnistylesMock());

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => [],
}));

vi.mock('@/agents/hooks/useResumeCapabilityOptions', () => ({
    useResumeCapabilityOptions: () => ({ resumeCapabilityOptions: [] }),
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
    useHydrateSessionForRoute: () => true,
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

vi.mock('@/sync/domains/state/storage', () => ({
    useSession: () => mockSession,
    useSettings: () => ({
        executionRunsGuidanceEnabled: false,
        executionRunsGuidanceMaxChars: 0,
        executionRunsGuidanceEntries: [],
        acpCatalogSettingsV1: { v: 2, backends: [] },
    }),
}));

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

vi.mock('@/sync/domains/session/directSessions/resolveSessionMachineId', () => ({
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
        useMachineCapabilitiesCacheSpy.mockClear();
        resolveSessionTargetServerIdSpy.mockClear();
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
        });
        expect(resolveSessionTargetServerIdSpy).not.toHaveBeenCalled();
        const executorConfig = createDefaultActionExecutorSpy.mock.calls.at(-1)?.[0] as {
            resolveServerIdForSessionId: (sessionId: string) => string | null;
        };
        expect(executorConfig.resolveServerIdForSessionId('session-launcher')).toBe('server-launcher');
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

});
