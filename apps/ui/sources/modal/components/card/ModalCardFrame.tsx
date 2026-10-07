import * as React from 'react';
import { Platform, ScrollView, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { shadowLevelStyle } from '@/shadowElevation';
import { resolveThemeSurfaceBorderStyle } from '@/components/ui/surfaces/resolveThemeHairlineBorderStyle';
import { RoundButtonSizeScope } from '@/components/ui/buttons/RoundButton';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { ModalCardBody } from './ModalCardBody';
import { ModalCardHeader } from './ModalCardHeader';
import { useModalCardDimensions, type ModalCardDimensionOptions, type ModalCardSizePreset } from './useModalCardDimensions';

type ModalCardFrameProps = Readonly<{
    children: React.ReactNode;
    /** `none`: no title band; the content is the top of the card. The title remains the accessible name. */
    header?: 'band' | 'none';
    leading?: React.ReactNode;
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    actions?: React.ReactNode;
    footer?: React.ReactNode;
    scrollHost?: 'overlay' | 'body';
    bodyScroll?: 'none' | 'auto';
    onClose?: () => void;
    size?: ModalCardSizePreset;
    testID?: string;
    titleTestID?: string;
    subtitleTestID?: string;
    closeButtonTestID?: string;
    style?: StyleProp<ViewStyle>;
    headerStyle?: StyleProp<ViewStyle>;
    bodyStyle?: StyleProp<ViewStyle>;
    footerStyle?: StyleProp<ViewStyle>;
    dimensions?: ModalCardDimensionOptions;
    /** `sheet`: a phone bottom sheet — full width, top corners only, the safe area inside its body. */
    presentation?: 'card' | 'sheet';
    /** The bottom safe area a sheet pads inside itself (its host reached the edge). */
    sheetBottomInset?: number;
}>;

const MODAL_CARD_BORDER_RADIUS = 14;

const stylesheet = StyleSheet.create((theme) => ({
    shadowFrame: {
        backgroundColor: 'transparent',
        borderRadius: MODAL_CARD_BORDER_RADIUS,
        ...shadowLevelStyle(theme.colors.shadowLevels[4]),
        alignSelf: 'center',
        minHeight: 0,
    },
    clipSurface: {
        borderRadius: MODAL_CARD_BORDER_RADIUS,
        ...resolveThemeSurfaceBorderStyle({
            borderColor: theme.colors.border.surface,
            highlightColor: theme.colors.effect.surfaceHighlight,
        }),
        overflow: 'hidden',
        flexDirection: 'column',
        minHeight: 0,
    },
    sheetFrame: {
        alignSelf: 'stretch',
        flexShrink: 1,
        borderBottomLeftRadius: 0,
        borderBottomRightRadius: 0,
    },
    // Card chrome owns the edge inset; consumers arrange actions, not the card's padding.
    footer: {
        paddingHorizontal: 16,
        paddingVertical: 12,
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
    const scrollHost = props.scrollHost ?? 'overlay';
    const sheet = props.presentation === 'sheet';
    const bodyScroll = props.bodyScroll ?? 'none';
    const dimensions = useModalCardDimensions({
        ...props.dimensions,
        size: props.size ?? props.dimensions?.size,
    });

    const hasHeader = props.header !== 'none' && (props.leading != null
        || props.title != null
        || props.subtitle != null
        || props.actions != null
        || typeof props.onClose === 'function');

    return (
        <View
            testID={props.testID}
            {...(Platform.OS === 'web'
                ? ({ dataSet: { happyModalCardBoundary: 'true' } } as unknown as Record<string, unknown>)
                : null)}
            style={[
                styles.shadowFrame,
                sheet
                    ? [styles.sheetFrame, { width: '100%', maxWidth: '100%' }]
                    : {
                        width: dimensions.width,
                        maxWidth: dimensions.width,
                    },
                scrollHost === 'body'
                    ? {
                        height: dimensions.maxHeight,
                    }
                    : null,
                props.style,
            ]}
        >
            <GlassSurface surfaceGroup="floating" style={[
                styles.clipSurface,
                scrollHost === 'body' ? { flex: 1 } : null,
                sheet ? [styles.sheetFrame, { paddingBottom: props.sheetBottomInset ?? 0 }] : null,
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
                        style={styles.bodyScrollView}
                        contentContainerStyle={styles.bodyScrollContent}
                        keyboardShouldPersistTaps="handled"
                        nestedScrollEnabled={true}
                    >
                        <ModalCardBody fill={false} style={props.bodyStyle}>
                            {props.children}
                        </ModalCardBody>
                    </ScrollView>
                ) : (
                    <ModalCardBody style={props.bodyStyle}>
                        {props.children}
                    </ModalCardBody>
                )}

                {props.footer != null ? (
                    <View testID="modal-card-footer" style={[styles.footer, props.footerStyle]}>
                        <RoundButtonSizeScope size="small">{props.footer}</RoundButtonSizeScope>
                    </View>
                ) : null}
            </GlassSurface>
        </View>
    );
}
