import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';

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
}>;

const stylesheet = StyleSheet.create({
    container: {
        gap: 12,
    },
});

export function FlowSurfaceActions(props: FlowSurfaceActionsProps) {
    const styles = stylesheet;

    return (
        <View style={styles.container}>
            <RoundButton
                testID={props.primary.testID}
                title={props.primary.label}
                onPress={props.primary.onPress}
                size="large"
                disabled={props.primary.disabled}
                loading={props.primary.loading}
            />
            {props.secondary ? (
                <RoundButton
                    testID={props.secondary.testID}
                    title={props.secondary.label}
                    onPress={props.secondary.onPress}
                    size="large"
                    display={props.secondary.display ?? 'inverted'}
                    disabled={props.secondary.disabled}
                    loading={props.secondary.loading}
                />
            ) : null}
        </View>
    );
}
