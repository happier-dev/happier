import * as React from 'react';

import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';

/**
 * The fields a declaration marks `presentation.advanced`, folded under one row in either credential form.
 * Closed by default; it starts open when a field holds a value, stays open while one must be filled, and
 * opens when one fails validation, so nothing the person has to see stays hidden.
 */
export function ConnectedAccountAdvancedFields(props: Readonly<{
    count: number;
    hasValue: boolean;
    required: boolean;
    invalid: boolean;
    children: React.ReactNode;
}>): React.ReactElement {
    const [open, setOpen] = React.useState(props.hasValue);
    const [wasInvalid, setWasInvalid] = React.useState(props.invalid);
    if (props.invalid !== wasInvalid) {
        setWasInvalid(props.invalid);
        if (props.invalid) setOpen(true);
    }
    return (
        <ExpandableItem
            testID="connected-account-advanced"
            expanded={open || props.required}
            onExpandedChange={(expanded) => setOpen(expanded || props.invalid)}
            header={(state) => (
                <Item
                    testID="connected-account-advanced:header"
                    {...state.headerProps}
                    title={t('connectedServicesPool.advancedTitle')}
                    detail={props.count > 1 ? t('connectedServicesPool.advancedCount', { count: props.count }) : undefined}
                />
            )}
        >
            {props.children}
        </ExpandableItem>
    );
}
