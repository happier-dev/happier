import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createAdmittedMuseSessionFixture } from './testkit/admittedSession.test-support.js';
import { createMuseInteractions } from './interactions.js';
import { requestNativePermissionDecision } from '@/session/services/pluginSessionHandleCapabilities';
import { createExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';
import { createRunScopedExecutionPermissionHandler, buildRunScopedExecutionPermissionRequestId } from '@/agent/executionRuns/policy/runScopedExecutionPermissionHandler';
import { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';
import type { AgentState } from '@/api/types';

let fixture: Awaited<ReturnType<typeof createAdmittedMuseSessionFixture>>;
beforeAll(async () => { fixture = await createAdmittedMuseSessionFixture(); });
afterAll(async () => { await fixture?.dispose(); });

it.each(['approved', 'denied', 'policy-denied', 'ceiling-denied', 'native-observed'] as const)('settles a Run native %s without duplicate Muse decisions', async outcome => {
    let state: AgentState = {};
    const store = new AgentStateRequestStore({ logPrefix: '[Muse Run]', target: {
        scopeId: 'run', readState: () => state, updateState: async update => { state = update(state); },
    } });
    const handler = createExecutionRunPermissionHandler({ backendId: 'muse', permissionMode: 'default',
        ...(outcome === 'policy-denied' ? { allowedTools: [], unlistedTools: 'deny' as const } : {}),
        getPermissionRequestStore: () => store,
        publishPendingRequest: async request => { await store.publishRequestAndWait({ ...request, createdAt: 1 }); },
    });
    const scope = createRunScopedExecutionPermissionHandler({ runId: 'run', controllerOccurrenceId: 'occurrence',
        parentSessionId: null, handler, readInteractionMode: () => 'deterministic' });
    const command = vi.fn(async () => ({})); // Native MSP command transport boundary.
    const errors: unknown[] = [];
    const interactions = createMuseInteractions({ context: fixture.context, command,
        permissions: {
            getMode: () => 'default',
            settleObservedDecision: request => scope.settleObservedDecision({ ...request,
                owner: { kind: 'plugin', pluginId: 'happier.agent.muse' },
            }),
            requestDecision: (request, options) => requestNativePermissionDecision({ request,
                permissionHandler: scope.handler, owner: { kind: 'plugin', pluginId: 'happier.agent.muse' },
                ...options,
                ...(outcome === 'ceiling-denied' ? { permissionContext: { causalPermissionAuthority: {
                    kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'read-only' as const,
                } } } : {}),
            }),
        }, onError: error => { errors.push(error); },
    });
    try {
        interactions.observe({ method: 'approval/requested', params: { sessionId: 'native', approvalId: 'approval',
            toolCallId: 'call', toolName: 'Bash', rawArgs: '{"command":"touch /tmp/synthetic-fixture"}',
            currentRequirementId: { approvalId: 'approval', sourceIndex: 0 },
            availableChoices: [
                { choiceId: 'allow_once', label: 'Allow', decision: 'approved', scope: 'once' },
                { choiceId: 'policy', label: 'Policy', decision: 'approvedPolicyAmendment', scope: 'localPersistent' },
                { choiceId: 'abort', label: 'Abort', decision: 'abort', scope: 'once' },
            ],
        } });
        const requestId = buildRunScopedExecutionPermissionRequestId({ runId: 'run', controllerOccurrenceId: 'occurrence', providerRequestId: 'call' });
        if (outcome !== 'policy-denied' && outcome !== 'ceiling-denied') {
            await vi.waitFor(() => expect(state.requests?.[requestId]?.nativeChoices).toBeDefined());
            const choice = outcome === 'approved' ? 'allow_once' : 'abort';
            if (outcome === 'native-observed') {
                interactions.observe({ method: 'approval/resolved', params: { approvalId: 'approval', decision: 'denied' } });
                await vi.waitFor(() => expect(state.completedRequests?.[requestId]).toMatchObject({ decision: 'denied' }));
                await new Promise<void>(resolve => setImmediate(resolve));
                expect(command).not.toHaveBeenCalled();
                return;
            }
            await scope.respondToPermissionRequest('call', { decision: outcome,
                nativeChoice: { requirementId: state.requests![requestId]!.nativeChoices!.requirementId, choiceId: choice } });
        }
        await vi.waitFor(() => expect(command).toHaveBeenCalledOnce());
        if (outcome === 'policy-denied' || outcome === 'ceiling-denied') expect(state.requests?.[requestId]).toBeUndefined();
        expect(command).toHaveBeenCalledWith('approval/decide', {
            sessionId: 'native', approvalId: 'approval', requirementId: { approvalId: 'approval', sourceIndex: 0 },
            choiceId: outcome === 'approved' ? 'allow_once' : 'abort',
        }, { signal: expect.any(AbortSignal) });
        expect(errors).toEqual([]);
    } finally { interactions.dispose(); await scope.dispose('test cleanup'); }
});
