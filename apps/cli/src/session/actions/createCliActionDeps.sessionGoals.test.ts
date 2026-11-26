import { updateMachineRegistration } from '@/daemon/machineIdentity/machineRegistrationStore';
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
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';

// Repository build preparation is a process boundary. The admitted runtime,
// contribution activation and native launch-owner refusal remain real.
vi.mock('@/subprocess/sourceDevSharedDepsPreflight', async importOriginal => ({
    ...await importOriginal<typeof import('@/subprocess/sourceDevSharedDepsPreflight')>(),
    prepareSourceDevSharedDepsForBundledPluginRuntimeLoad: async () => ({
        type: 'ready' as const, checked: false, reason: 'not-source-dev' as const,
    }),
}));

let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
    vi.restoreAllMocks();
});

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
        await updateMachineRegistration(() => ({ machineId: 'target-machine' }));
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

    it('refuses an authenticated daemon wake without its native launch owner and still checks caller authority', async () => {
        runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: { pluginIds: ['happier.agent.codex'],
                scopedActionRuntime: { credentials: null, actionsSettingsProvider: createActionSettingsProvider() } } });
        const sessionId = 'c123456789012345678901234';
        const credentials = { token: 'goal-token', encryption: null };
        const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
            metadata: { machineId: 'target-machine', path: '/repo',
                agentRuntimeDescriptorV1: buildTestCodexRuntimeDescriptorV1({ backendMode: 'appServer', providerSessionId: 'thread-1' }) }, agentState: null });
        const rawSession = createSessionRecordFixture({ id: sessionId, share: null, encryptionMode: 'plain', active: false, seq: 19,
            machineId: 'target-machine', metadataVersion: 0, metadataLayoutVersion: fields.metadataLayoutVersion,
            metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata, displayProjectionV1: fields.displayProjectionV1 });
        // Only persisted credentials/settings and the HTTP/process transport are replaced.
        vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
        await updateMachineRegistration(() => ({ machineId: 'target-machine' }));
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
            if (String(url).includes('/v2/sessions/unrelated-session')) {
                transportReads.push('caller-session');
                return { status: 200, data: { session: { ...rawSession, id: 'unrelated-session' } } };
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
                ok: false, errorCode: 'inactive_agent_launch_scope_unavailable',
            });
        expect(requests).toEqual([]);
        // Daemon admission and the nested Goal Action share this request's
        // transport fact. A second HTTP read adds latency without new authority.
        expect(transportReads).toEqual(['currentness', 'session']);
        requests.length = 0;
        await expect(handlers.get(RPC_METHODS.DAEMON_SESSION_GOAL_SET_V2)?.({ sessionId, objective: 'Finish',
            resumeInactiveWithInitialGoal: true }, { signal, sessionActionOrigin: { v: 1,
                caller: { kind: 'session', sessionId: 'unrelated-session', starterDepth: 0, turnDepth: 0 },
                sourceTurnId: 'turn-1', requestId: 'goal-1', callerPermissionMode: 'default',
            }, localActionContext: {
                surface: 'agent', authority: 'account_automation', callerPermissionMode: 'default',
                agentStartContext: {
                    caller: { kind: 'session', sessionId: 'unrelated-session', starterDepth: 0, turnDepth: 0 },
                    baseline: { machineId: 'target-machine', directory: '/repo' },
                    roles: {}, ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'default',
                },
            } })).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action', details: { cause: 'action_scope_restricted' } });
        expect(requests).toEqual([]);
        // A different invocation obtains fresh target facts and resolves the
        // authenticated caller's distinct Session before denying its scope.
        expect(transportReads).toEqual(['currentness', 'session', 'currentness', 'session', 'currentness', 'caller-session']);
    });

    it.each(['account_automation', undefined] as const)('retains automation authority and cancellation at the direct target daemon boundary (%s)', async authority => {
        const sessionId = 'c123456789012345678901234';
        const rawSession = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain',
            machineId: 'remote-machine', metadata: JSON.stringify({ machineId: 'remote-machine', path: '/repo' }) });
        // HTTP and device-local persistence are genuine boundaries; routing and resume admission stay real.
        await updateMachineRegistration(() => ({ machineId: 'local-machine' }));
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
