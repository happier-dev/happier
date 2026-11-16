import { describe, expect, it, vi } from 'vitest';

import { ActionsSettingsV1Schema, type ActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { DEFAULT_ACTIONS_SETTINGS_V1 } from '@happier-dev/protocol/account/settings/accountSettings';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { ApprovalRequestV2Schema, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { applyActionPolicyMutation } from '@happier-dev/protocol/actions/actionAudiencePolicy';
import type { ActionExecutorDeps, RuntimeActionExecute } from '@happier-dev/protocol/actions/executor/types';

import { createFrontDoorRuntimeActionExecutor, createFrontDoorUiActionExecutor } from './frontDoorRuntimeActionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleController';
import { registerVoiceAdapters, resetVoiceAdapterRegistryForTests } from '@/voice/session/voiceAdapterRegistry';
import type { VoiceAdapterController, VoiceSessionSnapshot } from '@/voice/session/types';
import { getVoiceSessionEndedAttempt, resetVoiceSessionStoreForTests, setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import { resolveActionSettingsTargetControlState, resolveActionSettingsTargetPolicyInput } from '@/components/settings/actions/resolveActionSettingsControlState';
import { isActionApprovalRequiredByAccountSettings } from '@/sync/domains/settings/actionsSettings';

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
 * (finding #31 fixed). Dangerous user invocations default to confirmation; an exact completed
 * host confirmation suppresses the duplicate policy prompt. Agent invocations stay gated behind
 * approval (rejected → leaf never runs; approved → leaf runs).
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
    defaultSessionId: 's1',
} as const;

/**
 * Builds the real protocol executor with the production approval wiring. Required deps are filled
 * with rejecting stubs (only the relevant boundaries — runtime leaf + approvals create — are
 * provided per test). The executor's enablement + approval routing logic is exercised for real.
 */
function createTestExecutor(overrides: Partial<ActionExecutorDeps>) {
    const baseDeps = createActionExecutorBoundaryFixture({
        // Production wiring (defaultActionExecutor.ts): approval decided by the persisted/
        // surface-keyed ActionsSettings policy.
        readActionsSettings: () => EMPTY_SETTINGS,
        // Durable replay is permitted only after the host revalidates the immutable origin.
        isApprovalExecutionOriginCurrent: async () => true,
        ...overrides,
    });
    return createActionExecutor(baseDeps);
}

describe('front door approval default (agent vs ui)', () => {
    it('persists Settings Reload choices through the canonical mutation and applies the same host policy (UI-17 / DG8-B-01)', async () => {
        let settings = ActionsSettingsV1Schema.parse({ v: 1 });
        // Runtime transport is the system boundary; the executor and policy stay real.
        const runtimeLeaf = vi.fn<RuntimeActionExecute>(async () => ({ v: 1, status: 'dispatched',
            commandId: 'own-reload', adapterKind: 'localPreview', events: [] }));
        const executor = createTestExecutor({ runtimeActionExecute: runtimeLeaf,
            readActionsSettings: () => settings });
        const input = { browserSessionId: 'mounted-session', viewId: 'mounted-view', kind: 'reload', commandId: 'own-reload' };
        const human = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
        const state = () => resolveActionSettingsTargetControlState({ settings, actionId: 'browser.reload', targetId: 'contextual_ui' });
        const select = (value: 'default' | 'ask_first' | 'allowed') => {
            // The detail screen produces this semantic intent; the canonical Account
            // mutation consumes it. Round-trip the stored bytes before execution.
            const mutationInput = resolveActionSettingsTargetPolicyInput({ settings,
                actionId: 'browser.reload', targetId: 'contextual_ui', value });
            settings = ActionsSettingsV1Schema.parse(JSON.parse(JSON.stringify(applyActionPolicyMutation(settings, mutationInput).settings)));
            return mutationInput;
        };
        expect(state()).toMatchObject({ value: 'default', approvalRequiredByPolicy: false });
        expect(await executor.execute('browser.reload', input, human)).toMatchObject({ ok: true,
            result: { status: 'dispatched', commandId: 'own-reload' } });
        expect(runtimeLeaf).toHaveBeenCalledTimes(1);
        const neighbours = [
            { surface: 'agent', authority: 'account_automation' },
            { surface: 'ui', authority: 'account_automation', actionCaller: { kind: 'host' } },
            { surface: 'plugin', authority: 'account_automation', actionCaller: { kind: 'plugin', pluginId: 'external-plugin' } },
            { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'plugin', pluginId: 'external-plugin' } },
            { surface: 'ui', authority: 'present_user', callerSurface: 'foreign_session_html' },
            {},
        ] as const;
        const assertNeighbourFloors = async () => {
            for (const context of neighbours) {
                expect(isActionApprovalRequiredByAccountSettings('browser.reload', { actionsSettingsV1: settings }, context)).toBe(true);
                expect(await executor.execute('browser.reload', input, context)).toMatchObject({ ok: false });
            }
            for (const targetId of ['agent', 'plugin'] as const) {
                expect(resolveActionSettingsTargetControlState({ settings, actionId: 'browser.reload', targetId }))
                    .toMatchObject({ approvalRequiredByPolicy: true });
            }
        };
        await assertNeighbourFloors();

        expect(select('ask_first')).toMatchObject({ audience: 'ui', mode: 'ask_first' });
        expect(settings.actions['browser.reload']?.approvalRequiredSurfaces).toContain('ui');
        expect(state()).toMatchObject({ value: 'ask_first', approvalRequiredByPolicy: true });
        expect(await executor.execute('browser.reload', input, human)).toMatchObject({ ok: false });
        expect(runtimeLeaf).toHaveBeenCalledTimes(1);

        // Allowed equals the reversible host default: remove Ask instead of retaining
        // a redundant UI waiver, and leave all other audiences' floors unchanged.
        expect(select('allowed')).toMatchObject({ audience: 'ui', mode: 'default' });
        expect(settings.actions['browser.reload']?.approvalRequiredSurfaces ?? []).not.toContain('ui');
        expect(settings.approvalWaivedSurfaces?.['browser.reload'] ?? []).not.toContain('ui');
        expect(state()).toMatchObject({ value: 'default', approvalRequiredByPolicy: false });
        expect(await executor.execute('browser.reload', input, human)).toMatchObject({ ok: true });
        await assertNeighbourFloors();
        expect(select('ask_first')).toMatchObject({ mode: 'ask_first' });
        expect(select('default')).toMatchObject({ mode: 'default' });
        expect(state()).toMatchObject({ value: 'default', approvalRequiredByPolicy: false });
        expect(await executor.execute('browser.reload', input, human)).toMatchObject({ ok: true });
        expect(runtimeLeaf).toHaveBeenCalledTimes(3);
    });

    it('keeps pending custody out of completed-value clients and preserves its typed artifact details', async () => {
        const runtimeLeaf = vi.fn<RuntimeActionExecute>(async () => VALID_OUTPUT);
        const executor = createTestExecutor({
            runtimeActionExecute: runtimeLeaf,
            approvalsCreate: async () => ({ artifactId: 'pending-value-approval' }),
            readActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1, actions: { 'localServices.publicPreview.create': { approvalRequiredSurfaces: ['ui'] } } }),
        });
        const execute = createFrontDoorUiActionExecutor(executor, { serverId: EXECUTION_CONTEXT.serverId });
        await expect(execute(APPROVAL_ACTION_ID, VALID_INPUT, {
            defaultSessionId: EXECUTION_CONTEXT.defaultSessionId,
            actionRequestId: EXECUTION_CONTEXT.actionRequestId,
            presentUserConfirmation: { actionId: APPROVAL_ACTION_ID },
        })).rejects.toMatchObject({ code: 'approval_request_created', details: {
            kind: 'approval_request_created', artifactId: 'pending-value-approval', actionId: APPROVAL_ACTION_ID,
        } });
        expect(runtimeLeaf).not.toHaveBeenCalled();
    });
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
    it('requires the agent danger floor while the person’s own UI uses in-place confirmation', () => {
        // Coordination 2026-11-15 23:05: own-UI consent belongs to the native
        // presenter; it does not create an automation approval Artifact.
        expect(
            isApprovalRequiredByActionsSettings(APPROVAL_ACTION_ID, EMPTY_SETTINGS, { surface: 'agent' }),
        ).toBe(true);
        expect(
            isApprovalRequiredByActionsSettings(APPROVAL_ACTION_ID, EMPTY_SETTINGS, {
                surface: 'ui',
                authority: 'present_user',
                actionCaller: { kind: 'host' },
            }),
        ).toBe(false);
    });

    it('executes an exactly confirmed UI dispatch through the front door without duplicate approval', async () => {
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
            context: { surface: 'ui', authority: 'present_user', ...EXECUTION_CONTEXT,
                presentUserConfirmation: { actionId: APPROVAL_ACTION_ID } },
        });

        // The host already confirmed this exact Action; its invocation reaches
        // the leaf without creating another approval Artifact.
        expect(approvalsCreate).not.toHaveBeenCalled();
        expect(runtimeLeaf).toHaveBeenCalledTimes(1);
        expect(runtimeLeaf).toHaveBeenCalledWith(expect.objectContaining({
            actionId: APPROVAL_ACTION_ID,
            input: expect.objectContaining(VALID_INPUT),
            context: expect.objectContaining({ surface: 'ui' }),
        }));
        expect(result).toEqual(VALID_OUTPUT);
    });

    it.each([true, false])('holds an own-UI Ask in place until confirmation (confirm=%s)', async (confirm) => {
        // Coordination 2026-11-15 23:05: explicit own-UI Ask uses the native
        // presenter. Cancellation settles the original invocation without an effect.
        const settingsRequiringUiApproval = ActionsSettingsV1Schema.parse({
            v: 1, actions: { [APPROVAL_ACTION_ID]: { approvalRequiredSurfaces: ['ui'] } },
        });
        const runtimeLeaf = vi.fn<RuntimeActionExecute>(async () => VALID_OUTPUT);
        const approvalsCreate = vi.fn(async () => ({ artifactId: 'unused-ui-approval' }));
        const approvalsWaitForDecision = vi.fn<NonNullable<ActionExecutorDeps['approvalsWaitForDecision']>>(async () => {
            throw new Error('own UI must use its in-place confirmation');
        });
        let answer: ((confirmed: boolean) => void) | undefined;
        let presented: (() => void) | undefined;
        const presentation = new Promise<void>((resolve) => { presented = resolve; });
        const presentUserActionConfirmation = vi.fn<NonNullable<ActionExecutorDeps['presentUserActionConfirmation']>>(async () => {
            presented!();
            return new Promise<boolean>((resolve) => { answer = resolve; });
        });
        const executor = createTestExecutor({ runtimeActionExecute: runtimeLeaf,
            approvalsCreate, approvalsWaitForDecision, presentUserActionConfirmation,
            readActionsSettings: () => settingsRequiringUiApproval });
        const bridge = createFrontDoorRuntimeActionExecutor(executor);
        const execution = bridge({ actionId: APPROVAL_ACTION_ID, input: VALID_INPUT,
            context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, ...EXECUTION_CONTEXT } });

        await presentation;
        expect(presentUserActionConfirmation).toHaveBeenCalledWith(expect.objectContaining({
            actionId: APPROVAL_ACTION_ID, input: expect.objectContaining(VALID_INPUT),
        }));
        expect(runtimeLeaf).not.toHaveBeenCalled();
        expect(approvalsCreate).not.toHaveBeenCalled();
        answer!(confirm);
        const result = await execution;
        if (confirm) {
            expect(result).toEqual(VALID_OUTPUT);
            expect(runtimeLeaf).toHaveBeenCalledTimes(1);
        } else {
            expect(result).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
            expect(runtimeLeaf).not.toHaveBeenCalled();
        }
        expect(approvalsCreate).not.toHaveBeenCalled();
        expect(approvalsWaitForDecision).not.toHaveBeenCalled();
    });

    it.each(['reject', 'approve'] as const)('returns agent custody before the person decides to %s', async (decision) => {
        const runtimeLeaf = vi.fn<RuntimeActionExecute>(async () => VALID_OUTPUT);
        let stored: ApprovalRequest | null = null;
        // Artifact persistence is the system boundary. Requests, decisions,
        // transitions and replay are produced by the real executor and owners.
        const approvalsCreate = vi.fn<NonNullable<ActionExecutorDeps['approvalsCreate']>>(async ({ request }) => {
            stored = ApprovalRequestV2Schema.parse(request);
            return { artifactId: 'agent-approval' };
        });
        const approvalsWaitForDecision = vi.fn<NonNullable<ActionExecutorDeps['approvalsWaitForDecision']>>(async () => {
            throw new Error('durable agent input must return Artifact custody');
        });
        const executor = createTestExecutor({ runtimeActionExecute: runtimeLeaf,
            approvalsCreate, approvalsWaitForDecision,
            approvalsGet: async () => stored,
            approvalsUpdate: async ({ request, expectedStatus }) => {
                if (!stored) throw new Error('Missing approval request');
                const next = ApprovalRequestV2Schema.parse(request);
                const transition = decideApprovalRequestTransition(stored, next, { expectedStatus });
                if (!transition.ok) return transition;
                stored = next;
                return { ok: true };
            },
        });
        const bridge = createFrontDoorRuntimeActionExecutor(executor);
        const result = await bridge({ actionId: APPROVAL_ACTION_ID, input: VALID_INPUT,
            context: { surface: 'agent', authority: 'account_automation', ...EXECUTION_CONTEXT } });

        expect(result).toEqual({ kind: 'approval_request_created', artifactId: 'agent-approval', actionId: APPROVAL_ACTION_ID });
        expect(stored).toMatchObject({ actionId: APPROVAL_ACTION_ID, status: 'open' });
        expect(approvalsCreate).toHaveBeenCalledTimes(1);
        expect(approvalsWaitForDecision).not.toHaveBeenCalled();
        expect(runtimeLeaf).not.toHaveBeenCalled();

        const decided = await executor.execute('approval.request.decide', { artifactId: 'agent-approval', decision },
            { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: EXECUTION_CONTEXT.serverId });
        if (decision === 'approve') {
            expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: 'executed',
                execution: { ok: true, result: VALID_OUTPUT } } });
            expect(stored).toMatchObject({ status: 'executed', decision: { kind: 'approve' } });
            expect(runtimeLeaf).toHaveBeenCalledTimes(1);
        } else {
            expect(decided).toMatchObject({ ok: true, result: { status: 'rejected' } });
            expect(stored).toMatchObject({ status: 'rejected', decision: { kind: 'reject' } });
            expect(runtimeLeaf).not.toHaveBeenCalled();
        }
    });
});
