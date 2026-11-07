import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';

export type SelectionCheckState = 'checked' | 'unchecked' | 'mixed';

export type SelectionCheckSize = 'regular' | 'compact';

/**
 * The glyph box for each row rhythm: the regular box is the default two-line row's 16 px checkbox;
 * compact is the one-line row's and the tree's 14 px checkbox (Git lab TV), the same ink ratio.
 */
export const SELECTION_CHECK_GLYPH_SIZE_PX: Readonly<Record<SelectionCheckSize, number>> = { regular: 18, compact: 16 };

/**
 * The checkbox mark of a list or tree row: one item (checked or not) or a group (`mixed` when some of
 * it is selected). It is only the mark: the control around it owns the press and the checked state.
 */
export function SelectionCheckGlyph(props: Readonly<{ state: SelectionCheckState; size?: SelectionCheckSize }>): React.ReactElement {
    const { theme } = useUnistyles();
    const size = SELECTION_CHECK_GLYPH_SIZE_PX[props.size ?? 'regular'];
    if (props.state === 'unchecked') {
        return <Icon name="square" size={size} color={theme.colors.text.tertiary} />;
    }
    return (
        <Icon
            name={props.state === 'checked' ? 'check-square' : 'minus-square'}
            weight="fill"
            size={size}
            color={theme.colors.text.primary}
        />
    );
}
