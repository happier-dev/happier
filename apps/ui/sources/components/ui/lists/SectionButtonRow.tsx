import { HappierFormActions } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { BareSectionContent } from './BareSectionContent';

/**
 * Core's adapter over the shared action cluster (`HappierFormActions`, public as `Form.Actions`): a
 * sheetless row of buttons at the end of a page section — a form's Save and Cancel, or the quiet
 * leave-and-destroy actions that close a page. Place it inside `ItemGroup surface="none"`, or after a
 * section's sheet. The layout, the far-edge `trailing` slot and the footnote's announcement are the
 * shared owner's; this adapter only draws the footnote in core typography. Submission state stays with
 * the buttons and their caller.
 */
export function SectionButtonRow(props: Readonly<{
    children: React.ReactNode;
    trailing?: React.ReactNode;
    /** One line under the buttons: the consequence of the destructive action, or a form's error. */
    footnote?: string | null;
    footnoteTone?: 'secondary' | 'danger';
    footnoteTestID?: string;
    testID?: string;
}>) {
    return (
        <BareSectionContent>
        <HappierFormActions
            testID={props.testID}
            trailing={props.trailing}
            footnote={props.footnote ? (
                <Text style={[styles.footnote, props.footnoteTone === 'danger' ? styles.footnoteDanger : null]}>
                    {props.footnote}
                </Text>
            ) : null}
            footnoteTone={props.footnoteTone}
            footnoteTestID={props.footnoteTestID}
        >
            {props.children}
        </HappierFormActions>
        </BareSectionContent>
    );
}

const styles = StyleSheet.create((theme) => ({
    footnote: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    footnoteDanger: {
        color: theme.colors.state.danger.textForeground,
    },
}));
