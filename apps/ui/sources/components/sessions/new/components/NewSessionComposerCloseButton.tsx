import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AGENT_INPUT_QUIET_ICON_SIZE_PX } from '@/components/sessions/agentInput/components/agentInputChromeStyles';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveIconButtonGlyphSize } from '@/components/ui/icons/iconButtonGlyphSize';
import { OVERLAY_CAPSULE_ROW_HEIGHT } from '@/components/ui/overlays/OverlayCapsuleButton';
import { t } from '@/text';

/**
 * The new-session composer's own actions in its status row: leave and retract the keyboard (Look, where the
 * composer floats on its own, is `NewSessionComposerLookButton` on the same rule). The status row is the
 * card's header seated on the band's solid ground (Docked and the phone Modal alike), so they are the row's
 * quiet icons at the card's accessory size, never glass capsules: those earn their glass only over a live
 * picture.
 *
 * The composer carried a header close button when it was a sheet. Dropping the header is what makes it
 * read as a bare surface, but a backdrop tap alone is not a sufficient way out: an overlay whose only
 * dismissal is "tap somewhere that looks like nothing" is an accessibility gap and a known cause of
 * accidental dismissals. This close is that way out.
 */

/**
 * The height budget the bottom-anchored composer reserves for its status row above the input, so a long
 * draft never pushes the row (and the only visible way out) under the status bar.
 */
export const NEW_SESSION_CLOSE_ROW_HEIGHT = OVERLAY_CAPSULE_ROW_HEIGHT;

/**
 * The close glyph ends on the card's content edge, over the microphone's glyph: its square reaches past the
 * edge by the space around its glyph, as the field's accessories do inside the card.
 */
const TRAILING_GLYPH_BLEED_PX = (AGENT_INPUT_QUIET_ICON_SIZE_PX - resolveIconButtonGlyphSize(AGENT_INPUT_QUIET_ICON_SIZE_PX)) / 2;

/**
 * The row sits just above the card: the hit areas split the row's gap sideways and never reach down into
 * the card's own controls.
 */
export function useNewSessionStatusIconHitEdges() {
    const { theme } = useUnistyles();
    const half = theme.space.s10 / 2;
    return React.useMemo(() => ({ leading: half, trailing: half, bottom: 0 }), [half]);
}

export const NewSessionComposerCloseButton = React.memo(function NewSessionComposerCloseButton(
    props: Readonly<{ onPress: () => void }>,
): React.ReactElement {
    const edges = useNewSessionStatusIconHitEdges();
    return (
        <View style={styles.closeSeat}>
            <IconButton testID="new-session-composer-close" variant="plain" iconName="x" tooltipPlacement="top"
                size={AGENT_INPUT_QUIET_ICON_SIZE_PX} interactiveTargetEdgesPx={edges}
                accessibilityLabel={t('common.close')} tooltip={t('common.close')} onPress={props.onPress} />
        </View>
    );
});

/**
 * Retracts the keyboard without leaving the composer. A backdrop tap dismisses the whole floating composer,
 * so no gesture lowers the keyboard alone; this does, and exists only while the keyboard is up.
 */
export const NewSessionComposerKeyboardDismissButton = React.memo(
    function NewSessionComposerKeyboardDismissButton(
        props: Readonly<{ onPress: () => void }>,
    ): React.ReactElement {
        const edges = useNewSessionStatusIconHitEdges();
        return (
            <IconButton testID="new-session-composer-dismiss-keyboard" variant="plain" iconName="caret-down"
                tooltipPlacement="top" size={AGENT_INPUT_QUIET_ICON_SIZE_PX} interactiveTargetEdgesPx={edges}
                accessibilityLabel={t('common.dismissKeyboard')} tooltip={t('common.dismissKeyboard')}
                onPress={props.onPress} />
        );
    },
);

const styles = StyleSheet.create(() => ({
    closeSeat: { marginRight: -TRAILING_GLYPH_BLEED_PX },
}));
