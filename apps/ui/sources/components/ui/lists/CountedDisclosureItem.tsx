import * as React from 'react';
import {
    HappierCountedDisclosure,
    type HappierCountedDisclosureContentProps,
    type HappierCountedDisclosureHeaderState,
} from '@happier-dev/plugin-ui/presentation';

import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';

function renderCountedDisclosureHeader(state: HappierCountedDisclosureHeaderState) {
    return (
        <Item
            {...state.headerProps}
            testID={state.testID}
            title={state.title}
            subtitle={state.subtitle}
            subtitleLines={state.subtitleNumberOfLines}
            icon={state.icon}
            detail={state.detail}
        />
    );
}

/**
 * A row that stands for several quiet items ("Offline  77", "Invalid doctor snapshot  11"): the title
 * says what they share, the count is its value, and the items open in place on demand. When the group
 * is better summarized in words than by a number ("Every agent uses the account default", "Last seen
 * 3 days ago"), the summary is the row's subtitle and the count may be left out.
 */
export const CountedDisclosureItem = React.memo(function CountedDisclosureItem(props: HappierCountedDisclosureContentProps) {
    return (
        <HappierCountedDisclosure
            {...props}
            Disclosure={ExpandableItem}
            renderHeader={renderCountedDisclosureHeader}
        />
    );
});
