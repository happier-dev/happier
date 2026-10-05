import { describe, expect, it, vi } from 'vitest';

import {
    ActionsSettingsV1Schema,
    createActionExecutor,
    DEFAULT_ACTIONS_SETTINGS_V1,
    isApprovalRequiredByActionsSettings,
    type ActionExecutorContext,
    type ActionExecutorDeps,
    type ActionsSettingsV1,
    type RuntimeActionExecute,
} from '@happier-dev/protocol';

import { createFrontDoorRuntimeActionExecutor } from './frontDoorRuntimeActionExecutor';
import { createVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleController';
import { registerVoiceAdapters, resetVoiceAdapterRegistryForTests } from '@/voice/session/voiceAdapterRegistry';
import type { VoiceAdapterController, VoiceSessionSnapshot } from '@/voice/session/types';
import { getVoiceSessionEndedAttempt, resetVoiceSessionStoreForTests, setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';

/**
 * End-to-end proof (FINALIZATION-PLAN §3.4 / §4.2 / §12.8): once a runtime action is routed
 * through the single front door (`createFrontDoorRuntimeActionExecutor` → `ActionExecutor.execute`)
 * the surface-keyed approval policy and the per-surface enablement gate both take effect.
 *
 * This wires the REAL protocol `createActionExecutor` and the REAL approval policy
 * (`isApprovalRequiredByActionsSettings`) exactly as the production `defaultActionExecutor` does.
 * Only system boundaries are stubbed: the runtime-action leaf (RPC) and the approvals store.
 * Assertions are on OUTCOMES.
 *
 * Phase 3.2 (now landed) flipped `RUNTIME_ACTION_DISABLED_SURFACES` per-family for the real
 * executors, so the agent-initiated dangerous subset (e.g. `localServices.publicPreview.create`)
 * now passes the ENABLEMENT gate on `agent` and REACHES the surface-keyed approval floor
 * (finding #31 fixed). The tests below pin the activated end-to-end behavior: user-initiated runs
 * with no prompt; agent-initiated is gated behind approval (rejected → leaf never runs; approved →
 * leaf runs).
 */

const EMPTY_SETTINGS: ActionsSettingsV1 = DEFAULT_ACTIONS_SETTINGS_V1;

// A local-services action in the agent-initiated approval-required set. It is surfaced-on for
// `ui` today (so user-initiated execution is observable) and surface-off for `agent`.
const APPROVAL_ACTION_ID = 'localServices.publicPreview.create' as const;
const VALID_INPUT = {
    machineId: 'm1',
    sessionId: 's1',
    previewId: 'p1',
    mode: 'secret_link',
    ttlMs: 600_000,
} as const;
const VALID_OUTPUT = {
    protocolVersion: 1,
    exposure: {
        exposureId: 'public-preview-1',
        previewId: 'p1',
        sessionId: 's1',
        machineId: 'm1',
        mode: 'secret_link',
        state: 'active',
        publicUrl: 'https://preview.example.test/s/public-preview-1',
        issuedAt: 1_000,
        expiresAt: 601_000,
        auditEventIds: [],
        rateLimitProfileId: 'default',
    },
} as const;

const EXECUTION_CONTEXT = {
    serverId: 'home-1',
    actionRequestId: 'action-request-1',
} as const;

function unsupported(): never {
    throw new Error('unexpected executor dependency invocation');
}

/**
 * Builds the real protocol executor with the production approval wiring. Required deps are filled
 * with rejecting stubs (only the relevant boundaries — runtime leaf + approvals create — are
 * provided per test). The executor's enablement + approval routing logic is exercised for real.
 */
function createTestExecutor(overrides: Partial<ActionExecutorDeps>) {
    const baseDeps = {
        executionRunStart: unsupported,
        executionRunList: unsupported,
        executionRunGet: unsupported,
        detachedExecutionRunSend: unsupported,
        executionRunStop: unsupported,
        executionRunAction: unsupported,
        executionRunWait: unsupported,
        sessionOpen: unsupported,
        sessionFork: unsupported,
        sessionRollback: unsupported,
        sessionSpawnNew: unsupported,
        pathsListRecent: unsupported,
        machinesList: unsupported,
        serversList: unsupported,
        reviewEnginesList: unsupported,
        agentsBackendsList: unsupported,
        agentsModelsList: unsupported,
        sessionSendMessage: unsupported,
        sessionPermissionRespond: unsupported,
        sessionUserActionAnswer: unsupported,
        sessionTargetPrimarySet: unsupported,
        sessionTargetTrackedSet: unsupported,
        sessionList: unsupported,
        sessionActivityGet: unsupported,
        sessionRecentMessagesGet: unsupported,
        daemonMemorySearch: unsupported,
        daemonMemoryGetWindow: unsupported,
        daemonMemoryEnsureUpToDate: unsupported,
        resetGlobalVoiceAgent: () => {},
        // Production wiring (defaultActionExecutor.ts): approval decided by the persisted/
        // surface-keyed ActionsSettings policy.
        isActionApprovalRequired: (
            actionId: Parameters<NonNullable<ActionExecutorDeps['isActionApprovalRequired']>>[0],
            ctx: ActionExecutorContext,
        ) =>
            isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, ctx),
        // Durable replay is permitted only after the host revalidates the immutable origin.
        isApprovalExecutionOriginCurrent: async () => true,
        ...overrides,
    } as unknown as ActionExecutorDeps;
    return createActionExecutor(baseDeps);
}

describe('front door approval default (agent vs ui)', () => {
    it('keeps a permission pending after a spoken decision and Voice End, then admits its present-user tap once', async () => {
        let pending = true;
        let permissionWrites = 0;
        const executor = createTestExecutor({
            // The permission RPC is a genuine process boundary. Its pending state
            // changes only when the real executor admits the present-user call.
            sessionPermissionRespond: async () => {
                permissionWrites += 1;
                pending = false;
                return { ok: true };
            },
        });
        const request = { sessionId: 'coding-session', requestId: 'permission', turnId: 'turn', decision: 'allow' } as const;
        const spoken = await executor.execute('session.permission.respond', request, { surface: 'voice' });
        expect(spoken.ok).toBe(false);
        expect(pending).toBe(true);

        let snapshot: VoiceSessionSnapshot = { adapterId: 'provider-boundary', sessionId: null,
            status: 'disconnected', mode: 'idle', canStop: false };
        const listeners = new Set<() => void>();
        // Only the provider/media boundary is synthetic. Registry and local End
        // admission/cleanup beneath the canonical lifecycle owner remain real.
        const adapter: VoiceAdapterController = { id: 'provider-boundary', engineKind: 'realtime',
            start: async ({ sessionId }) => {
                snapshot = { ...snapshot, sessionId, status: 'connected', mode: 'listening', canStop: true };
                for (const listener of listeners) listener();
            }, toggle: async () => {}, interrupt: async () => {}, setMuted: async () => {},
            sendContextUpdate: () => {}, getSnapshot: () => snapshot,
            subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            stop: async () => {
                snapshot = { ...snapshot, status: 'disconnected', mode: 'idle', canStop: false };
                for (const listener of listeners) listener();
            } };
        registerVoiceAdapters([adapter]);
        const lifecycle = createVoiceSessionLifecycleController();
        const conversationSessionAddress = { serverId: 'home-a', sessionId: 'voice-conversation' };
        const continuation = { v: 1 as const, deviceId: 'other-device', deviceDisplayName: 'Alice’s phone', conversation: conversationSessionAddress };
        const publish = () => setVoiceSessionSnapshot(lifecycle.getSnapshot(), {
            adapterId: adapter.id, controlSessionId: 'voice-control', conversationSessionId: conversationSessionAddress.sessionId,
            conversationSessionAddress, targetSessionAddress: null, transcriptMode: 'synthetic', updatedAt: 1,
        });
        publish();
        const unsubscribe = lifecycle.subscribe(publish);
        try {
            lifecycle.setConfiguredProviderId(adapter.id);
            await lifecycle.toggle({ serverId: 'home-a', sessionId: 'voice-control' });
            expect(lifecycle.getSnapshot()).toMatchObject({ sessionId: 'voice-control', canStop: true });
            await lifecycle.stop('voice-control', { kind: 'continued_elsewhere', continuation });
            expect(lifecycle.getSnapshot().canStop).toBe(false);
            expect(getVoiceSessionEndedAttempt()).toMatchObject({
                reason: { kind: 'continued_elsewhere', continuation }, conversationSessionAddress, targetSessionAddress: null,
            });
            expect(pending).toBe(true);
            expect(permissionWrites).toBe(0);
            const tapped = await executor.execute('session.permission.respond', request, { surface: 'ui', authority: 'present_user' });
            expect(tapped).toEqual({ ok: true, result: { ok: true } });
            expect(pending).toBe(false);
            expect(permissionWrites).toBe(1);
        } finally {
            unsubscribe();
            await lifecycle.dispose();
            resetVoiceAdapterRegistryForTests();
            resetVoiceSessionStoreForTests();
        }
    });
    it('classifies the agent-initiated dangerous subset as approval-required and user forms as not (policy contract)', () => {
        // The surface-keyed default that the front door consults. This is the contract Phase 3.2
        // activates end-to-end once the runtime family is surfaced-on for `agent`.
        expect(
            isApprovalRequiredByActionsSettings(APPROVAL_ACTION_ID, EMPTY_SETTINGS, { surface: 'agent' }),
        ).toBe(true);
        expect(
            isApprovalRequiredByActionsSettings(APPROVAL_ACTION_ID, EMPTY_SETTINGS, {
                surface: 'ui',
                authority: 'present_user',
            }),
        ).toBe(false);
    });

    it('executes a user-initiated (ui) dispatch directly through the front door — no approval prompt', async () => {
        const runtimeLeaf = vi.fn<RuntimeActionExecute>(async () => VALID_OUTPUT);
        const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval_unused' }));
        const executor = createTestExecutor({
            runtimeActionExecute: runtimeLeaf,
            approvalsCreate,
        });
        const bridge = createFrontDoorRuntimeActionExecutor(executor);

        const result = await bridge({
            actionId: APPROVAL_ACTION_ID,
            input: VALID_INPUT,
            context: { surface: 'ui', authority: 'present_user', ...EXECUTION_CONTEXT },
        });

        // OUTCOME: user-initiated invocation runs straight through to the runtime leaf, never the
        // approvals store; the unwrapped runtime payload is returned to the caller.
        expect(approvalsCreate).not.toHaveBeenCalled();
        expect(runtimeLeaf).toHaveBeenCalledTimes(1);
        expect(runtimeLeaf).toHaveBeenCalledWith(expect.objectContaining({
            actionId: APPROVAL_ACTION_ID,
            input: expect.objectContaining(VALID_INPUT),
            context: expect.objectContaining({ surface: 'ui' }),
        }));
        expect(result).toEqual(VALID_OUTPUT);
    });

    it('returns exact deferred custody when present-user UI policy requires approval', async () => {
        // A mounted UI cannot retain this invocation as a blocking waiter. Its
        // operation-specific ActionApprovalContinuation follows the Artifact and
        // consumes the eventual typed result, while Agent/CLI blocking callers
        // keep the Action row's ordinary flow.
        const settingsRequiringUiApproval: ActionsSettingsV1 = ActionsSettingsV1Schema.parse({
            ...DEFAULT_ACTIONS_SETTINGS_V1,
            actions: {
                ...DEFAULT_ACTIONS_SETTINGS_V1.actions,
                [APPROVAL_ACTION_ID]: { approvalRequiredSurfaces: ['ui'] },
            },
        });
        const runtimeLeaf = vi.fn<RuntimeActionExecute>(async () => VALID_OUTPUT);
        const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval_2' }));
        const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
        const approvalsWaitForDecision = vi.fn(async () => {
            throw new Error('present-user UI must return custody instead of blocking');
        });
        const executor = createTestExecutor({
            runtimeActionExecute: runtimeLeaf,
            approvalsCreate,
            approvalsUpdate,
            approvalsWaitForDecision,
            isActionApprovalRequired: (actionId, ctx: ActionExecutorContext) =>
                isApprovalRequiredByActionsSettings(actionId, settingsRequiringUiApproval, ctx),
        });
        const bridge = createFrontDoorRuntimeActionExecutor(executor);

        const result = await bridge({
            actionId: APPROVAL_ACTION_ID,
            input: VALID_INPUT,
            context: { surface: 'ui', authority: 'present_user', ...EXECUTION_CONTEXT },
        });

        // OUTCOME: the action is gated and its mounted screen receives the
        // Artifact identity it must register. It never redispatches the mutation.
        expect(approvalsCreate).toHaveBeenCalledTimes(1);
        expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({ actionId: APPROVAL_ACTION_ID, status: 'open' }),
        }));
        expect(approvalsWaitForDecision).not.toHaveBeenCalled();
        expect(approvalsUpdate).not.toHaveBeenCalled();
        expect(runtimeLeaf).not.toHaveBeenCalled();
        expect(result).toEqual({
            kind: 'approval_request_created',
            artifactId: 'approval_2',
            actionId: APPROVAL_ACTION_ID,
        });
    });

    it('routes an agent-initiated (agent) dispatch through the approval gate — Phase 3.2 flip active', async () => {
        // Phase 3.2 flipped `localServices.publicPreview.*` ON for `agent`, so the agent
        // dispatch now passes the enablement gate and REACHES the surface-keyed approval floor
        // (it no longer short-circuits to `action_disabled`). `publicPreview.create` is in
        // RESULT_REQUIRED → a `blocking` flow; we reject the request to prove the leaf is gated.
        const runtimeLeaf = vi.fn<RuntimeActionExecute>(async () => VALID_OUTPUT);
        const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval_1' }));
        const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
        const approvalsWaitForDecision: NonNullable<ActionExecutorDeps['approvalsWaitForDecision']> = vi.fn(async (args) => ({
            decision: 'reject' as const,
            request: {
                ...args.request,
                status: 'rejected' as const,
                decision: { kind: 'reject' as const, decidedAtMs: 2 },
            },
        }));
        const executor = createTestExecutor({
            runtimeActionExecute: runtimeLeaf,
            approvalsCreate,
            approvalsUpdate,
            approvalsWaitForDecision,
        });
        const bridge = createFrontDoorRuntimeActionExecutor(executor);

        const result = await bridge({
            actionId: APPROVAL_ACTION_ID,
            input: VALID_INPUT,
            context: { surface: 'agent', ...EXECUTION_CONTEXT },
        });

        // OUTCOME: the agent dispatch reached the APPROVAL gate (request created), and the leaf was
        // gated behind it — rejected → leaf never runs. This is the §3.2-activated §3.4 behavior.
        expect(approvalsCreate).toHaveBeenCalledTimes(1);
        expect(approvalsWaitForDecision).toHaveBeenCalledTimes(1);
        expect(runtimeLeaf).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    });

    it('executes the same agent-initiated dispatch once approval is granted', async () => {
        const runtimeLeaf = vi.fn<RuntimeActionExecute>(async () => VALID_OUTPUT);
        const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval_ok' }));
        const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
        const approvalsWaitForDecision: NonNullable<ActionExecutorDeps['approvalsWaitForDecision']> = vi.fn(async (args) => ({
            decision: 'approve' as const,
            request: {
                ...args.request,
                status: 'approved' as const,
                decision: { kind: 'approve' as const, decidedAtMs: 2 },
            },
        }));
        const executor = createTestExecutor({
            runtimeActionExecute: runtimeLeaf,
            approvalsCreate,
            approvalsUpdate,
            approvalsWaitForDecision,
        });
        const bridge = createFrontDoorRuntimeActionExecutor(executor);

        const result = await bridge({
            actionId: APPROVAL_ACTION_ID,
            input: VALID_INPUT,
            context: { surface: 'agent', ...EXECUTION_CONTEXT },
        });

        expect(approvalsCreate).toHaveBeenCalledTimes(1);
        expect(runtimeLeaf).toHaveBeenCalledTimes(1);
        expect(result).toEqual(VALID_OUTPUT);
    });
});
