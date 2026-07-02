import { Platform } from 'react-native';

import type { SelectionListHeightBehavior } from './_types';

/**
 * Popover bodies should treat maxHeight as a cap, not as the actual height.
 * On native, SelectionList still needs a concrete bounded viewport because
 * ScrollView/flex descendants collapse under maxHeight-only parents. The
 * measured behavior provides that concrete height while keeping short menus
 * content-sized.
 */
export function resolvePopoverSelectionListHeightBehavior(
    preferredHeightBehavior?: SelectionListHeightBehavior,
): SelectionListHeightBehavior | undefined {
    if (Platform.OS !== 'web') {
        if (preferredHeightBehavior === 'fixedToMaxHeight') return 'fixedToMaxHeight';
        return 'measuredToMaxHeight';
    }
    return preferredHeightBehavior;
}
