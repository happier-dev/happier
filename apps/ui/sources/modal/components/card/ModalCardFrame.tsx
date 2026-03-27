import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ModalCardBody } from './ModalCardBody';
import { ModalCardHeader } from './ModalCardHeader';
import { useModalCardDimensions, type ModalCardDimensionOptions, type ModalCardSizePreset } from './useModalCardDimensions';

type ModalCardFrameProps = Readonly<{
    children: React.ReactNode;
    leading?: React.ReactNode;
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    actions?: React.ReactNode;
    footer?: React.ReactNode;
    onClose?: () => void;
    size?: ModalCardSizePreset;
    layout?: 'fit' | 'fill';
    testID?: string;
    titleTestID?: string;
    subtitleTestID?: string;
    closeButtonTestID?: string;
    style?: StyleProp<ViewStyle>;
    headerStyle?: StyleProp<ViewStyle>;
    bodyStyle?: StyleProp<ViewStyle>;
    footerStyle?: StyleProp<ViewStyle>;
    dimensions?: ModalCardDimensionOptions;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surface,
        borderRadius: 14,
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
        elevation: 5,
        alignSelf: 'center',
        flexDirection: 'column',
        minHeight: 0,
    },
    footer: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
    },
}));

export function ModalCardFrame(props: ModalCardFrameProps) {
    useUnistyles();
    const styles = stylesheet;
    const layout: 'fit' | 'fill' = props.layout ?? 'fit';
    const dimensions = useModalCardDimensions({
        ...props.dimensions,
        size: props.size ?? props.dimensions?.size,
    });

    const hasHeader = props.leading != null
        || props.title != null
        || props.subtitle != null
        || props.actions != null
        || typeof props.onClose === 'function';

    return (
        <View
            testID={props.testID}
            style={[
                styles.container,
                {
                    width: dimensions.width,
                    maxWidth: dimensions.width,
                    ...(layout === 'fill'
                        ? { height: dimensions.maxHeight }
                        : { maxHeight: dimensions.maxHeight }),
                },
                props.style,
            ]}
        >
            {hasHeader ? (
                <ModalCardHeader
                    leading={props.leading}
                    title={props.title}
                    subtitle={props.subtitle}
                    actions={props.actions}
                    onClose={props.onClose}
                    titleTestID={props.titleTestID}
                    subtitleTestID={props.subtitleTestID}
                    closeButtonTestID={props.closeButtonTestID}
                    style={props.headerStyle}
                />
            ) : null}

            <ModalCardBody style={props.bodyStyle}>
                {props.children}
            </ModalCardBody>

            {props.footer != null ? (
                <View style={[styles.footer, props.footerStyle]}>
                    {props.footer}
                </View>
            ) : null}
        </View>
    );
}
