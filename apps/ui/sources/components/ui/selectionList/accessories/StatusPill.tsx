import * as React from 'react';

import {
    StatusPill as BaseStatusPill,
    type StatusPillVariant,
} from '@/components/ui/status/StatusPill';

import type { SelectionListStatusVariant } from '../_types';
import { selectionListTestId } from '../_shared';

const STATUS_VARIANT_CONFIG: Readonly<Record<SelectionListStatusVariant, StatusPillVariant>> = {
    clean: 'success',
    dirty: 'warning',
    stale: 'danger',
    info: 'info',
    neutral: 'neutral',
};

export type StatusPillProps = Readonly<{
    variant: SelectionListStatusVariant;
    /** Short label after the count, e.g. 'ch', 'stale', 'clean'. */
    label: string;
    /** Optional integer rendered before the label with `Typography.tabular()` so digit changes don't shift width. */
    count?: number;
    /** Hide the leading dot (default false; dot is shown). */
    hideDot?: boolean;
    testID?: string;
}>;

/**
 * Compact status indicator pill (used by worktree rows). Pill shape
 * (`borderRadius: 999`) so dynamic count widths don't introduce corner-radius
 * jitter as digits change.
 *
 * The variant→accent token mapping is centralized; tests assert observable
 * structure (count/label text, fontVariant on count) rather than raw color
 * values to avoid brittle theme-token churn.
 */
export function StatusPill(props: StatusPillProps): React.ReactElement {
    return (
        <BaseStatusPill
            testID={props.testID}
            variant={STATUS_VARIANT_CONFIG[props.variant]}
            variantTestID={selectionListTestId(props.testID, 'variant', props.variant)}
            label={props.label}
            count={props.count}
            hideDot={props.hideDot}
            accessibilityLabel={`${props.label}${props.count !== undefined ? ` ${props.count}` : ''}`}
        />
    );
}
