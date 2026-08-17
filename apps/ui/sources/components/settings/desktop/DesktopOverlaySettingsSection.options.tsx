import * as React from 'react';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import type { TranslationKey } from '@/text';

export type ChoiceOption<T extends string | number> = Readonly<{
    value: T;
    titleKey: TranslationKey;
    icon: IconName;
}>;

export const VISIBILITY_MODE_OPTIONS: readonly ChoiceOption<'attention_only' | 'active_sessions' | 'always_when_enabled'>[] = [
    {
        value: 'attention_only',
        titleKey: 'settingsDesktop.overlay.visibilityAttentionOnlyTitle',
        icon: 'warning-circle',
    },
    {
        value: 'active_sessions',
        titleKey: 'settingsDesktop.overlay.visibilityActiveSessionsTitle',
        icon: 'pulse',
    },
    {
        value: 'always_when_enabled',
        titleKey: 'settingsDesktop.overlay.visibilityAlwaysWhenEnabledTitle',
        icon: 'sparkle',
    },
];

export const PRESENTATION_MODE_OPTIONS: readonly ChoiceOption<'automatic' | 'notch_integrated' | 'floating_overlay'>[] = [
    {
        value: 'automatic',
        titleKey: 'settingsDesktop.overlay.presentationAutomaticTitle',
        icon: 'sparkle',
    },
    {
        value: 'notch_integrated',
        titleKey: 'settingsDesktop.overlay.presentationNotchIntegratedTitle',
        icon: 'minus-circle',
    },
    {
        value: 'floating_overlay',
        titleKey: 'settingsDesktop.overlay.presentationFloatingOverlayTitle',
        icon: 'stack',
    },
];

export const AUTO_HIDE_DELAY_OPTIONS: readonly ChoiceOption<3000 | 6000 | 10000 | 30000>[] = [
    {
        value: 3000,
        titleKey: 'settingsDesktop.overlay.autoHideDelay3sTitle',
        icon: 'clock',
    },
    {
        value: 6000,
        titleKey: 'settingsDesktop.overlay.autoHideDelay6sTitle',
        icon: 'clock',
    },
    {
        value: 10000,
        titleKey: 'settingsDesktop.overlay.autoHideDelay10sTitle',
        icon: 'clock',
    },
    {
        value: 30000,
        titleKey: 'settingsDesktop.overlay.autoHideDelay30sTitle',
        icon: 'clock',
    },
];

export const PLACEMENT_MODE_OPTIONS: readonly ChoiceOption<'anchored' | 'custom'>[] = [
    {
        value: 'anchored',
        titleKey: 'settingsDesktop.overlay.placementAnchoredTitle',
        icon: 'push-pin',
    },
    {
        value: 'custom',
        titleKey: 'settingsDesktop.overlay.placementCustomTitle',
        icon: 'arrows-out-cardinal',
    },
];

export const ANCHOR_OPTIONS: readonly ChoiceOption<'top_center' | 'top_left' | 'top_right' | 'bottom_center' | 'bottom_left' | 'bottom_right' | 'left_center' | 'right_center'>[] = [
    {
        value: 'top_center',
        titleKey: 'settingsDesktop.overlay.anchorTopCenterTitle',
        icon: 'minus-circle',
    },
    {
        value: 'top_left',
        titleKey: 'settingsDesktop.overlay.anchorTopLeftTitle',
        icon: 'arrow-elbow-up-left',
    },
    {
        value: 'top_right',
        titleKey: 'settingsDesktop.overlay.anchorTopRightTitle',
        icon: 'arrow-elbow-up-right',
    },
    {
        value: 'bottom_center',
        titleKey: 'settingsDesktop.overlay.anchorBottomCenterTitle',
        icon: 'minus-circle',
    },
    {
        value: 'bottom_left',
        titleKey: 'settingsDesktop.overlay.anchorBottomLeftTitle',
        icon: 'arrow-elbow-down-left',
    },
    {
        value: 'bottom_right',
        titleKey: 'settingsDesktop.overlay.anchorBottomRightTitle',
        icon: 'arrow-elbow-down-right',
    },
    {
        value: 'left_center',
        titleKey: 'settingsDesktop.overlay.anchorLeftCenterTitle',
        icon: 'caret-left',
    },
    {
        value: 'right_center',
        titleKey: 'settingsDesktop.overlay.anchorRightCenterTitle',
        icon: 'caret-right',
    },
];

export function buildChoiceDropdownItems<T extends string | number>(
    choices: readonly ChoiceOption<T>[],
    color: string,
): readonly DropdownMenuItem[] {
    return choices.map((choice) => ({
        id: String(choice.value),
        title: t(choice.titleKey),
        icon: <Icon name={choice.icon} size={29} color={color} />,
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
