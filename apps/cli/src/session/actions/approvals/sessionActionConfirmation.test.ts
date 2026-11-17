import { describe, expect, it, vi } from 'vitest';

import { normalizeActionsSettingsV1, type ActionExecutorDeps } from '@happier-dev/protocol';
import type { AgentState } from '@/api/types';
import { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createScopedRuntimeActionSettingsProvider } from '@/settings/scopedRuntimeActionSettingsProvider';
import { createSessionActionConfirmationAdapter } from './sessionActionConfirmation';

type ConfirmationRequest = Parameters<NonNullable<ActionExecutorDeps['sessionActionConfirmation']>>[0];

function createSessionTransport() {
    let state: AgentState = { requests: {}, completedRequests: {} };
    // Session state persistence/transport is the boundary; request custody and
    // response correlation below use the real store and coordinator.
    const session = {
        sessionId: 's1',
        getAgentStateSnapshot: () => state,
        updateAgentState: (update: (current: AgentState) => AgentState) => {
            state = update(state);
        },
        updateAgentStateRequestSettlement: async (update: (current: AgentState) => AgentState) => {
            state = update(state);
        },
    };
    return { session, store: new AgentStateRequestStore({ session, logPrefix: '[confirmation-test]' }) };
}

describe('Session Action confirmation', () => {
    it('resumes the canonical Action executor only after the exact Session-local approval', async () => {
        const { session, store } = createSessionTransport();
        const lifetime = new AbortController();
        let currentTurn = true;
        const adapter = createSessionActionConfirmationAdapter({
            sessionId: 's1',
            store,
            sessionSignal: new AbortController().signal,
            getAuthenticatedAccountId: async () => 'runtime-account',
        });
        // The effect answers with a valid `session.activity.get` output: the
        // executor validates the Action output boundary after the approval
        // resumes, so an off-contract stub would fail there rather than prove
        // the resume leg this case is about.
        const executeEffect = vi.fn(async () => ({
            ok: true as const,
            sessionId: 's1',
            active: false,
            updatedAt: null,
            pendingCount: 0,
            pendingPermissionRequestCount: 0,
            pendingUserActionRequestCount: 0,
        }));
        // Dependency overrides are the harness's seam: the effect and the
        // confirmation owner are both replaced there rather than smuggled in as
        // executor construction params.
        const { executor } = createCliActionExecutorHarness({
            token: 'restricted-runtime-token',
            sessionId: 's1',
            mode: 'plain',
            ctx: null,
            // The bound Session supplies its live owner metadata; no profile
            // reference means this fixture uses the injected runtime policy.
            getCurrentSessionMetadata: () => ({}),
            actionsSettingsProvider: createScopedRuntimeActionSettingsProvider(normalizeActionsSettingsV1({
                v: 1,
                actions: {
                    'session.activity.get': { approvalRequiredSurfaces: ['agent'] },
                },
            })),
        }, {
            // Blocking Session confirmation belongs to this retained host
            // operation; ordinary durable Agent reads use deferred approval.
            hostActionApprovalLifetime: { operationId: 'session-action-1', signal: lifetime.signal },
            sessionActionConfirmation: async (request) => await adapter.confirm(request, {
                turnId: 'turn-1',
                lifetimeSignal: lifetime.signal,
                isCurrent: () => currentTurn,
            }),
            sessionActivityGet: executeEffect,
        });

        const execution = executor.execute('session.activity.get', { sessionId: 's1' }, {
            surface: 'agent',
            authority: 'account_automation',
            signal: lifetime.signal,
            actionCaller: { kind: 'host' },
            operationAcceptance: { operationId: 'session-action-1', actionId: 'session.activity.get', accept: () => {} },
            defaultSessionId: 's1',
            sessionInputSource: {
                sourceSessionId: 's1',
                sourceTurnId: 'turn-1',
                via: 'action',
            },
        });
        await vi.waitFor(() => expect(store.listOutstandingRequests()).toHaveLength(1));
        expect(executeEffect).not.toHaveBeenCalled();
        const requestId = store.listOutstandingRequests()[0]!.requestId;
        await store.completeRequest({
            requestId,
            status: 'approved',
            decision: 'approved',
            extraCompletedFields: {
                permissionDecisionActorV1: {
                    kind: 'accountUser',
                    accountId: 'approver-account',
                    relationship: 'sharedApprover',
                },
            },
        });

        await expect(execution).resolves.toMatchObject({ ok: true });
        expect(executeEffect).toHaveBeenCalledOnce();

        currentTurn = false;
        expect(session.getAgentStateSnapshot().completedRequests?.[requestId]).toMatchObject({
            status: 'approved',
            permissionDecisionActorV1: {
                accountId: 'approver-account',
                relationship: 'sharedApprover',
            },
        });
        await adapter.dispose();
    });

    it('publishes only the owner-approved preview and cancels the request with its runtime', async () => {
        const { session, store } = createSessionTransport();
        const lifetime = new AbortController();
        const adapter = createSessionActionConfirmationAdapter({
            sessionId: 's1',
            store,
            sessionSignal: new AbortController().signal,
            getAuthenticatedAccountId: async () => 'runtime-account',
        });
        const request: ConfirmationRequest & { preview: unknown } = {
            actionId: 'session.activity.get',
            input: { sessionId: 's1', windowSeconds: 10, privateSentinel: 'ACCOUNT-PRIVATE-INPUT' },
            preview: { sessionId: 's1', windowSeconds: 10 },
            context: { surface: 'agent', authority: 'account_automation', defaultSessionId: 's1', sessionInputSource: { sourceSessionId: 's1', sourceTurnId: 'turn-1', via: 'action' } },
            sessionId: 's1',
        };
        const pending = adapter.confirm(request, {
            turnId: 'turn-1', lifetimeSignal: lifetime.signal, isCurrent: () => true,
            run: { runId: 'run-1', occurrenceId: 'run-1#2', sidechainId: 'sidechain-1' },
        });
        await vi.waitFor(() => expect(store.listOutstandingRequests()).toHaveLength(1));
        const published = JSON.stringify(session.getAgentStateSnapshot());
        const publishedRequest = store.listOutstandingRequests()[0]!;
        const association = {
            sidechainId: publishedRequest.sidechainId,
            responseTarget: publishedRequest.responseTarget,
        };
        lifetime.abort();
        await expect(pending).resolves.toMatchObject({ decision: 'canceled' });
        expect(store.listOutstandingRequests()).toEqual([]);
        expect(published).not.toContain('ACCOUNT-PRIVATE-INPUT');
        expect(published).toContain('windowSeconds');
        expect(association).toMatchObject({
            sidechainId: 'sidechain-1',
            responseTarget: { run: { runId: 'run-1', occurrenceId: 'run-1#2', sidechainId: 'sidechain-1' } },
        });
        await adapter.dispose();
    });

    it('keeps approval bound to its exact runtime turn after the human response', async () => {
        const { store } = createSessionTransport();
        let current = true;
        const adapter = createSessionActionConfirmationAdapter({
            sessionId: 's1', store, sessionSignal: new AbortController().signal,
            getAuthenticatedAccountId: async () => 'runtime-account',
        });
        const binding = {
            turnId: 'turn-1', lifetimeSignal: new AbortController().signal,
            isCurrent: () => current,
        };
        const pending = adapter.confirm({
            actionId: 'session.activity.get', input: { sessionId: 's1' }, preview: { sessionId: 's1' },
            context: { surface: 'agent', authority: 'account_automation', defaultSessionId: 's1', sessionInputSource: { sourceSessionId: 's1', sourceTurnId: 'turn-1', via: 'action' } }, sessionId: 's1',
        }, binding);
        await vi.waitFor(() => expect(store.listOutstandingRequests()).toHaveLength(1));
        await store.completeRequest({ requestId: store.listOutstandingRequests()[0]!.requestId, status: 'approved', decision: 'approved' });
        const confirmation = await pending;
        expect(confirmation?.decision).toBe('approve');
        expect(await confirmation?.isCurrent()).toBe(true);
        current = false;
        expect(await confirmation?.isCurrent()).toBe(false);
        await adapter.dispose();
    });
    it('does not publish an unavailable or different Session binding', async () => {
        const { store } = createSessionTransport();
        const adapter = createSessionActionConfirmationAdapter({
            sessionId: 's1', store, sessionSignal: new AbortController().signal,
            getAuthenticatedAccountId: async () => 'runtime-account',
        });
        const request: ConfirmationRequest = {
            actionId: 'session.activity.get', input: { sessionId: 's1' }, preview: { sessionId: 's1' },
            context: { surface: 'agent', authority: 'account_automation', defaultSessionId: 's1', sessionInputSource: { sourceSessionId: 's1', sourceTurnId: 'turn-1', via: 'action' } }, sessionId: 's1',
        };
        const binding = { turnId: 'turn-1', lifetimeSignal: new AbortController().signal, isCurrent: () => true };
        await expect(adapter.confirm(request, null)).resolves.toMatchObject({ decision: 'canceled' });
        await expect(adapter.confirm(request, { ...binding, isCurrent: () => false })).resolves.toMatchObject({ decision: 'canceled' });
        await expect(adapter.confirm({ ...request, sessionId: 's2' }, binding)).resolves.toMatchObject({ decision: 'canceled' });
        const priorTurn = adapter.confirm({ ...request, context: { ...request.context,
            sessionInputSource: { sourceSessionId: 's1', sourceTurnId: 'prior-turn', via: 'action' },
        } }, binding);
        // Both persistence and Account lookup above are synchronous/in-memory
        // boundaries. Let their microtasks settle before inspecting publication.
        await new Promise<void>((resolve) => setImmediate(resolve));
        const outstanding = store.listOutstandingRequests();
        await adapter.dispose();
        await expect(priorTurn).resolves.toMatchObject({ decision: 'canceled' });
        expect(outstanding).toEqual([]);
    });

    it('retires unrecoverable requests without consuming a new Action continuation', async () => {
        const { session, store } = createSessionTransport();
        store.publishRequest({
            requestId: 'old-action', toolName: 'Happier Action confirmation',
            toolInput: { actionId: 'session.activity.get', preview: { sessionId: 's1' } },
            createdAt: 1, source: 'happier_action', turnId: 'old-turn',
        });
        store.publishRequest({ requestId: 'native', toolName: 'Bash', toolInput: {}, createdAt: 1 });
        const adapter = createSessionActionConfirmationAdapter({
            sessionId: 's1', store, sessionSignal: new AbortController().signal,
            getAuthenticatedAccountId: async () => 'runtime-account',
        });
        await vi.waitFor(() => expect(store.listOutstandingRequests().map((r) => r.requestId)).toEqual(['native']));
        expect(session.getAgentStateSnapshot().completedRequests?.['old-action']).toMatchObject({ status: 'canceled' });
        await adapter.dispose();
        expect(store.listOutstandingRequests().map((r) => r.requestId)).toEqual(['native']);
    });

});
