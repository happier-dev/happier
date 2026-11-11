import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { AGENT_INPUT_QUIET_ICON_SIZE_PX } from '@/components/sessions/agentInput/components/agentInputChromeStyles';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveIconButtonGlyphSize } from '@/components/ui/icons/iconButtonGlyphSize';
import { useStatusRowIconHitEdges } from '@/components/sessions/agentInput/instrumentStrip/useStatusRowIconHitEdges';
import { t } from '@/text';

/**
 * The new-session composer's own way out in its status row (Look, where the composer floats on its own, is
 * `NewSessionComposerLookButton` on the same rule; the keyboard's controls are the composer's own accessory). The status row is the
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
 * The close glyph ends on the card's content edge, over the microphone's glyph: its square reaches past the
 * edge by the space around its glyph, as the field's accessories do inside the card.
 */
const TRAILING_GLYPH_BLEED_PX = (AGENT_INPUT_QUIET_ICON_SIZE_PX - resolveIconButtonGlyphSize(AGENT_INPUT_QUIET_ICON_SIZE_PX)) / 2;

export const NewSessionComposerCloseButton = React.memo(function NewSessionComposerCloseButton(
    props: Readonly<{ onPress: () => void }>,
): React.ReactElement {
    const edges = useStatusRowIconHitEdges();
    return (
        <View style={styles.closeSeat}>
            <IconButton testID="new-session-composer-close" variant="plain" iconName="x" tooltipPlacement="top"
                size={AGENT_INPUT_QUIET_ICON_SIZE_PX} interactiveTargetEdgesPx={edges}
                accessibilityLabel={t('common.close')} tooltip={t('common.close')} onPress={props.onPress} />
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    closeSeat: { marginRight: -TRAILING_GLYPH_BLEED_PX },
}));
