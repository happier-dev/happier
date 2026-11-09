import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS, Popover } from '@/components/ui/popover';
import { t } from '@/text';

import { BrowserProfileStatus, type BrowserProfileStatusModel } from './BrowserProfileStatus';

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        padding: theme.space.s10,
        minWidth: 0,
        flexShrink: 1,
    },
}));

/**
 * B-RC5: compact privacy/security control for the browser toolbar. Replaces the
 * always-on "Mode / Storage / Permissions" triad with a single shield trigger
 * that opens a popover containing the full `BrowserProfileStatus` detail. Only
 * mounted when `shouldSurfaceBrowserPrivacy(model)` is true, so a clean browser
 * shows no profile chrome.
 */
export function BrowserPrivacyPopover(props: Readonly<{
    model: BrowserProfileStatusModel;
    testID: string;
}>): React.ReactElement {
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<View>(null);

    return (
        <>
            {/* A plain glyph like the rest of the chrome row — not a bordered tile around a glyph. */}
            <View ref={anchorRef} collapsable={false}>
                <IconButton
                    testID={props.testID}
                    iconName="shield-check"
                    variant="plain"
                    iconSize={ICON_SIZE.sm}
                    size={34}
                    accessibilityLabel={t('browserShell.privacy.title')}
                    tooltip={t('browserShell.privacy.title')}
                    tooltipHidden={open}
                    expanded={open}
                    hasPopup="dialog"
                    interactiveTargetGapPx={4}
                    onPress={() => setOpen((value) => !value)}
                />
            </View>
            {open ? (
                <Popover
                    open={open}
                    anchorRef={anchorRef}
                    placement="bottom"
                    gap={6}
                    maxHeightCap={420}
                    maxWidthCap={400}
                    onRequestClose={() => setOpen(false)}
                    backdrop={{ enabled: false }}
                    portal={MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS}
                >
                    {({ maxHeight }) => (
                        <FloatingOverlay maxHeight={maxHeight} surfaceChrome="theme" scrollEnabled={!props.model.management}>
                            <View testID={`${props.testID}-panel`} style={[stylesheet.body, { maxHeight }]}>
                                <BrowserProfileStatus
                                    testID={`${props.testID}-status`}
                                    model={props.model}
                                />
                            </View>
                        </FloatingOverlay>
                    )}
                </Popover>
            ) : null}
        </>
    );
}
