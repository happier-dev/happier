import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { usePressFeedback } from '@/components/ui/interaction/usePressFeedback';
import { Popover } from '@/components/ui/popover';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { readTranscriptQuoteSelection, type TranscriptQuoteSelection } from './readTranscriptQuoteSelection';
import type { TranscriptQuoteSelectionControlsProps } from './TranscriptQuoteSelectionControls';

/**
 * One floating Quote action for the current text selection inside this Session's transcript.
 * It appears once a pointer or keyboard selection settles inside a single quotable message, and
 * goes away when the selection collapses, leaves the transcript, or the page scrolls.
 */
export function TranscriptQuoteSelectionControls(props: TranscriptQuoteSelectionControlsProps): React.ReactElement | null {
    const { theme } = useUnistyles();
    const pressFeedback = usePressFeedback({ tone: 'control' });
    const { sessionId, onQuote } = props;
    const [selection, setSelection] = React.useState<TranscriptQuoteSelection | null>(null);

    React.useEffect(() => {
        if (!onQuote || typeof document === 'undefined') {
            setSelection(null);
            return;
        }
        let pointerDown = false;
        let settleFrame: number | null = null;
        const refresh = () => {
            setSelection(readTranscriptQuoteSelection(document.getSelection(), sessionId));
        };
        const handlePointerDown = () => {
            pointerDown = true;
        };
        const handlePointerUp = () => {
            pointerDown = false;
            // The browser finalizes a click/drag selection after pointerup.
            if (settleFrame !== null) cancelAnimationFrame(settleFrame);
            settleFrame = requestAnimationFrame(() => {
                settleFrame = null;
                refresh();
            });
        };
        // Keyboard selection and collapses; a pointer drag is read once it ends.
        const handleSelectionChange = () => {
            if (!pointerDown) refresh();
        };
        const handleScroll = () => setSelection(null);
        document.addEventListener('pointerdown', handlePointerDown, true);
        document.addEventListener('pointerup', handlePointerUp, true);
        document.addEventListener('selectionchange', handleSelectionChange);
        document.addEventListener('scroll', handleScroll, true);
        return () => {
            if (settleFrame !== null) cancelAnimationFrame(settleFrame);
            document.removeEventListener('pointerdown', handlePointerDown, true);
            document.removeEventListener('pointerup', handlePointerUp, true);
            document.removeEventListener('selectionchange', handleSelectionChange);
            document.removeEventListener('scroll', handleScroll, true);
            setSelection(null);
        };
    }, [onQuote, sessionId]);

    const handleQuote = React.useCallback(() => {
        if (!selection || !onQuote) return;
        document.getSelection()?.removeAllRanges();
        setSelection(null);
        onQuote(selection.text);
    }, [onQuote, selection]);

    if (!selection || !onQuote) return null;

    return (
        <Popover
            open
            anchor={{ kind: 'rect', rect: selection.rect, coordinateSpace: 'window' }}
            backdrop={false}
            placement="auto-vertical"
            gap={6}
            // Popover gives its box a fixed width (the cap); the surface below centers itself in it at its own size.
            maxWidthCap={QUOTE_ACTION_MAX_WIDTH}
            followScrollRef={null}
            portal={{ web: { target: 'body' }, matchAnchorWidth: false, anchorAlign: 'center' }}
        >
            {() => (
                <FloatingOverlay surfaceChrome="theme" scrollEnabled={false} containerStyle={styles.surface}>
                    <View style={styles.inset}>
                        <Pressable
                            testID="transcript-quote-selection-action"
                            accessibilityRole="button"
                            accessibilityLabel={t('transcript.quote.actionA11y')}
                            // Keep the transcript selection while the pointer is down on the action.
                            onPressIn={(event) => (event as unknown as { preventDefault?: () => void }).preventDefault?.()}
                            onPress={handleQuote}
                            // Hover and press tint the action, never dim it (the shared press-feedback owner).
                            style={(state) => [styles.action, { backgroundColor: pressFeedback.resolveBackgroundColor(state) }]}
                        >
                            <Icon name="quotes" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
                            <Text style={styles.label} numberOfLines={1}>{t('transcript.quote.action')}</Text>
                        </Pressable>
                    </View>
                </FloatingOverlay>
            )}
        </Popover>
    );
}

// Room for the longest localized label ("Цитировать") at larger text sizes; longer labels truncate.
const QUOTE_ACTION_MAX_WIDTH = 200;

// The floating overlay is rounded at 12: an action inset by 4 is rounded at 8, so the two stay concentric.
const styles = StyleSheet.create((theme) => ({
    surface: {
        alignSelf: 'center',
        maxWidth: '100%',
    },
    inset: {
        padding: 4,
    },
    action: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minHeight: 32,
        paddingHorizontal: 10,
        borderRadius: 8,
    },
    label: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
}));
