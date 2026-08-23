import { describe, expect, it, vi } from 'vitest';

import {
    createActionExecutor,
    type ActionExecutorDeps,
} from '@happier-dev/protocol/actions';

import { createHostContributedActionInvoker } from './hostContributedActionInvoker';
import type { InvokeContributedAction } from '../services/actions';

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
        executionRunStart: unexpectedDependency,
        executionRunList: unexpectedDependency,
        executionRunGet: unexpectedDependency,
        executionRunSend: unexpectedDependency,
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
        isActionApprovalRequired: () => false,
        invokeContributedAction,
    } as unknown as ActionExecutorDeps;
    return createActionExecutor(deps);
}

function createInvokerForTest(
    invokeContributedAction: InvokeContributedAction,
    overrides: Readonly<{
        revalidatePluginActionCallerMaterialization?: () => Promise<boolean>;
        revalidatePluginActionCallerImmutableGeneration?: () => Promise<boolean>;
    }> = {},
) {
    return createHostContributedActionInvoker({
        invokeContributedAction,
        revalidatePluginActionCallerMaterialization:
            overrides.revalidatePluginActionCallerMaterialization ?? (async () => true),
        revalidatePluginActionCallerImmutableGeneration:
            overrides.revalidatePluginActionCallerImmutableGeneration ?? (async () => true),
    });
}

describe('createHostContributedActionInvoker', () => {
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
                immutableGenerationId: 'generation-1',
                materialization: {
                    pluginId: 'acme.caller',
                    machineId: 'machine-1',
                    materializationId: 'materialization-1',
                },
            },
        })).resolves.toEqual({ ok: true, result: { accepted: true } });

        expect(invokeContributedAction).toHaveBeenCalledWith({
            action: { pluginId: 'acme.caller', localId: 'target' },
            input: { title: 'Ready' },
            surface: 'plugin',
            caller: {
                kind: 'plugin',
                pluginId: 'acme.caller',
                contribution: {
                    id: 'caller',
                    qualifiedId: 'acme.caller/caller',
                },
                materialization: {
                    pluginId: 'acme.caller',
                    machineId: 'machine-1',
                    materializationId: 'materialization-1',
                },
            },
            signal: controller.signal,
        });
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
                materialization: {
                    pluginId: 'acme.caller',
                    machineId: 'machine-1',
                    materializationId: 'materialization-1',
                },
            },
        })).resolves.toEqual({
            ok: false,
            errorCode: 'target_declined',
            error: 'Target rejected this request',
        });
    });

    it('fails closed when the host-stamped caller generation is no longer current', async () => {
        const invokeContributedAction = vi.fn<InvokeContributedAction>(async () => Object.freeze({
            status: 'executed' as const,
            value: null,
        }));
        const revalidatePluginActionCallerMaterialization = vi.fn(async () => true);
        const revalidatePluginActionCallerImmutableGeneration = vi.fn(async () => false);
        const executor = createExecutorForTest(createInvokerForTest(invokeContributedAction, {
            revalidatePluginActionCallerMaterialization,
            revalidatePluginActionCallerImmutableGeneration,
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
                immutableGenerationId: 'generation-1',
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
        expect(revalidatePluginActionCallerImmutableGeneration).toHaveBeenCalledWith({
            pluginId: 'acme.caller',
            immutableGenerationId: 'generation-1',
        });
        expect(invokeContributedAction).not.toHaveBeenCalled();
    });

    it('does not report a target success after the caller retires during dispatch', async () => {
        const invokeContributedAction = vi.fn<InvokeContributedAction>(async () => Object.freeze({
            status: 'executed' as const,
            value: { completed: true },
        }));
        const revalidatePluginActionCallerMaterialization = vi.fn(async () => true);
        let generationChecks = 0;
        const revalidatePluginActionCallerImmutableGeneration = vi.fn(async () => {
            generationChecks += 1;
            return generationChecks === 1;
        });
        const executor = createExecutorForTest(createInvokerForTest(invokeContributedAction, {
            revalidatePluginActionCallerMaterialization,
            revalidatePluginActionCallerImmutableGeneration,
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
                immutableGenerationId: 'generation-1',
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

        expect(invokeContributedAction).toHaveBeenCalledOnce();
        expect(revalidatePluginActionCallerMaterialization).toHaveBeenCalledTimes(2);
        expect(revalidatePluginActionCallerImmutableGeneration).toHaveBeenCalledTimes(2);
    });
});
