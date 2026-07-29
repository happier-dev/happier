import { describe, expect, it, vi } from 'vitest';

import {
    ActionsSettingsV1Schema,
    createActionExecutor,
    DEFAULT_ACTIONS_SETTINGS_V1,
    isApprovalRequiredByActionsSettings,
    type ActionExecutorContext,
    type ActionExecutorDeps,
    type ActionsSettingsV1,
    type ApprovalRequestV1,
    type RuntimeActionExecute,
} from '@happier-dev/protocol';

import { createFrontDoorRuntimeActionExecutor } from './frontDoorRuntimeActionExecutor';

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
        executionRunSend: unsupported,
        executionRunStop: unsupported,
        executionRunAction: unsupported,
        executionRunWait: unsupported,
        sessionOpen: unsupported,
        sessionFork: unsupported,
        sessionRollback: unsupported,
        sessionSpawnNew: unsupported,
        sessionSpawnPicker: unsupported,
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
            isApprovalRequiredByActionsSettings(actionId, EMPTY_SETTINGS, { surface: ctx.surface ?? null }),
        ...overrides,
    } as unknown as ActionExecutorDeps;
    return createActionExecutor(baseDeps);
}

describe('front door approval default (agent vs ui)', () => {
    it('classifies the agent-initiated dangerous subset as approval-required and user forms as not (policy contract)', () => {
        // The surface-keyed default that the front door consults. This is the contract Phase 3.2
        // activates end-to-end once the runtime family is surfaced-on for `agent`.
        expect(
            isApprovalRequiredByActionsSettings(APPROVAL_ACTION_ID, EMPTY_SETTINGS, { surface: 'agent' }),
        ).toBe(true);
        expect(
            isApprovalRequiredByActionsSettings(APPROVAL_ACTION_ID, EMPTY_SETTINGS, { surface: 'ui' }),
        ).toBe(false);
    });

    it('executes a user-initiated (ui) dispatch directly through the front door — no approval prompt', async () => {
        const runtimeLeaf = vi.fn<RuntimeActionExecute>(async () => ({ snapshot: { previewId: 'p1' } }));
        const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval_unused' }));
        const executor = createTestExecutor({
            runtimeActionExecute: runtimeLeaf,
            approvalsCreate,
        });
        const bridge = createFrontDoorRuntimeActionExecutor(executor);

        const result = await bridge({
            actionId: APPROVAL_ACTION_ID,
            input: VALID_INPUT,
            context: { surface: 'ui' },
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
        expect(result).toEqual({ snapshot: { previewId: 'p1' } });
    });

    it('routes through approval-then-execute end-to-end when policy requires approval on an enabled surface (routing proof)', async () => {
        // Proves the front door's approval ROUTING works end-to-end (independent of the Phase 3.2
        // surface flip): a persisted `approvalRequiredSurfaces` override on the enabled `ui` surface
        // is honored by `isApprovalRequiredByActionsSettings`, so the executor diverts to approvals
        // FIRST (runtime leaf gated), and only runs the runtime leaf AFTER the request is approved.
        // This is the same mechanism the `agent` default uses once 3.2 enables the family.
        const settingsRequiringUiApproval: ActionsSettingsV1 = ActionsSettingsV1Schema.parse({
            ...DEFAULT_ACTIONS_SETTINGS_V1,
            actions: {
                ...DEFAULT_ACTIONS_SETTINGS_V1.actions,
                [APPROVAL_ACTION_ID]: { approvalRequiredSurfaces: ['ui'] },
            },
        });
        const runtimeLeaf = vi.fn<RuntimeActionExecute>(async () => ({ snapshot: { previewId: 'p1' } }));
        const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval_2' }));
        const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
        // Approve the blocking request: the executor must then run the action through the leaf.
        const approvalsWaitForDecision = vi.fn(async (args: { request: ApprovalRequestV1 }) => ({
            decision: 'approve' as const,
            request: { ...args.request, status: 'approved' as const },
        }));
        const executor = createTestExecutor({
            runtimeActionExecute: runtimeLeaf,
            approvalsCreate,
            approvalsUpdate,
            approvalsWaitForDecision,
            isActionApprovalRequired: (actionId, ctx: ActionExecutorContext) =>
                isApprovalRequiredByActionsSettings(actionId, settingsRequiringUiApproval, { surface: ctx.surface ?? null }),
        });
        const bridge = createFrontDoorRuntimeActionExecutor(executor);

        const result = await bridge({
            actionId: APPROVAL_ACTION_ID,
            input: VALID_INPUT,
            context: { surface: 'ui' },
        });

        // OUTCOME: the action was diverted into the approvals store (gating the leaf) and only
        // executed after approval — proving approval routing precedes execution end-to-end.
        expect(approvalsCreate).toHaveBeenCalledTimes(1);
        expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({ actionId: APPROVAL_ACTION_ID, status: 'open' }),
        }));
        expect(approvalsWaitForDecision).toHaveBeenCalledTimes(1);
        expect(runtimeLeaf).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ snapshot: { previewId: 'p1' } });
    });

    it('routes an agent-initiated (agent) dispatch through the approval gate — Phase 3.2 flip active', async () => {
        // Phase 3.2 flipped `localServices.publicPreview.*` ON for `agent`, so the agent
        // dispatch now passes the enablement gate and REACHES the surface-keyed approval floor
        // (it no longer short-circuits to `action_disabled`). `publicPreview.create` is in
        // RESULT_REQUIRED → a `blocking` flow; we reject the request to prove the leaf is gated.
        const runtimeLeaf = vi.fn<RuntimeActionExecute>(async () => ({ snapshot: { previewId: 'p1' } }));
        const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval_1' }));
        const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
        const approvalsWaitForDecision = vi.fn(async (args: { request: ApprovalRequestV1 }) => ({
            decision: 'reject' as const,
            request: { ...args.request, status: 'rejected' as const },
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
            context: { surface: 'agent' },
        });

        // OUTCOME: the agent dispatch reached the APPROVAL gate (request created), and the leaf was
        // gated behind it — rejected → leaf never runs. This is the §3.2-activated §3.4 behavior.
        expect(approvalsCreate).toHaveBeenCalledTimes(1);
        expect(approvalsWaitForDecision).toHaveBeenCalledTimes(1);
        expect(runtimeLeaf).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
    });

    it('executes the same agent-initiated dispatch once approval is granted', async () => {
        const runtimeLeaf = vi.fn<RuntimeActionExecute>(async () => ({ snapshot: { previewId: 'p1' } }));
        const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval_ok' }));
        const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
        const approvalsWaitForDecision = vi.fn(async (args: { request: ApprovalRequestV1 }) => ({
            decision: 'approve' as const,
            request: { ...args.request, status: 'approved' as const },
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
            context: { surface: 'agent' },
        });

        expect(approvalsCreate).toHaveBeenCalledTimes(1);
        expect(runtimeLeaf).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ snapshot: { previewId: 'p1' } });
    });
});
