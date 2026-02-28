import * as React from 'react';
import { View } from 'react-native';
import { ToolCall } from '@/sync/domains/messages/messageTypes';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { buildToolHeaderModel } from '@/components/tools/shell/presentation/buildToolHeaderModel';


interface ToolHeaderProps {
    tool: ToolCall;
}

export function ToolHeader({ tool }: ToolHeaderProps) {
    const { theme } = useUnistyles();
    const model = React.useMemo(() => {
        return buildToolHeaderModel({
            tool,
            metadata: null,
            iconSize: 18,
            iconColorPrimary: theme.colors.header.tint,
            iconColorSecondary: theme.colors.header.tint,
        });
    }, [theme.colors.header.tint, tool]);

    return (
        <View style={styles.container}>
            <View style={styles.titleContainer}>
                <View style={styles.titleRow}>
                    {model.icon}
                    <Text style={styles.title} numberOfLines={1}>{model.title}</Text>
                </View>
                {model.subtitle && (
                    <Text style={styles.subtitle} numberOfLines={1}>{model.subtitle}</Text>
                )}
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        flexGrow: 1,
        flexBasis: 0,
        paddingHorizontal: 4,
    },
    titleContainer: {
        flexDirection: 'column',
        alignItems: 'center',
        flexGrow: 1,
        flexBasis: 0
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    title: {
        fontSize: 14,
        fontWeight: '500',
        color: theme.colors.text,
        textAlign: 'center',
    },
    subtitle: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginTop: 2,
    },
}));
