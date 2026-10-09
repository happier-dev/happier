import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcActionExecutor } from './_actionDispatchAdapter';
import {
    REQUIRED_GENERIC_ACTION_SPEC_RPC_SCOPES,
    SUBAGENT_RPC_SCOPES,
} from './actionSpecRpcRegistration';
import * as registrarModule from './registerActionSpecRpcHandlers';

const REVIEW_COMMENT_ACTION_IDS = Object.freeze([
    'reviews.comments.create',
    'reviews.comments.list',
    'reviews.comments.get',
    'reviews.comments.transition',
    'reviews.comments.edit',
    'reviews.comments.reply',
    'reviews.comments.redact',
    'reviews.comments.setDisposition',
    'reviews.comments.attachEvidence',
    'reviews.comments.bulkTransition',
] as const);

// These registrar tests inject focused specs directly; loading the full catalog belongs to catalog tests.
vi.mock('@happier-dev/protocol/actions/actionSpecs', async (importOriginal) => ({
    ...await importOriginal<typeof import('@happier-dev/protocol/actions/actionSpecs')>(),
    ACTION_SPECS: [],
}));

function createRpcHarness() {
    const handlers = new Map<string, (
        input: unknown,
        context?: Readonly<{ signal: AbortSignal }>,
    ) => Promise<unknown>>();
    return {
        handlers,
        rpcHandlerManager: {
            hasHandler(method: string) {
                return handlers.has(method);
            },
            registerHandler(method: string, handler: (
                input: unknown,
                context?: Readonly<{ signal: AbortSignal }>,
            ) => Promise<unknown>) {
                handlers.set(method, handler);
            },
        },
    };
}

