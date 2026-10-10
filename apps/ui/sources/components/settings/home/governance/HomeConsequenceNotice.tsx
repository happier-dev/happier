import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { SectionLeadingColumnProvider } from '@/components/ui/lists/sectionLeadingColumn';

/**
 * The console's one inline "what this change does" card, placed in the page flow right under the
 * row that causes it: a warning mark, the outcome as the title, one line per consequence, and,
 * when the change waits for the owner, its decision underneath (lab `hcFeatures-D` dependents,
 * lab `hcPolicies-W` widening). Nothing on it writes; its actions are the caller's.
 *
 * Its warning mark is its own leading column: the card appearing never moves the titles of the
 * rows around it (the section's shared column is only for rows that are always there).
 */
export const HomeConsequenceNotice = React.memo(function HomeConsequenceNotice(props: Readonly<{
    testID: string;
    title: string;
    lines: readonly string[];
    /** The decision the change is waiting for (Cancel and the named primary), under the text. */
    actions?: React.ReactNode;
    showDivider?: boolean;
}>) {
    const { theme } = useUnistyles();
    return (
        <SectionLeadingColumnProvider>
            <Item
                testID={props.testID}
                title={props.title}
                titleLines={0}
                subtitle={props.lines.join('\n')}
                subtitleLines={0}
                subtitleAccessory={props.actions}
                icon={<Icon name="warning" size={ICON_SIZE.md} color={theme.colors.state.warning.foreground} />}
                accessibilityLiveRegion="polite"
                mode="info"
                showChevron={false}
                showDivider={props.showDivider}
            />
        </SectionLeadingColumnProvider>
    );
});
