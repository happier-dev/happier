import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { ModalCloseButton } from './ModalCloseButton';

type ModalCardHeaderProps = Readonly<{
    leading?: React.ReactNode;
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    actions?: React.ReactNode;
    onClose?: () => void;
    testID?: string;
    titleTestID?: string;
    subtitleTestID?: string;
    closeButtonTestID?: string;
    style?: StyleProp<ViewStyle>;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    header: {
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 10,
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
    },
    headerLeadingWrap: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
        minWidth: 0,
        gap: 10,
    },
    titleWrap: {
        flex: 1,
        minWidth: 0,
        gap: 4,
    },
    title: {
        fontSize: 17,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    subtitle: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    actionsWrap: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
}));

export function ModalCardHeader(props: ModalCardHeaderProps) {
    useUnistyles();
    const styles = stylesheet;
    const hasVisibleTitle = props.title != null || props.subtitle != null;
    const showClose = typeof props.onClose === 'function';

    if (!hasVisibleTitle && !props.leading && !props.actions && !showClose) {
        return null;
    }

    return (
        <View testID={props.testID ?? 'modal-card-header'} style={[styles.header, props.style]}>
            <View style={styles.headerLeadingWrap}>
                {props.leading}
                {hasVisibleTitle ? (
                    <View style={styles.titleWrap}>
                        {props.title != null ? (
                            <Text testID={props.titleTestID} style={styles.title}>{props.title}</Text>
                        ) : null}
                        {props.subtitle != null ? (
                            <Text testID={props.subtitleTestID} style={styles.subtitle}>{props.subtitle}</Text>
                        ) : null}
                    </View>
                ) : (
                    <View style={styles.titleWrap} />
                )}
            </View>

            <View style={styles.actionsWrap}>
                {props.actions}
                {showClose ? <ModalCloseButton testID={props.closeButtonTestID} onPress={props.onClose} /> : null}
            </View>
        </View>
    );
}
