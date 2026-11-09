import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import * as persistence from '@/persistence';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { buildTestCodexRuntimeDescriptorV1 } from '@/testkit/runtimeDescriptorFixtures';
import { registerMachineSessionGoalRpcHandlers } from '@/api/machine/rpcHandlers.sessionGoals';
import type { RpcHandler, RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createCliActionDeps } from './createCliActionDeps';

afterEach(() => vi.restoreAllMocks());

describe('CLI inactive goal transport', () => {
    it.each([false, true])('FIX75 routes configured ACP Goal Set/Get/complete through daemon custody (bound=%s)', async bound => {
        const sessionId = 'c123456789012345678901234';
        const credentials = { token: 'goal-token', encryption: null };
        const rawSession = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', active: false,
            machineId: 'target-machine', metadata: JSON.stringify({ machineId: 'target-machine', path: '/repo',
                runtimeDescriptorV1: { v: 1, agentId: 'custom-acp', agent: { definitionId: 'configured-test' } },
                acpConfiguredBackendV1: { v: 1, updatedAt: 1, backendId: 'configured-test', title: 'Configured Agent' },
            }) });
        vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
        vi.spyOn(persistence, 'readSettings').mockResolvedValue({ schemaVersion: 6, onboardingCompleted: true, machineId: 'target-machine' });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
            if (String(url).includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: rawSession } };
            throw new Error(`Unexpected HTTP boundary: ${url}`);
        });
        const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
        registerMachineSessionGoalRpcHandlers({ rpcHandlerManager: {
            registerHandler: <TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) => {
                handlers.set(method, async raw => handler(raw as TRequest));
            },
        } satisfies RpcHandlerRegistrar, deps: { currentMachineId: 'target-machine', stageWorkStateMutation: async ({ mutation }) => {
            rawSession.metadata = JSON.stringify({ ...JSON.parse(rawSession.metadata ?? '{}'),
                sessionWorkStateV1: mutation.op.kind === 'set' ? mutation.op.value : null });
        } } });
        await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_GOAL_SET)?.({ sessionId, objective: 'Finish the objective' }))
            .resolves.toMatchObject({ workState: { items: [expect.objectContaining({ origin: 'happier', status: 'active' })] } });
        await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_GOAL_GET)?.({ sessionId }))
            .resolves.toMatchObject({ nativeGoalOwner: false, workState: { items: [expect.objectContaining({ title: 'Finish the objective' })] } });
        // The Workflow Action host has no daemon outbox, even on the same
        // Machine. Its request must reach the registered target Goal owner.
        const actionDeps = createCliActionDeps({ token: credentials.token, credentials, sessionId, mode: 'plain', ctx: null,
            ...(bound ? { rawSession,
                getCurrentSessionMetadata: () => JSON.parse(rawSession.metadata ?? '{}'),
                invokeBoundSessionRpc: async () => ({ ok: false, errorCode: 'unsupported_session_runtime_method' }),
            } : {}),
            machineActionDirectTargetTransport: { machineId: 'target-machine', invoke: async (method, request) => {
                const handler = handlers.get(method);
                if (!handler) throw new Error(`Unexpected Goal RPC: ${method}`);
                return handler(request);
            } },
        });
        await expect(actionDeps.sessionGoalSet!({ sessionId, status: 'complete' }))
            .resolves.toMatchObject({ workState: { items: [expect.objectContaining({ status: 'complete' })] } });
        for (const mutation of [{ status: 'blocked' as const }, { objective: 'Resolve the blocker', status: 'blocked' as const }]) {
            await expect(actionDeps.sessionGoalSet!({ sessionId, ...mutation, resumeInactiveWithInitialGoal: false }))
                .resolves.toMatchObject({ workState: { items: [expect.objectContaining({ status: mutation.status,
                    ...('objective' in mutation ? { title: mutation.objective } : {}) })] } });
        }
    });

    it('refuses an authenticated daemon wake without its Goal owner and still checks caller authority', async () => {
        const sessionId = 'c123456789012345678901234';
        const credentials = { token: 'goal-token', encryption: null };
        const rawSession = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', active: false, seq: 19,
            machineId: 'target-machine', metadata: JSON.stringify({ machineId: 'target-machine', path: '/repo',
                agentRuntimeDescriptorV1: buildTestCodexRuntimeDescriptorV1({ backendMode: 'appServer', providerSessionId: 'thread-1' }) }) });
        // Only persisted credentials/settings and the HTTP/process transport are replaced.
        vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
        vi.spyOn(persistence, 'readSettings').mockResolvedValue({ schemaVersion: 6, onboardingCompleted: true, machineId: 'target-machine' });
        const transportReads: string[] = [];
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (String(url).endsWith('/v1/account/encryption/currentness')) {
                transportReads.push('currentness');
                return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
            }
            if (String(url).includes(`/v2/sessions/${sessionId}`)) {
                transportReads.push('session');
                return { status: 200, data: { session: rawSession } };
            }
            throw new Error(`Unexpected HTTP boundary: ${url}`);
        });
        const requests: unknown[] = [];
        const handlers = new Map<string, (raw: unknown, context?: RpcHandlerContext) => Promise<unknown>>();
        registerMachineSessionGoalRpcHandlers({ rpcHandlerManager: {
            registerHandler: <TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) => {
                handlers.set(method, async (raw, context) => await handler(raw as TRequest, context));
            },
        } satisfies RpcHandlerRegistrar, deps: { currentMachineId: 'target-machine',
            machineActionDirectTargetTransport: { machineId: 'target-machine', invoke: async (method, request, options) => {
                expect(method).toBe(RPC_METHODS.SPAWN_HAPPY_SESSION);
                expect(options?.localActionContext?.authority).toBe('account_automation');
                expect(options?.signal).toBe(signal);
                requests.push(request);
                return { type: 'success', sessionId };
            } },
        } });
        const signal = new AbortController().signal;
        const context: RpcHandlerContext = { signal, callerAuthority: 'account_automation' };
        await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_GOAL_SET_V2)?.({ sessionId, objective: 'Finish',
            resumeInactiveWithInitialGoal: true, tokenBudget: null }, context)).resolves.toMatchObject({
                ok: false, errorCode: 'inactive_agent_runtime_unavailable',
            });
        expect(requests).toEqual([]);
        // Daemon admission and the nested Goal Action share this request's
        // transport fact. A second HTTP read adds latency without new authority.
        expect(transportReads).toEqual(['currentness', 'session']);
        requests.length = 0;
        await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_GOAL_SET_V2)?.({ sessionId, objective: 'Finish',
            resumeInactiveWithInitialGoal: true }, { signal, localActionContext: {
                surface: 'agent', authority: 'account_automation', callerPermissionMode: 'default',
                agentStartContext: {
                    caller: { kind: 'session', sessionId: 'unrelated-session', starterDepth: 0, turnDepth: 0 },
                    baseline: { machineId: 'target-machine', directory: '/repo' },
                    roles: {}, ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'default',
                },
            } })).resolves.toMatchObject({ ok: false, errorCode: 'subtree_denied' });
        expect(requests).toEqual([]);
        // A different invocation still obtains fresh Account/Session facts.
        expect(transportReads).toEqual(['currentness', 'session', 'currentness', 'session']);
    });

    it.each(['account_automation', undefined] as const)('retains automation authority and cancellation at the direct target daemon boundary (%s)', async authority => {
        const sessionId = 'c123456789012345678901234';
        const rawSession = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain',
            machineId: 'remote-machine', metadata: JSON.stringify({ machineId: 'remote-machine', path: '/repo' }) });
        // HTTP and device-local persistence are genuine boundaries; routing and resume admission stay real.
        vi.spyOn(persistence, 'readSettings').mockResolvedValue({ schemaVersion: 6, onboardingCompleted: true, machineId: 'local-machine' });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (String(url).endsWith('/v1/account/encryption/currentness')) {
                return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
            }
            if (String(url).includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: rawSession } };
            if (String(url).endsWith('/v1/machines')) return { status: 200, data: [{ id: 'local-machine' }, { id: 'remote-machine' }] };
            throw new Error(`Unexpected HTTP boundary: ${url}`);
        });
        const invoke = vi.fn(async () => ({ ok: true }));
        const deps = createCliActionDeps({ token: 'goal-token', credentials: { token: 'goal-token', encryption: null },
            sessionId, mode: 'plain', ctx: null, serverId: 'goal-home', serverHttpBaseUrl: 'http://goal-home.test',
            machineActionDirectTargetTransport: { machineId: 'remote-machine', invoke } });
        const signal = new AbortController().signal;
        const context: ActionExecutorContext = { surface: 'agent', ...(authority ? { authority } : {}),
            callerPermissionMode: 'default', agentStartWorkDepth: 3, actionRequestId: 'admitted-goal', signal };
        await expect(deps.sessionGoalSet!({ sessionId, objective: 'Finish', resumeInactiveWithInitialGoal: true,
            context, signal, actionRequestId: 'admitted-goal' })).resolves.toEqual({ ok: true });
        expect(invoke).toHaveBeenCalledWith('daemon.sessionGoal.set.v2', {
            sessionId, objective: 'Finish', resumeInactiveWithInitialGoal: true,
        }, expect.objectContaining({ signal, localActionContext: expect.objectContaining({ surface: 'agent',
            authority: 'account_automation', callerPermissionMode: 'default', agentStartWorkDepth: 3,
            actionRequestId: 'admitted-goal' }) }));
    });
});
