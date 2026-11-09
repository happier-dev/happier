import { describe, expect, it, vi } from 'vitest';

import {
    type ActionId} from '@happier-dev/protocol/actions/actionIds';
import {
    createActionExecutor} from '@happier-dev/protocol/actions/actionExecutor';
import {
    DEFAULT_ACTIONS_SETTINGS_V1} from '@happier-dev/protocol/account/settings/accountSettings';
import {
    isApprovalRequiredByActionsSettings} from '@happier-dev/protocol/actions/actionApprovalPolicy';
import {
    normalizeActionsSettingsV1} from '@happier-dev/protocol/actions/actionSettings';
import {
    type ActionExecutorContext,
    type ActionExecutorDeps,
} from '@happier-dev/protocol/actions/executor/types';

import type { MachinePluginUiResourceReadResult, MachinePluginUiResourceWatchNextResult } from '@/sync/ops/machineContributionRegistryProjection';
import type {
    PluginSurfaceContributedActionTransport,
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
    it('uses the same foreign caller policy for qualified Actions before daemon invocation', async () => {
        let owned = false;
        let settings = normalizeActionsSettingsV1({ v: 1, actions: {} });
        const executeContributedAction = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true, result: { ok: true, result: { contributed: true } },
        }));
        const controller = createSessionCallerHostedHtmlRequestController({
            sessionId: 'session-1', serverId: 'home-1', serverIdentityId: 'identity-1', accountId: 'viewer',
            isSessionOwned: () => owned, readActionsSettings: async () => settings,
            executeHostAction: async () => ({ ok: true, result: null }), executeContributedAction,
            isAccountCurrent: () => true, isSessionCurrent: () => true,
            pluginTarget: { machineId: 'machine-1', serverId: 'home-1', projection: projection(), isCurrent: () => true },
            publishResourceEvent: () => {}, notify: () => {},
        });
        const request = { requestId: 'qualified', method: 'executeAction' as const,
            payload: { action: { pluginId: 'acme.preview', localId: 'open' }, input: { value: 1 } } };
        try {
            await expect(controller.handleRequest(request)).resolves.toMatchObject({ code: 'denied', diagnostics: ['plugin_action_disabled'] });
            expect(executeContributedAction).not.toHaveBeenCalled();
            settings = normalizeActionsSettingsV1({ v: 1, actions: {}, callerSurfacePolicies: {
                foreign_session_html: { 'acme.preview/actions/open': 'allowed' },
            } });
            await expect(controller.handleRequest(request)).resolves.toEqual({ contributed: true });
            expect(executeContributedAction).toHaveBeenCalledTimes(1);
            owned = true;
            settings = normalizeActionsSettingsV1({ v: 1, actions: {} });
            await expect(controller.handleRequest(request)).resolves.toEqual({ contributed: true });
            expect(executeContributedAction).toHaveBeenCalledTimes(2);
            settings = normalizeActionsSettingsV1({ v: 1, actions: { 'acme.preview/actions/open': { disabledSurfaces: ['ui'] } } });
            await expect(controller.handleRequest(request)).resolves.toMatchObject({ code: 'denied', diagnostics: ['plugin_action_disabled'] });
            expect(executeContributedAction).toHaveBeenCalledTimes(2);
        } finally { controller.dispose(); }
    });
    it.each(['readResource', 'watchResource'] as const)('refuses foreign Session HTML %s before any Resource work', async method => {
        let owned = false;
        let settings = normalizeActionsSettingsV1({ v: 1, actions: {} });
        const readResource = vi.fn<NonNullable<Parameters<typeof createSessionCallerHostedHtmlRequestController>[0]['readResource']>>(async (_machine, options) => ({
            supported: true, result: { ok: true, resource: options.resource, kind: 'config', contentType: 'application/json', digest: DIGEST, bytesBase64: 'e30=' },
        }));
        const open = vi.fn(async () => ({ supported: true as const, result: { ok: true as const, subscriptionId: 'watch-1', digest: DIGEST } }));
        const options = {
            sessionId: 'session-1', serverId: 'home-1', serverIdentityId: 'identity-1', accountId: 'viewer',
            isSessionOwned: () => owned,
            readActionsSettings: async () => settings,
            executeHostAction: async () => ({ ok: true as const, result: null }),
            isAccountCurrent: () => true, isSessionCurrent: () => true,
            pluginTarget: { machineId: 'machine-1', serverId: 'home-1', projection: projection(), isCurrent: () => true },
            publishResourceEvent: () => {}, notify: () => {}, readResource,
            watchResource: { open, next: async () => ({ supported: false as const, reason: 'aborted' as const }), close: async () => {} },
        };
        const controller = createSessionCallerHostedHtmlRequestController(options);
        try {
            await expect(controller.handleRequest({ requestId: method, method,
                payload: { resource: { pluginId: 'acme.preview', localId: 'status' }, subscriptionId: 'watch-1' },
            })).resolves.toMatchObject({ code: 'action_disabled' });
            expect(readResource).not.toHaveBeenCalled();
            expect(open).not.toHaveBeenCalled();
            settings = normalizeActionsSettingsV1({ v: 1, actions: {}, callerSurfacePolicies: {
                foreign_session_html: { 'acme.preview/resources/status': 'ask_first' },
            } });
            await expect(controller.handleRequest({ requestId: `${method}-ask`, method,
                payload: { resource: { pluginId: 'acme.preview', localId: 'status' }, subscriptionId: 'watch-1' },
            })).resolves.toMatchObject({ code: 'approval_required' });
            expect(readResource).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
            settings = normalizeActionsSettingsV1({ v: 1, actions: {}, callerSurfacePolicies: {
                foreign_session_html: { 'acme.preview/resources/status': 'allowed' },
            } });
            await expect(controller.handleRequest({ requestId: `${method}-allowed`, method,
                payload: { resource: { pluginId: 'acme.preview', localId: 'status' }, subscriptionId: 'watch-1' },
            })).resolves.toBeDefined();
            expect(method === 'readResource' ? readResource : open).toHaveBeenCalledTimes(1);
            owned = true;
            settings = normalizeActionsSettingsV1({ v: 1, actions: {} });
            await expect(controller.handleRequest({ requestId: `${method}-own`, method,
                payload: { resource: { pluginId: 'acme.preview', localId: 'status' }, subscriptionId: 'watch-2' },
            })).resolves.toBeDefined();
            expect(method === 'readResource' ? readResource : open).toHaveBeenCalledTimes(2);
        } finally { controller.dispose(); }
    });
    it('refuses foreign Session HTML host Actions without prompting while own Session Actions still work', async () => {
        let owned = false;
        let settings = normalizeActionsSettingsV1({ v: 1, actions: {} });
        const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'input-1' }));
        const sessionStop = vi.fn(async () => ({ stopped: true }));
        const approvalsCreate = vi.fn(async () => ({ artifactId: 'unexpected-approval' }));
        const executor = createActionExecutor({ sessionSendMessage, sessionStop, approvalsCreate,
            isActionApprovalRequired: (actionId: ActionId, context: ActionExecutorContext) =>
                isApprovalRequiredByActionsSettings(actionId, DEFAULT_ACTIONS_SETTINGS_V1, context),
        } as unknown as ActionExecutorDeps);
        const options = {
            sessionId: 'session-1', serverId: 'home-1', serverIdentityId: 'identity-1', accountId: 'viewer',
            isSessionOwned: () => owned,
            executeHostAction: (actionId: ActionId, value: unknown, context?: ActionExecutorContext) => executor.execute(actionId, value, { ...context, actionsSettings: settings }),
            isAccountCurrent: () => true, isSessionCurrent: () => true, pluginTarget: null,
            publishResourceEvent: () => {}, notify: () => {},
        };
        const controller = createSessionCallerHostedHtmlRequestController(options);
        try {
            for (const action of ['session.message.send', 'session.stop'] as const) {
                await expect(controller.handleRequest({ requestId: action, method: 'executeAction',
                    payload: { action, input: action === 'session.message.send' ? { message: 'Hello' } : { sessionId: 'session-1' } },
                })).resolves.toMatchObject({ code: 'action_disabled' });
            }
            expect(sessionSendMessage).not.toHaveBeenCalled();
            expect(sessionStop).not.toHaveBeenCalled();
            expect(approvalsCreate).not.toHaveBeenCalled();
            settings = normalizeActionsSettingsV1({ v: 1, actions: {}, callerSurfacePolicies: {
                foreign_session_html: { 'session.message.send': 'allowed', 'session.stop': 'allowed' },
            } });
            for (const action of ['session.message.send', 'session.stop'] as const) {
                await expect(controller.handleRequest({ requestId: `granted-${action}`, method: 'executeAction',
                    payload: { action, input: action === 'session.message.send' ? { message: 'Hello' } : { sessionId: 'session-1' } },
                })).resolves.toBeDefined();
            }
            expect(sessionSendMessage).toHaveBeenCalledTimes(1); expect(sessionStop).toHaveBeenCalledTimes(1);
            owned = true;
            settings = normalizeActionsSettingsV1({ v: 1, actions: {} });
            await expect(controller.handleRequest({ requestId: 'own-send', method: 'executeAction',
                payload: { action: 'session.message.send', input: { message: 'Hello' } },
            })).resolves.toMatchObject({ status: 'accepted' });
            await expect(controller.handleRequest({ requestId: 'own-stop', method: 'executeAction',
                payload: { action: 'session.stop', input: { sessionId: 'session-1' } },
            })).resolves.toBeDefined();
            expect(sessionSendMessage).toHaveBeenCalledTimes(2);
            expect(sessionStop).toHaveBeenCalledTimes(2);
        } finally { controller.dispose(); }
    });
    it('replaces one guest watch across differently scoped Resources without leaving the predecessor live', async () => {
        const base = projection();
        const projected = { ...base, resourcesById: { ...base.resourcesById,
            'acme.preview/global': { ...base.resourcesById['acme.preview/status']!, id: 'global', scope: 'global' as const },
        } };
        const nextSignals: AbortSignal[] = [];
        const contexts: unknown[] = [];
        const surfaceTarget = { kind: 'session' as const, sessionId: 'session-1', branch: 'feature/ci', headOid: 'abc123',
            repository: { kind: 'github' as const, deployment: 'https://github.com', repository: 'owner/repo' } };
        const controller = createSessionCallerHostedHtmlRequestController({
            sessionId: 'session-1', serverId: 'home-1', serverIdentityId: 'server-identity-1', accountId: 'viewer',
            surfaceTarget,
            isSessionOwned: () => true,
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
            await controller.handleRequest({ requestId: 'initial', method: 'watchResource',
                payload: { subscriptionId: 'same-watch', resource: { pluginId: 'acme.preview', localId: 'status' } } });
            const nextTarget = { ...surfaceTarget, headOid: 'def456' };
            controller.updateSurfaceTarget?.(nextTarget);
            expect(nextSignals[0]?.aborted).toBe(true);
            for (const localId of ['status', 'global']) await controller.handleRequest({ requestId: localId, method: 'watchResource',
                payload: { subscriptionId: 'same-watch', resource: { pluginId: 'acme.preview', localId } } });
            expect(contexts).toEqual([{ kind: 'session', sessionId: 'session-1', target: surfaceTarget },
                { kind: 'session', sessionId: 'session-1', target: nextTarget }, { kind: 'global' }]);
            expect(nextSignals.map(signal => signal.aborted)).toEqual([true, true, false]);
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
            isSessionOwned: () => true,
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
            isSessionOwned: () => true,
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

    it.each(['allow', 'ask'] as const)('uses ordinary %s policy for Send without a browser activation receipt', async (policy) => {
        // Message delivery and approval persistence are external boundaries;
        // the Action executor and its configurable policy remain real.
        const sessionSendMessage = vi.fn(async () => ({ status: 'accepted' as const, localId: 'input-1' }));
        const approvalsCreate = vi.fn(async () => ({ artifactId: 'send-approval' }));
        const settings = normalizeActionsSettingsV1(policy === 'allow'
            ? { v: 1, approvalWaivedSurfaces: { 'session.message.send': ['ui'] } }
            : { v: 1, actions: { 'session.message.send': { approvalRequiredSurfaces: ['ui'] } } });
        const executor = createActionExecutor({
            sessionSendMessage,
            approvalsCreate,
            isApprovalExecutionOriginCurrent: async () => true,
            isActionApprovalRequired: (actionId: ActionId, context: ActionExecutorContext) =>
                isApprovalRequiredByActionsSettings(actionId, settings, context),
        } as unknown as ActionExecutorDeps);
        const controller = createSessionCallerHostedHtmlRequestController({
            sessionId: 'session-1',
            serverId: 'home-1',
            serverIdentityId: 'server-identity-1',
            accountId: 'account-1',
            executeHostAction: (actionId, actionInput, context) => executor.execute(actionId, actionInput, context),
            isAccountCurrent: () => true,
            isSessionCurrent: () => true,
            isSessionOwned: () => true,
            pluginTarget: null,
            publishResourceEvent: vi.fn(),
            notify: vi.fn(),
        });
        await expect(controller.handleRequest({
            requestId: 'send-without-activation',
            method: 'executeAction',
            payload: { action: 'session.message.send', input: { message: 'Hello' } },
        })).resolves.toEqual(policy === 'allow'
            ? { status: 'accepted', localId: 'input-1' }
            : { kind: 'approval_request_created', artifactId: 'send-approval', actionId: 'session.message.send' });
        if (policy === 'allow') {
            expect(sessionSendMessage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1', message: 'Hello' }));
            expect(approvalsCreate).not.toHaveBeenCalled();
        } else {
            expect(sessionSendMessage).not.toHaveBeenCalled();
            expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({
                actionId: 'session.message.send', executionOriginV1: expect.objectContaining({ authority: 'account_automation' }),
            }) }));
        }
        controller.dispose();
    });

    it('uses the incumbent Action owners without manufacturing plugin caller identity', async () => {
        const executeHostAction = vi.fn(async () => ({ ok: true as const, result: { host: true } }));
        const executeContributedAction = vi.fn<PluginSurfaceContributedActionTransport>(async () => ({
            supported: true, result: { ok: true, result: { contributed: true } },
        }));
        const consumeTransientActivation = vi.fn(() => true);
        const controller = createSessionCallerHostedHtmlRequestController({
            sessionId: 'session-1',
            serverId: 'home-1',
            serverIdentityId: 'server-identity-1',
            accountId: 'account-1',
            executeHostAction,
            executeContributedAction,
            isAccountCurrent: () => true,
            isSessionCurrent: () => true,
            isSessionOwned: () => true,
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
        expect(executeContributedAction).toHaveBeenCalledWith('machine-1', expect.objectContaining({
                qualifiedActionId: 'acme.preview/open',
                serverId: 'home-1',
                sessionId: 'session-1',
                executionSurface: 'ui',
        }));
        expect(executeContributedAction.mock.calls[0]![1]).not.toHaveProperty('callerPluginId');
        expect(consumeTransientActivation).not.toHaveBeenCalled();
        controller.dispose();
    });

    it('resolves exact reviewed Resources through the current projection and Session context', async () => {
        const reads: unknown[] = [];
        let targetCurrent = true;
        const admitTarget = vi.fn(() => targetCurrent);
        const admitAccount = vi.fn(() => true);
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
            isAccountCurrent: admitAccount,
            isSessionCurrent: () => true,
            isSessionOwned: () => true,
            pluginTarget: {
                machineId: 'machine-1',
                serverId: 'home-1',
                projection: projection(),
                isCurrent: admitTarget,
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
        // One incoming read consumes one Account/Session admission and the
        // canonical declaration binding, without reacquiring either below it.
        expect(admitAccount).toHaveBeenCalledTimes(1);
        expect(admitTarget).toHaveBeenCalledTimes(1);
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
        targetCurrent = false;
        await expect(controller.handleRequest({ requestId: 'retired-target', method: 'readResource',
            payload: { resource: { pluginId: 'acme.preview', localId: 'status' } },
        })).rejects.toThrow('plugin_resource_not_found');
        expect(reads).toHaveLength(1);
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
