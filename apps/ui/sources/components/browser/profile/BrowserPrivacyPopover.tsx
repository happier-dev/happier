import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS, Popover } from '@/components/ui/popover';
import { t } from '@/text';

import { BrowserProfileStatus, type BrowserProfileStatusModel } from './BrowserProfileStatus';
import { Icon } from '@/components/ui/icons/Icon';

const stylesheet = StyleSheet.create((theme) => ({
    trigger: {
        width: 34,
        // `minHeight`, not `height`. Q2 measured that the app's `uiFontScale` GROWS the line box —
        // a fixed-height container is what actually clips scaled text, not a missing `lineHeight`.
        minHeight: 34,
        borderRadius: 6,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    body: {
        padding: 10,
        minWidth: 0,
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
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<View>(null);

    return (
        <>
            <Pressable
                ref={anchorRef}
                testID={props.testID}
                accessibilityRole="button"
                accessibilityLabel={t('browserShell.privacy.title')}
                accessibilityState={{ expanded: open }}
                onPress={() => setOpen((value) => !value)}
                style={stylesheet.trigger}
            >
                <Icon name="shield-check" size={16} color={theme.colors.text.primary} />
            </Pressable>
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
                        <FloatingOverlay maxHeight={maxHeight} surfaceChrome="theme">
                            <View testID={`${props.testID}-panel`} style={stylesheet.body}>
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
