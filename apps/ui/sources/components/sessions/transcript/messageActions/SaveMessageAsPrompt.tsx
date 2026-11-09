import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Popover } from '@/components/ui/popover';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { FavoriteToggleButton } from '@/components/ui/buttons/FavoriteToggleButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Text } from '@/components/ui/text/Text';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { useSaveMessageAsPrompt } from './useSaveMessageAsPrompt';

const POPOVER_WIDTH = 340;
const POPOVER_EDGE_PADDING = { horizontal: 12, vertical: 12 } as const;

type SaveProps = Readonly<{
    messageId: string;
    text: string;
    serverId?: string | null;
    onClose: () => void;
    onSaved: (artifactId: string) => void;
}>;

/** Mounted only on demand; both presentations use this exact form. */
export function SaveMessagePromptForm(props: SaveProps) {
    const { title, setTitle, favorite, setFavorite, shortcutExpanded, setShortcutExpanded, shortcut, setShortcut,
        error, setError, isSaving, canSave, save } = useSaveMessageAsPrompt({ text: props.text, serverId: props.serverId,
        onSaved: (saved) => props.onSaved(saved.artifactId) });
    return <View testID="save-message-prompt-form" style={styles.form}>
        <Text style={styles.heading} accessibilityRole="header">{t('committedMessageActions.savePrompt')}</Text>
        <FieldTextInput testID="save-message-prompt-name" accessibilityLabel={t('committedMessageActions.name')}
            value={title} onChangeText={setTitle} autoFocus selectTextOnFocus returnKeyType="done" onSubmitEditing={canSave ? save : undefined}
            trailing={<FavoriteToggleButton id={props.messageId} isFavorite={favorite} testID="save-message-prompt-favorite"
                addLabel={t('agentInput.promptPicker.addFavorite')} removeLabel={t('agentInput.promptPicker.removeFavorite')}
                onToggle={() => setFavorite((value) => !value)} />} />
        <Text style={styles.hint}>{t(favorite ? 'committedMessageActions.savedHintFavorite' : 'committedMessageActions.savedHint')}</Text>
        {shortcutExpanded ? <FieldTextInput testID="save-message-prompt-shortcut" accessibilityLabel={t('committedMessageActions.shortcut')}
            value={shortcut} onChangeText={(value) => { setError(null); setShortcut(value); }} autoCapitalize="none" monospace autoFocus
            // The shortcut is typed as `/token` everywhere else (picker badges, composer): the field shows the slash it continues.
            leading={<Text style={styles.shortcutSlash}>/</Text>}
            placeholder={t('committedMessageActions.shortcutPlaceholder')} returnKeyType="done" onSubmitEditing={canSave ? save : undefined} />
            : <View style={styles.shortcutToggle}>
                <TextLinkButton testID="save-message-prompt-shortcut-toggle" size="meta" expanded={false}
                    label={t('committedMessageActions.addShortcut')} onPress={() => setShortcutExpanded(true)} />
            </View>}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <View style={styles.buttons}>
            <RoundButton testID="save-message-prompt-cancel" size="small" display="inverted" title={t('common.cancel')} onPress={props.onClose} />
            <RoundButton testID="save-message-prompt-save" size="small" title={t('common.save')} disabled={!canSave} loading={isSaving} action={save} />
        </View>
    </View>;
}

function SaveMessagePromptSheet(props: Omit<SaveProps, 'onClose'> & Readonly<{ onCancel: () => void }> & CustomModalInjectedProps) {
    return <SaveMessagePromptForm {...props} onClose={() => { props.onCancel(); props.onClose(); }} />;
}

export function SaveMessageAsPrompt(props: SaveProps & Readonly<{ anchorRef: React.RefObject<View | null> }>) {
    const native = Platform.OS !== 'web';
    React.useEffect(() => {
        if (!native) return;
        const modalId = Modal.show({ component: SaveMessagePromptSheet,
            props: { messageId: props.messageId, text: props.text, serverId: props.serverId,
                onSaved: props.onSaved, onCancel: props.onClose }, onRequestClose: props.onClose,
            chrome: { kind: 'card', header: 'none', title: t('committedMessageActions.savePrompt'), phonePresentation: 'sheet' },
        });
        return () => Modal.hide(modalId);
    }, [native, props.messageId]);
    if (native) return null;
    // Opens beside the row that summoned it, never over the message being named; its trailing edge
    // stays on the icon because user rows sit at the right.
    // The popover keeps the same inset from the window edges as the app's other anchored popovers, so on a
    // phone-width window it never touches the screen edge.
    return <Popover open anchorRef={props.anchorRef} placement="auto-vertical" maxWidthCap={POPOVER_WIDTH}
        edgePadding={POPOVER_EDGE_PADDING}
        portal={{ web: true, native: true, matchAnchorWidth: false, anchorAlign: 'end' }} onRequestClose={props.onClose}>
        {({ maxHeight }) => <FloatingOverlay surfaceChrome="theme" maxHeight={maxHeight}>
            <View style={styles.popoverBody}><SaveMessagePromptForm {...props} /></View>
        </FloatingOverlay>}
    </Popover>;
}

const styles = StyleSheet.create((theme) => ({
    form: { padding: theme.space.s16, gap: theme.space.s10 },
    popoverBody: { width: POPOVER_WIDTH, maxWidth: '100%' },
    heading: { ...Typography.variant('label', 'semiBold'), color: theme.colors.text.primary, marginBottom: theme.space.s2 },
    hint: { ...Typography.variant('meta'), color: theme.colors.text.secondary, marginTop: -4 },
    shortcutToggle: { alignSelf: 'flex-start' },
    shortcutSlash: { ...Typography.mono(), color: theme.colors.text.tertiary },
    buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: theme.space.s8, marginTop: theme.space.s4 },
    error: { ...Typography.variant('meta'), color: theme.colors.state.danger.foreground },
}));
