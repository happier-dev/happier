import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SelectionListSectionHeader } from '@/components/ui/selectionList/SelectionListSectionHeader';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';

/**
 * One section owner for the Inbox and Updates, in two host-selected shapes:
 * - `page` (the Inbox screen): a page section — sentence-case title, its one action in the section
 *   header's action slot, the rows in one sheet. Spacing comes from the page metrics.
 * - `flat` (the sidebar popovers): the compact command-bar header above flat rows.
 */
export const InboxSection = React.memo(function InboxSection(props: Readonly<{
    testID: string;
    /** Absent when the section's first row already names what the section is about. */
    title?: string;
    rightAccessory?: React.ReactNode;
    /** Page surface only: an identity mark before the title (a lead's agent mark, a run's glyph). */
    leading?: React.ReactNode;
    /** Page surface only: one quiet fact read with the title ("Orchestrator · 3 sub-sessions"). */
    meta?: React.ReactNode;
    /** Flat surface only: whether a section is rendered above this one. */
    spacingBefore?: 'following' | 'separated';
    surface?: 'flat' | 'page';
    children: React.ReactNode;
}>) {
    if (props.surface === 'page') {
        return (
            <View testID={props.testID}>
                <ItemGroup
                    title={props.title}
                    // Inbox rows are domain rows around \`Item\`, which the group cannot count, and a row
                    // is marked because its item is open beside the list — not because it was chosen
                    // among siblings — so even a group's only row shows it is the open one.
                    selectableItemCountOverride={2}
                    action={props.rightAccessory}
                    titleLeading={props.leading}
                    titleAccessory={props.meta}
                >
                    {props.children}
                </ItemGroup>
            </View>
        );
    }

    return (
        <View
            testID={props.testID}
            style={props.spacingBefore === 'following'
                ? styles.following
                : props.spacingBefore === 'separated'
                    ? styles.separated
                    : undefined}
        >
            {props.title ? (
                <SelectionListSectionHeader
                    testID={`${props.testID}.header`}
                    title={props.title}
                    rightAccessory={props.rightAccessory}
                    containerStyle={props.rightAccessory ? styles.actionHeader : undefined}
                />
            ) : null}
            {props.children}
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    following: {
        marginTop: 6,
    },
    separated: {
        marginTop: 14,
    },
    actionHeader: {
        minHeight: Platform.select({ ios: 44, default: 48 }),
    },
}));
