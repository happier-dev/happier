import { describe, expect, it, vi } from 'vitest';

import {
    type ActionId,
    createActionExecutor,
    DEFAULT_ACTIONS_SETTINGS_V1,
    isApprovalRequiredByActionsSettings,
    type ActionExecutorContext,
    type ActionExecutorDeps,
} from '@happier-dev/protocol';

import type { MachinePluginUiResourceReadResult, MachinePluginUiResourceWatchNextResult } from '@/sync/ops/machineContributionRegistryProjection';
import type {
    dispatchPluginSurfaceAction,
    PluginSurfaceHostActionExecute,
} from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';

import { createSessionCallerHostedHtmlRequestController } from './sessionCallerHostedHtmlRequestController';

const DIGEST = `sha256:${'a'.repeat(64)}` as const;
const REVISION = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';

function projection(): PluginUiProjectionModel {
    return {
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: 7,
        installedPackagesById: {
            'acme.preview': {
                id: 'acme.preview',
                displayName: 'Preview',
                enabled: true,
                source: { kind: 'localPath', locator: 'acme.preview' },
                occurrenceId: 'occurrence-1',
            },
        },
        actionsById: {
            'acme.preview/open': {
                id: 'open',
                pluginId: 'acme.preview',
                occurrenceId: 'occurrence-1',
                title: 'Open',
                scopes: ['session'],
                surfaces: ['ui'],
                execution: { target: 'daemon' },
                placementBindings: [],
                priority: 0,
                dangerLevel: 'safe',
                available: true,
            },
        },
        resourcesById: {
            'acme.preview/status': {
                id: 'status',
                pluginId: 'acme.preview',
                resourceKind: 'config',
                path: 'status.json',
                digest: DIGEST,
                contentType: 'application/json',
                scope: 'session',
            },
        },
    };
}

