import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { hasAgentIconMark } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

const stylesheet = StyleSheet.create(() => ({
    // The mark stands on its own: no border, fill or tile behind it (user ruling 2026-09-30; DESIGN-6
    // P5). The box keeps its size so a header's geometry holds whichever mark the catalog supplies.
    tile: {
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

/**
 * The Agent behind a Run, drawn with the mark its catalog entry contributes. Generic UI never
 * branches on Agent ids: the catalog decides whether a mark exists; without one the tile keeps a
 * neutral glyph rather than a blank space.
 */
export const ExecutionRunAgentMark = React.memo((props: Readonly<{
    agentId: string | null;
    /** The tile's side; the mark is drawn at a little over half of it. */
    size: number;
    testID?: string;
    /** The object's existing kind glyph when it has no Agent mark. */
    iconName?: IconName;
}>) => {
    const { theme } = useUnistyles();
    const markSize = Math.round(props.size * 0.56);
    const hasMark = props.agentId !== null && hasAgentIconMark(props.agentId, theme);
    return (
        <View
            testID={props.testID}
            accessible={false}
            importantForAccessibility="no-hide-descendants"
            style={[stylesheet.tile, { width: props.size, height: props.size, borderRadius: Math.round(props.size * 0.3) }]}
        >
            {hasMark && props.agentId
                ? <AgentIcon agentId={props.agentId} size={markSize} />
                : <Icon name={props.iconName ?? 'sparkle'} size={markSize} color={theme.colors.text.secondary} />}
        </View>
    );
});
