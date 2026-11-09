import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { SystemTaskResult, SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import type { RelayDriftBanner } from '@/components/settings/server/relayDriftTypes';
import type { SystemTaskBridgeListenerSet } from '@/components/systemTasks/types';
import type { SetupThisComputerWizardPrimaryState } from './SetupThisComputerChecklistStep';

const RELAY_URL = 'https://relay.example.test';

const preflightMock = vi.hoisted(() => ({
    value: {
        activeRelayUrl: 'https://relay.example.test' as string | null,
        activeWebappUrl: 'https://app.example.test' as string | null,
        activeLocalRelayUrl: null as string | null,
        activeServerId: 'srv_relay_example' as string | null,
        localCliReady: false,
        serviceInstalled: false,
        daemonRunning: false,
        machineId: null as string | null,
        needsAuth: true,
        daemonServerUrl: null as string | null,
        daemonComparableKey: null as string | null,
        daemonAccountId: null as string | null,
        daemonMachineRegistered: false as boolean | null,
        uiAccountId: 'acct_ui',
        serverMismatch: false,
        accountMismatch: false,
        pairingRequired: true,
        relayDriftBanner: null as RelayDriftBanner | null,
        thisComputerConnection: null,
    },
}));

const approvalMocks = vi.hoisted(() => ({
    readCredentials: vi.fn(),
    serverFetch: vi.fn(),
    createServerFetchAtEndpoint: vi.fn(),
    endpointFetch: vi.fn(),
}));

const runnerMock = vi.hoisted(() => ({ value: null as unknown }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Pressable: 'Pressable',
        ScrollView: 'ScrollView',
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            borderRadius: { modalCard: 14 },
            colors: {
                text: '#111',
                textSecondary: '#666',
                textTertiary: '#999',
                surface: '#fff',
                surfaceHigh: '#f9f9f9',
                surfacePressed: '#f2f2f2',
                surfacePressedOverlay: '#fafafa',
                surfaceSelected: '#f8f8f8',
                divider: '#ddd',
                accent: { blue: '#007aff' },
                success: '#34c759',
                warningCritical: '#ff3b30',
            },
        },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

vi.mock('@/components/ui/code/blocks/CodeBlockViewFrame', () => ({
    CodeBlockViewFrame: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('CodeBlockViewFrame', props, props.children),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const modalMock = createModalModuleMock({ spies: { confirm: vi.fn(async () => true) } });
vi.mock('@/modal', () => modalMock.module);

vi.mock('./useThisComputerSetupPreflight', () => ({
    useThisComputerSetupPreflight: () => preflightMock.value,
}));

vi.mock('@/components/systemTasks/systemTasksRuntime', () => ({
    getSystemTasksRunner: () => runnerMock.value,
}));

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    TokenStorage: {
        getCredentialsForServerUrl: (...args: unknown[]) => approvalMocks.readCredentials(...args),
    },
}));

vi.mock('@/sync/http/client', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    serverFetch: (...args: unknown[]) => approvalMocks.serverFetch(...args),
    createServerFetchAtEndpoint: (...args: unknown[]) => approvalMocks.createServerFetchAtEndpoint(...args),
}));

async function createManualRunner() {
    const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
    let nextTsMs = 1;
    const listeners = new Map<string, SystemTaskBridgeListenerSet>();
    const bridge = {
        capabilities: {},
        start: vi.fn(async (_spec: SystemTaskSpec) => 'checklist-task-1'),
        subscribe: vi.fn(async (taskId: string, taskListeners: SystemTaskBridgeListenerSet) => {
            listeners.set(taskId, taskListeners);
            return () => {
                listeners.delete(taskId);
            };
        }),
        cancel: vi.fn(async () => undefined),
        respond: vi.fn(async () => undefined),
    };
    return {
        runner: createSystemTaskRunner({ bridge }),
        bridge,
        emitResult(taskId: string, result: SystemTaskResult) {
            listeners.get(taskId)?.onResult(result);
        },
        emitEvent(taskId: string, event: Record<string, unknown>) {
            listeners.get(taskId)?.onEvent({
                protocolVersion: 1,
                taskId,
                tsMs: nextTsMs++,
                ...event,
            });
        },
    };
}

describe('SetupThisComputerChecklistStep pairing approval', () => {
    beforeEach(() => {
        approvalMocks.readCredentials.mockReset();
        approvalMocks.serverFetch.mockReset();
        approvalMocks.endpointFetch.mockReset();
        approvalMocks.createServerFetchAtEndpoint.mockReset();
        approvalMocks.createServerFetchAtEndpoint.mockImplementation(() => approvalMocks.endpointFetch);
    });

    afterEach(() => {
        standardCleanup();
    });

    // The executor blocks on this prompt: nothing else answers it, and no CLI timeout covers it,
    // so an unanswered prompt leaves the checklist running with no user-reachable way forward.
    it('answers the blocking token-only pairing prompt through the approval owner', async () => {
        approvalMocks.readCredentials.mockResolvedValue({ token: 'relay-bearer' });
        approvalMocks.endpointFetch
            .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'pending', supportsV2: true }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));

        const manual = await createManualRunner();
        runnerMock.value = manual.runner;
        const { SetupThisComputerChecklistStep } = await import('./SetupThisComputerChecklistStep');

        const primaryRef: { current: SetupThisComputerWizardPrimaryState | null } = { current: null };
        await renderScreen(
            <SetupThisComputerChecklistStep
                testID="setup-this-computer"
                onWizardPrimaryChange={(state) => {
                    primaryRef.current = state;
                }}
            />,
        );

        await act(async () => {
            await primaryRef.current?.onPress?.();
        });
        expect(manual.bridge.start).toHaveBeenCalledTimes(1);

        await act(async () => {
            manual.emitEvent('checklist-task-1', {
                type: 'prompt',
                stepId: 'setup.thisComputer.auth.request',
                message: 'Approve this computer in Happier to continue',
                data: {
                    kind: 'authRequest',
                    publicKey: 'pub-key-b64',
                    response: 'opaque-token-only-response-b64',
                    responseKind: 'tokenOnly',
                    relayUrl: RELAY_URL,
                    webappUrl: 'https://app.example.test',
                    cliProvenance: 'managed',
                },
            });
        });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(approvalMocks.readCredentials).toHaveBeenCalledWith(
            RELAY_URL,
            { serverId: 'srv_relay_example' },
        );
        expect(manual.bridge.respond).toHaveBeenCalledWith('checklist-task-1', { approved: true });
    });
});