describe('Session caller-hosted HTML request controller', () => {
    it('replaces one guest watch across differently scoped Resources without leaving the predecessor live', async () => {
        const base = projection();
        const projected = { ...base, resourcesById: { ...base.resourcesById,
            'acme.preview/global': { ...base.resourcesById['acme.preview/status']!, id: 'global', scope: 'global' as const },
        } };
        const nextSignals: AbortSignal[] = [];
        const contexts: unknown[] = [];
        const controller = createSessionCallerHostedHtmlRequestController({
            sessionId: 'session-1', serverId: 'home-1', serverIdentityId: 'server-identity-1', accountId: 'viewer',
            executeHostAction: async () => ({ ok: true, result: null }), isAccountCurrent: () => true, isSessionCurrent: () => true,
            pluginTarget: { machineId: 'machine-1', serverId: 'home-1', projection: projected, isCurrent: () => true },
            publishResourceEvent: () => {}, notify: () => {},
            // The daemon long-poll is the genuine external boundary. Keep the
            // canonical Resource watch lifecycle and its abort ownership real.
            watchResource: {
                open: async (_machine, options) => {
                    if (!('callerPluginId' in options)) throw new Error('Expected a declared plugin Resource watch');
                    contexts.push(options.context); return { supported: true,
                    result: { ok: true, subscriptionId: options.subscriptionId, digest: DIGEST } }; },
                next: async (_machine, options) => new Promise<MachinePluginUiResourceWatchNextResult>(resolve => {
                    if (options.signal) nextSignals.push(options.signal);
                    options.signal?.addEventListener('abort', () => resolve({ supported: false, reason: 'aborted' }), { once: true });
                }),
                close: async () => {},
            },
        });
        try {
            for (const localId of ['status', 'global']) await controller.handleRequest({ requestId: localId, method: 'watchResource',
                payload: { subscriptionId: 'same-watch', resource: { pluginId: 'acme.preview', localId } } });
            expect(contexts).toEqual([{ kind: 'session', sessionId: 'session-1' }, { kind: 'global' }]);
            expect(nextSignals.map(signal => signal.aborted)).toEqual([true, false]);
            await controller.handleRequest({ requestId: 'dispose', method: 'disposeHostResource', payload: { subscriptionId: 'same-watch' } });
            expect(nextSignals.every(signal => signal.aborted)).toBe(true);
        } finally { controller.dispose(); }
    });
    it('reads an app HTML copy Resource with viewer global context and no Session authority', async () => {
        let current = true;
        const base = projection();
        const projected = { ...base, resourcesById: { ...base.resourcesById,
            'acme.preview/status': { ...base.resourcesById['acme.preview/status']!, scope: 'global' as const,
                hostOrigin: { machineId: 'machine-1', serverId: 'home-1', phase: 'current' as const, interactionEnabled: true, executionOrigin: null } },
            'acme.preview/session-only': { ...base.resourcesById['acme.preview/status']!, id: 'session-only', scope: 'session' as const },
            'acme.preview/foreign': { ...base.resourcesById['acme.preview/status']!, id: 'foreign', scope: 'global' as const,
                hostOrigin: { machineId: 'foreign-machine', serverId: 'foreign-home', phase: 'current' as const, interactionEnabled: true, executionOrigin: null } },
        } };
        const reads: unknown[] = [];
        const controller = createSessionCallerHostedHtmlRequestController({
            serverId: 'home-1', serverIdentityId: 'server-identity-1', accountId: 'viewer',
            executeHostAction: async () => ({ ok: true, result: null }),
            isAccountCurrent: () => current,
            isSessionCurrent: () => true,
            pluginTarget: { machineId: null, serverId: null, projection: projected, isCurrent: () => current },
            publishResourceEvent: () => {}, notify: () => {},
            readResource: async (machineId, options) => { reads.push({ machineId, options }); return { supported: true,
                result: { ok: true, resource: options.resource, kind: 'config', contentType: 'application/json', digest: DIGEST, bytesBase64: 'e30=' } }; },
        });
        await expect(controller.handleRequest({ requestId: 'app-resource', method: 'readResource',
            payload: { resource: { pluginId: 'acme.preview', localId: 'status' } } })).resolves.toMatchObject({ bytesBase64: 'e30=' });
        expect(reads).toEqual([{ machineId: 'machine-1', options: expect.objectContaining({ context: { kind: 'global' } }) }]);
        for (const localId of ['session-only', 'foreign']) await expect(controller.handleRequest({ requestId: localId, method: 'readResource',
            payload: { resource: { pluginId: 'acme.preview', localId } } })).rejects.toThrow('plugin_resource_not_found');
        expect(reads).toHaveLength(1);
        current = false;
        await expect(controller.handleRequest({ requestId: 'retired', method: 'readResource',
            payload: { resource: { pluginId: 'acme.preview', localId: 'status' } } })).rejects.toThrow('caller_surface_retired');
        controller.dispose();
    });
    it('routes scripted destructive Actions through the shared approval floor before mutation', async () => {
        const sessionBoardAction = vi.fn(async () => ({
            v: 1 as const,
            serverId: 'home-1',
            sessionId: 'session-1',
            result: {
                operation: 'remove_item' as const,
                itemId: 'item-1',
                outcome: 'removed' as const,
                layoutRevision: REVISION,
            },
            destination: null,
        }));
        const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval-1' }));
        const executor = createActionExecutor({
            sessionBoardAction,
            approvalsCreate,
            isApprovalExecutionOriginCurrent: async () => true,
            isActionApprovalRequired: (actionId: ActionId, context: ActionExecutorContext) =>
                isApprovalRequiredByActionsSettings(actionId, DEFAULT_ACTIONS_SETTINGS_V1, context),
        } as unknown as ActionExecutorDeps);
        // Production's default UI executor fills an omitted authority as
        // present_user. Preserve that real front-door behavior here so this
        // regression would execute the mutation under the former controller,
        // rather than letting the lower Protocol executor's safer undefined-
        // authority default conceal the integration defect.
        const executeHostAction = vi.fn<PluginSurfaceHostActionExecute>((actionId, actionInput, context) => executor.execute(
            actionId,
            actionInput,
            {
                ...context,
                surface: context?.surface ?? 'ui',
                authority: context?.authority ?? 'present_user',
            },
        ));
        const controller = createSessionCallerHostedHtmlRequestController({
            sessionId: 'session-1',
            serverId: 'home-1',
            serverIdentityId: 'server-identity-1',
            accountId: 'account-1',
            executeHostAction,
            isAccountCurrent: () => true,
            isSessionCurrent: () => true,
            pluginTarget: null,
            publishResourceEvent: vi.fn(),
            notify: vi.fn(),
        });

        await expect(controller.handleRequest({
            requestId: 'remove-item',
            method: 'executeAction',
            payload: {
                action: 'session.board.item.remove',
                input: {
                    sessionId: 'session-1',
                    itemId: 'item-1',
                    expectedItemRevision: REVISION,
                    expectedLayoutRevision: REVISION,
                },
            },
        })).resolves.toEqual({
            kind: 'approval_request_created',
            artifactId: 'approval-1',
            actionId: 'session.board.item.remove',
        });
        expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
            serverId: 'home-1',
            request: expect.objectContaining({
                actionId: 'session.board.item.remove',
                status: 'open',
                requestedSurface: 'ui',
                executionOriginV1: expect.objectContaining({
                    authority: 'account_automation',
                    surface: 'ui',
                    serverId: 'home-1',
                    serverIdentityId: 'server-identity-1',
                    accountId: 'account-1',
                    sessionId: 'session-1',
                    requestId: 'remove-item',
                }),
            }),
        }));
        expect(sessionBoardAction).not.toHaveBeenCalled();
        controller.dispose();
    });

    it('does not accept caller-provided Action authority or approval bypass context', async () => {
        const executeHostAction = vi.fn(async () => ({ ok: true as const, result: null }));
        const controller = createSessionCallerHostedHtmlRequestController({
            sessionId: 'session-1',
            serverId: 'home-1',
            serverIdentityId: 'server-identity-1',
            accountId: 'account-1',
            executeHostAction,
            isAccountCurrent: () => true,
            isSessionCurrent: () => true,
            pluginTarget: null,
            publishResourceEvent: vi.fn(),
            notify: vi.fn(),
        });

        for (const injectedContext of [
            { authority: 'present_user' },
            { presentUserConfirmation: { actionId: 'session.board.item.remove' } },
            { bypassApprovals: true },
        ]) {
            await expect(controller.handleRequest({
                requestId: 'forged-context',
                method: 'executeAction',
                payload: {
                    action: 'session.board.item.remove',
                    input: {
                        sessionId: 'session-1',
                        itemId: 'item-1',
                        expectedItemRevision: REVISION,
                        expectedLayoutRevision: REVISION,
                    },
                    ...injectedContext,
                } as never,
            })).rejects.toThrow('caller_surface_action_invalid');
        }
        expect(executeHostAction).not.toHaveBeenCalled();
        controller.dispose();
    });

    it('requires and consumes host-owned transient activation only for session.message.send', async () => {
        const executeHostAction = vi.fn(async () => ({ ok: true as const, result: { sent: true } }));
        const controller = createSessionCallerHostedHtmlRequestController({
            sessionId: 'session-1',
            serverId: 'home-1',
            serverIdentityId: 'server-identity-1',
            accountId: 'account-1',
            executeHostAction,
            isAccountCurrent: () => true,
            isSessionCurrent: () => true,
            pluginTarget: null,
            publishResourceEvent: vi.fn(),
            notify: vi.fn(),
        });
        const consumeTransientActivation = vi.fn()
            .mockReturnValueOnce(true)
            .mockReturnValue(false);

        await expect(controller.handleRequest({
            requestId: 'send-without-activation',
            method: 'executeAction',
            payload: { action: 'session.message.send', input: { message: 'Hello' } },
        })).rejects.toThrow('caller_surface_transient_activation_required');
        await expect(controller.handleRequest({
            requestId: 'send-with-activation',
            method: 'executeAction',
            payload: { action: 'session.message.send', input: { message: 'Hello' } },
        }, { consumeHostTransientActivation: consumeTransientActivation } as never)).resolves.toEqual({ sent: true });
        await expect(controller.handleRequest({
            requestId: 'send-replay',
            method: 'executeAction',
            payload: { action: 'session.message.send', input: { message: 'Again' } },
        }, { consumeHostTransientActivation: consumeTransientActivation } as never)).rejects.toThrow(
            'caller_surface_transient_activation_required',
        );

        await expect(controller.handleRequest({
            requestId: 'ordinary-action',
            method: 'executeAction',
            payload: { action: 'session.board.get' },
        })).resolves.toEqual({ sent: true });
        expect(executeHostAction).toHaveBeenCalledTimes(2);
        controller.dispose();
    });

    it('uses the incumbent Action owners without manufacturing plugin caller identity', async () => {
        const executeHostAction = vi.fn(async () => ({ ok: true as const, result: { host: true } }));
        const dispatchAction = vi.fn<typeof dispatchPluginSurfaceAction>(async () => ({
            ok: true as const,
            result: { contributed: true },
        }));
        const consumeTransientActivation = vi.fn(() => true);
        const controller = createSessionCallerHostedHtmlRequestController({
            sessionId: 'session-1',
            serverId: 'home-1',
            serverIdentityId: 'server-identity-1',
            accountId: 'account-1',
            executeHostAction,
            dispatchAction,
            isAccountCurrent: () => true,
            isSessionCurrent: () => true,
            pluginTarget: {
                machineId: 'machine-1',
                serverId: 'home-1',
                projection: projection(),
                isCurrent: () => true,
            },
            publishResourceEvent: vi.fn(),
            notify: vi.fn(),
        });

        await expect(controller.handleRequest({
            requestId: 'host-action',
            method: 'executeAction',
            payload: {
                action: 'session.board.item.remove',
                input: {
                    sessionId: 'session-1',
                    itemId: 'item-1',
                    expectedItemRevision: REVISION,
                    expectedLayoutRevision: REVISION,
                },
            },
        })).resolves.toEqual({ host: true });
        expect(executeHostAction).toHaveBeenCalledWith('session.board.item.remove', {
            sessionId: 'session-1',
            itemId: 'item-1',
            expectedItemRevision: REVISION,
            expectedLayoutRevision: REVISION,
        }, {
            serverId: 'home-1',
            serverIdentityId: 'server-identity-1',
            runtimeAccountId: 'account-1',
            defaultSessionId: 'session-1',
            actionRequestId: 'host-action',
            surface: 'ui',
            authority: 'account_automation',
        });

        await expect(controller.handleRequest({
            requestId: 'plugin-action',
            method: 'executeAction',
            payload: { action: { pluginId: 'acme.preview', localId: 'open' }, input: { value: 1 } },
        }, { consumeHostTransientActivation: consumeTransientActivation } as never)).resolves.toEqual({ contributed: true });
        expect(dispatchAction).toHaveBeenCalledWith(expect.objectContaining({
            action: { pluginId: 'acme.preview', localId: 'open' },
            contributedAction: expect.objectContaining({
                machineId: 'machine-1',
                serverId: 'home-1',
                sessionId: 'session-1',
            }),
        }));
        expect(dispatchAction.mock.calls[0]![0]).not.toHaveProperty('callerPluginId');
        expect(consumeTransientActivation).not.toHaveBeenCalled();
        controller.dispose();
    });

    it('resolves exact reviewed Resources through the current projection and Session context', async () => {
        const reads: unknown[] = [];
        const readResource = vi.fn(async (machineId, options) => {
            reads.push({ machineId, options });
            return {
                supported: true,
                result: {
                    ok: true,
                    resource: options.resource,
                    kind: 'config',
                    contentType: 'application/json',
                    digest: DIGEST,
                    bytesBase64: 'e30=',
                },
            } satisfies MachinePluginUiResourceReadResult;
        });
        const controller = createSessionCallerHostedHtmlRequestController({
            sessionId: 'session-1',
            serverId: 'home-1',
            serverIdentityId: 'server-identity-1',
            accountId: 'account-1',
            executeHostAction: vi.fn(async () => ({ ok: true as const, result: null })),
            isAccountCurrent: () => true,
            isSessionCurrent: () => true,
            pluginTarget: {
                machineId: 'machine-1',
                serverId: 'home-1',
                projection: projection(),
                isCurrent: () => true,
            },
            publishResourceEvent: vi.fn(),
            notify: vi.fn(),
            readResource,
        });

        await expect(controller.handleRequest({
            requestId: 'resource-1',
            method: 'readResource',
            payload: { resource: { pluginId: 'acme.preview', localId: 'status' } },
        })).resolves.toMatchObject({ contentType: 'application/json', digest: DIGEST, bytesBase64: 'e30=' });
        expect(reads).toEqual([{
            machineId: 'machine-1',
            options: expect.objectContaining({
                callerPluginId: 'acme.preview',
                expectedCallerOccurrenceId: 'occurrence-1',
                resource: { pluginId: 'acme.preview', localId: 'status' },
                context: { kind: 'session', sessionId: 'session-1' },
            }),
        }]);
        await expect(controller.handleRequest({
            requestId: 'resource-missing',
            method: 'readResource',
            payload: { resource: { pluginId: 'acme.preview', localId: 'missing' } },
        })).rejects.toThrow('plugin_resource_not_found');
        await expect(controller.handleRequest({
            requestId: 'bare-resource',
            method: 'readResource',
            payload: { resource: 'status' },
        })).rejects.toThrow('caller_surface_resource_invalid');
        controller.dispose();
    });

    it('fails every effect after Account or projection retirement', async () => {
        let current = true;
        const controller = createSessionCallerHostedHtmlRequestController({
            sessionId: 'session-1',
            serverId: 'home-1',
            serverIdentityId: 'server-identity-1',
            accountId: 'account-1',
            executeHostAction: vi.fn(async () => ({ ok: true as const, result: null })),
            isAccountCurrent: () => current,
            isSessionCurrent: () => true,
            pluginTarget: null,
            publishResourceEvent: vi.fn(),
            notify: vi.fn(),
        });
        current = false;
        await expect(controller.handleRequest({
            requestId: 'late', method: 'executeAction', payload: { action: 'session.board.get' },
        })).rejects.toThrow('caller_surface_retired');
        controller.dispose();
    });

    it('rejects effects after exact Session authority retires and cannot target another Session', async () => {
        let sessionCurrent = true;
        const executeHostAction = vi.fn(async () => ({ ok: true as const, result: null }));
        const controller = createSessionCallerHostedHtmlRequestController({
            sessionId: 'session-1',
            serverId: 'home-1',
            serverIdentityId: 'server-identity-1',
            accountId: 'account-1',
            executeHostAction,
            isAccountCurrent: () => true,
            isSessionCurrent: () => sessionCurrent,
            pluginTarget: null,
            publishResourceEvent: vi.fn(),
            notify: vi.fn(),
        });

        await expect(controller.handleRequest({
            requestId: 'cross-session',
            method: 'executeAction',
            payload: {
                action: 'session.board.get',
                input: { sessionId: 'session-2' },
            },
        })).rejects.toThrow('caller_surface_session_mismatch');
        expect(executeHostAction).not.toHaveBeenCalled();

        sessionCurrent = false;
        await expect(controller.handleRequest({
            requestId: 'retired-session',
            method: 'executeAction',
            payload: { action: 'session.board.get' },
        })).rejects.toThrow('caller_surface_retired');
        controller.dispose();
    });
});
