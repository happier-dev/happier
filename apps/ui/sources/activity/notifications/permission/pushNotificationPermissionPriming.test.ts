import { describe, expect, it } from 'vitest';

import type { PushPermissionState } from './pushNotificationAccess';
import { resolvePushPermissionPrimingDecision } from './pushNotificationPermissionPriming';

function permission(overrides: Partial<PushPermissionState>): PushPermissionState {
    return { status: 'undetermined', granted: false, canAskAgain: true, ...overrides };
}

describe('resolvePushPermissionPrimingDecision', () => {
    it('primes when the OS has never been asked', () => {
        expect(resolvePushPermissionPrimingDecision({
            pushEnabled: true,
            permission: permission({}),
            hasDeclinedInAppPrompt: false,
            trigger: 'automatic',
        })).toBe('prime');
    });

    it('does nothing when the account disabled push', () => {
        expect(resolvePushPermissionPrimingDecision({
            pushEnabled: false,
            permission: permission({}),
            hasDeclinedInAppPrompt: false,
            trigger: 'automatic',
        })).toBe('skip_push_disabled');
    });

    it('does nothing when permission is already granted', () => {
        expect(resolvePushPermissionPrimingDecision({
            pushEnabled: true,
            permission: permission({ status: 'granted', granted: true }),
            hasDeclinedInAppPrompt: false,
            trigger: 'automatic',
        })).toBe('skip_already_granted');
    });

    it('does nothing on a platform without a push runtime', () => {
        expect(resolvePushPermissionPrimingDecision({
            pushEnabled: true,
            permission: permission({ status: 'unsupported', canAskAgain: false }),
            hasDeclinedInAppPrompt: false,
            trigger: 'automatic',
        })).toBe('skip_unsupported');
    });

    it('does nothing when the notification runtime could not be read', () => {
        expect(resolvePushPermissionPrimingDecision({
            pushEnabled: true,
            permission: null,
            hasDeclinedInAppPrompt: false,
            trigger: 'automatic',
        })).toBe('skip_runtime_unavailable');
    });

    it('does not re-prime automatically after the user declined the in-app explainer', () => {
        expect(resolvePushPermissionPrimingDecision({
            pushEnabled: true,
            permission: permission({}),
            hasDeclinedInAppPrompt: true,
            trigger: 'automatic',
        })).toBe('skip_already_declined');
    });

    it('primes again when the user explicitly asks, even after an earlier decline', () => {
        expect(resolvePushPermissionPrimingDecision({
            pushEnabled: true,
            permission: permission({}),
            hasDeclinedInAppPrompt: true,
            trigger: 'user_action',
        })).toBe('prime');
    });

    it('routes to system settings once the OS refuses further prompts', () => {
        expect(resolvePushPermissionPrimingDecision({
            pushEnabled: true,
            permission: permission({ status: 'denied', canAskAgain: false }),
            hasDeclinedInAppPrompt: false,
            trigger: 'user_action',
        })).toBe('open_system_settings');
    });

    it('never opens system settings from an automatic trigger', () => {
        expect(resolvePushPermissionPrimingDecision({
            pushEnabled: true,
            permission: permission({ status: 'denied', canAskAgain: false }),
            hasDeclinedInAppPrompt: false,
            trigger: 'automatic',
        })).toBe('skip_cannot_ask_again');
    });
});
