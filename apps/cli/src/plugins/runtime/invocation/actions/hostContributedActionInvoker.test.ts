import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionSurfaceSchema } from '@happier-dev/protocol/actions/metadata';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { describe, expect, it, vi } from 'vitest';

import {
    createActionExecutor,
    type ActionExecutorDeps,
} from '@happier-dev/protocol/actions';
import { ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';

import { createHostContributedActionInvoker } from './hostContributedActionInvoker';
import type { InvokeContributedAction } from '../services/actions';
import { createPluginInvocationActionsService } from '../services/actions';
import { createTargetActionInvocationRegistry } from '../targetActionRegistry';
import { createPluginRuntimeOccurrenceId } from '../../runtimeSlots';
import { createProductionPluginInvocationServiceOwners } from '../services/production';

function unexpectedDependency(): never {
    throw new Error('unexpected ActionExecutor dependency invocation');
}

/**
 * `action.invoke` is resolved before every other ActionExecutor dependency.
 * Keep the real protocol dispatcher in this test and make unrelated leaves
 * fail loudly if that routing changes.
 */
function createExecutorForTest(
    invokeContributedAction: NonNullable<ActionExecutorDeps['invokeContributedAction']>,
) {
    const deps = {
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"teams.archive": Object.keys(ActionSurfaceSchema.shape), "action.invoke": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }),
        executionRunStart: unexpectedDependency,
        executionRunList: unexpectedDependency,
        executionRunGet: unexpectedDependency,
        detachedExecutionRunSend: unexpectedDependency,
        executionRunStop: unexpectedDependency,
        executionRunAction: unexpectedDependency,
        executionRunWait: unexpectedDependency,
        sessionOpen: unexpectedDependency,
        sessionFork: unexpectedDependency,
        sessionRollback: unexpectedDependency,
        sessionSpawnNew: unexpectedDependency,
        pathsListRecent: unexpectedDependency,
        machinesList: unexpectedDependency,
        serversList: unexpectedDependency,
        reviewEnginesList: unexpectedDependency,
        agentsBackendsList: unexpectedDependency,
        agentsModelsList: unexpectedDependency,
        sessionSendMessage: unexpectedDependency,
        sessionPermissionRespond: unexpectedDependency,
        sessionUserActionAnswer: unexpectedDependency,
        sessionTargetPrimarySet: unexpectedDependency,
        sessionTargetTrackedSet: unexpectedDependency,
        sessionList: unexpectedDependency,
        sessionActivityGet: unexpectedDependency,
        sessionRecentMessagesGet: unexpectedDependency,
        daemonMemorySearch: unexpectedDependency,
        daemonMemoryGetWindow: unexpectedDependency,
        daemonMemoryEnsureUpToDate: unexpectedDependency,
        resetGlobalVoiceAgent: () => {},

        invokeContributedAction,
    } as unknown as ActionExecutorDeps;
    return createActionExecutor(deps);
}

function createInvokerForTest(
    invokeContributedAction: InvokeContributedAction,
    overrides: Readonly<{
        revalidatePluginActionCallerMaterialization?: () => Promise<boolean>;
        revalidatePluginActionCallerOccurrence?: () => Promise<boolean>;
    }> = {},
) {
    return createHostContributedActionInvoker({
        invokeContributedAction,
        revalidatePluginActionCallerMaterialization:
            overrides.revalidatePluginActionCallerMaterialization ?? (async () => true),
        revalidatePluginActionCallerOccurrence:
            overrides.revalidatePluginActionCallerOccurrence ?? (async () => true),
    });
}

