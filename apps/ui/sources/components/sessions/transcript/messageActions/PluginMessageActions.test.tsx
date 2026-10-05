import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginProjectedActionV2Schema, type MessageActionReferenceV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type {
    PluginProjectionAction,
    PluginProjectionEntry,
} from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { renderScreen, standardCleanup } from '@/dev/testkit';

import {
    createPluginMessageActionHost,
    PluginMessageActionHostProvider,
    PluginMessageActions,
} from './PluginMessageActions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const machinePluginStructuredMessageActionExecuteMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
            select: <T,>(values: { ios?: T; native?: T; default?: T }) =>
                values.ios ?? values.native ?? values.default,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                state: { neutral: { background: '#eeeeee' } },
                text: { secondary: '#666666' },
            },
        },
    });
});

vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: (props: Record<string, unknown>) => React.createElement('Icon', props),
    ICON_SIZE: { xs: 14 },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('Text', props, props.children),
}));

// Keep the projection/schema/dispatch owners real; only daemon RPC leaves the process.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (request: { machineId: string; serverId?: string | null; signal?: AbortSignal;
        method: string; payload: Record<string, unknown> }) => {
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) return { ok: true, inputSchema: {} };
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
            const { machineId, ...payload } = request.payload;
            return machinePluginStructuredMessageActionExecuteMock(request.machineId,
                { ...payload, serverId: request.serverId, signal: request.signal });
        }
        throw new Error(`Unexpected daemon RPC: ${request.method}`);
    },
}));

const messageReference: MessageActionReferenceV1 = {
    v: 1,
    sessionId: 'session-1',
    messageId: 'message-1',
    observedRevision: 'revision-1',
};

function action(input: Partial<PluginProjectionAction> & Readonly<{ id: string }>): PluginProjectionAction {
    return {
        id: input.id,
        occurrenceId: input.occurrenceId ?? '7',
        title: input.title ?? input.id,
        description: input.description ?? null,
        icon: input.icon ?? null,
        scopes: input.scopes ?? ['message'],
        surfaces: input.surfaces ?? ['ui'],
        placementBindings: input.placementBindings ?? ['rowAction'],
        inputHints: input.inputHints ?? null,
        priority: input.priority ?? null,
        dangerLevel: input.dangerLevel ?? 'safe',
        confirmation: input.confirmation ?? null,
        available: input.available ?? true,
    };
}

function entry(actions: readonly PluginProjectionAction[]): PluginProjectionEntry {
    return {
        pluginId: 'acme.preview',
        title: 'Preview',
        description: null,
        version: '1.0.0',
        enabled: true,
        generation: 7,
        generationLabel: '7',
        status: null,
        provenance: null,
        diagnostics: [],
        actions,
        resources: [],
        editableSettingsGroups: [],
    };
}

