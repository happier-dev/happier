import type React from 'react';
import type { GestureResponderEvent } from 'react-native';
import type { IconName } from '@/components/ui/icons/Icon';
import type { PopoverAnchor } from '@/components/ui/popover';

export type ItemAction = {
    id: string;
    title: string;
    /** Accessible action name when the visible title is intentionally concise. */
    accessibilityLabel?: string;
    subtitle?: string;
    /**
     * Either an Ionicons icon name (recommended for standard row actions),
     * or a fully-rendered icon node for custom surfaces (e.g. header icons with badges).
     */
    icon: IconName | React.ReactElement;
    onPress?: (event?: GestureResponderEvent, selection?: Readonly<{ anchor: PopoverAnchor }>) => void;
    /** Optional testID for the inline icon pressable. */
    inlineTestID?: string;
    disabled?: boolean;
    /** Whether this trigger currently owns an expanded anchored surface. */
    expanded?: boolean;
    /**
     * The action represents the current value of a choice (a width, a sort order).
     * Menus announce it as checked rather than disabling it — a valid value that is
     * already applied is selected, not unavailable.
     */
    selected?: boolean;
    /** Optional labelled section in the overflow menu. Ignored by inline layouts. */
    group?: Readonly<{
        id: string;
        title: string;
    }>;
    destructive?: boolean;
    color?: string;
};

/** Below this layout width a row keeps only its compact actions and folds the rest into `⋯`. */
export const ITEM_ROW_ACTIONS_COMPACT_THRESHOLD_PX = 450;