describe('createHostContributedActionInvoker', () => {
    it.each(['execute', 'executeWithExecutionOrigin'] as const)('admits SDK %s contribution refs through the canonical Action grant before a target effect', async method => {
        let effects = 0;
        const occurrenceId = createPluginRuntimeOccurrenceId('acme.target');
        let targets: ReturnType<typeof createTargetActionInvocationRegistry>;
        const invokeContributedAction: InvokeContributedAction = async request => {
            const result = await targets.invoke({ pluginId: request.action.pluginId, localId: request.action.localId,
                input: request.input, surface: request.surface, invocationSurface: request.surface,
                caller: request.caller, signal: request.signal });
            if (result.status === 'deferred') throw new Error('Safe target unexpectedly deferred');
            return result;
        };
        const executor = createExecutorForTest(createInvokerForTest(invokeContributedAction));
        const owners = createProductionPluginInvocationServiceOwners({ actionExecutor: executor, invokeContributedAction });
        targets = createTargetActionInvocationRegistry({
            actions: [{ pluginId: 'acme.target', pluginVersion: '1.0.0', occurrenceId,
                sourceCustody: { kind: 'development', registeredRootId: 'target-root' }, localId: 'write',
                definition: { id: 'write', dangerLevel: 'safe', scopes: ['global'], surfaces: ['plugin'],
                    inputSchema: { type: 'object' }, resultSchema: {} },
                handler: async () => { effects += 1; return { written: true }; },
            }],
            resolveAuthorizationFacts: target => ({ generation: { targetGeneration: target.occurrenceId,
                desiredGeneration: target.occurrenceId, appliedGeneration: target.occurrenceId },
                resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
            createServices: owners.createServices, resolveHostBinding: owners.resolveHostBinding,
            readCurrentPluginOccurrenceId: pluginId => pluginId === 'acme.target' ? occurrenceId : null,
        });
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' }, contribution: { id: 'caller', qualifiedId: 'acme.caller/caller' },
                occurrenceId: 'caller-occurrence', sourceCustody: { kind: 'development', registeredRootId: 'caller-root' },
                surface: 'plugin', signal: new AbortController().signal, isOccurrenceCurrent: () => true,
                approvalContext: {
                    authority: 'account_automation', runtimeAccountId: 'alice', serverId: 'home-profile', serverIdentityId: 'srv_home-1', actionRequestId: 'source-request',
                    externalActionCredential: { accountId: 'alice', principalId: 'principal', credentialId: 'pat',
                        grant: ApiTokenGrantV1Schema.parse({ v: 1, actions: { families: [], ids: ['teams.archive'] },
                            targets: null, approve: false, origins: [], models: null, permissionModes: null, create: null }) },
                },
            }, actionExecutor: executor, invokeContributedAction,
        });
        try {
            const action = { pluginId: 'acme.target', localId: 'write' };
            const pending = method === 'execute' ? service.execute(action, {}) : service.executeWithExecutionOrigin(action, {});
            const failure = await pending.then(() => null, (error: unknown) => error);
            expect(effects).toBe(0);
            expect(failure).toMatchObject({ code: 'credential_scope_denied' });
        } finally { targets.dispose(); await owners.dispose(); }
    });
    it('routes plugin action.invoke through the committed dispatcher with current caller provenance', async () => {
        const invokeContributedAction = vi.fn<InvokeContributedAction>(async () => Object.freeze({
            status: 'executed' as const,
            value: Object.freeze({ accepted: true }),
        }));
        const executor = createExecutorForTest(createInvokerForTest(invokeContributedAction));
        const controller = new AbortController();

        await expect(executor.execute('action.invoke', {
            action: { pluginId: 'acme.caller', localId: 'target' },
            input: { title: 'Ready' },
        }, {
            surface: 'plugin',
            signal: controller.signal,
            actionCaller: {
                kind: 'plugin',
                pluginId: 'acme.caller',
                contributionLocalId: 'caller',
occurrenceId: 'generation-1',
sourceCustody: { kind: 'development', registeredRootId: 'acme-caller-root' },
materialization: {
                    pluginId: 'acme.caller',
                    machineId: 'machine-1',
                    materializationId: 'materialization-1',
                },
            },
        })).resolves.toEqual({ ok: true, result: { accepted: true } });

        expect(invokeContributedAction).toHaveBeenCalledWith(expect.objectContaining({
            action: { pluginId: 'acme.caller', localId: 'target' },
            input: { title: 'Ready' },
            surface: 'plugin',
            initiatingActionCaller: {
                kind: 'plugin', pluginId: 'acme.caller', contributionLocalId: 'caller', occurrenceId: 'generation-1',
                sourceCustody: { kind: 'development', registeredRootId: 'acme-caller-root' },
                materialization: { pluginId: 'acme.caller', machineId: 'machine-1', materializationId: 'materialization-1' },
            },
            caller: {
                kind: 'plugin',
                pluginId: 'acme.caller',
                contribution: {
                    id: 'caller',
                    qualifiedId: 'acme.caller/caller',
                },
occurrenceId: 'generation-1',
sourceCustody: { kind: 'development', registeredRootId: 'acme-caller-root' },
materialization: {
                    pluginId: 'acme.caller',
                    machineId: 'machine-1',
                    materializationId: 'materialization-1',
                },
            },
            signal: controller.signal,
        }));
    });

    it('returns the target failure without claiming execution when host caller provenance is incomplete', async () => {
        const invokeContributedAction = vi.fn<InvokeContributedAction>(async () => Object.freeze({
            status: 'executed' as const,
            value: null,
        }));
        const executor = createExecutorForTest(createInvokerForTest(invokeContributedAction));

        await expect(executor.execute('action.invoke', {
            action: { pluginId: 'acme.target', localId: 'run' },
        }, {
            surface: 'plugin',
            actionCaller: { kind: 'plugin', pluginId: 'acme.caller' },
        })).resolves.toEqual({
            ok: false,
            errorCode: 'plugin_action_caller_unavailable',
            error: 'Plugin contributed action calls require current host-stamped caller provenance',
        });
        expect(invokeContributedAction).not.toHaveBeenCalled();
    });

    it('rejects generationless caller provenance before contributed dispatch', async () => {
        const invokeContributedAction = vi.fn<InvokeContributedAction>(async () => Object.freeze({
            status: 'executed' as const,
            value: null,
        }));
        const executor = createExecutorForTest(createInvokerForTest(invokeContributedAction));

        await expect(executor.execute('action.invoke', {
            action: { pluginId: 'acme.target', localId: 'run' },
        }, {
            surface: 'plugin',
            actionCaller: {
                kind: 'plugin',
                pluginId: 'acme.caller',
                contributionLocalId: 'caller',
                materialization: {
                    pluginId: 'acme.caller',
                    machineId: 'machine-1',
                    materializationId: 'materialization-1',
                },
            },
        })).resolves.toMatchObject({
            ok: false,
            errorCode: 'plugin_action_caller_unavailable',
        });
        expect(invokeContributedAction).not.toHaveBeenCalled();
    });

    it('returns a committed target failure without converting it into success', async () => {
        const invokeContributedAction = vi.fn<InvokeContributedAction>(async () => Object.freeze({
            status: 'failed' as const,
            code: 'target_declined',
            message: 'Target rejected this request',
            retryable: true,
            data: { reason: 'policy' },
        }));
        const executor = createExecutorForTest(createInvokerForTest(invokeContributedAction));

        await expect(executor.execute('action.invoke', {
            action: { pluginId: 'acme.target', localId: 'run' },
            input: null,
        }, {
            surface: 'plugin',
            actionCaller: {
                kind: 'plugin',
                pluginId: 'acme.caller',
                contributionLocalId: 'caller',
occurrenceId: 'generation-1',
sourceCustody: { kind: 'development', registeredRootId: 'acme-caller-root' },
materialization: {
                    pluginId: 'acme.caller',
                    machineId: 'machine-1',
                    materializationId: 'materialization-1',
                },
            },
        })).resolves.toMatchObject({
            ok: false, errorCode: 'target_declined', error: 'Target rejected this request',
            details: { name: 'PluginError', code: 'target_declined', retryable: true },
        });
    });

    it('fails closed when the host-stamped caller generation is no longer current', async () => {
        const invokeContributedAction = vi.fn<InvokeContributedAction>(async () => Object.freeze({
            status: 'executed' as const,
            value: null,
        }));
        const revalidatePluginActionCallerMaterialization = vi.fn(async () => true);
        const revalidatePluginActionCallerOccurrence = vi.fn(async () => false);
        const executor = createExecutorForTest(createInvokerForTest(invokeContributedAction, {
            revalidatePluginActionCallerMaterialization,
            revalidatePluginActionCallerOccurrence,
        }));

        await expect(executor.execute('action.invoke', {
            action: { pluginId: 'acme.target', localId: 'run' },
            input: null,
        }, {
            surface: 'plugin',
            actionCaller: {
                kind: 'plugin',
                pluginId: 'acme.caller',
                contributionLocalId: 'caller',
occurrenceId: 'generation-1',
sourceCustody: { kind: 'development', registeredRootId: 'acme-caller-root' },
materialization: {
                    pluginId: 'acme.caller',
                    machineId: 'machine-1',
                    materializationId: 'materialization-1',
                },
            },
        })).resolves.toEqual({
            ok: false,
            errorCode: 'plugin_action_caller_unavailable',
            error: 'Plugin contributed action caller is no longer current',
        });

        expect(revalidatePluginActionCallerMaterialization).toHaveBeenCalledWith({
            pluginId: 'acme.caller',
            machineId: 'machine-1',
            materializationId: 'materialization-1',
        });
        expect(revalidatePluginActionCallerOccurrence).toHaveBeenCalledWith({
            pluginId: 'acme.caller',
            occurrenceId: 'generation-1',
        });
        expect(invokeContributedAction).not.toHaveBeenCalled();
    });

    it('reports the executed target result when the caller retires during dispatch', async () => {
        const invokeContributedAction = vi.fn<InvokeContributedAction>(async () => Object.freeze({
            status: 'executed' as const,
            value: { completed: true },
        }));
        const revalidatePluginActionCallerMaterialization = vi.fn(async () => true);
        let occurrenceChecks = 0;
        const revalidatePluginActionCallerOccurrence = vi.fn(async () => {
            occurrenceChecks += 1;
            return occurrenceChecks === 1;
        });
        const executor = createExecutorForTest(createInvokerForTest(invokeContributedAction, {
            revalidatePluginActionCallerMaterialization,
            revalidatePluginActionCallerOccurrence,
        }));

        await expect(executor.execute('action.invoke', {
            action: { pluginId: 'acme.target', localId: 'run' },
            input: null,
        }, {
            surface: 'plugin',
            actionCaller: {
                kind: 'plugin',
                pluginId: 'acme.caller',
                contributionLocalId: 'caller',
occurrenceId: 'generation-1',
sourceCustody: { kind: 'development', registeredRootId: 'acme-caller-root' },
materialization: {
                    pluginId: 'acme.caller',
                    machineId: 'machine-1',
                    materializationId: 'materialization-1',
                },
            },
        })).resolves.toEqual({ ok: true, result: { completed: true } });

        // The caller is admitted once before dispatch; its later retirement
        // applies at its next call, not to an effect that already ran.
        expect(invokeContributedAction).toHaveBeenCalledOnce();
        expect(revalidatePluginActionCallerMaterialization).toHaveBeenCalledTimes(1);
        expect(revalidatePluginActionCallerOccurrence).toHaveBeenCalledTimes(1);
    });
});
