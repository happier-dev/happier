import React from 'react';
import { Pressable, View } from 'react-native';

import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Text } from '@/components/ui/text/Text';
import { bugReportComposerStyles } from './bugReportComposerStyles';

export function BugReportExpandableSection(props: Readonly<{
    title: string;
    testID: string;
    children: React.ReactNode;
}>): React.JSX.Element {
    const [expanded, setExpanded] = React.useState(false);
    return <ExpandableItem
        expanded={expanded}
        onExpandedChange={setExpanded}
        showDivider={false}
        header={({ headerProps }) => <Pressable {...headerProps} testID={props.testID} style={bugReportComposerStyles.row}>
            <Text style={bugReportComposerStyles.previewButtonText}>{props.title}</Text>
            <Text style={bugReportComposerStyles.helperText}>{expanded ? '−' : '+'}</Text>
        </Pressable>}
    >
        <View style={bugReportComposerStyles.sectionFields}>{props.children}</View>
    </ExpandableItem>;
}
