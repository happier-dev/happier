import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { PendingMessage } from '@/sync/domains/state/storageTypes';

import {
    getPendingMessageVisualState,
    resolvePendingMessageHeightBearingChrome,
    type PendingMessageVisualStateKind,
} from './pendingMessageVisualState';

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
 * F-P2 (2026-08-10): the transcript MEASUREMENT layer needs to know which delivery states can change
 * the row's HEIGHT, and only this owner knows. `PendingMessagesTranscriptBlock` selects its in-flow
 * notice from this descriptor, so the descriptor is the single decision-maker rather than a third
 * restatement of the mapping. In THIS repository every state except `blocked` paints only the
 * absolutely-positioned status chip — including the `queuedReason` copy — so only `blocked` bears
 * height.
 */
describe('resolvePendingMessageHeightBearingChrome', () => {
    const EXPECTED_BY_KIND = {
        saving: 'none',
        send_unconfirmed: 'none',
        send_failed: 'none',
        cancelling: 'none',
        cancel_failed: 'none',
        queued: 'none',
        delivering: 'none',
        materializing: 'none',
        blocked: 'blocked-notice',
    } as const satisfies Record<PendingMessageVisualStateKind, string>;

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
            expect(resolvePendingMessageHeightBearingChrome(visualState), kind).toBe(expected);
        }
    });

    it('reads the blocked notice off the presentation the block itself renders', () => {
        // The block paints `blockedDeliveryNotice` iff `deliveryBlockedPresentation` exists, so a new
        // kind that starts carrying one cannot silently drop out of the size version.
        expect(resolvePendingMessageHeightBearingChrome({
            kind: 'queued',
            showSpinner: false,
            iconName: 'clock',
            deliveryBlockedPresentation: { labelKey: 'session.pendingMessages.deliveryBlockedReasons.unknown', isUnknown: true },
        })).toBe('blocked-notice');
    });
});
