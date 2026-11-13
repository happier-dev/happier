import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

import {
    createSessionInputFailureError,
    getPendingMessageVisualState,
    canUseDirectPendingDeliveryActions,
    getSessionInputFailureLabelKey,
    pendingMessageStatesBlockedReason,
    resolvePendingMessagesPresentation,
    resolveSessionDeliveryFailure,
    type PendingMessageVisualStateKind,
} from './pendingMessageVisualState';
import { buildSessionHostOnboardingInputV1 } from '@happier-dev/protocol/sessions';
import { SESSION_INPUT_REQUEST_META_KEY, SESSION_MESSAGE_PROVENANCE_META_KEY } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

function pendingMessage(overrides: Partial<PendingMessage> = {}): PendingMessage {
    return {
        id: 'p1',
        localId: 'p1',
        createdAt: 0,
        updatedAt: 0,
        source: 'server_pending',
        text: 'hello',
        rawRecord: {},
        ...overrides,
    };
}

describe('getPendingMessageVisualState', () => {
    it('resolves a split queue once and reads only each visible record when deriving its row presentation', () => {
        let recordReads = 0;
        const messages = Array.from({ length: 24 }, (_, index) => {
            const message = pendingMessage({ id: `pending-${index}`, localId: `local-${index}`, pendingDeliveryStatus: index === 0 ? 'blocked' : 'server_queued' });
            Object.defineProperty(message, 'rawRecord', { get: () => { recordReads += 1; return {}; } });
            return message;
        });
        const queueContext = resolvePendingMessagesPresentation(messages);
        const initialReads = recordReads;
        for (const message of messages) {
            const row = resolvePendingMessagesPresentation(messages, {
                visibleMessageIds: new Set([message.id]), queueContext,
            });
            expect(row.shownRows.map((entry) => entry.message.id)).toEqual([message.id]);
        }
        // The projection's complete result is reused by row hosts and measurement; splitting it
        // must not repeat metadata parsing or queue grouping for every anchored retry row.
        expect(initialReads).toBeGreaterThan(0);
        expect(recordReads - initialReads).toBe(0);
    });
    it('leaves a failed start to the Session start-failure banner: no starting spinner and no second cause on the row', () => {
        const session = { activeAt: 0, active: false, pendingActivationAuthorization: undefined, pendingActivationFailureDetails: undefined,
            lastRuntimeIssue: { v: 1 as const, scope: 'primary_session' as const, status: 'failed' as const,
                code: 'agent_isolation_unavailable', source: 'dependency_failure' as const, occurredAt: 1 } };
        for (const pendingLaunch of [{ state: 'starting' as const },
            { state: 'failed' as const, message: 'Couldn’t start the session. (Error spawn_failed)', draftId: 'draft-1' }]) {
            const state = getPendingMessageVisualState(pendingMessage({ source: 'local_outbound', pendingLaunch }), { session });
            expect(state).toEqual({ kind: 'launch_failed', showSpinner: false, iconName: 'warning-circle' });
            expect(pendingMessageStatesBlockedReason(state)).toBe(false);
        }
    });
    it('paints a launch-owned first message as starting, then as a launch refusal with its typed reason', () => {
        const starting = pendingMessage({ source: 'local_outbound', pendingLaunch: { state: 'starting' } });
        expect(getPendingMessageVisualState(starting)).toEqual({ kind: 'starting', showSpinner: true, iconName: 'cloud-arrow-up' });
        const failed = pendingMessage({ source: 'local_outbound',
            pendingLaunch: { state: 'failed', message: 'The model is not available.', draftId: 'draft-1' } });
        const failedState = getPendingMessageVisualState(failed);
        expect(failedState).toMatchObject({ kind: 'launch_failed', showSpinner: false,
            deliveryBlockedPresentation: { labelKey: 'session.pendingMessages.deliveryStatus.notStarted', message: 'The model is not available.' } });
        expect(pendingMessageStatesBlockedReason(failedState)).toBe(true);
        // A terminal wait that ended without an outcome never keeps spinning as "starting".
        const unresolvedState = getPendingMessageVisualState(pendingMessage({ source: 'local_outbound', pendingLaunch: { state: 'unresolved' } }));
        // One voice: the row's status line says the outcome is unknown; no second notice repeats it.
        expect(unresolvedState).toEqual({ kind: 'launch_unresolved', showSpinner: false, iconName: 'warning-circle' });
        expect(pendingMessageStatesBlockedReason(unresolvedState)).toBe(false);
        // A launch-owned row is never the composer's direct send/steer target, whatever its delivery status.
        expect(canUseDirectPendingDeliveryActions({ ...starting, source: undefined })).toBe(false);
        expect(canUseDirectPendingDeliveryActions({ ...failed, source: undefined })).toBe(false);
    });
    it('keeps check-in holds and muted input distinct from unknown delivery failures', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            pendingDeliveryStatus: 'blocked', pendingDeliveryBlockedReason: 'autonomous_check_in',
        }))).toMatchObject({ kind: 'blocked', showSpinner: false,
            deliveryBlockedPresentation: { labelKey: 'settingsCoordination.checkInPaused', isUnknown: false } });
        expect(getSessionInputFailureLabelKey(createSessionInputFailureError('session_input_muted')))
            .toBe('settingsCoordination.inputMuted');
    });
    it('treats server accepted rows as queued, not actively processing', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            source: 'server_pending',
            deliveryStatus: 'accepted',
        }))).toEqual({
            kind: 'queued',
            showSpinner: false,
            iconName: 'clock',
            queuedRequestedAction: 'enqueue',
        });
    });

    it.each([
        ['enqueue', 'enqueue'],
        ['steer_if_active', 'steer_if_active'],
        ['steer_now', 'steer_now'],
        ['send_now', 'send_now'],
    ] as const)('keeps queued %s intent visible in the canonical visual state', (requestedAction, queuedRequestedAction) => {
        expect(getPendingMessageVisualState(pendingMessage({
            pendingRequestedAction: { v: 1, kind: requestedAction },
        }))).toMatchObject({
            kind: 'queued',
            queuedRequestedAction,
        });
    });

    it('surfaces malformed queued requested actions as an unsupported action reason', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            pendingRequestedActionMalformed: true,
        }))).toMatchObject({
            kind: 'queued',
            queuedReason: 'unsupported_action',
        });
    });

    it.each([
        [{ runtimeReachable: false }, 'waiting_for_runtime'],
        [{ runtimeReachable: true, hasEarlierRow: true, foregroundState: 'ready' }, 'waiting_for_predecessor'],
        [{ runtimeReachable: true, hasEarlierRow: true, hasBlockedEarlierRow: true, foregroundState: 'ready' }, 'waiting_for_blocked_predecessor'],
        [{ runtimeReachable: true, foregroundState: 'active_unsteerable' }, 'waiting_for_foreground_turn'],
        [{ runtimeReachable: true, foregroundState: 'ready', deliveryTiming: 'after_runtime_idle', runtimeActivity: 'active' }, 'waiting_for_runtime_activity'],
        [{ runtimeReachable: true, foregroundState: 'ready', deliveryTiming: 'after_runtime_idle', runtimeActivity: 'unknown' }, 'runtime_activity_unknown'],
    ] as const)('derives the canonical visible defer reason %s', (options, queuedReason) => {
        expect(getPendingMessageVisualState(pendingMessage({
            pendingRequestedAction: { v: 1, kind: 'enqueue' },
        }), options)).toMatchObject({ kind: 'queued', queuedReason });
    });

    it('lets a head urgent exact action bypass automatic-timing defer reasons', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            pendingRequestedAction: { v: 1, kind: 'send_now' },
        }), {
            runtimeReachable: true,
            foregroundState: 'active_unsteerable',
            deliveryTiming: 'after_runtime_idle',
            runtimeActivity: 'active',
        })).toMatchObject({ kind: 'queued', queuedRequestedAction: 'send_now' });
        expect(getPendingMessageVisualState(pendingMessage({
            pendingRequestedAction: { v: 1, kind: 'send_now' },
        }), {
            runtimeReachable: true,
            foregroundState: 'active_unsteerable',
            deliveryTiming: 'after_runtime_idle',
            runtimeActivity: 'active',
        })).not.toHaveProperty('queuedReason');
    });

    it('lets an urgent exact action outrank an earlier ordinary or blocked row', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            pendingRequestedAction: { v: 1, kind: 'send_now' },
        }), {
            runtimeReachable: true,
            hasEarlierRow: true,
            foregroundState: 'active_unsteerable',
        })).toMatchObject({ kind: 'queued', queuedRequestedAction: 'send_now' });
        expect(getPendingMessageVisualState(pendingMessage({
            pendingRequestedAction: { v: 1, kind: 'send_now' },
        }), {
            runtimeReachable: true,
            hasEarlierRow: true,
            foregroundState: 'active_unsteerable',
        })).not.toHaveProperty('queuedReason');
    });

    it('keeps an urgent exact action serialized behind an earlier provider-custody claim', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            pendingRequestedAction: { v: 1, kind: 'send_now' },
        }), {
            runtimeReachable: true,
            hasEarlierRow: true,
            hasProviderDeliveryInFlight: true,
            foregroundState: 'active_unsteerable',
        })).toMatchObject({
            kind: 'queued',
            queuedRequestedAction: 'send_now',
            queuedReason: 'waiting_for_predecessor',
        });
    });

    it('shows saving only for local outbound rows that are not yet accepted', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            source: 'local_outbound',
            deliveryStatus: 'queued',
        }))).toEqual({
            kind: 'saving',
            showSpinner: true,
            iconName: 'cloud-arrow-up',
        });
    });

    it('surfaces unconfirmed and exhausted sends as distinct durable states', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            source: 'local_outbound',
            deliveryStatus: 'queued',
            sendState: 'unconfirmed',
        }))).toMatchObject({ kind: 'send_unconfirmed', showSpinner: true });
        expect(getPendingMessageVisualState(pendingMessage({
            source: 'local_outbound',
            deliveryStatus: 'queued',
            sendState: 'failed',
        }))).toMatchObject({ kind: 'send_failed', showSpinner: false });
    });

    it('lets durable server Pending truth outrank a stale local send failure', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            source: 'server_pending',
            deliveryStatus: 'queued',
            sendState: 'failed',
        }))).toMatchObject({ kind: 'queued' });
    });

    it('keeps cancellation distinct from send retry state', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            source: 'local_outbound',
            deliveryStatus: 'queued',
            pendingOutboxOperation: 'cancel',
        }))).toMatchObject({ kind: 'cancelling', showSpinner: true });
        expect(getPendingMessageVisualState(pendingMessage({
            source: 'local_outbound',
            deliveryStatus: 'queued',
            pendingOutboxOperation: 'cancel',
            sendState: 'failed',
        }))).toMatchObject({ kind: 'cancel_failed', showSpinner: false });
    });

    it('allows the caller to mark the single row currently materializing', () => {
        expect(getPendingMessageVisualState(pendingMessage({ id: 'p2', localId: 'p2' }), {
            materializingLocalIds: new Set(['p2']),
        })).toEqual({
            kind: 'materializing',
            showSpinner: true,
            iconName: 'navigation-arrow',
        });
    });

    it('treats server-delivering rows as delivery-owned work', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            pendingDeliveryStatus: 'server_delivering',
        }))).toEqual({
            kind: 'delivering',
            showSpinner: true,
            iconName: 'navigation-arrow',
            deliveryMutationPolicy: 'effect_possible',
        });
    });

    it('keeps retained external handoffs visible without implying active provider delivery', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            pendingDeliveryStatus: 'external_handoff',
        }))).toEqual({
            kind: 'delivering',
            showSpinner: false,
            iconName: 'navigation-arrow',
            deliveryMutationPolicy: 'effect_possible',
        });
    });

    it('attaches reason-specific presentation for blocked rows', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'provider_unavailable_before_acceptance',
        }))).toEqual({
            kind: 'blocked',
            showSpinner: false,
            iconName: 'warning-circle',
            deliveryBlockedPresentation: {
                labelKey: 'session.pendingMessages.deliveryBlockedReasons.providerUnavailableBeforeAcceptance',
                isUnknown: false,
            },
        });

        expect(getPendingMessageVisualState(pendingMessage({
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'session_input_target_unavailable',
        }))).toEqual({
            kind: 'blocked',
            showSpinner: false,
            iconName: 'warning-circle',
            deliveryBlockedPresentation: {
                labelKey: 'session.pendingMessages.deliveryBlockedReasons.targetUnavailable',
                isUnknown: false,
            },
        });

        expect(getPendingMessageVisualState(pendingMessage({
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'conditional_steer_unavailable',
        }))).toEqual({
            kind: 'blocked',
            showSpinner: false,
            iconName: 'warning-circle',
            deliveryBlockedPresentation: {
                labelKey: 'session.pendingMessages.deliveryBlockedReasons.unknown',
                isUnknown: false,
            },
        });
    });

    it.each([
        'ambiguous_terminal_delivery',
        'delivery_outcome_uncertain',
        'team_access_removed',
        'unknown',
    ] as const)('fails closed for effect-possible blocked reason %s', (pendingDeliveryBlockedReason) => {
        expect(getPendingMessageVisualState(pendingMessage({
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason,
        }))).toMatchObject({
            kind: 'blocked',
            deliveryMutationPolicy: 'effect_possible',
        });
    });

    it('presents runtime-config and capture-style blockers as known blocked states', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'runtime_config_blocked',
        }))).toMatchObject({
            kind: 'blocked',
            deliveryBlockedPresentation: {
                labelKey: 'session.pendingMessages.deliveryBlockedReasons.runtimeConfigBlocked',
                isUnknown: false,
            },
        });

        expect(getPendingMessageVisualState(pendingMessage({
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'capture_style_unavailable',
        }))).toMatchObject({
            kind: 'blocked',
            deliveryBlockedPresentation: {
                labelKey: 'session.pendingMessages.deliveryBlockedReasons.captureStyleUnavailable',
                isUnknown: false,
            },
        });
    });

    it('gives an untyped runtime-config block one Session-level message without inventing account recovery', () => {
        const blocked = pendingMessage({ pendingDeliveryStatus: 'blocked', pendingDeliveryBlockedReason: 'runtime_config_blocked' });
        // The row defers: its reason belongs to the Session's account, said once with its next action.
        expect(getPendingMessageVisualState(blocked).deliveryBlockedPresentation?.recovery).toBe('choose_account');
        expect(pendingMessageStatesBlockedReason(getPendingMessageVisualState(blocked))).toBe(false);
        const failure = resolveSessionDeliveryFailure([pendingMessage({ id: 'q', localId: 'q' }), blocked], null, false);
        expect(failure?.recovery).toBeNull();
        expect(failure?.message).toBe(t('session.pendingMessages.deliveryBlockedReasons.runtimeConfigBlocked'));
        // Removed machine access has no account to choose; other blockers stay on their row.
        expect(resolveSessionDeliveryFailure([blocked], null, true)).toBeNull();
        expect(resolveSessionDeliveryFailure([{ ...blocked, pendingDeliveryBlockedReason: 'payload_too_large' }], null, false)).toBeNull();
        expect(resolveSessionDeliveryFailure([pendingMessage()], null, false)).toBeNull();
    });

    it('presents removed machine access for a runtime-config block and retracts it when access returns', () => {
        const message = pendingMessage({
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'runtime_config_blocked',
        });
        expect(getPendingMessageVisualState(message, { machineAccessRemoved: true })).toMatchObject({
            kind: 'blocked',
            deliveryBlockedPresentation: {
                message: t('machineRequester.accessRemoved', { machine: t('common.machine') }),
                isUnknown: false,
            },
        });
        expect(getPendingMessageVisualState(message, { machineAccessRemoved: false }).deliveryBlockedPresentation)
            .not.toHaveProperty('message');
        expect(getPendingMessageVisualState({ ...message, pendingDeliveryBlockedReason: 'terminal_composer_draft' }, {
            machineAccessRemoved: true,
        }).deliveryBlockedPresentation).toEqual({
            labelKey: 'session.pendingMessages.deliveryBlockedReasons.terminalComposerDraft',
            isUnknown: false,
        });
    });

    it('marks unknown raw delivery states as unknown blocked presentation', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'unknown',
            pendingDeliveryBlockedReasonRaw: 'newer_runtime_reason',
        }))).toEqual({
            kind: 'blocked',
            showSpinner: false,
            iconName: 'warning-circle',
            deliveryBlockedPresentation: {
                labelKey: 'session.pendingMessages.deliveryBlockedReasons.unknown',
                isUnknown: true,
            },
            deliveryMutationPolicy: 'effect_possible',
        });
    });

    it('keeps transcript components from branching on raw pending delivery status fields', () => {
        const source = readFileSync(resolve(__dirname, 'PendingMessagesTranscriptBlock.tsx'), 'utf8');

        expect(source).not.toContain('getPendingDeliveryBlockedReasonPresentation');
        expect(source).not.toMatch(/message\.pendingDeliveryStatus(?:Raw)?/);
        expect(source).not.toMatch(/pendingDeliveryStatus\s*===/);
    });
});

