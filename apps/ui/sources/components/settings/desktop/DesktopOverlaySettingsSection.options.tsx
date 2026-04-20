import * as React from 'react';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';
import type { TranslationKey } from '@/text';

import { DesktopSettingsIonicon, type DesktopSettingsIoniconName } from './DesktopSettingsIonicon';

export type ChoiceOption<T extends string | number> = Readonly<{
    value: T;
    titleKey: TranslationKey;
    icon: DesktopSettingsIoniconName;
}>;

export const VISIBILITY_MODE_OPTIONS: readonly ChoiceOption<'attention_only' | 'active_sessions' | 'always_when_enabled'>[] = [
    {
        value: 'attention_only',
        titleKey: 'settingsDesktop.overlay.visibilityAttentionOnlyTitle',
        icon: 'alert-circle-outline',
    },
    {
        value: 'active_sessions',
        titleKey: 'settingsDesktop.overlay.visibilityActiveSessionsTitle',
        icon: 'pulse-outline',
    },
    {
        value: 'always_when_enabled',
        titleKey: 'settingsDesktop.overlay.visibilityAlwaysWhenEnabledTitle',
        icon: 'sparkles-outline',
    },
];

export const PRESENTATION_MODE_OPTIONS: readonly ChoiceOption<'automatic' | 'notch_integrated' | 'floating_overlay'>[] = [
    {
        value: 'automatic',
        titleKey: 'settingsDesktop.overlay.presentationAutomaticTitle',
        icon: 'sparkles-outline',
    },
    {
        value: 'notch_integrated',
        titleKey: 'settingsDesktop.overlay.presentationNotchIntegratedTitle',
        icon: 'remove-circle-outline',
    },
    {
        value: 'floating_overlay',
        titleKey: 'settingsDesktop.overlay.presentationFloatingOverlayTitle',
        icon: 'albums-outline',
    },
];

export const AUTO_HIDE_DELAY_OPTIONS: readonly ChoiceOption<3000 | 6000 | 10000 | 30000>[] = [
    {
        value: 3000,
        titleKey: 'settingsDesktop.overlay.autoHideDelay3sTitle',
        icon: 'time-outline',
    },
    {
        value: 6000,
        titleKey: 'settingsDesktop.overlay.autoHideDelay6sTitle',
        icon: 'time-outline',
    },
    {
        value: 10000,
        titleKey: 'settingsDesktop.overlay.autoHideDelay10sTitle',
        icon: 'time-outline',
    },
    {
        value: 30000,
        titleKey: 'settingsDesktop.overlay.autoHideDelay30sTitle',
        icon: 'time-outline',
    },
];

export const PLACEMENT_MODE_OPTIONS: readonly ChoiceOption<'anchored' | 'custom'>[] = [
    {
        value: 'anchored',
        titleKey: 'settingsDesktop.overlay.placementAnchoredTitle',
        icon: 'pin-outline',
    },
    {
        value: 'custom',
        titleKey: 'settingsDesktop.overlay.placementCustomTitle',
        icon: 'move-outline',
    },
];

export const ANCHOR_OPTIONS: readonly ChoiceOption<'top_center' | 'top_left' | 'top_right' | 'bottom_center' | 'bottom_left' | 'bottom_right' | 'left_center' | 'right_center'>[] = [
    {
        value: 'top_center',
        titleKey: 'settingsDesktop.overlay.anchorTopCenterTitle',
        icon: 'remove-circle-outline',
    },
    {
        value: 'top_left',
        titleKey: 'settingsDesktop.overlay.anchorTopLeftTitle',
        icon: 'arrow-up-left-box-outline',
    },
    {
        value: 'top_right',
        titleKey: 'settingsDesktop.overlay.anchorTopRightTitle',
        icon: 'arrow-up-right-box-outline',
    },
    {
        value: 'bottom_center',
        titleKey: 'settingsDesktop.overlay.anchorBottomCenterTitle',
        icon: 'remove-circle-outline',
    },
    {
        value: 'bottom_left',
        titleKey: 'settingsDesktop.overlay.anchorBottomLeftTitle',
        icon: 'arrow-down-left-box-outline',
    },
    {
        value: 'bottom_right',
        titleKey: 'settingsDesktop.overlay.anchorBottomRightTitle',
        icon: 'arrow-down-right-box-outline',
    },
    {
        value: 'left_center',
        titleKey: 'settingsDesktop.overlay.anchorLeftCenterTitle',
        icon: 'chevron-back-outline',
    },
    {
        value: 'right_center',
        titleKey: 'settingsDesktop.overlay.anchorRightCenterTitle',
        icon: 'chevron-forward-outline',
    },
];

export function buildChoiceDropdownItems<T extends string | number>(
    choices: readonly ChoiceOption<T>[],
    color: string,
): readonly DropdownMenuItem[] {
    return choices.map((choice) => ({
        id: String(choice.value),
        title: t(choice.titleKey),
        icon: <DesktopSettingsIonicon name={choice.icon} size={29} color={color} />,
    }));
}

export function findChoiceOption<T extends string | number>(
    choices: readonly ChoiceOption<T>[],
    value: T,
): ChoiceOption<T> | null {
    return choices.find((choice) => choice.value === value) ?? null;
}

export function findChoiceOptionById<T extends string | number>(
    choices: readonly ChoiceOption<T>[],
    id: string,
): ChoiceOption<T> | null {
    return choices.find((choice) => String(choice.value) === id) ?? null;
}
