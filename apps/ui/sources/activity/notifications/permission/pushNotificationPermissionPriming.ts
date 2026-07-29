import { Linking } from 'react-native';

import { Modal } from '@/modal';
import { t } from '@/text';

import {
    readPushPermission,
    requestPushPermission,
    type PushPermissionState,
} from './pushNotificationAccess';
import {
    clearDeclinedPushPermissionPriming,
    hasDeclinedPushPermissionPriming,
    recordDeclinedPushPermissionPriming,
} from './pushPermissionPrimingRecord';

/**
 * iOS grants exactly one system notification prompt per install. Once it is spent — or declined —
 * the only recovery is a trip through system settings. Spending it from a background sync task
 * gives the user no context for the decision, so the ask is framed in-app first and the OS prompt
 * is only reached after the user opts in here.
 */
export type PushPermissionPrimingTrigger = 'automatic' | 'user_action';

export type PushPermissionPrimingDecision =
    | 'prime'
    | 'open_system_settings'
    | 'skip_push_disabled'
    | 'skip_unsupported'
    | 'skip_already_granted'
    | 'skip_already_declined'
    | 'skip_cannot_ask_again'
    | 'skip_runtime_unavailable';

export function resolvePushPermissionPrimingDecision(input: Readonly<{
    pushEnabled: boolean;
    /** `null` when the notification runtime could not be reached. */
    permission: PushPermissionState | null;
    hasDeclinedInAppPrompt: boolean;
    trigger: PushPermissionPrimingTrigger;
}>): PushPermissionPrimingDecision {
    if (!input.pushEnabled) return 'skip_push_disabled';
    if (!input.permission) return 'skip_runtime_unavailable';
    if (input.permission.status === 'unsupported') return 'skip_unsupported';
    if (input.permission.granted) return 'skip_already_granted';

    if (!input.permission.canAskAgain) {
        // Only an explicit user action earns a detour into system settings; doing it unprompted
        // would be an unexplained context switch out of the app.
        return input.trigger === 'user_action' ? 'open_system_settings' : 'skip_cannot_ask_again';
    }

    if (input.trigger === 'automatic' && input.hasDeclinedInAppPrompt) {
        return 'skip_already_declined';
    }
    return 'prime';
}

export type PushPermissionPrimingOutcome = Readonly<{
    decision: PushPermissionPrimingDecision;
    /** True once the OS reports the permission as granted. */
    granted: boolean;
}>;

export type RunPushPermissionPrimingOptions = Readonly<{
    pushEnabled: boolean;
    trigger: PushPermissionPrimingTrigger;
    /** Invoked after a newly granted permission so the token can be registered immediately. */
    onGranted?: () => void | Promise<void>;
}>;

/**
 * Resolve the account/OS state, then ask for permission with in-app framing when that is the
 * useful next step. Never throws: every boundary it touches returns a typed outcome.
 */
export async function runPushNotificationPermissionPriming(
    opts: RunPushPermissionPrimingOptions,
): Promise<PushPermissionPrimingOutcome> {
    const permissionOutcome = await readPushPermission();
    const permission = permissionOutcome.ok ? permissionOutcome.permission : null;
    const decision = resolvePushPermissionPrimingDecision({
        pushEnabled: opts.pushEnabled,
        permission,
        hasDeclinedInAppPrompt: hasDeclinedPushPermissionPriming(),
        trigger: opts.trigger,
    });

    if (decision === 'skip_already_granted') {
        return { decision, granted: true };
    }
    if (decision !== 'prime' && decision !== 'open_system_settings') {
        return { decision, granted: false };
    }

    if (decision === 'open_system_settings') {
        const openSettings = await Modal.confirm(
            t('settingsNotifications.pushPriming.blockedTitle'),
            t('settingsNotifications.pushPriming.blockedBody'),
            {
                cancelText: t('common.cancel'),
                confirmText: t('settingsNotifications.pushPriming.openSettings'),
            },
        );
        if (openSettings) {
            try {
                await Linking.openSettings();
            } catch {
                Modal.alert(
                    t('common.error'),
                    t('settingsNotifications.pushPriming.openSettingsFailed'),
                );
            }
        }
        return { decision, granted: false };
    }

    const accepted = await Modal.confirm(
        t('settingsNotifications.pushPriming.title'),
        t('settingsNotifications.pushPriming.body'),
        {
            cancelText: t('settingsNotifications.pushPriming.decline'),
            confirmText: t('settingsNotifications.pushPriming.accept'),
        },
    );

    if (!accepted) {
        recordDeclinedPushPermissionPriming();
        return { decision, granted: false };
    }

    // The user opted in here, so a previous decline no longer suppresses the automatic path.
    clearDeclinedPushPermissionPriming();

    const requested = await requestPushPermission();
    const granted = requested.ok && requested.permission.granted;
    if (granted) {
        await opts.onGranted?.();
    }
    return { decision, granted };
}
