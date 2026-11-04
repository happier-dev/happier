import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';

import { FLOW_SURFACE_CONTENT_INSET } from './FlowSurfaceChrome';

export type FlowSurfaceAction = Readonly<{
    testID?: string;
    label: string;
    onPress: () => void | Promise<void>;
    disabled?: boolean;
    loading?: boolean;
    display?: 'default' | 'inverted';
}>;

export type FlowSurfaceActionsProps = Readonly<{
    primary: FlowSurfaceAction;
    secondary?: FlowSurfaceAction;
    /**
     * `card` (default) insets the actions into a flow card's content column. `column` is for a
     * host that already is that column, such as a signed-out step in the welcome workflow pane.
     */
    placement?: 'card' | 'column';
}>;

const stylesheet = StyleSheet.create({
    container: {
        // The actions belong to the card's content column, not to its edges.
        paddingHorizontal: FLOW_SURFACE_CONTENT_INSET,
        paddingBottom: FLOW_SURFACE_CONTENT_INSET,
        gap: 12,
    },
    column: {
        width: '100%',
        gap: 12,
    },
});

export function FlowSurfaceActions(props: FlowSurfaceActionsProps) {
    const styles = stylesheet;
    // On the welcome pane's column the step's actions are the pane's actions: the same tier as
    // every other step's primary there, not the card's dialog-sized buttons.
    const size = props.placement === 'column' ? 'large' : 'normal';

    return (
        <View style={props.placement === 'column' ? styles.column : styles.container}>
            <RoundButton
                testID={props.primary.testID}
                title={props.primary.label}
                action={() => Promise.resolve(props.primary.onPress())}
                size={size}
                disabled={props.primary.disabled}
                loading={props.primary.loading}
            />
            {props.secondary ? (
                <RoundButton
                    testID={props.secondary.testID}
                    title={props.secondary.label}
                    action={() => Promise.resolve(props.secondary!.onPress())}
                    size={size}
                    display={props.secondary.display ?? 'inverted'}
                    disabled={props.secondary.disabled}
                    loading={props.secondary.loading}
                />
            ) : null}
        </View>
    );
}