describe('ActionSpec-derived RPC registrar', () => {
    const module = registrarModule;

    it('projects only code-bound worker refusal facts for finite Project Actions', async () => {
        const failure = { ok: false as const, errorCode: 'not_accepting', error: 'not_accepting',
            details: { kind: 'no_worker_can_accept', unavailable: 'ask', reason: 'not_accepting' } };
        expect(module.unwrapActionResultForRpc('projects.script.run', failure)).toEqual(failure);
        expect(module.unwrapActionResultForRpc('session.spawn_new', failure)).not.toHaveProperty('details');
        expect(module.unwrapActionResultForRpc('projects.script.run', { ...failure,
            errorCode: 'process_exit_nonzero' })).not.toHaveProperty('details');
        expect(module.unwrapActionResultForRpc('projects.script.run', { ...failure,
            details: { ...failure.details, credential: 'private' } })).not.toHaveProperty('details');
        const scriptReview = { ok: false as const, errorCode: 'project_script_effect_changed', error: 'project_script_effect_changed',
            details: { kind: 'pendingApproval', code: 'project_script_effect_changed', reviewedEffectDigest: 'script',
                reviewedEffect: { command: { kind: 'command', command: 'echo changed' } } } };
        expect(module.unwrapActionResultForRpc('projects.script.run', scriptReview)).toEqual(scriptReview);
        expect(module.unwrapActionResultForRpc('projects.script.run', { ...scriptReview,
            errorCode: 'project_setup_effect_changed' })).not.toHaveProperty('details');
        expect(module.unwrapActionResultForRpc('projects.script.run', { ...scriptReview,
            details: { ...scriptReview.details, consentScope: 'untilChanged' } })).not.toHaveProperty('details');
        expect(module.unwrapActionResultForRpc('session.spawn_new', scriptReview)).not.toHaveProperty('details');
    });
    it('keeps only the validated committed spawn outcome in source-key waiting failures', async () => {
        const source = { type: 'success', disposition: 'created', sessionId: 'c111111111111111111111111',
            executionTarget: { serverId: 'home', machineId: 'machine' },
            organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } };
        const failure = { ok: false as const, errorCode: 'session_follow_source_key_preparation_waiting',
            error: 'session_follow_source_key_preparation_waiting', details: {
                status: 'waiting', reason: 'source_key_unavailable', edgeCommitted: true, source,
                secret: 'must-not-cross-the-boundary',
            } };
        expect(module.unwrapActionResultForRpc('session.spawn_new', failure)).toEqual({
            ...failure, details: { status: 'waiting', reason: 'source_key_unavailable', edgeCommitted: true, source },
        });
        expect(module.unwrapActionResultForRpc('session.spawn_new', { ...failure,
            details: { ...failure.details, source: { ...source, secret: 'invalid-spawn-dto' } },
        })).not.toHaveProperty('details');
        expect(module.unwrapActionResultForRpc('memory.search', failure)).not.toHaveProperty('details');
    });

    it('lets one compatibility seam reject an alias request before canonical Action dispatch', async () => {
        const execute = vi.fn(async () => ({ ok: true as const, result: null }));
        const { handlers, rpcHandlerManager } = createRpcHarness();
        module.registerActionSpecRpcHandlers({
            rpcHandlerManager,
            actionExecutor: { execute },
            actionSpecs: [{
                id: 'session.handoff',
                surfaces: { rpc: true },
                bindings: {
                    rpcMethod: 'daemon.sessionHandoff.start.v3',
                    rpcMethodAliases: ['daemon.sessionHandoff.start'],
                },
            }],
            mapRequestForMethod: ({ method, input }) => method.endsWith('.v3')
                ? { accepted: true, input }
                : { accepted: false, response: { ok: false, errorCode: 'invalid_request' } },
        });

        await expect(handlers.get('daemon.sessionHandoff.start')?.({ currentOnly: true }))
            .resolves.toEqual({ ok: false, errorCode: 'invalid_request' });
        expect(execute).not.toHaveBeenCalled();

        await expect(handlers.get('daemon.sessionHandoff.start.v3')?.({ currentOnly: true }))
            .resolves.toBeNull();
        expect(execute).toHaveBeenCalledOnce();
    });

    it('projects only strict execution-run start certainty across the generated RPC seam', async () => {
        expect(module.unwrapActionResultForRpc('execution.run.start', {
            ok: false,
            errorCode: 'execution_run_target_unavailable',
            error: 'execution_run_target_unavailable',
            details: {
                executionRunStart: { v: 1, runCreation: 'noRunCreated' },
                secret: 'must-not-cross-the-rpc-boundary',
            },
        })).toEqual({
            ok: false,
            errorCode: 'execution_run_target_unavailable',
            error: 'execution_run_target_unavailable',
            details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
        });
        expect(module.unwrapActionResultForRpc('execution.run.start', {
            ok: false,
            errorCode: 'execution_run_target_unavailable',
            error: 'execution_run_target_unavailable',
            details: { executionRunStart: { v: 2, runCreation: 'noRunCreated' } },
        })).toEqual({
            ok: false,
            errorCode: 'execution_run_target_unavailable',
            error: 'execution_run_target_unavailable',
            details: { executionRunStart: { v: 1, runCreation: 'outcomeUnknown' } },
        });
        expect(module.unwrapActionResultForRpc('memory.search', {
            ok: false,
            errorCode: 'action_failed',
            error: 'action_failed',
            details: { secret: 'must-not-cross-the-rpc-boundary' },
        })).toEqual({
            ok: false,
            errorCode: 'action_failed',
            error: 'action_failed',
        });
    });

    it('classifies generated start-RPC input rejection before Action execution as no-run-created', async () => {
        const execute = vi.fn();
        const { handlers, rpcHandlerManager } = createRpcHarness();
        module.registerActionSpecRpcHandlers({
            rpcHandlerManager,
            actionExecutor: { execute },
            actionSpecs: [{
                id: 'execution.run.start',
                surfaces: { rpc: true },
                bindings: { rpcMethod: 'execution.run.start.test' },
                surfaceBindings: {
                    rpc: {
                        inputSchema: z.object({ instructions: z.string().min(1) }).strict(),
                        decodeInput: (input) => input,
                        outputSchema: z.unknown(),
                        encodeOutput: (result) => result,
                    },
                },
            }],
        });

        await expect(handlers.get('execution.run.start.test')?.({ instructions: '' })).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_action_transport_input',
            error: 'invalid_action_transport_input',
            details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } },
        });
        expect(execute).not.toHaveBeenCalled();
    });

    it('decodes released RPC input to semantic Action input and encodes the transport result', async () => {
        const execute = vi.fn(async () => ({
            ok: true as const,
            result: { operationId: 'operation-1', presentation: { state: 'running' } },
        }));
        const { handlers, rpcHandlerManager } = createRpcHarness();
        module.registerActionSpecRpcHandlers({
            rpcHandlerManager,
            actionExecutor: { execute },
            actionSpecs: [{
                id: 'sessions.external.operation.status.get',
                surfaces: { rpc: true },
                bindings: { rpcMethod: 'daemon.externalSessions.operation.status' },
                surfaceBindings: {
                    rpc: {
                        inputSchema: z.object({ privateOperationId: z.string().min(1) }).strict(),
                        decodeInput: (input) => ({
                            operationId: (input as { privateOperationId: string }).privateOperationId,
                        }),
                        outputSchema: z.object({ privateOperationId: z.string(), state: z.string() }).strict(),
                        encodeOutput: (result) => ({
                            privateOperationId: (result as { operationId: string }).operationId,
                            state: (result as { presentation: { state: string } }).presentation.state,
                        }),
                    },
                },
            }],
        });

        await expect(handlers.get('daemon.externalSessions.operation.status')?.({
            privateOperationId: 'operation-1',
        })).resolves.toEqual({
            privateOperationId: 'operation-1',
            state: 'running',
        });
        expect(execute).toHaveBeenCalledWith(
            'sessions.external.operation.status.get',
            { operationId: 'operation-1' },
            { surface: 'rpc', authority: 'account_automation' },
        );
    });

    it('rejects invalid released input and invalid encoded output at the RPC binding seam', async () => {
        const execute = vi.fn(async () => ({ ok: true as const, result: { semantic: true } }));
        const { handlers, rpcHandlerManager } = createRpcHarness();
        module.registerActionSpecRpcHandlers({
            rpcHandlerManager,
            actionExecutor: { execute },
            actionSpecs: [{
                id: 'sessions.external.operation.status.get',
                surfaces: { rpc: true },
                bindings: { rpcMethod: 'daemon.externalSessions.operation.status' },
                surfaceBindings: {
                    rpc: {
                        inputSchema: z.object({ transportId: z.string().min(1) }).strict(),
                        decodeInput: (input) => input,
                        outputSchema: z.object({ transportResult: z.string() }).strict(),
                        encodeOutput: () => ({ leakedPrivateState: true }),
                    },
                },
            }],
        });
        const handler = handlers.get('daemon.externalSessions.operation.status');

        await expect(handler?.({ transportId: '' })).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_action_transport_input',
            error: 'invalid_action_transport_input',
        });
        expect(execute).not.toHaveBeenCalled();

        await expect(handler?.({ transportId: 'operation-1' })).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_action_transport_output',
            error: 'invalid_action_transport_output',
        });
        expect(execute).toHaveBeenCalledOnce();
    });

    it('threads the canonical RPC cancellation signal into Action execution', async () => {
        const execute = vi.fn(async () => ({
            ok: true as const,
            result: { ok: true },
        }));
        const { handlers, rpcHandlerManager } = createRpcHarness();
        module.registerActionSpecRpcHandlers({
            rpcHandlerManager,
            actionExecutor: { execute },
            actionSpecs: [{
                id: 'sessions.external.takeover.start',
                surfaces: { rpc: true },
                bindings: { rpcMethod: 'daemon.externalSessions.takeover.start' },
            }],
        });
        const controller = new AbortController();

        await handlers.get('daemon.externalSessions.takeover.start')?.(
            { request: { idempotencyKey: 'takeover-1' } },
            { signal: controller.signal },
        );

        expect(execute).toHaveBeenCalledWith(
            'sessions.external.takeover.start',
            { request: { idempotencyKey: 'takeover-1' } },
            {
                surface: 'rpc',
                authority: 'account_automation',
                signal: controller.signal,
            },
        );
    });

    it('registers scoped ActionSpec RPC rows through the shared dispatch adapter', async () => {

        const calls: unknown[] = [];
        const actionExecutor: RpcActionExecutor = {
            execute: async (actionId, input, context) => {
                calls.push({ actionId, input, context });
                return { ok: true, result: { actionId, input } };
            },
        };
        const { handlers, rpcHandlerManager } = createRpcHarness();

        module.registerActionSpecRpcHandlers({
            rpcHandlerManager,
            actionExecutor,
            actionSpecs: [
                {
                    id: 'sessions.subagents.list',
                    surfaces: { rpc: true },
                    bindings: { rpcMethod: 'sessions.subagents.list' },
                },
                {
                    id: 'approval.request.decide',
                    surfaces: { rpc: true },
                    bindings: { rpcMethod: 'approval.request.decide' },
                },
                {
                    id: 'session.permission.respond',
                    surfaces: { rpc: true },
                    bindings: { rpcMethod: 'session.permission.respond' },
                },
            ],
            actionIds: ['sessions.subagents.list', 'approval.request.decide'],
        });

        expect([...handlers.keys()]).toEqual([
            'sessions.subagents.list',
            'approval.request.decide',
        ]);

        await expect(handlers.get('sessions.subagents.list')?.({
            parentSessionId: 'parent-session',
            sessionId: 'child-session',
        })).resolves.toEqual({
            actionId: 'sessions.subagents.list',
            input: {
                parentSessionId: 'parent-session',
                sessionId: 'child-session',
            },
        });
        await expect(handlers.get('approval.request.decide')?.({
            serverId: 'server-1',
        })).resolves.toEqual({
            actionId: 'approval.request.decide',
            input: { serverId: 'server-1' },
        });

        expect(calls).toEqual([
            {
                actionId: 'sessions.subagents.list',
                input: {
                    parentSessionId: 'parent-session',
                    sessionId: 'child-session',
                },
                context: {
                    defaultSessionId: 'parent-session',
                    surface: 'rpc',
                    authority: 'account_automation',
                },
            },
            {
                actionId: 'approval.request.decide',
                input: { serverId: 'server-1' },
                context: {
                    serverId: 'server-1',
                    surface: 'rpc',
                    authority: 'account_automation',
                },
            },
        ]);
    });

    it('keeps raw direct Action requests unchanged when targeted requests are enabled', async () => {
        const execute = vi.fn(async () => ({ ok: true as const, result: { state: 'paused' } }));
        const { handlers, rpcHandlerManager } = createRpcHarness();
        module.registerActionSpecRpcHandlers({
            rpcHandlerManager,
            actionExecutor: { execute },
            targetMachineId: 'machine-1',
            actionSpecs: [{
                id: 'workflow.run.pause',
                surfaces: { rpc: true },
                bindings: { rpcMethod: 'workflow.run.pause' },
            }],
        });
        const input = {
            runId: '11111111-1111-4111-8111-111111111111',
            expectedRevision: 2,
        };

        await expect(handlers.get('workflow.run.pause')?.(input)).resolves.toEqual({ state: 'paused' });
        expect(execute).toHaveBeenCalledWith(
            'workflow.run.pause',
            input,
            { surface: 'rpc', authority: 'account_automation' },
        );
    });

    it('opens the targeted envelope origin session into the execution context', async () => {
        const execute = vi.fn(async () => ({ ok: true as const, result: { admission: 'created' } }));
        const { handlers, rpcHandlerManager } = createRpcHarness();
        module.registerActionSpecRpcHandlers({
            rpcHandlerManager,
            actionExecutor: { execute },
            targetMachineId: 'machine-1',
            actionSpecs: [{ id: 'workflow.run.start', surfaces: { rpc: true }, bindings: { rpcMethod: 'workflow.run.start' } }],
        });
        const input = { runId: '11111111-1111-4111-8111-111111111111' };
        const target = { kind: 'machine' as const, machineId: 'machine-1' };

        await handlers.get('workflow.run.start')?.({ v: 1, kind: 'targeted_action_rpc', input, target, defaultSessionId: 'session-a' });
        expect(execute).toHaveBeenCalledWith('workflow.run.start', input,
            expect.objectContaining({ defaultSessionId: 'session-a', externalActionTarget: target }));
    });

    it('registers new ActionSpec rows matched by RPC method scope without action-id catalog updates', async () => {

        const actionExecutor: RpcActionExecutor = {
            execute: async (actionId, input) => ({ ok: true, result: { actionId, input } }),
        };
        const { handlers, rpcHandlerManager } = createRpcHarness();

        module.registerActionSpecRpcHandlers({
            rpcHandlerManager,
            actionExecutor,
            scopes: SUBAGENT_RPC_SCOPES,
            actionSpecs: [
                {
                    id: 'sessions.subagents.inspect',
                    surfaces: { rpc: true },
                    bindings: { rpcMethod: 'sessions.subagents.inspect' },
                },
                {
                    id: 'approval.request.inspect',
                    surfaces: { rpc: true },
                    bindings: { rpcMethod: 'approval.request.inspect' },
                },
            ],
        });

        expect([...handlers.keys()]).toEqual(['sessions.subagents.inspect']);
        await expect(handlers.get('sessions.subagents.inspect')?.({
            sessionId: 'session-1',
        })).resolves.toEqual({
            actionId: 'sessions.subagents.inspect',
            input: { sessionId: 'session-1' },
        });
    });

    it('stamps the Action operation runner admitted request identity into execution context', async () => {
        const contexts: unknown[] = [];
        const actionExecutor: RpcActionExecutor = {
            execute: async (_actionId, _input, context) => {
                contexts.push(context);
                return { ok: true, result: { accepted: true } };
            },
        };
        const { handlers, rpcHandlerManager } = createRpcHarness();

        module.registerActionSpecRpcHandlers({
            rpcHandlerManager,
            actionExecutor,
            actionIds: ['sessions.subagents.list'],
            actionSpecs: [{
                id: 'sessions.subagents.list',
                operation: { version: 1 },
                surfaces: { rpc: true },
                bindings: { rpcMethod: 'sessions.subagents.list' },
            }],
            observeExecution: async (request) => await request.execute({
                actionRequestId: 'admitted-request-1',
                signal: new AbortController().signal,
                operationProgress: { update: () => undefined },
                operationOwnerUpdate: { update: () => undefined },
            }),
        });

        await expect(handlers.get('sessions.subagents.list')?.({ sessionId: 'session-1' }))
            .resolves.toEqual({ accepted: true });
        expect(contexts).toEqual([expect.objectContaining({ actionRequestId: 'admitted-request-1' })]);
    });

    it('does not register runtime ActionSpec rows while their rpc surface is disabled', async () => {

        const actionExecutor: RpcActionExecutor = {
            execute: async (actionId, input) => ({ ok: true, result: { actionId, input } }),
        };
        const { handlers, rpcHandlerManager } = createRpcHarness();

        module.registerActionSpecRpcHandlers({
            rpcHandlerManager,
            actionExecutor,
            scopes: [{
                id: 'fixture.runtime',
                methodPrefixes: ['browser.', 'session.'],
            }],
            actionIds: ['browser.navigate', 'session.list'],
            actionSpecs: [
                {
                    id: 'browser.navigate',
                    surfaces: { rpc: false },
                    bindings: { rpcMethod: 'browser.navigate' },
                },
                {
                    id: 'session.list',
                    surfaces: { rpc: true },
                    bindings: { rpcMethod: 'session.list' },
                },
            ],
        });

        expect([...handlers.keys()]).toEqual(['session.list']);
        expect(handlers.has('browser.navigate')).toBe(false);
    });

    it('registers review-comment ActionSpec rows through required generic scopes', async () => {

        const calls: unknown[] = [];
        const actionExecutor: RpcActionExecutor = {
            execute: async (actionId, input, context) => {
                calls.push({ actionId, input, context });
                return { ok: true, result: { actionId, input } };
            },
        };
        const { handlers, rpcHandlerManager } = createRpcHarness();

        module.registerActionSpecRpcHandlers({
            rpcHandlerManager,
            actionExecutor,
            scopes: REQUIRED_GENERIC_ACTION_SPEC_RPC_SCOPES,
            actionIds: REVIEW_COMMENT_ACTION_IDS,
            actionSpecs: REVIEW_COMMENT_ACTION_IDS.map((actionId) => ({
                id: actionId,
                surfaces: { rpc: true },
                bindings: { rpcMethod: actionId },
            })),
        });

        expect([...handlers.keys()]).toEqual([...REVIEW_COMMENT_ACTION_IDS]);
        await expect(handlers.get('reviews.comments.create')?.({
            projectId: 'project-1',
        })).resolves.toEqual({
            actionId: 'reviews.comments.create',
            input: { projectId: 'project-1' },
        });
        expect(calls).toEqual([
            {
                actionId: 'reviews.comments.create',
                input: { projectId: 'project-1' },
                context: { surface: 'rpc', authority: 'account_automation' },
            },
        ]);
    });

    it('honors scope exclusions for typed ABI exceptions', async () => {

        const actionExecutor: RpcActionExecutor = {
            execute: async () => ({ ok: true, result: null }),
        };
        const { handlers, rpcHandlerManager } = createRpcHarness();

        module.registerActionSpecRpcHandlers({
            rpcHandlerManager,
            actionExecutor,
            scopes: [
                {
                    id: 'fixture.externalSessions',
                    methodPrefixes: ['daemon.externalSessions.'],
                    excludedMethods: ['daemon.externalSessions.takeover'],
                },
            ],
            exceptions: [],
            actionSpecs: [
                {
                    id: 'sessions.external.candidates.list',
                    surfaces: { rpc: true },
                    bindings: { rpcMethod: 'daemon.externalSessions.candidates.list' },
                },
                {
                    id: 'sessions.external.takeover',
                    surfaces: { rpc: true },
                    bindings: { rpcMethod: RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY },
                },
            ],
        });

        expect([...handlers.keys()]).toEqual(['daemon.externalSessions.candidates.list']);
    });

    it('registers ActionSpec RPC aliases through the same action handler', async () => {

        const calls: unknown[] = [];
        const actionExecutor: RpcActionExecutor = {
            execute: async (actionId, input) => {
                calls.push({ actionId, input });
                return { ok: true, result: { actionId, input } };
            },
        };
        const { handlers, rpcHandlerManager } = createRpcHarness();

        module.registerActionSpecRpcHandlers({
            rpcHandlerManager,
            actionExecutor,
            scopes: [
                {
                    id: 'fixture.externalSessions',
                    methodPrefixes: ['daemon.externalSessions.'],
                },
            ],
            exceptions: [],
            actionSpecs: [
                {
                    id: 'sessions.external.candidates.list',
                    surfaces: { rpc: true },
                    bindings: {
                        rpcMethod: 'daemon.externalSessions.candidates.list',
                        rpcMethodAliases: ['daemon.directSessions.candidates.list'],
                    },
                },
            ],
        });

        expect([...handlers.keys()]).toEqual([
            'daemon.externalSessions.candidates.list',
            'daemon.directSessions.candidates.list',
        ]);

        await expect(handlers.get('daemon.externalSessions.candidates.list')?.({
            machineId: 'machine-1',
        })).resolves.toEqual({
            actionId: 'sessions.external.candidates.list',
            input: { machineId: 'machine-1' },
        });
        expect(calls).toEqual([
            {
                actionId: 'sessions.external.candidates.list',
                input: { machineId: 'machine-1' },
            },
        ]);
    });

    it('skips canonical typed exceptions and rejects duplicate ActionSpec RPC bindings', async () => {

        const { handlers, rpcHandlerManager } = createRpcHarness();
        const actionExecutor: RpcActionExecutor = {
            execute: async () => ({ ok: true, result: null }),
        };

        module.registerActionSpecRpcHandlers({
            rpcHandlerManager,
            actionExecutor,
            actionSpecs: [
                {
                    id: 'sessions.external.takeover',
                    surfaces: { rpc: true },
                    bindings: { rpcMethod: RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY },
                },
            ],
        });

        expect([...handlers.keys()]).toEqual([]);

        expect(() => module.registerActionSpecRpcHandlers({
            rpcHandlerManager,
            actionExecutor,
            actionSpecs: [
                {
                    id: 'sessions.subagents.list',
                    surfaces: { rpc: true },
                    bindings: { rpcMethod: 'sessions.subagents.list' },
                },
                {
                    id: 'sessions.subagents.get',
                    surfaces: { rpc: true },
                    bindings: { rpcMethod: 'sessions.subagents.list' },
                },
            ],
        })).toThrow(/duplicate_action_spec_rpc_method/);
    });

    it('rejects duplicate registrations across scoped registrar calls', async () => {

        const { rpcHandlerManager } = createRpcHarness();
        const actionExecutor: RpcActionExecutor = {
            execute: async () => ({ ok: true, result: null }),
        };

        module.registerActionSpecRpcHandlers({
            rpcHandlerManager,
            actionExecutor,
            actionSpecs: [
                {
                    id: 'sessions.subagents.list',
                    surfaces: { rpc: true },
                    bindings: { rpcMethod: 'sessions.subagents.list' },
                },
            ],
        });

        expect(() => module.registerActionSpecRpcHandlers({
            rpcHandlerManager,
            actionExecutor,
            actionSpecs: [
                {
                    id: 'sessions.subagents.get',
                    surfaces: { rpc: true },
                    bindings: { rpcMethod: 'sessions.subagents.list' },
                },
            ],
        })).toThrow(/duplicate_action_spec_rpc_method/);
    });
});
