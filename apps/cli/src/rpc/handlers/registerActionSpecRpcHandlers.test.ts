import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcActionExecutor } from './_actionDispatchAdapter';
import {
    REQUIRED_GENERIC_ACTION_SPEC_RPC_SCOPES,
    SUBAGENT_RPC_SCOPES,
} from './actionSpecRpcRegistration';

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
    it('projects only strict execution-run start certainty across the generated RPC seam', async () => {
        const module = await import('./registerActionSpecRpcHandlers');
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
        const module = await import('./registerActionSpecRpcHandlers');
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
        const module = await import('./registerActionSpecRpcHandlers');
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
            { surface: 'rpc' },
        );
    });

    it('rejects invalid released input and invalid encoded output at the RPC binding seam', async () => {
        const module = await import('./registerActionSpecRpcHandlers');
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
        const module = await import('./registerActionSpecRpcHandlers');
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
                signal: controller.signal,
            },
        );
    });

    it('registers scoped ActionSpec RPC rows through the shared dispatch adapter', async () => {
        const module = await import('./registerActionSpecRpcHandlers');

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
                },
            },
            {
                actionId: 'approval.request.decide',
                input: { serverId: 'server-1' },
                context: {
                    serverId: 'server-1',
                    surface: 'rpc',
                },
            },
        ]);
    });

    it('registers new ActionSpec rows matched by RPC method scope without action-id catalog updates', async () => {
        const module = await import('./registerActionSpecRpcHandlers');

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

    it('does not register runtime ActionSpec rows while their rpc surface is disabled', async () => {
        const module = await import('./registerActionSpecRpcHandlers');

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
        const module = await import('./registerActionSpecRpcHandlers');

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
                context: { surface: 'rpc' },
            },
        ]);
    });

    it('honors scope exclusions for typed ABI exceptions', async () => {
        const module = await import('./registerActionSpecRpcHandlers');

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
        const module = await import('./registerActionSpecRpcHandlers');

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
        const module = await import('./registerActionSpecRpcHandlers');

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
        const module = await import('./registerActionSpecRpcHandlers');

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
