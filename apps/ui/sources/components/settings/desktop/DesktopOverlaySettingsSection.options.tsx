import * as React from 'react';

import { Ionicons } from '@expo/vector-icons';

import { t } from '@/text';
import type { TranslationKey } from '@/text';

export type ChoiceOption<T extends string | number> = Readonly<{
    value: T;
    titleKey: TranslationKey;
    icon: string;
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

export const EXPANDED_BEHAVIOR_OPTIONS: readonly ChoiceOption<'click' | 'hover'>[] = [
    {
        value: 'click',
        titleKey: 'settingsDesktop.overlay.expandedBehaviorClickTitle',
        icon: 'hand-left-outline',
    },
    {
        value: 'hover',
        titleKey: 'settingsDesktop.overlay.expandedBehaviorHoverTitle',
        icon: 'eye-outline',
    },
];

export const COLLAPSED_CLICK_ACTION_OPTIONS: readonly ChoiceOption<'expand_overlay' | 'open_primary_session' | 'open_sessions'>[] = [
    {
        value: 'expand_overlay',
        titleKey: 'settingsDesktop.overlay.collapsedClickActionExpandOverlayTitle',
        icon: 'open-outline',
    },
    {
        value: 'open_primary_session',
        titleKey: 'settingsDesktop.overlay.collapsedClickActionOpenPrimarySessionTitle',
        icon: 'arrow-forward-outline',
    },
    {
        value: 'open_sessions',
        titleKey: 'settingsDesktop.overlay.collapsedClickActionOpenSessionsTitle',
        icon: 'albums-outline',
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
        icon: 'arrow-up-left-outline',
    },
    {
        value: 'top_right',
        titleKey: 'settingsDesktop.overlay.anchorTopRightTitle',
        icon: 'arrow-up-right-outline',
    },
    {
        value: 'bottom_center',
        titleKey: 'settingsDesktop.overlay.anchorBottomCenterTitle',
        icon: 'remove-circle-outline',
    },
    {
        value: 'bottom_left',
        titleKey: 'settingsDesktop.overlay.anchorBottomLeftTitle',
        icon: 'arrow-down-left-outline',
    },
    {
        value: 'bottom_right',
        titleKey: 'settingsDesktop.overlay.anchorBottomRightTitle',
        icon: 'arrow-down-right-outline',
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

export const DENSITY_OPTIONS: readonly ChoiceOption<'compact' | 'comfortable'>[] = [
    {
        value: 'compact',
        titleKey: 'settingsDesktop.overlay.densityCompactTitle',
        icon: 'scan-outline',
    },
    {
        value: 'comfortable',
        titleKey: 'settingsDesktop.overlay.densityComfortableTitle',
        icon: 'reader-outline',
    },
];

export const COMPACT_STYLE_OPTIONS: readonly ChoiceOption<'pill' | 'panel'>[] = [
    {
        value: 'pill',
        titleKey: 'settingsDesktop.overlay.compactStylePillTitle',
        icon: 'ellipse-outline',
    },
    {
        value: 'panel',
        titleKey: 'settingsDesktop.overlay.compactStylePanelTitle',
        icon: 'square-outline',
    },
];

export function renderChoiceRows<T extends string | number>(
    ItemComponent: React.ComponentType<{
        title: React.ReactNode;
        icon?: React.ReactNode;
        selected?: boolean;
        disabled?: boolean;
        onPress?: () => void;
        showChevron?: boolean;
    }>,
    choices: readonly ChoiceOption<T>[],
    params: {
        disabled: boolean;
        selectedValue: T;
        onSelect: (value: T) => void;
        color: string;
    },
) {
    return choices.map((choice) => (
        <ItemComponent
            key={String(choice.value)}
            title={t(choice.titleKey)}
            icon={<Ionicons name={choice.icon as keyof typeof Ionicons.glyphMap} size={29} color={params.color} />}
            selected={params.selectedValue === choice.value}
            disabled={params.disabled}
            onPress={() => params.onSelect(choice.value)}
            showChevron={false}
        />
    ));
}
