import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

export type PageLeaveAction = Readonly<{
    label: string;
    onPress: () => void;
    /** `bordered`: the common way out (Uninstall, Remove server). `text`: a rarer one. `destructive`: cannot be undone. */
    display: 'bordered' | 'text' | 'destructive';
    icon?: IconName;
    busy?: boolean;
    disabled?: boolean;
    /** Said to assistive tech with the label (the consequence a footnote states on screen). */
    accessibilityHint?: string;
    testID: string;
}>;

/**
 * How an entity page ends: the quiet actions that remove or leave it. Recoverable ones first, in the
 * order given; anything that cannot be undone stands apart at the far edge, and its consequence is
 * stated once underneath (R9, extracted from the plugin detail page).
 */
export function PageLeaveActions(props: Readonly<{
    actions: readonly PageLeaveAction[];
    footnote?: string;
    accessibilityLabel?: string;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const recoverable = props.actions.filter((action) => action.display !== 'destructive');
    const destructive = props.actions.filter((action) => action.display === 'destructive');
    const render = (action: PageLeaveAction) => (
        <RoundButton
            key={action.testID}
            testID={action.testID}
            size="small"
            display={action.display === 'bordered' ? 'secondary' : action.display === 'text' ? 'inverted' : 'destructive'}
            leading={action.icon ? <Icon name={action.icon} size={15} color={action.display === 'text' ? theme.colors.text.secondary : theme.colors.text.primary} /> : undefined}
            textStyle={action.display === 'text' ? styles.quietAction : undefined}
            title={action.label}
            titleNumberOfLines={action.display === 'destructive' ? 'complete' : undefined}
            accessibilityHint={action.accessibilityHint}
            disabled={action.disabled === true || action.busy === true}
            loading={action.busy}
            onPress={action.onPress}
        />
    );
    // The consequence of the one way out stands beside it (it wraps beneath on a narrow page); with an irreversible
    // action apart at the far edge, it is stated once underneath.
    const beside = props.footnote !== undefined && destructive.length === 0;
    const footnote = props.footnote ? (
        <Text testID={props.testID ? `${props.testID}:footnote` : undefined} style={beside ? styles.footnoteBeside : styles.footnote}>{props.footnote}</Text>
    ) : null;
    return (
        <ItemGroup surface="none" accessibilityLabel={props.accessibilityLabel}>
            <View style={styles.actions} testID={props.testID}>
                {recoverable.map(render)}
                {beside ? footnote : null}
                {destructive.length > 0 ? <View style={styles.spacer} /> : null}
                {destructive.map(render)}
            </View>
            {beside ? null : footnote}
        </ItemGroup>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    // Pushes the irreversible action to the far edge when the row fits, apart from the recoverable ones.
    spacer: {
        flexGrow: 1,
    },
    quietAction: {
        ...Typography.variant('body', 'medium'),
        color: theme.colors.text.secondary,
    },
    footnote: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
        marginTop: theme.space.s10,
        marginHorizontal: theme.space.s2,
    },
    footnoteBeside: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 240,
        marginHorizontal: theme.space.s2,
    },
}));
