import {
    CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS,
    CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { buildSessionUsageLimitRecoveryOperationFailureAlert } from './sessionUsageLimitRecoveryOperationFailureAlert';

const translate = (key: string, params?: Readonly<Record<string, unknown>>) => (
    params ? `${key}:${JSON.stringify(params)}` : key
);

describe('sessionUsageLimitRecoveryOperationFailureAlert', () => {
    it('builds executable diagnostic actions from a usage-limit control failure', () => {
        const retry = vi.fn();
        const openConnectedAccounts = vi.fn();
        const reconnectProfile = vi.fn();
        const enableStateSharing = vi.fn();
        const dismiss = vi.fn();

        const alert = buildSessionUsageLimitRecoveryOperationFailureAlert({
            result: {
                ok: false,
                error: 'session_usage_limit_recovery_control_switch_failed',
                errorCode: 'session_usage_limit_recovery_control_switch_failed',
                uxDiagnostic: {
                    code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerAccountAdoptionMismatch,
                    failurePhase: 'post_switch_verification',
                    source: 'usage_limit_recovery',
                    serviceId: 'openai-codex',
                    agentId: 'codex',
                    profileId: 'happier',
                    retryable: true,
                    suggestedActions: [
                        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.retry,
                        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.startFreshUnderSelectedAccount,
                        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.openConnectedAccounts,
                        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.reconnectProfile,
                        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.enableStateSharing,
                        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.dismiss,
                    ],
                },
            },
            fallbackMessage: 'fallback',
            translate,
            actions: {
                retry,
                openConnectedAccounts,
                reconnectProfile,
                enableStateSharing,
                dismiss,
            },
        });

        expect(alert.title).toBe('connectedServices.diagnostics.title.provider_account_adoption_mismatch');
        expect(alert.body).toBe('connectedServices.diagnostics.body.provider_account_adoption_mismatch');
        const buttons = alert.buttons;
        if (!buttons) throw new Error('expected diagnostic alert buttons');

        expect(buttons).toEqual([
            expect.objectContaining({ text: 'common.retry', onPress: expect.any(Function) }),
            expect.objectContaining({ text: 'connectedServices.title', onPress: expect.any(Function) }),
            expect.objectContaining({ text: 'connectedServices.detail.actions.reconnect', onPress: expect.any(Function) }),
            expect.objectContaining({ text: 'connectedServices.providerStateSharing.title', onPress: expect.any(Function) }),
            expect.objectContaining({ text: 'common.cancel', onPress: expect.any(Function) }),
        ]);
        expect(buttons.some((button) =>
            button.text === 'newSession.connectedServiceSwitchUnavailable.startFreshAction'
        )).toBe(false);

        buttons[0]?.onPress?.();
        buttons[1]?.onPress?.();
        buttons[2]?.onPress?.();
        buttons[3]?.onPress?.();
        buttons[4]?.onPress?.();

        expect(retry).toHaveBeenCalledTimes(1);
        expect(openConnectedAccounts).toHaveBeenCalledTimes(1);
        expect(reconnectProfile).toHaveBeenCalledTimes(1);
        expect(enableStateSharing).toHaveBeenCalledTimes(1);
        expect(dismiss).toHaveBeenCalledTimes(1);
    });

    it('translates diagnostic body params and falls back when no diagnostic is available', () => {
        const diagnosticAlert = buildSessionUsageLimitRecoveryOperationFailureAlert({
            result: {
                ok: false,
                error: 'session_usage_limit_recovery_control_switch_failed',
                uxDiagnostic: {
                    code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.resumeReachabilityInputsMissing,
                    failurePhase: 'continuity',
                    source: 'usage_limit_recovery',
                    serviceId: 'openai-codex',
                    agentId: 'codex',
                    retryable: false,
                    suggestedActions: [CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.openConnectedAccounts],
                    diagnostics: { reason: 'missing_resume_target' },
                },
            },
            fallbackMessage: 'fallback',
            translate,
            actions: {
                openConnectedAccounts: vi.fn(),
                dismiss: vi.fn(),
            },
        });

        expect(diagnosticAlert.body).toBe(
            'connectedServices.diagnostics.body.resume_reachability_inputs_missing:{"reason":"missing_resume_target","agentId":"codex"}',
        );

        const fallbackAlert = buildSessionUsageLimitRecoveryOperationFailureAlert({
            result: {
                ok: false,
                error: 'session_usage_limit_recovery_control_switch_failed',
            },
            fallbackMessage: 'fallback',
            translate,
            actions: { dismiss: vi.fn() },
        });

        expect(fallbackAlert).toEqual({
            title: 'common.error',
            body: 'fallback',
            buttons: undefined,
        });
    });

    it('does not render resume-current-account actions without a real resume handler', () => {
        const dismiss = vi.fn();

        const alert = buildSessionUsageLimitRecoveryOperationFailureAlert({
            result: {
                ok: false,
                error: 'session_usage_limit_recovery_control_switch_unavailable',
                uxDiagnostic: {
                    code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.providerSessionStateUnavailableForResume,
                    failurePhase: 'continuity',
                    source: 'usage_limit_recovery',
                    serviceId: 'openai-codex',
                    retryable: false,
                    suggestedActions: [
                        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.resumeCurrentAccount,
                    ],
                },
            },
            fallbackMessage: 'fallback',
            translate,
            actions: { dismiss },
        });

        expect(alert.buttons).toEqual([
            expect.objectContaining({
                text: 'common.cancel',
                style: 'cancel',
                onPress: expect.any(Function),
            }),
        ]);
        expect(alert.buttons?.some((button) => button.text === 'common.continue')).toBe(false);
    });

    it('renders fork-view diagnostic actions only when executable handlers exist', () => {
        const viewLatestFork = vi.fn();
        const viewNativeFork = vi.fn();
        const dismiss = vi.fn();

        const alert = buildSessionUsageLimitRecoveryOperationFailureAlert({
            result: {
                ok: false,
                error: 'session_usage_limit_recovery_control_switch_failed',
                uxDiagnostic: {
                    code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.postSwitchVerificationFailed,
                    failurePhase: 'post_switch_verification',
                    source: 'usage_limit_recovery',
                    serviceId: 'openai-codex',
                    retryable: false,
                    suggestedActions: [
                        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.viewLatestFork,
                        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.viewNativeFork,
                        CONNECTED_SERVICE_UX_DIAGNOSTIC_ACTIONS.dismiss,
                    ],
                },
            },
            fallbackMessage: 'fallback',
            translate,
            actions: { viewLatestFork, viewNativeFork, dismiss },
        });

        const buttons = alert.buttons;
        if (!buttons) throw new Error('expected diagnostic alert buttons');

        expect(buttons).toEqual([
            expect.objectContaining({
                text: 'connectedServices.diagnostics.actions.viewLatestFork',
                onPress: expect.any(Function),
            }),
            expect.objectContaining({
                text: 'connectedServices.diagnostics.actions.viewNativeFork',
                onPress: expect.any(Function),
            }),
            expect.objectContaining({
                text: 'common.cancel',
                style: 'cancel',
                onPress: expect.any(Function),
            }),
        ]);

        buttons[0]?.onPress?.();
        buttons[1]?.onPress?.();
        buttons[2]?.onPress?.();

        expect(viewLatestFork).toHaveBeenCalledTimes(1);
        expect(viewNativeFork).toHaveBeenCalledTimes(1);
        expect(dismiss).toHaveBeenCalledTimes(1);
    });
});
