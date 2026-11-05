import * as React from 'react';

import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { SegmentedChoiceOption } from '@/components/ui/lists/SegmentedChoiceItem';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import type { TranslationKey } from '@/text';

export type ChoiceOption<T extends string | number> = Readonly<{
    value: T;
    titleKey: TranslationKey;
    /** Only menus draw it; segmented choices are words. */
    icon?: IconName;
}>;

export const VISIBILITY_MODE_OPTIONS: readonly ChoiceOption<'attention_only' | 'active_sessions' | 'always_when_enabled'>[] = [
    {
        value: 'attention_only',
        titleKey: 'settingsDesktop.overlay.visibilityAttentionOnlyTitle',
    },
    {
        value: 'active_sessions',
        titleKey: 'settingsDesktop.overlay.visibilityActiveSessionsTitle',
    },
    {
        value: 'always_when_enabled',
        titleKey: 'settingsDesktop.overlay.visibilityAlwaysWhenEnabledTitle',
    },
];

export const DOCK_OPTIONS: readonly ChoiceOption<'top' | 'left' | 'right' | 'floating'>[] = [
    { value: 'top', titleKey: 'settingsDesktop.overlay.dockTop' },
    { value: 'left', titleKey: 'settingsDesktop.overlay.dockLeft' },
    { value: 'right', titleKey: 'settingsDesktop.overlay.dockRight' },
    { value: 'floating', titleKey: 'settingsDesktop.overlay.dockFloating' },
];

export const IDLE_OPTIONS: readonly ChoiceOption<'tip' | 'full' | 'hidden'>[] = [
    { value: 'tip', titleKey: 'settingsDesktop.overlay.idleTip' },
    { value: 'full', titleKey: 'settingsDesktop.overlay.idleFull' },
    { value: 'hidden', titleKey: 'settingsDesktop.overlay.idleHidden' },
];

export function buildChoiceDropdownItems<T extends string | number>(
    choices: readonly ChoiceOption<T>[],
    color: string,
): readonly DropdownMenuItem[] {
    return choices.map((choice) => ({
        id: String(choice.value),
        title: t(choice.titleKey),
        icon: choice.icon ? <Icon name={choice.icon} size={29} color={color} /> : undefined,
    }));
}

/** The same choices for a segmented row; ids are the stringified values. */
export function toSegmentedChoiceOptions<T extends string | number>(
    choices: readonly ChoiceOption<T>[],
): ReadonlyArray<SegmentedChoiceOption<string>> {
    return choices.map((choice) => ({ id: String(choice.value), label: t(choice.titleKey) }));
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

export const BOT_CONVERSATION_OPTIONS: readonly ChoiceOption<'overlay' | 'window'>[] = [
    { value: 'overlay', titleKey: 'settingsDesktop.overlay.botConversationOverlayTitle' },
    { value: 'window', titleKey: 'settingsDesktop.overlay.botConversationWindowTitle' },
];
