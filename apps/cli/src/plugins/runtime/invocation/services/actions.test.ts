import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';

import { createBrowserDaemonRuntimeActionExecutor } from '@/daemon/browser/actions/runtimeActionExecutor';
import { createBrowserDaemonControlBroker } from '@/daemon/browser/control/broker';
import { createBrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';

import {
    createPluginInvocationActionsService,
    type InvokeContributedAction,
} from './actions';
import { createPluginActionCallerMaterializationFixture } from './actionCaller.testkit';

type TestActionExecutorOverrides = Pick<
    ActionExecutorDeps,
    'pluginPermissionGrantAction' | 'sessionPermissionRespond' | 'sessionUserActionAnswer'
>;

function createActionExecutorForTest(overrides: TestActionExecutorOverrides = {}) {
    const deps: ActionExecutorDeps = {
        executionRunStart: async () => ({}),
        executionRunList: async () => ({}),
        executionRunGet: async () => ({}),
        executionRunSend: async () => ({}),
        executionRunStop: async () => ({}),
        executionRunAction: async () => ({}),
        executionRunWait: async () => ({}),
        sessionOpen: async () => ({}),
        sessionFork: async () => ({}),
        sessionRollback: async () => ({}),
        sessionSpawnNew: async () => ({}),
        pathsListRecent: async () => ({ items: [] }),
        machinesList: async () => ({ items: [] }),
        serversList: async () => ({ items: [] }),
        reviewEnginesList: async () => ({ items: [] }),
        agentsBackendsList: async () => ({ items: [] }),
        agentsModelsList: async () => ({ items: [] }),
        sessionSendMessage: async () => ({}),
        sessionModeSet: async () => ({}),
        sessionModesList: async () => ({ items: [] }),
        sessionTargetPrimarySet: async () => ({}),
        sessionTargetTrackedSet: async () => ({}),
        sessionList: async () => ({ sessions: [] }),
        sessionActivityGet: async () => ({}),
        sessionRecentMessagesGet: async () => ({}),
        daemonMemorySearch: async () => ({ v: 1, ok: true, hits: [] }),
        daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
        daemonMemoryEnsureUpToDate: async () => ({}),
        resetGlobalVoiceAgent: async () => {},
        isActionApprovalRequired: () => false,
        ...overrides,
    };
    return createActionExecutor(deps);
}

function createPermissionActionExecutor(
    pluginPermissionGrantAction: NonNullable<ActionExecutorDeps['pluginPermissionGrantAction']>,
) {
    return createActionExecutorForTest({ pluginPermissionGrantAction });
}

describe('plugin invocation ActionsService', () => {
    it('preserves strict execution-run start certainty in the public PluginError', async () => {
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.automations', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.automations').resolveCurrentPluginMaterializationRef,
                generation: 'generation-1',
                correlationId: 'automation-run-1',
                surface: 'background',
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            },
            actionExecutor: {
                execute: vi.fn(async () => ({
                    ok: false as const,
                    errorCode: 'execution_run_target_unavailable',
                    error: 'execution_run_target_unavailable',
                    details: {
                        executionRunStart: { v: 1, runCreation: 'noRunCreated' },
                        secret: 'must-not-cross-the-plugin-boundary',
                    },
                })),
            },
            invokeContributedAction: vi.fn(),
        });

        const error = await service.execute('execution.run.start', {
            sessionId: null,
            intent: 'task',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            instructions: 'Summarize the occurrence.',
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
        }).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ code: 'execution_run_target_unavailable' });
        expect(error).toHaveProperty('details', {
            executionRunStart: { v: 1, runCreation: 'noRunCreated' },
        });
    });

    it('defaults malformed start evidence to outcome-unknown and drops non-start failure details', async () => {
        const materialization = createPluginActionCallerMaterializationFixture('acme.automations');
        const seed = {
            plugin: { id: 'acme.automations', version: '1.0.0' },
            resolveCurrentPluginMaterializationRef: materialization.resolveCurrentPluginMaterializationRef,
            generation: 'generation-1',
            surface: 'background' as const,
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        };
        const malformedStart = createPluginInvocationActionsService({
            seed,
            actionExecutor: {
                execute: vi.fn(async () => ({
                    ok: false as const,
                    errorCode: 'execution_run_target_unavailable',
                    error: 'execution_run_target_unavailable',
                    details: { executionRunStart: { v: 2, runCreation: 'noRunCreated' } },
                })),
            },
            invokeContributedAction: vi.fn(),
        });

        await expect(malformedStart.execute('execution.run.start', {
            sessionId: null,
            intent: 'task',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            instructions: 'Summarize the occurrence.',
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
        })).rejects.toMatchObject({
            code: 'execution_run_target_unavailable',
            details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
        });

        const nonStart = createPluginInvocationActionsService({
            seed,
            actionExecutor: {
                execute: vi.fn(async () => ({
                    ok: false as const,
                    errorCode: 'action_disabled',
                    error: 'action_disabled',
                    details: { secret: 'must-not-cross-the-plugin-boundary' },
                })),
            },
            invokeContributedAction: vi.fn(),
        });
        const error = await nonStart.execute('memory.search', {
            machineId: 'machine-1',
            query: { v: 1, query: 'x', scope: { type: 'global' }, mode: 'hints' },
        }).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ code: 'action_disabled' });
        expect(error).not.toHaveProperty('details');
    });

    it('classifies plugin retirement before and after host start dispatch without granting retry authority', async () => {
        const startInput = {
            sessionId: null,
            intent: 'task',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            instructions: 'Summarize the occurrence.',
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
        } as const;
        const materialization = createPluginActionCallerMaterializationFixture('acme.automations');
        const inactiveBeforeDispatch = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.automations', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: materialization.resolveCurrentPluginMaterializationRef,
                generation: 'generation-1',
                surface: 'background',
                signal: new AbortController().signal,
                isGenerationCurrent: () => false,
            },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction: vi.fn(),
        });
        await expect(inactiveBeforeDispatch.execute('execution.run.start', startInput)).rejects.toMatchObject({
            code: 'plugin_action_generation_retired',
            details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
        });

        let currentnessChecks = 0;
        const inactiveAfterDispatch = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.automations', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: materialization.resolveCurrentPluginMaterializationRef,
                generation: 'generation-1',
                surface: 'background',
                signal: new AbortController().signal,
                isGenerationCurrent: () => ++currentnessChecks < 3,
            },
            actionExecutor: {
                execute: vi.fn(async () => ({
                    ok: true as const,
                    result: { runId: 'run-1', callId: 'call-1', sidechainId: 'sidechain-1' },
                })),
            },
            invokeContributedAction: vi.fn(),
        });
        await expect(inactiveAfterDispatch.execute('execution.run.start', startInput)).rejects.toMatchObject({
            code: 'plugin_action_generation_retired',
            details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
        });
    });

    it('classifies plugin input rejection before dispatch and output rejection after dispatch', async () => {
        const materialization = createPluginActionCallerMaterializationFixture('acme.automations');
        const execute = vi.fn(async () => ({ ok: true as const, result: {} }));
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.automations', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: materialization.resolveCurrentPluginMaterializationRef,
                generation: 'generation-1',
                surface: 'background',
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await expect(Reflect.apply(service.execute, service, ['execution.run.start', {}])).rejects.toMatchObject({
            code: 'plugin_action_input_schema_invalid',
            details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
        });
        expect(execute).not.toHaveBeenCalled();

        await expect(service.execute('execution.run.start', {
            sessionId: null,
            intent: 'task',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            instructions: 'Summarize the occurrence.',
            permissionMode: 'read_only',
            retentionPolicy: 'ephemeral',
            runClass: 'bounded',
            ioMode: 'request_response',
        })).rejects.toMatchObject({
            code: 'plugin_action_result_schema_invalid',
            details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
        });
        expect(execute).toHaveBeenCalledOnce();
    });

    it('keeps permission approval unavailable to plugins while retaining host-stamped user-action outcomes', async () => {
        const sessionUserActionAnswer = vi.fn<NonNullable<ActionExecutorDeps['sessionUserActionAnswer']>>(
            async (_args) => undefined,
        );
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.interactions', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.interactions').resolveCurrentPluginMaterializationRef,
                generation: 'generation-1',
                correlationId: 'interaction-1',
                surface: 'ui',
                session: { id: 'session-bound' },
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            },
            actionExecutor: createActionExecutorForTest({
                sessionUserActionAnswer,
            }),
            invokeContributedAction: vi.fn(),
        });

        await expect(Reflect.apply(service.execute, service, ['session.permission.respond', {
            requestId: 'permission-1',
            decision: 'allow',
        }])).rejects.toMatchObject({ code: 'plugin_action_not_available' });

        await expect(service.execute('session.user_action.answer', {
            requestId: 'question-1',
            answers: [{ question: 'Continue?', values: ['Yes'] }],
        })).resolves.toEqual({ ok: true });
        expect(sessionUserActionAnswer).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-bound',
            requestId: 'question-1',
            answers: [{ question: 'Continue?', values: ['Yes'] }],
            signal: expect.any(AbortSignal),
        }));
        expect(sessionUserActionAnswer.mock.calls[0]?.[0]).not.toHaveProperty('requesterPluginId');

        await expect(Reflect.apply(service.execute, service, ['session.permission.respond', {
            sessionId: 'session-forged',
            requestId: 'permission-1',
            decision: 'allow',
        }])).rejects.toMatchObject({ code: 'plugin_action_not_available' });
    });

    it('reaches the canonical daemon browser owner with host-stamped identity and composed cancellation', async () => {
        const dispatchCommand = vi.fn(async (command: Readonly<{ commandId: string }>) => ({
            v: 1 as const,
            commandId: command.commandId,
            status: 'dispatched' as const,
            adapterKind: 'chromiumSidecar' as const,
            events: [],
        }));
        const broker = createBrowserDaemonControlBroker();
        broker.registerAdapter({
            adapterKind: 'chromiumSidecar',
            ownsView: ({ browserSessionId, viewId }) => (
                browserSessionId === 'browser-session-1' && viewId === 'view-1'
            ),
            supportsOpenView: () => false,
            dispatchCommand,
        });
        const canonicalBrowserExecute = createBrowserDaemonRuntimeActionExecutor({
            control: createBrowserDaemonControlRoutes({ broker }),
            featureGate: {
                isEnabled: () => true,
                refresh: async () => {},
            },
        });
        const runtimeActionExecute = vi.fn(canonicalBrowserExecute);
        const actionExecutor = createCliActionExecutor({
            token: 'token',
            sessionId: 'plugin-global',
            mode: 'plain',
            ctx: null,
            runtimeActionExecute,
        } as Parameters<typeof createCliActionExecutor>[0] & Readonly<{
            runtimeActionExecute: typeof runtimeActionExecute;
        }>);
        const retirement = new AbortController();
        const caller = new AbortController();
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.browser', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.browser').resolveCurrentPluginMaterializationRef,
                generation: 'generation-1',
                surface: 'cli',
                signal: retirement.signal,
                isGenerationCurrent: () => true,
            },
            actionExecutor,
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('browser.navigate', {
            kind: 'navigate',
            commandId: 'command-1',
            browserSessionId: 'browser-session-1',
            viewId: 'view-1',
            url: 'https://example.com',
        }, { signal: caller.signal })).resolves.toMatchObject({
            v: 1,
            commandId: 'command-1',
            status: 'dispatched',
        });

        expect(runtimeActionExecute).toHaveBeenCalledOnce();
        expect(runtimeActionExecute.mock.calls[0]?.[0].context).toMatchObject({
            surface: 'plugin',
            actionCaller: { kind: 'plugin', pluginId: 'acme.browser' },
        });
        const signal = runtimeActionExecute.mock.calls[0]?.[0].context.signal;
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal).not.toBe(retirement.signal);
        expect(signal).not.toBe(caller.signal);
        expect(dispatchCommand).toHaveBeenCalledOnce();
    });

    it('binds host action execution to the plugin surface and host-stamped caller identity', async () => {
        const execute = vi.fn(async () => ({
            ok: true as const,
            result: { v: 1, ok: true as const, hits: [] },
        }));
        const retirement = new AbortController();
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.memory');
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.memory', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef:
                    callerMaterialization.resolveCurrentPluginMaterializationRef,
                contribution: { id: 'search', qualifiedId: 'acme.memory/actions/search' },
                generation: 'generation-1',
                immutableGenerationId: 'memory-immutable-generation-a',
                correlationId: 'correlation-1',
                surface: 'cli',
                session: { id: 'session-1' },
                signal: retirement.signal,
                isGenerationCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('memory.search', {
            machineId: 'machine-1',
            query: {
                v: 1,
                query: 'architecture owner',
                scope: { type: 'global' },
                mode: 'hints',
            },
        })).resolves.toEqual({ v: 1, ok: true, hits: [] });

        expect(execute).toHaveBeenCalledWith(
            'memory.search',
            {
                machineId: 'machine-1',
                query: {
                    v: 1,
                    query: 'architecture owner',
                    scope: { type: 'global' },
                    mode: 'hints',
                },
            },
            expect.objectContaining({
                defaultSessionId: 'session-1',
                surface: 'plugin',
                actionCaller: {
                    kind: 'plugin',
                    pluginId: 'acme.memory',
                    contributionLocalId: 'search',
                    materialization: callerMaterialization.materialization,
                    immutableGenerationId: 'memory-immutable-generation-a',
                },
                actionRequestId: 'correlation-1:memory.search:1',
                signal: retirement.signal,
            }),
        );
    });

    it('strictly validates the plugin-recipient result and reports executor failures as PluginError', async () => {
        const invalidResult = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.memory', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.memory').resolveCurrentPluginMaterializationRef,
                generation: 'generation-1',
                surface: 'cli',
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            },
            actionExecutor: {
                execute: async () => ({ ok: true, result: { privateMemoryRows: [] } }),
            },
            invokeContributedAction: vi.fn(),
        });
        await expect(invalidResult.execute('memory.search', {
            machineId: 'machine-1',
            query: { v: 1, query: 'x', scope: { type: 'global' }, mode: 'hints' },
        })).rejects.toMatchObject({
            name: 'PluginError',
            code: 'plugin_action_result_schema_invalid',
        });

        const denied = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.memory', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.memory').resolveCurrentPluginMaterializationRef,
                generation: 'generation-1',
                surface: 'cli',
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            },
            actionExecutor: {
                execute: async () => ({ ok: false, errorCode: 'action_disabled', error: 'action_disabled' }),
            },
            invokeContributedAction: vi.fn(),
        });
        await expect(denied.execute('memory.search', {
            machineId: 'machine-1',
            query: { v: 1, query: 'x', scope: { type: 'global' }, mode: 'hints' },
        })).rejects.toMatchObject({ code: 'action_disabled' });
    });

    it('rejects a semantic transcript result that is outside the plugin external-shareable projection', async () => {
        const execute = vi.fn(async () => ({
            ok: true as const,
            result: {
                ok: true as const,
                sessionId: 'session-1',
                items: [],
                nextCursor: null,
                hasMore: false,
                diagnostics: {
                    rawRowsScanned: 0,
                    pagesFetched: 0,
                    scanLimitReached: false,
                    payloadTruncations: 0,
                },
            },
        }));
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.channels', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.channels').resolveCurrentPluginMaterializationRef,
                generation: 'generation-1',
                surface: 'background',
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('session.transcript.get', {
            sessionId: 'session-1',
            projection: 'externalShareableV1',
        })).rejects.toMatchObject({
            code: 'plugin_action_result_schema_invalid',
        });
        expect(execute).toHaveBeenCalledOnce();
    });

    it('forwards the host-private interception bypass only for hook-originated service seeds', async () => {
        const execute = vi.fn(async () => ({
            ok: true as const,
            result: { v: 1, ok: true as const, hits: [] },
        }));
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.hook', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.hook').resolveCurrentPluginMaterializationRef,
                generation: 'generation-1',
                surface: 'background',
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
                bypassActionInterception: true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await service.execute('memory.search', {
            machineId: 'machine-1',
            query: { v: 1, query: 'x', scope: { type: 'global' }, mode: 'hints' },
        });
        expect(execute).toHaveBeenCalledWith(
            'memory.search',
            expect.anything(),
            expect.objectContaining({ bypassActionInterception: true }),
        );
    });

    it('binds permission-request identity from the host seed instead of accepting plugin-authored identity', async () => {
        const pluginPermissionGrantAction: NonNullable<ActionExecutorDeps['pluginPermissionGrantAction']> = vi.fn(async () => ({
            ok: false as const,
            errorCode: 'test_stop_after_binding',
            error: 'test_stop_after_binding',
        }));
        const actionExecutor = createPermissionActionExecutor(pluginPermissionGrantAction);
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.caller').resolveCurrentPluginMaterializationRef,
                generation: 'generation-1',
                surface: 'ui',
                session: { id: 'session-7' },
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            },
            actionExecutor,
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('plugins.permissions.grants.request', {
            capability: 'reviews.comments.write.direct',
            targetScope: { kind: 'account' },
            subject: { kind: 'general' },
            reason: 'Publish approved review comments directly',
        })).rejects.toMatchObject({ code: 'test_stop_after_binding' });
        expect(pluginPermissionGrantAction).toHaveBeenCalledWith(expect.objectContaining({
            actionId: 'plugins.permissions.grants.request',
            input: expect.objectContaining({
                pluginId: 'acme.caller',
                requester: {
                    kind: 'plugin',
                    pluginId: 'acme.caller',
                    sessionId: 'session-7',
                },
            }),
            caller: expect.objectContaining({
                kind: 'plugin',
                pluginId: 'acme.caller',
                materialization: expect.objectContaining({
                    machineId: 'machine-1',
                    materializationId: 'materialization-acme-caller-current',
                }),
            }),
        }));
    });

    it('routes own-grant revoke through the real executor and keeps user decisions directional', async () => {
        const pluginPermissionGrantAction: NonNullable<ActionExecutorDeps['pluginPermissionGrantAction']> = vi.fn(async () => ({
            ok: false as const,
            errorCode: 'test_stop_after_binding',
            error: 'test_stop_after_binding',
        }));
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.caller').resolveCurrentPluginMaterializationRef,
                generation: 'generation-1',
                surface: 'ui',
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            },
            actionExecutor: createPermissionActionExecutor(pluginPermissionGrantAction),
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('plugins.permissions.grants.revoke', {
            grantId: 'grant-1',
        })).rejects.toMatchObject({ code: 'test_stop_after_binding' });
        expect(pluginPermissionGrantAction).toHaveBeenCalledWith({
            actionId: 'plugins.permissions.grants.revoke',
            input: { grantId: 'grant-1' },
            caller: expect.objectContaining({
                kind: 'plugin',
                pluginId: 'acme.caller',
                materialization: expect.objectContaining({
                    machineId: 'machine-1',
                    materializationId: 'materialization-acme-caller-current',
                }),
            }),
            signal: expect.any(AbortSignal),
        });

        await expect(service.execute('plugins.permissions.grants.grant' as never, {
            requestId: 'request-1',
        } as never)).rejects.toMatchObject({ code: 'plugin_action_not_available' });
        expect(pluginPermissionGrantAction).toHaveBeenCalledTimes(1);
    });

    it('invokes an exact contributed action reference through the committed registry owner', async () => {
        const invokeContributedAction = vi.fn<InvokeContributedAction>(async () => ({
            status: 'executed' as const,
            value: { accepted: true },
        }));
        const signal = new AbortController().signal;
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.caller', {
            materializationId: 'materialization-caller-current',
        });
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                generation: 'generation-1',
                surface: 'agent',
                resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
                session: { id: 'session-1' },
                signal,
                isGenerationCurrent: () => true,
            },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction,
        });

        await expect(service.execute(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
        )).resolves.toEqual({ accepted: true });
        expect(invokeContributedAction).toHaveBeenCalledWith({
            action: { pluginId: 'acme.target', localId: 'publish' },
            input: { title: 'Ready' },
            surface: 'plugin',
            originSurface: 'agent',
            caller: {
                kind: 'plugin',
                pluginId: 'acme.caller',
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                materialization: callerMaterialization.materialization,
                originSurface: 'agent',
            },
            sessionId: 'session-1',
            signal,
        });
    });

    it('withholds a contributed result when the host-stamped caller materialization changes during dispatch', async () => {
        const initialCaller = createPluginActionCallerMaterializationFixture('acme.caller', {
            materializationId: 'materialization-caller-before',
        }).materialization;
        let currentCaller = initialCaller;
        const invokeContributedAction = vi.fn(async () => {
            currentCaller = createPluginActionCallerMaterializationFixture('acme.caller', {
                materializationId: 'materialization-caller-after',
            }).materialization;
            return {
                status: 'executed' as const,
                value: { accepted: true },
            };
        });
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                generation: 'generation-1',
                surface: 'agent',
                resolveCurrentPluginMaterializationRef: () => currentCaller,
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction,
        });

        await expect(service.execute(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
        )).rejects.toMatchObject({ code: 'plugin_action_caller_unavailable' });
        expect(invokeContributedAction).toHaveBeenCalledWith(expect.objectContaining({
            caller: expect.objectContaining({
                materialization: initialCaller,
            }),
        }));
    });

    it('reads only the canonical projected fields when reconstructing a contributed action failure', async () => {
        const cause = new Error('provider credential is secret');
        const original = new PluginError({
            code: 'fixture_provider_failed',
            message: 'provider credential is secret',
            retryable: true,
            details: { credential: 'secret' },
            remediation: { kind: 'openSettings', path: 'accounts/acme' },
            diagnostics: [{ code: 'fixture_diagnostic', severity: 'error', message: 'private' }],
        }, { cause });
        // Boundary fixture: a malformed richer result whose author vocabulary
        // sits at the top level instead of inside the canonical `data` payload.
        const richResult = Object.freeze({
            status: 'failed' as const,
            code: original.code,
            message: original.message,
            retryable: original.retryable,
            details: original.details,
            remediation: original.remediation,
            diagnostics: original.diagnostics,
            cause: original,
        });
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.caller');
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                generation: 'generation-1',
                surface: 'agent',
                resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            },
            actionExecutor: { execute: vi.fn() },
            // Boundary fixture intentionally models a malformed richer result
            // that must not cross the generic service boundary.
            invokeContributedAction: vi.fn<InvokeContributedAction>(async () => richResult),
        });

        const received = await service.execute(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
        ).catch((error: unknown) => error);

        expect(received).toBeInstanceOf(PluginError);
        expect(received).not.toBe(original);
        // `retryable` is a canonical projected field, so it crosses. The author
        // vocabulary is read only from the canonical `data` payload: a fixture
        // that hangs `details`/`remediation`/`diagnostics`/`cause` off the
        // result itself publishes nothing, and no error class is transported.
        expect(received).toMatchObject({
            code: 'fixture_provider_failed',
            message: 'provider credential is secret',
            retryable: true,
            details: undefined,
            remediation: undefined,
            diagnostics: undefined,
        });
        expect(Object.hasOwn(received as object, 'cause')).toBe(false);
        expect((received as PluginError).data).toEqual({
            name: 'PluginError',
            code: 'fixture_provider_failed',
            message: 'provider credential is secret',
            retryable: true,
        });
    });

    it('carries a target plugin canonical error retryable and data across a plugin-to-plugin failure', async () => {
        // Plugins are trusted code. A target's own published failure payload is
        // the failure its caller receives, not a bare taxonomy code.
        const target = new PluginError({
            code: 'fixture_provider_failed',
            message: 'provider rejected the publish',
            retryable: true,
            details: { field: 'title', attempted: 2 },
            remediation: { kind: 'openSettings', path: 'accounts/acme' },
            diagnostics: [{ code: 'fixture_diagnostic', severity: 'error', message: 'quota exhausted' }],
        });
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.caller');
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                generation: 'generation-1',
                surface: 'agent',
                resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction: vi.fn<InvokeContributedAction>(async () => Object.freeze({
                status: 'failed' as const,
                code: target.code,
                message: target.message,
                retryable: target.retryable,
                data: target.data as JsonValue,
            })),
        });

        const received = await service.execute(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
        ).catch((error: unknown) => error);

        expect(received).toBeInstanceOf(PluginError);
        expect(received).not.toBe(target);
        expect(received).toMatchObject({
            code: 'fixture_provider_failed',
            message: 'provider rejected the publish',
            retryable: true,
            details: { field: 'title', attempted: 2 },
            remediation: { kind: 'openSettings', path: 'accounts/acme' },
            diagnostics: [{ code: 'fixture_diagnostic', severity: 'error', message: 'quota exhausted' }],
        });
        expect((received as PluginError).data).toEqual(target.data);
    });

    it('preserves only the generic proof that a contributed handler never began', async () => {
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.caller');
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                generation: 'generation-1',
                surface: 'agent',
                resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction: vi.fn<InvokeContributedAction>(async () => ({
                status: 'unavailable' as const,
                code: 'plugin_action_handler_missing',
                message: 'No committed target handler exists',
                actionHandlerInvocation: 'notStarted',
            } as never)),
        });

        const received = await service.execute(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
        ).catch((error: unknown) => error);

        expect(received).toMatchObject({
            name: 'PluginError',
            code: 'plugin_action_handler_missing',
            actionHandlerInvocation: 'notStarted',
            data: {
                actionHandlerInvocation: 'notStarted',
            },
        });
    });

    it('returns a host-stamped exact target execution origin only for the contributed-Action origin call', async () => {
        const executionOrigin = Object.freeze({
            serverIdentityId: 'srv_action_origin_fixture',
            materializationRef: Object.freeze({
                pluginId: 'acme.target',
                machineId: 'machine-target',
                materializationId: 'materialization-target-current',
            }),
        });
        const invokeContributedAction = vi.fn<InvokeContributedAction>(async () => ({
            status: 'executed' as const,
            value: { accepted: true },
            executionOrigin,
        }));
        const signal = new AbortController().signal;
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.caller', {
            materializationId: 'materialization-caller-current',
        });
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                generation: 'generation-1',
                surface: 'agent',
                resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
                signal,
                isGenerationCurrent: () => true,
            },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction,
        });

        await expect(service.executeWithExecutionOrigin(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
        )).resolves.toEqual({
            result: { accepted: true },
            executionOrigin,
        });
        expect(invokeContributedAction).toHaveBeenCalledWith(expect.objectContaining({
            action: { pluginId: 'acme.target', localId: 'publish' },
            input: { title: 'Ready' },
            surface: 'plugin',
            captureExecutionOrigin: true,
            caller: {
                kind: 'plugin',
                pluginId: 'acme.caller',
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                materialization: callerMaterialization.materialization,
                originSurface: 'agent',
            },
            signal,
        }));
        expect(invokeContributedAction.mock.calls[0]?.[0]).not.toHaveProperty('executionOrigin');

        await expect(service.execute(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
        )).resolves.toEqual({ accepted: true });
        expect(invokeContributedAction.mock.calls[1]?.[0]).not.toHaveProperty('captureExecutionOrigin');
        expect(invokeContributedAction.mock.calls[1]?.[0]).not.toHaveProperty('executionOrigin');
    });

    it('rejects a malformed expected execution origin before contributed Action dispatch', async () => {
        const invokeContributedAction = vi.fn(async () => ({
            status: 'executed' as const,
            value: { accepted: true },
            executionOrigin: {
                serverIdentityId: 'srv_action_origin_fixture',
                materializationRef: {
                    pluginId: 'acme.target',
                    machineId: 'machine-target',
                    materializationId: 'materialization-target-current',
                },
            },
        }));
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.caller');
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                contribution: { id: 'caller', qualifiedId: 'acme.caller/actions/caller' },
                generation: 'generation-1',
                surface: 'agent',
                resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction,
        });

        await expect(service.executeWithExecutionOrigin(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
            {
                expectedExecutionOrigin: {
                    serverIdentityId: 'not-a-server-identity',
                    materializationRef: {
                        pluginId: 'acme.target',
                        machineId: 'machine-target',
                        materializationId: 'materialization-target-current',
                    },
                },
            } as never,
        )).rejects.toMatchObject({
            code: 'plugin_action_execution_origin_invalid',
        });
        expect(invokeContributedAction).not.toHaveBeenCalled();
    });

    it('keeps a background contributed-action call on the target plugin surface', async () => {
        const invokeContributedAction = vi.fn(async () => ({
            status: 'executed' as const,
            value: { accepted: true },
        }));
        const signal = new AbortController().signal;
        const callerMaterialization = createPluginActionCallerMaterializationFixture('acme.background', {
            materializationId: 'materialization-background-current',
        });
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.background', version: '1.0.0' },
                contribution: {
                    id: 'gateway-supervisor',
                    qualifiedId: 'acme.background/backgroundServices/gateway-supervisor',
                },
                generation: 'generation-1',
                surface: 'background',
                resolveCurrentPluginMaterializationRef: callerMaterialization.resolveCurrentPluginMaterializationRef,
                signal,
                isGenerationCurrent: () => true,
            },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction,
        });

        await expect(service.execute(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
        )).resolves.toEqual({ accepted: true });
        expect(invokeContributedAction).toHaveBeenCalledWith({
            action: { pluginId: 'acme.target', localId: 'publish' },
            input: { title: 'Ready' },
            surface: 'plugin',
            originSurface: 'background',
            caller: {
                kind: 'plugin',
                pluginId: 'acme.background',
                contribution: {
                    id: 'gateway-supervisor',
                    qualifiedId: 'acme.background/backgroundServices/gateway-supervisor',
                },
                materialization: callerMaterialization.materialization,
                originSurface: 'background',
            },
            signal,
        });
    });

    it('fails closed instead of inventing caller authority when its own materialization is unavailable', async () => {
        const invokeContributedAction = vi.fn(async () => ({
            status: 'executed' as const,
            value: { accepted: true },
        }));
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.unbound', version: '1.0.0' },
                contribution: { id: 'caller', qualifiedId: 'acme.unbound/actions/caller' },
                generation: 'generation-1',
                surface: 'agent',
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            },
            actionExecutor: { execute: vi.fn() },
            invokeContributedAction,
        });

        await expect(service.execute(
            { pluginId: 'acme.target', localId: 'publish' },
            { title: 'Ready' },
        )).rejects.toMatchObject({ code: 'plugin_action_caller_unavailable' });
        expect(invokeContributedAction).not.toHaveBeenCalled();
    });

    it('fails closed for runtime strings outside the generated plugin action registry', async () => {
        const execute = vi.fn();
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.caller').resolveCurrentPluginMaterializationRef,
                generation: 'generation-1',
                surface: 'ui',
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('unknown.action' as never, {} as never))
            .rejects.toMatchObject({ code: 'plugin_action_unknown' });
        await expect(service.execute('sessions.external.takeover.start' as never, {} as never))
            .rejects.toMatchObject({ code: 'plugin_action_not_available' });
        expect(execute).not.toHaveBeenCalled();
    });

    it('rejects raw Session-subagent Action ids before off-invocation reads or writes reach the generic executor', async () => {
        const execute = vi.fn(async () => ({ ok: true as const, result: [] }));
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.caller', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.caller').resolveCurrentPluginMaterializationRef,
                generation: 'generation-1',
                surface: 'ui',
                session: { id: 'session-bound' },
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        for (const [actionId, input] of [
            ['sessions.subagents.list', { parentSessionId: 'session-outside' }],
            ['sessions.subagents.get', { id: 'subagent-outside', parentSessionId: 'session-outside' }],
            ['sessions.subagents.watch', { id: 'subagent-outside', parentSessionId: 'session-outside' }],
            ['sessions.subagents.upsert', {
                id: 'subagent-outside',
                parentSessionId: 'session-outside',
                origin: 'agent',
                kind: 'native',
                agentRef: { agentId: 'acme.caller' },
            }],
            ['sessions.subagents.updateStatus', {
                id: 'subagent-outside',
                parentSessionId: 'session-outside',
                status: 'running',
            }],
            ['sessions.subagents.complete', {
                id: 'subagent-outside',
                parentSessionId: 'session-outside',
                status: 'completed',
            }],
        ] as const) {
            await expect(Reflect.apply(service.execute, service, [actionId, input]))
                .rejects.toMatchObject({ code: 'plugin_action_not_available' });
        }

        expect(execute).not.toHaveBeenCalled();
    });

    it('invokes an executor-backed runtime action through its exact canonical schemas', async () => {
        const execute = vi.fn(async () => ({
            ok: true as const,
            result: {
                v: 1 as const,
                commandId: 'command-1',
                status: 'dispatched' as const,
                adapterKind: 'chromiumSidecar' as const,
                events: [],
            },
        }));
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.browser', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.browser').resolveCurrentPluginMaterializationRef,
                generation: 'generation-1',
                surface: 'ui',
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('browser.navigate', {
            kind: 'navigate',
            commandId: 'command-1',
            browserSessionId: 'browser-session-1',
            viewId: 'view-1',
            url: 'https://example.com',
        })).resolves.toMatchObject({ status: 'dispatched', commandId: 'command-1' });
        await expect(service.execute('browser.navigate', {
            kind: 'navigate',
            commandId: 'command-2',
            browserSessionId: 'browser-session-1',
            viewId: 'view-1',
        } as never)).rejects.toMatchObject({ code: 'plugin_action_input_schema_invalid' });
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it('composes caller cancellation with generation retirement and rejects late publication', async () => {
        let current = true;
        const retirement = new AbortController();
        const caller = new AbortController();
        const execute = vi.fn(async (
            _actionId: unknown,
            _input: unknown,
            context?: Readonly<{ signal?: AbortSignal }>,
        ) => {
            expect(context?.signal).not.toBe(caller.signal);
            expect(context?.signal).not.toBe(retirement.signal);
            expect(context?.signal?.aborted).toBe(false);
            current = false;
            return { ok: true as const, result: { v: 1, ok: true as const, hits: [] } };
        });
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.memory', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.memory').resolveCurrentPluginMaterializationRef,
                generation: 'generation-1',
                surface: 'cli',
                signal: retirement.signal,
                isGenerationCurrent: () => current,
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('memory.search', {
            machineId: 'machine-1',
            query: { v: 1, query: 'x', scope: { type: 'global' }, mode: 'hints' },
        }, { signal: caller.signal })).rejects.toMatchObject({
            code: 'plugin_action_generation_retired',
        });
    });

    it('rechecks generation authority immediately before invoking the host Action executor', async () => {
        let currentnessReads = 0;
        const execute = vi.fn(async () => ({
            ok: true as const,
            result: { v: 1, ok: true as const, hits: [] },
        }));
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.memory', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef: createPluginActionCallerMaterializationFixture('acme.memory').resolveCurrentPluginMaterializationRef,
                generation: 'generation-1',
                surface: 'agent',
                signal: new AbortController().signal,
                isGenerationCurrent: () => {
                    currentnessReads += 1;
                    return currentnessReads === 1;
                },
            },
            actionExecutor: { execute },
            invokeContributedAction: vi.fn(),
        });

        await expect(service.execute('memory.search', {
            machineId: 'machine-1',
            query: {
                v: 1,
                query: 'witness race',
                scope: { type: 'global' },
                mode: 'hints',
            },
        })).rejects.toMatchObject({
            code: 'plugin_action_generation_retired',
        });
        expect(execute).not.toHaveBeenCalled();
    });
});
