import * as React from 'react';
import { ScrollView, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { shadowLevelStyle } from '@/shadowElevation';
import { resolveThemeSurfaceBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { RoundButtonSizeScope } from '@/components/ui/buttons/RoundButton';
import { ModalCardBody } from './ModalCardBody';
import { ModalCardHeader } from './ModalCardHeader';
import { ModalCloseButton } from './ModalCloseButton';
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
    /** `floatingClose`: no header bar, only the close button over the body's top-right corner. */
    header?: 'bar' | 'floatingClose';
    style?: StyleProp<ViewStyle>;
    headerStyle?: StyleProp<ViewStyle>;
    bodyStyle?: StyleProp<ViewStyle>;
    footerStyle?: StyleProp<ViewStyle>;
    bodyScroll?: 'none' | 'auto';
    dimensions?: ModalCardDimensionOptions;
}>;

const MODAL_CARD_BORDER_RADIUS = 14;

const stylesheet = StyleSheet.create((theme) => ({
    shadowFrame: {
        backgroundColor: theme.colors.surface.base,
        borderRadius: MODAL_CARD_BORDER_RADIUS,
        ...shadowLevelStyle(theme.colors.shadowLevels[4]),
        alignSelf: 'center',
        minHeight: 0,
    },
    clipSurface: {
        backgroundColor: theme.colors.surface.base,
        borderRadius: MODAL_CARD_BORDER_RADIUS,
        ...resolveThemeSurfaceBorderStyle({
            borderColor: theme.colors.border.surface,
            highlightColor: theme.colors.effect.surfaceHighlight,
        }),
        overflow: 'hidden',
        flexDirection: 'column',
        minHeight: 0,
    },
    footer: {},
    // Above the scrolling body, in the corner the header's close button would sit in.
    floatingClose: {
        position: 'absolute',
        top: 14,
        right: 14,
        zIndex: 2,
    },
    bodyFillLayout: {
        flexBasis: 0,
    },
    bodyScrollView: {
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 0,
    },
    bodyScrollContent: {
        flexGrow: 1,
        minHeight: 0,
    },
}));

export function ModalCardFrame(props: ModalCardFrameProps) {
    useUnistyles();
    const styles = stylesheet;
    const layout: 'fit' | 'fill' = props.layout ?? 'fit';
    const bodyScroll = props.bodyScroll ?? 'none';
    const dimensions = useModalCardDimensions({
        ...props.dimensions,
        size: props.size ?? props.dimensions?.size,
    });

    const floatingClose = props.header === 'floatingClose';
    const hasHeader = !floatingClose && (props.leading != null
        || props.title != null
        || props.subtitle != null
        || props.actions != null
        || typeof props.onClose === 'function');

    const frameSizingStyle: ViewStyle = {
        width: dimensions.width,
        maxWidth: dimensions.width,
        ...(layout === 'fill'
            ? { height: dimensions.maxHeight }
            : { maxHeight: dimensions.maxHeight }),
    };

    return (
        <View
            testID={props.testID}
            style={[
                styles.shadowFrame,
                frameSizingStyle,
                props.style,
            ]}
        >
            <View style={[
                styles.clipSurface,
                layout === 'fill' ? { flex: 1 } : { maxHeight: dimensions.maxHeight },
            ]}>
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

                {bodyScroll === 'auto' ? (
                    <ScrollView
                        testID="modal-card-body-scroll"
                        style={[
                            styles.bodyScrollView,
                            layout === 'fill' ? styles.bodyFillLayout : null,
                        ]}
                        contentContainerStyle={styles.bodyScrollContent}
                        keyboardShouldPersistTaps="handled"
                        nestedScrollEnabled={true}
                    >
                        <ModalCardBody fill={false} style={props.bodyStyle}>
                            {props.children}
                        </ModalCardBody>
                    </ScrollView>
                ) : (
                    <ModalCardBody style={[
                        layout === 'fill' ? styles.bodyFillLayout : null,
                        props.bodyStyle,
                    ]}>
                        {props.children}
                    </ModalCardBody>
                )}

                {props.footer != null ? (
                    <View testID="modal-card-footer" style={[styles.footer, props.footerStyle]}>
                        <RoundButtonSizeScope size="small">{props.footer}</RoundButtonSizeScope>
                    </View>
                ) : null}

                {/* Last, so it paints over the body on every platform. */}
                {floatingClose && typeof props.onClose === 'function' ? (
                    <View style={styles.floatingClose}>
                        <ModalCloseButton testID={props.closeButtonTestID} onPress={props.onClose} />
                    </View>
                ) : null}
            </View>
        </View>
    );
}
