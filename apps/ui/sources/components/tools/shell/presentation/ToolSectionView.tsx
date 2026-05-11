import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';


interface ToolSectionViewProps {
    title?: string;
    fullWidth?: boolean;
    children: React.ReactNode;
}

type ToolSectionSpacing = 'default' | 'compact';

const TOOL_SECTION_BOTTOM_SPACING: Record<ToolSectionSpacing, number> = {
    default: 12,
    compact: 8,
};

const ToolSectionSpacingContext = React.createContext<ToolSectionSpacing>('default');

export function ToolSectionSpacingProvider(props: {
    spacing: ToolSectionSpacing;
    children: React.ReactNode;
}) {
    return (
        <ToolSectionSpacingContext.Provider value={props.spacing}>
            {props.children}
        </ToolSectionSpacingContext.Provider>
    );
}

export const ToolSectionView = React.memo<ToolSectionViewProps>(({ title, children, fullWidth }) => {
    const spacing = React.useContext(ToolSectionSpacingContext);
    return (
        <View style={[
            styles.section,
            { marginBottom: TOOL_SECTION_BOTTOM_SPACING[spacing] },
            fullWidth && styles.fullWidthSection,
        ]}>
            {title && <Text style={styles.sectionTitle}>{title}</Text>}
            <View style={fullWidth ? styles.fullWidthContent : undefined}>
                {children}
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    section: {
        overflow: 'visible',
    },
    fullWidthSection: {
        marginHorizontal: -12, // Compensate for parent padding
    },
    fullWidthContent: {
        // No negative margins needed since we're moving the whole section
    },
    sectionTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.text.secondary,
        marginBottom: 6,
        marginHorizontal: 12, // Add padding back for title when full width
        textTransform: 'uppercase',
    },
}));
