import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { useVoiceSurfaceModel } from '@/components/voice/surface/useVoiceSurfaceModel';

import { VoiceGlance } from './VoiceGlance';

/** The lab popover's width; it narrows to the window on a phone. */
const VOICE_GLANCE_POPOVER_WIDTH = 340;

const SURFACE_PROPS = Object.freeze({ variant: 'sidebar' as const });

/**
 * The Voice section, opened from a container (top-bar pill, island, orb) on a view without the
 * Companion beside it. Anchored to its container and non-modal: the work stays visible and live.
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

function OpenVoiceGlancePopover(props: Readonly<{
    anchorRef: React.RefObject<View | null>;
    placement: 'bottom' | 'top';
    onRequestClose: () => void;
    testID?: string;
}>): React.ReactElement | null {
    const model = useVoiceSurfaceModel(SURFACE_PROPS);
    if (!model) return null;
    return (
        <Popover
            open
            autoFocusOnOpen
            anchorRef={props.anchorRef}
            focusReturnRef={props.anchorRef}
            boundaryRef={null}
            placement={props.placement}
            gap={8}
            edgePadding={{ horizontal: 12, vertical: 12 }}
            portal={{ web: { target: 'body' }, native: true, matchAnchorWidth: false, anchorAlign: 'end' }}
            maxWidthCap={VOICE_GLANCE_POPOVER_WIDTH}
            backdrop={false}
            onRequestClose={props.onRequestClose}
        >
            {({ maxHeight, maxWidth }) => (
                <FloatingOverlay
                    maxHeight={maxHeight}
                    surfaceChrome="theme"
                    containerStyle={{ width: Math.min(maxWidth, VOICE_GLANCE_POPOVER_WIDTH) }}
                    keyboardShouldPersistTaps="always"
                >
                    <View style={styles.inset}>
                        <VoiceGlance model={model} presentation="popover" testID={props.testID ?? 'voice-glance-popover'} />
                    </View>
                </FloatingOverlay>
            )}
        </Popover>
    );
}

const styles = StyleSheet.create({
    inset: { paddingHorizontal: 14, paddingTop: 4, paddingBottom: 14 },
});
