import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Eyebrow } from '@/components/ui/text/Eyebrow';
import { ItemGroupColumns } from '@/components/ui/lists/ItemGroupColumns';
import type { ViewportClass } from '@/utils/platform/viewportClass';

export interface ItemSectionProps {
    caption?: string;
    children: React.ReactNode;
    columns?: 1 | 2 | 3;
    collapseBelow?: ViewportClass;
    tone?: 'tint' | 'plain';
    style?: StyleProp<ViewStyle>;
    testID?: string;
}

const stylesheet = StyleSheet.create((theme) => ({
    containerTint: {
        // Barely-there separation: a baked low-opacity section tint sits a hair off
        // the base surface, lighter than the recessed inset and not a heavy elevated
        // grey block. Baked into the token because a runtime opacity transform is a
        // silent no-op once the web build var-ifies theme tokens.
        backgroundColor: theme.colors.surface.sectionTint,
        borderRadius: 12,
        overflow: 'hidden',
    },
    containerPlain: {
        borderRadius: 12,
        overflow: 'hidden',
    },
    caption: {
        paddingHorizontal: 16,
        paddingTop: 12,
    },
    body: {
        paddingTop: 8,
    },
}));

export const ItemSection = React.memo<ItemSectionProps>((props) => {
    const styles = stylesheet;
    const tone = props.tone ?? 'tint';

    return (
        <View
            testID={props.testID}
            style={[tone === 'tint' ? styles.containerTint : styles.containerPlain, props.style]}
        >
            {props.caption != null ? (
                <Eyebrow style={styles.caption}>{props.caption}</Eyebrow>
            ) : null}
            <ItemGroupColumns
                style={styles.body}
                columns={props.columns ?? 2}
                collapseBelow={props.collapseBelow ?? 'medium'}
            >
                {props.children}
            </ItemGroupColumns>
        </View>
    );
});

ItemSection.displayName = 'ItemSection';
