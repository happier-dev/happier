import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { useVoiceSurfaceModel, type VoiceSurfaceViewModel } from '@/components/voice/surface/useVoiceSurfaceModel';
import { t } from '@/text';

import { VoiceGlance } from './VoiceGlance';
import { useVoiceReadAloud } from './VoiceReadAloud';

/** The lab popover's width; it narrows to the window on a phone. */
const VOICE_GLANCE_POPOVER_WIDTH = 340;
/** The gutter kept clear of the window's edges; the popover's box carries it, so its cap includes both sides. */
const GLANCE_EDGE = 12;
/**
 * Mute and End close the glance's body, so a real request card (about 430 tall with its diff) must
 * not push them under the popover's default 400 cap. Same cap as the app's large popover; longer
 * content scrolls inside it.
 */
const VOICE_GLANCE_POPOVER_MAX_HEIGHT = 560;

const SURFACE_PROPS = Object.freeze({ variant: 'sidebar' as const });

/**
 * The Voice section, opened from a container (top-bar pill, island, orb) on a view without the
 * Companion beside it. Anchored to its container and non-modal: the work stays visible and live.
 * On a phone it is the lab's sheet instead (`As`): the app's bottom sheet, opaque, its grabber over
 * the glance's own Voice header, closed by the grabber, a drag, the scrim or the header's collapse.
 *
 * The surface model — transcript subscription included — mounts only while the popover is open,
 * so a closed container carries nothing but the attempt projection.
 */
export const VoiceGlancePopover = React.memo(function VoiceGlancePopover(props: Readonly<{
    open: boolean;
    anchorRef: React.RefObject<View | null>;
    placement: 'bottom' | 'top';
    onRequestClose: () => void;
    testID?: string;
}>): React.ReactElement | null {
    if (!props.open) return null;
    return <OpenVoiceGlancePopover {...props} />;
});

type VoiceGlanceOverlayProps = Readonly<{
    anchorRef: React.RefObject<View | null>;
    placement: 'bottom' | 'top';
    onRequestClose: () => void;
    testID?: string;
}>;

function OpenVoiceGlancePopover(props: VoiceGlanceOverlayProps): React.ReactElement | null {
    const model = useVoiceSurfaceModel(SURFACE_PROPS);
    if (!model) return null;
    return <VoiceGlanceOverlay {...props} model={model} />;
}

/** The overlay that hosts the glance for an open surface model: anchored popover, or phone sheet. */
export function VoiceGlanceOverlay(props: VoiceGlanceOverlayProps & Readonly<{ model: VoiceSurfaceViewModel }>): React.ReactElement {
    const { model } = props;
    const readAloud = useVoiceReadAloud();
    const testID = props.testID ?? 'voice-glance-popover';
    return (
        <Popover
            open
            phonePresentation="sheet"
            sheetHeader="none"
            sheetMaterial="solid"
            accessibilityLabel={t('voicePresence.title')}
            autoFocusOnOpen
            anchorRef={props.anchorRef}
            focusReturnRef={props.anchorRef}
            boundaryRef={null}
            placement={props.placement}
            gap={8}
            edgePadding={{ horizontal: GLANCE_EDGE, vertical: GLANCE_EDGE }}
            portal={{ web: { target: 'body' }, native: true, matchAnchorWidth: false, anchorAlign: 'end' }}
            maxWidthCap={VOICE_GLANCE_POPOVER_WIDTH + 2 * GLANCE_EDGE}
            maxHeightCap={VOICE_GLANCE_POPOVER_MAX_HEIGHT}
            backdrop={false}
            onRequestClose={props.onRequestClose}
        >
            {({ maxHeight, maxWidth, presentation, requestClose }) => presentation === 'sheet' ? (
                <View style={styles.sheetInset}>
                    <VoiceGlance
                        model={model}
                        presentation="sheet"
                        readAloud={readAloud}
                        testID={testID}
                        menu={(
                            <IconButton
                                testID={`${testID}-collapse`}
                                accessibilityLabel={t('common.collapse')}
                                iconName="caret-down"
                                variant="plain"
                                onPress={() => requestClose('dismiss')}
                            />
                        )}
                    />
                </View>
            ) : (
                <FloatingOverlay
                    maxHeight={maxHeight}
                    surfaceChrome="theme"
                    containerStyle={{ width: Math.min(maxWidth, VOICE_GLANCE_POPOVER_WIDTH) }}
                    keyboardShouldPersistTaps="always"
                >
                    <View style={styles.inset}>
                        <VoiceGlance model={model} presentation="popover" readAloud={readAloud} testID={testID} />
                    </View>
                </FloatingOverlay>
            )}
        </Popover>
    );
}

const styles = StyleSheet.create({
    // The plain frame already ends its body on the section's bottom inset; adding the popover's own
    // would leave twice the space under End as beside it.
    inset: { paddingHorizontal: 14, paddingTop: 4 },
    // Lab `.vo-sheet`: the glance sits 18 in from the sheet's edges; the sheet pads the safe area.
    sheetInset: { paddingHorizontal: 18, paddingBottom: 8 },
});