/**
 * Which rows state their own blocked reason (CALM-1110: one line of meta on the row's status line).
 * Only `blocked` does; a Session-owned block is said once by the Session, never on the row.
 */
describe('pendingMessageStatesBlockedReason', () => {
    const EXPECTED_BY_KIND = {
        saving: false,
        send_unconfirmed: false,
        send_failed: false,
        cancelling: false,
        cancel_failed: false,
        queued: false,
        delivering: false,
        materializing: false,
        blocked: true,
    } as const satisfies Record<PendingMessageVisualStateKind, boolean>;

    const REACHED_BY: Readonly<Record<PendingMessageVisualStateKind, () => PendingMessage>> = {
        saving: () => pendingMessage({ source: 'local_outbound' }),
        send_unconfirmed: () => pendingMessage({ source: 'local_outbound', sendState: 'unconfirmed' }),
        send_failed: () => pendingMessage({ source: 'local_outbound', sendState: 'failed' }),
        cancelling: () => pendingMessage({ source: 'local_outbound', pendingOutboxOperation: 'cancel' }),
        cancel_failed: () => pendingMessage({ source: 'local_outbound', pendingOutboxOperation: 'cancel', sendState: 'failed' }),
        queued: () => pendingMessage({ pendingDeliveryStatus: 'server_queued' }),
        delivering: () => pendingMessage({ pendingDeliveryStatus: 'server_delivering' }),
        materializing: () => pendingMessage({ pendingDeliveryStatus: 'server_queued' }),
        blocked: () => pendingMessage({
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'terminal_composer_draft',
        }),
    };

    it('classifies every visual state a pending row can reach', () => {
        for (const [kind, expected] of Object.entries(EXPECTED_BY_KIND)) {
            const typedKind = kind as PendingMessageVisualStateKind;
            const visualState = getPendingMessageVisualState(
                REACHED_BY[typedKind](),
                typedKind === 'materializing' ? { materializingLocalIds: new Set(['p1']) } : undefined,
            );
            expect(visualState.kind, `fixture for ${kind} drifted`).toBe(typedKind);
            expect(pendingMessageStatesBlockedReason(visualState), kind).toBe(expected);
        }
    });

    it('reads the blocked reason off the presentation the block itself renders', () => {
        // The block states a reason iff `deliveryBlockedPresentation` exists, so a new kind that starts
        // carrying one states it too.
        expect(pendingMessageStatesBlockedReason({
            kind: 'queued',
            showSpinner: false,
            iconName: 'clock',
            deliveryBlockedPresentation: { labelKey: 'session.pendingMessages.deliveryBlockedReasons.unknown', isUnknown: true },
        })).toBe(true);
    });
});