describe('PluginMessageActions', () => {
    beforeEach(() => {
        machinePluginStructuredMessageActionExecuteMock.mockReset();
        machinePluginStructuredMessageActionExecuteMock.mockResolvedValue({
            ok: true, result: null,
        });
    });

    afterEach(() => {
        standardCleanup();
    });

    it('preserves legacy message Actions and presents semantic menu Actions with current Message intent', async () => {
        const projection = entry([
            action({ id: 'open-preview', title: 'Open preview' }),
            action({ id: 'session-only', scopes: ['session'], placementBindings: ['contextMenu'] }),
            action({ id: 'menu-only', placementBindings: ['contextMenu'] }),
            action({ id: 'semantic-menu-only', placementBindings: ['message.menu'] }),
            action({ id: 'mixed-menu', placementBindings: ['contextMenu', 'message.menu'] }),
        ]);
        const resolveCurrent = vi.fn(() => ({
            resolveContributedAction: (identity: { pluginId: string; localId: string }) => {
                const contribution = projection.actions.find((candidate) => candidate.id === identity.localId);
                if (identity.pluginId !== projection.pluginId || !contribution) return null;
                return PluginProjectedActionV2Schema.parse({
                    id: contribution.id, pluginId: projection.pluginId, occurrenceId: String(projection.generation),
                    title: contribution.title, scopes: contribution.scopes, surfaces: contribution.surfaces,
                    placementBindings: contribution.placementBindings, execution: { target: 'daemon' },
                    dangerLevel: contribution.dangerLevel, available: true,
                });
            },
            pluginProjectionById: {
                'acme.preview': projection,
            },
            host: {
                machineId: 'machine-1',
                serverId: 'server-1',
                expectedContributorOccurrenceId: 7,
                sessionId: 'session-1',
                isCurrent: () => true,
            },
        }));
        const abortController = new AbortController();
        const host = createPluginMessageActionHost({
            resolveCurrent,
            sessionId: 'session-1',
            signal: abortController.signal,
        });

        const screen = await renderScreen(
            <PluginMessageActionHostProvider host={host}>
                <PluginMessageActions
                    messageActionReference={messageReference}
                    invertedActionsLayout={false}
                />
            </PluginMessageActionHostProvider>,
        );

        expect(screen.findByTestId('plugin-message-action:acme.preview/open-preview')).toBeTruthy();
        expect(screen.findByTestId('plugin-message-action:acme.preview/session-only')).toBeNull();
        expect(screen.findByTestId('plugin-message-action:acme.preview/menu-only')).toBeNull();
        expect(screen.findByTestId('plugin-message-actions-overflow')).toBeTruthy();
        const currentReadsBeforeRowPress = resolveCurrent.mock.calls.length;

        await act(async () => {
            screen.pressByTestId('plugin-message-action:acme.preview/open-preview');
            await vi.waitFor(() => expect(machinePluginStructuredMessageActionExecuteMock).toHaveBeenCalled());
        });

        expect(resolveCurrent.mock.calls.length).toBeGreaterThan(currentReadsBeforeRowPress);
        expect(machinePluginStructuredMessageActionExecuteMock).toHaveBeenCalledWith('machine-1', {
            serverId: 'server-1',
            expectedContributorOccurrenceId: '7',
            qualifiedActionId: 'acme.preview/open-preview',
            input: {},
            executionSurface: 'ui',
            sessionId: 'session-1',
            messageActionReference: messageReference,
            signal: abortController.signal,
        });

        await act(async () => {
            screen.pressByTestId('plugin-message-actions-overflow');
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        });

        expect(screen.findByTestId('plugin-message-action-menu:acme.preview/menu-only')).toBeTruthy();
        expect(screen.findByTestId('plugin-message-action-menu:acme.preview/semantic-menu-only')).toBeTruthy();
        expect(screen.findAllByType('Pressable').filter(
            (node) => node.props.testID === 'plugin-message-action-menu:acme.preview/mixed-menu',
        )).toHaveLength(1);
        expect(screen.findByTestId('plugin-message-action-menu:acme.preview/session-only')).toBeNull();

        await act(async () => {
            screen.pressByTestId('plugin-message-action-menu:acme.preview/menu-only');
            await vi.waitFor(() => expect(machinePluginStructuredMessageActionExecuteMock.mock.calls.at(-1)?.[1])
                .toMatchObject({ qualifiedActionId: 'acme.preview/menu-only' }));
        });

        expect(machinePluginStructuredMessageActionExecuteMock).toHaveBeenLastCalledWith('machine-1', {
            serverId: 'server-1',
            expectedContributorOccurrenceId: '7',
            qualifiedActionId: 'acme.preview/menu-only',
            input: {},
            executionSurface: 'ui',
            sessionId: 'session-1',
            messageActionReference: messageReference,
            signal: abortController.signal,
        });
        const legacyRequest = machinePluginStructuredMessageActionExecuteMock.mock.calls.at(-1)?.[1];
        expect(legacyRequest).not.toHaveProperty('invocation');

        await act(async () => {
            screen.pressByTestId('plugin-message-actions-overflow');
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        });
        await act(async () => {
            screen.pressByTestId('plugin-message-action-menu:acme.preview/semantic-menu-only');
            await vi.waitFor(() => expect(machinePluginStructuredMessageActionExecuteMock.mock.calls.at(-1)?.[1])
                .toMatchObject({ qualifiedActionId: 'acme.preview/semantic-menu-only' }));
        });

        expect(machinePluginStructuredMessageActionExecuteMock).toHaveBeenLastCalledWith('machine-1', {
            serverId: 'server-1',
            expectedContributorOccurrenceId: '7',
            qualifiedActionId: 'acme.preview/semantic-menu-only',
            input: {},
            executionSurface: 'ui',
            sessionId: 'session-1',
            messageActionReference: messageReference,
            invocation: {
                kind: 'hostPresentedMessage',
                currentMessageIntent: messageReference,
            },
            signal: abortController.signal,
        });
    });

    it('fails closed when the row reference is not current for the mounted transcript host', async () => {
        const resolveCurrent = vi.fn(() => {
            throw new Error('a cross-session row must not read the mounted Action projection');
        });
        const host = createPluginMessageActionHost({
            resolveCurrent,
            sessionId: 'session-1',
        });
        const screen = await renderScreen(
            <PluginMessageActionHostProvider host={host}>
                <PluginMessageActions
                    messageActionReference={{ ...messageReference, sessionId: 'other-session' }}
                    invertedActionsLayout={false}
                />
            </PluginMessageActionHostProvider>,
        );

        expect(screen.findAllByType('Pressable')).toHaveLength(0);
        expect(resolveCurrent).not.toHaveBeenCalled();
        expect(machinePluginStructuredMessageActionExecuteMock).not.toHaveBeenCalled();
    });

});
