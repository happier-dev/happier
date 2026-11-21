import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS, Popover } from '@/components/ui/popover';
import { t } from '@/text';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';

import { BrowserProfileStatus, type BrowserProfileStatusModel } from './BrowserProfileStatus';

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        paddingVertical: theme.space.s6,
        minWidth: 0,
        flexShrink: 1,
    },
}));

/**
 * The browser toolbar's privacy control: a shield that opens which profile this browser uses and what it
 * keeps, with the Machine's saved profiles below (a sheet on a phone). Only mounted when
 * `shouldSurfaceBrowserPrivacy(model)` is true, so a clean browser shows no profile chrome.
 */
export function BrowserPrivacyPopover(props: Readonly<{
    model: BrowserProfileStatusModel;
    testID: string;
}>): React.ReactElement {
    const [open, setOpen] = React.useState(false);
    const anchorRef = React.useRef<View>(null);
    const commands = useCurrentUiContextLocalCommands([
        { key: 'open', title: t('browserShell.privacy.title'), invoke: () => {
            setOpen(true);
            return { ok: true, result: {
                profileId: props.model.profile?.profileId ?? null,
                storageMode: props.model.profile?.storageMode ?? null,
                storagePersistence: props.model.storagePartition?.persistence ?? null,
                activePermissionGrantCount: props.model.activePermissionGrantCount ?? null,
                permissionState: props.model.permissionState ?? null,
            } };
        } },
        ...(open ? [{ key: 'close', title: t('common.close'), description: t('browserShell.privacy.title'), invoke: () => setOpen(false) }] : []),
    ], { contextKey: props.model.profile?.profileId, unbound: 'local' });

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
                    onPress={() => { void commands.invoke(open ? 'close' : 'open'); }}
                />
            </View>
            {open ? (
                <Popover
                    open={open}
                    anchorRef={anchorRef}
                    placement="bottom"
                    gap={6}
                    maxHeightCap={480}
                    maxWidthCap={360}
                    onRequestClose={() => { void commands.invoke('close'); }}
                    backdrop={{ enabled: false }}
                    // A phone gets the shared bottom sheet, titled by what it is about.
                    phonePresentation="sheet"
                    accessibilityLabel={t('browserShell.profile.title')}
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
