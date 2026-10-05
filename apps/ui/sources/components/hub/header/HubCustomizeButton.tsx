import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { CustomModal } from '@/modal/components/CustomModal';
import type { CustomModalConfig, CustomModalInjectedProps } from '@/modal/types';
import { t } from '@/text';
import { useIsTablet } from '@/utils/platform/responsive';

import { HomeWidgetAddPopover } from '@/components/widgets/add/HomeWidgetAddPopover';

import { HomeLayoutEditor } from '../layout/HomeLayoutEditor';

const CUSTOMIZE_POPOVER_WIDTH_PX = 360;
const CUSTOMIZE_POPOVER_MAX_HEIGHT_PX = 640;

/** The phone sheet's editor; Add widgets hands over to the Add to Home sheet. */
function HomeCustomizeSheetContent(props: CustomModalInjectedProps & Readonly<{ onAddWidgets: () => void }>) {
    return <HomeLayoutEditor presentation="popover" onAddWidgets={props.onAddWidgets} />;
}

/**
 * "Customize" in Home's header: the layout editor in a popover anchored to the button, over the live
 * page (every change shows behind it at once). A section's "⋯ → Customize" opens the same popover,
 * so the open state belongs to Home. Phones use the shared modal's bottom sheet with the same editor.
 * The editor mounts only while open.
 */
export const HubCustomizeButton = React.memo(function HubCustomizeButton(props: Readonly<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
}>) {
    const anchorRef = React.useRef<View>(null);
    const { onOpenChange } = props;
    const toggle = React.useCallback(() => onOpenChange(!props.open), [onOpenChange, props.open]);
    const close = React.useCallback(() => onOpenChange(false), [onOpenChange]);
    // Customize arranges what is on Home; Add widgets opens the shared gallery in its place, anchored
    // to the same button (lab dbind G / dadd A).
    const [addOpen, setAddOpen] = React.useState(false);
    const openAdd = React.useCallback(() => {
        onOpenChange(false);
        setAddOpen(true);
    }, [onOpenChange]);
    const closeAdd = React.useCallback(() => setAddOpen(false), []);
    // A phone's header has no room beside the greeting for a labelled button: the glyph alone (I1p).
    const compact = !useIsTablet();
    const sheetTitle = t('homeIndex.customizeTitle');
    const sheetConfig = React.useMemo<CustomModalConfig>(() => ({
        id: 'home-customize',
        type: 'custom',
        component: HomeCustomizeSheetContent,
        props: { onAddWidgets: openAdd },
        chrome: {
            kind: 'card',
            header: 'none',
            title: sheetTitle,
            phonePresentation: 'sheet',
            testID: 'home-hub.customize.sheet',
        },
    }), [openAdd, sheetTitle]);
    return (
        <View ref={anchorRef} collapsable={false} style={styles.anchor}>
            {compact ? (
                <IconButton
                    testID="home-hub.customize"
                    variant="plain"
                    iconName="sliders-horizontal"
                    accessibilityLabel={t('homeIndex.customizeTitle')}
                    onPress={toggle}
                />
            ) : (
                <SectionActionButton
                    testID="home-hub.customize"
                    title={t('homeIndex.customize')}
                    icon="sliders-horizontal"
                    onPress={toggle}
                />
            )}
            {props.open && compact ? (
                <CustomModal visible config={sheetConfig} onClose={close} />
            ) : props.open ? (
                <Popover
                    open
                    anchorRef={anchorRef}
                    autoFocusOnOpen
                    placement="bottom"
                    gap={8}
                    edgePadding={{ horizontal: 8, vertical: 8 }}
                    portal={{ web: true, native: true, matchAnchorWidth: false, anchorAlign: 'end' }}
                    maxWidthCap={CUSTOMIZE_POPOVER_WIDTH_PX}
                    maxHeightCap={CUSTOMIZE_POPOVER_MAX_HEIGHT_PX}
                    onRequestClose={close}
                >
                    {({ maxHeight, maxWidth }) => (
                        <View testID="home-hub.customize.popover">
                            <FloatingOverlay
                                maxHeight={Math.min(maxHeight, CUSTOMIZE_POPOVER_MAX_HEIGHT_PX)}
                                edgeFades={{ top: true, bottom: true, size: 18 }}
                                surfaceChrome="theme"
                                keyboardShouldPersistTaps="always"
                                containerStyle={{ width: Math.min(maxWidth, CUSTOMIZE_POPOVER_WIDTH_PX) }}
                            >
                                <HomeLayoutEditor presentation="popover" onAddWidgets={openAdd} />
                            </FloatingOverlay>
                        </View>
                    )}
                </Popover>
            ) : null}
            <HomeWidgetAddPopover open={addOpen} anchorRef={anchorRef} onRequestClose={closeAdd} testID="home-hub.add" />
        </View>
    );
});

const styles = StyleSheet.create({
    anchor: {
        flexShrink: 0,
    },
});