describe('session input failure copy owner', () => {
    it('points a missing admitted runner runtime source to the existing runner restart guidance', () => {
        expect(getSessionInputFailureLabelKey(Object.assign(new Error('private runtime detail'), {
            code: 'RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING',
        }))).toBe('session.staleRunner.banner.body');
    });

    it('gives delivery_outcome_uncertain its own copy instead of the generic needs-review label', () => {
        expect(getPendingMessageVisualState(pendingMessage({
            pendingDeliveryStatus: 'blocked',
            pendingDeliveryBlockedReason: 'delivery_outcome_uncertain',
        })).deliveryBlockedPresentation).toEqual({
            labelKey: 'session.pendingMessages.deliveryBlockedReasons.deliveryOutcomeUncertain',
            isUnknown: false,
        });
    });

    it('resolves a coded admission or Run-launch failure to a translation key and never to the raw code', () => {
        expect(getSessionInputFailureLabelKey(
            Object.assign(new Error('session_input_target_unavailable'), { code: 'session_input_target_unavailable' }),
        )).toBe('session.pendingMessages.admissionRejected.targetUnavailable');
        expect(getSessionInputFailureLabelKey(
            Object.assign(new Error('session_input_target_update_required'), { code: 'session_input_target_update_required' }),
        )).toBe('session.pendingMessages.admissionRejected.targetUpdateRequired');
        expect(getSessionInputFailureLabelKey(createSessionInputFailureError('model_not_granted')))
            .toBe('session.pendingMessages.admissionRejected.modelNotGranted');
        expect(getSessionInputFailureLabelKey(createSessionInputFailureError('permission_mode_not_granted')))
            .toBe('session.pendingMessages.admissionRejected.permissionModeNotGranted');
        expect(getSessionInputFailureLabelKey(createSessionInputFailureError('execution_run_target_changed')))
            .toBe('sessionDrafts.executionRunStart.targetChanged');
        expect(getSessionInputFailureLabelKey(new Error('participant send rejected'))).toBeNull();
        expect(getSessionInputFailureLabelKey(Object.assign(new Error('x'), { code: 'not_a_known_code' }))).toBeNull();
    });
});

