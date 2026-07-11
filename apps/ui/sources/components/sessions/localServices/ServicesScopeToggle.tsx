import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export type ServicesScope = 'workspace' | 'machine';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        marginHorizontal: 16,
        marginBottom: 8,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        padding: 2,
    },
    segment: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 999,
    },
    segmentActive: {
        backgroundColor: theme.colors.surface.pressed,
    },
    segmentText: {
        color: theme.colors.text.secondary,
        fontWeight: '600',
    },
    segmentTextActive: {
        color: theme.colors.text.primary,
    },
}));

function ScopeSegment(props: Readonly<{
    label: string;
    active: boolean;
    onPress: () => void;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityState={{ selected: props.active }}
            onPress={props.onPress}
            style={[styles.segment, props.active ? styles.segmentActive : null]}
        >
            <Text style={[styles.segmentText, props.active ? styles.segmentTextActive : null]}>
                {props.label}
            </Text>
        </Pressable>
    );
}

/**
 * The this-workspace ⇄ this-machine scope toggle. Calls back to the host to set the
 * active scope used by the launcher request and the row banding.
 */
export function ServicesScopeToggle(props: Readonly<{
    scope: ServicesScope;
    onChangeScope: (scope: ServicesScope) => void;
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    return (
        <View
            testID={props.testID}
            accessibilityRole="tablist"
            accessibilityLabel={t('localServices.scope.toggleA11y')}
            style={styles.root}
        >
            <ScopeSegment
                label={t('localServices.scope.workspace')}
                active={props.scope === 'workspace'}
                onPress={() => props.onChangeScope('workspace')}
                testID={`${props.testID}-workspace`}
            />
            <ScopeSegment
                label={t('localServices.scope.machine')}
                active={props.scope === 'machine'}
                onPress={() => props.onChangeScope('machine')}
                testID={`${props.testID}-machine`}
            />
        </View>
    );
}
