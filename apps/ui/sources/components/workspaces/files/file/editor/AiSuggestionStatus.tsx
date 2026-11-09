import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { t } from '@/text';

export type AiSuggestionFooterState = 'off' | 'signed_out' | 'rate_limited' | 'model_unavailable' | null;

/**
 * The footer's one reason, from the inline-suggestion operation's state (null: healthy, say nothing). An
 * operation that is merely not taking requests yet (the editor waiting for the person after a layout change)
 * reads "off" too, so the setting decides whether "AI suggestions off" is true.
 */
export function resolveAiSuggestionFooterState(
    snapshot: Readonly<{ status: 'off' | 'idle' | 'requesting' | 'ready' | 'unavailable'; reason?: string }>,
    settings: Readonly<{ enabled: boolean }>,
): AiSuggestionFooterState {
    if (snapshot.reason === 'excluded' || snapshot.reason === 'language_disabled') return 'off';
    if (snapshot.status === 'off') return settings.enabled ? null : 'off';
    if (snapshot.status !== 'unavailable') return null;
    if (snapshot.reason === 'signed_out' || snapshot.reason === 'account_unavailable') return 'signed_out';
    return snapshot.reason === 'rate_limited' ? 'rate_limited' : 'model_unavailable';
}

/** The controller supplies the reason; this quiet footer action opens its existing settings owner. */
export function AiSuggestionStatus(props: Readonly<{ state: AiSuggestionFooterState; onOpenSettings: () => void }>) {
    const label = props.state === 'off' ? t('files.editing.aiSuggestions.off')
        : props.state === 'signed_out' ? t('files.editing.aiSuggestions.signedOut')
            : props.state === 'rate_limited' ? t('files.editing.aiSuggestions.rateLimited')
                : props.state === 'model_unavailable' ? t('files.editing.aiSuggestions.modelUnavailable') : null;
    // The footer sits on the page's own edge-to-edge column, so it takes the page inset the File page's other lines keep.
    return label ? <View style={styles.footer}>
        <TextLinkButton testID="file-editor-ai-status" label={label} size="meta" tone="quiet" onPress={props.onOpenSettings} />
    </View> : null;
}

const styles = StyleSheet.create((theme) => ({
    footer: { alignItems: 'flex-start', paddingHorizontal: theme.space.s16 },
}));