describe('pending delivery actions', () => {
    it('allows the queued row and retains custody restrictions', () => {
        expect(canUseDirectPendingDeliveryActions(pendingMessage())).toBe(true);
        expect(canUseDirectPendingDeliveryActions(pendingMessage({ pendingDecryption: { kind: 'loading' } }))).toBe(false);
        expect(canUseDirectPendingDeliveryActions(pendingMessage({ source: 'local_outbound', deliveryStatus: 'queued' }))).toBe(false);
        expect(canUseDirectPendingDeliveryActions(pendingMessage({ pendingOutboxOperation: 'cancel' }))).toBe(false);
        expect(canUseDirectPendingDeliveryActions(pendingMessage({ pendingOutboxOperation: 'enqueue' }))).toBe(false);
        expect(canUseDirectPendingDeliveryActions(pendingMessage({ pendingDecryptFailure: { kind: 'decrypt_failed' } }))).toBe(false);
        expect(canUseDirectPendingDeliveryActions(pendingMessage({ pendingDeliveryStatus: 'server_delivering' }))).toBe(false);
    });
});

describe('a new Bot\'s first-run seed while it is pending', () => {
    // The real birth record (`preparedSessionBirth`): template facts plus host provenance and request, no Home authority yet.
    const onboarding = buildSessionHostOnboardingInputV1({ templateName: 'Coffee Companion', templateVersion: '1.0.10', authorDisplayName: 'Mara' });
    const seed = (overrides: Partial<PendingMessage> = {}) => pendingMessage({
        text: onboarding.initialInput.text,
        rawRecord: { meta: { ...onboarding.meta, [SESSION_MESSAGE_PROVENANCE_META_KEY]: onboarding.inputAdmission.provenance,
            [SESSION_INPUT_REQUEST_META_KEY]: onboarding.inputAdmission.request } },
        ...overrides,
    });

    it('is the host\'s quiet line, not the person\'s bubble, and never paints its own blocked notice', () => {
        const [row] = resolvePendingMessagesPresentation([seed({
            pendingDeliveryStatus: 'blocked', pendingDeliveryBlockedReason: 'runtime_config_blocked' })]).rows;
        expect(row).toMatchObject({ isHostInput: true, hostOnboarding: true, statesBlockedReason: false });
    });

    it('leaves an ordinary message the person typed as their own', () => {
        const [row] = resolvePendingMessagesPresentation([pendingMessage({
            pendingDeliveryStatus: 'blocked', pendingDeliveryBlockedReason: 'runtime_config_blocked' })]).rows;
        // Still the person's own message; its account block is said once by the Session line (JOURNEY-UX-1107 B).
        expect(row).toMatchObject({ isHostInput: false, hostOnboarding: false, statesBlockedReason: false });
    });
});
