import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/forms/dropdown/ContextMenu';
import { SelectMessageButton } from '../messageSelection/SelectMessageButton';
import { useSessionTranscriptSource } from '../source/SessionTranscriptSourceContext';
import { MessageActionRow } from './MessageActionRow';
import { MessagePinButton } from './MessagePinButton';
import { PluginMessageActionsView } from './PluginMessageActions';
import { useCommittedMessageActions, type CommittedMessageActionInput } from './useCommittedMessageActions';
import { SaveMessageAsPrompt } from './SaveMessageAsPrompt';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { promptCollectionItemHref } from '@/components/settings/prompts/collection/promptCollectionModel';

type Props = Omit<CommittedMessageActionInput, 'openSavePrompt'> & Readonly<{
    showActions: boolean;
    showPinAction: boolean;
    timestampText: string | null;
    invertTimestampAndActions: boolean;
    onActionsFocus: () => void;
    onActionsBlur: () => void;
    onHoverIn?: () => void;
    onHoverOut?: () => void;
    onActionHoverIn?: () => void;
    onActionHoverOut?: () => void;
    children: (row: React.ReactNode) => React.ReactNode;
}>;

/** The committed row and its native long-press menu share the same admitted actions. */
export function CommittedMessageActions(props: Props) {
    const { theme } = useUnistyles();
    const source = useSessionTranscriptSource();
    const anchorRef = React.useRef<View>(null);
    const saveAnchorRef = React.useRef<View>(null);
    const [menuOpen, setMenuOpen] = React.useState(false);
    const [saveOpen, setSaveOpen] = React.useState(false);
    const [savedArtifactId, setSavedArtifactId] = React.useState<string | null>(null);
    const { actions, pinAvailability, pluginActions } = useCommittedMessageActions({
        ...props, openSavePrompt: () => setSaveOpen(true),
    });
    React.useEffect(() => { setSaveOpen(false); setMenuOpen(false); setSavedArtifactId(null); }, [props.message.id]);
    const availableActions = actions.filter((action) => action.available);
    const saveAvailable = availableActions.some((action) => action.id === 'savePrompt');
    React.useEffect(() => { if (!saveAvailable) setSaveOpen(false); }, [saveAvailable]);
    const items: ContextMenuItem[] = availableActions.flatMap((action) => action.menuItems
        ? [...action.menuItems]
        : action.id === 'pin' && props.settings.transcriptMessagePinActionEnabled === false
            ? [] : [{
                id: action.id, title: action.title,
                icon: <Icon name={action.icon} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />,
                ...(action.id === 'savePrompt' ? { subtitle: t('committedMessageActions.savePromptHint') } : {}),
            }]);
    const perform = (id: string) => {
        setMenuOpen(false);
        if (id.startsWith('plugin:')) {
            const action = pluginActions.menuActions.find((candidate) => `plugin:${candidate.qualifiedActionId}` === id);
            if (action) pluginActions.openAction(action);
            return;
        }
        const action = availableActions.find((candidate) => candidate.id === id);
        if (action) void action.onPress();
    };
    const pinAction = availableActions.find((action) => action.id === 'pin');
    const row = <MessageActionRow
        isWeb={Platform.OS === 'web'} messageId={props.message.id}
        showActions={props.showActions} showPinAction={props.showPinAction}
        pinAction={pinAction ? <MessagePinButton availability={pinAvailability} onTogglePin={props.onToggleMessagePin}
            testID={`transcript-message-pin:${props.message.id}`} invertedActionsLayout={props.invertTimestampAndActions}
            onHoverIn={props.onActionHoverIn} onHoverOut={props.onActionHoverOut} /> : null}
        onActionsFocus={props.onActionsFocus} onActionsBlur={props.onActionsBlur}
        timestampText={props.timestampText} invertTimestampAndActions={props.invertTimestampAndActions}
    >
        {availableActions.filter((action) => action.id !== 'pin').map((action) => {
            if (action.id === 'plugins') return <PluginMessageActionsView key={action.id} actions={pluginActions} invertedActionsLayout={props.invertTimestampAndActions} />;
            if (action.id === 'select') return <SelectMessageButton key={action.id} messageId={props.message.id}
                enabled visible role={props.selectableText?.role} previewText={props.selectableText?.text}
                testID={`transcript-message-select:${props.message.id}`} invertedActionsLayout={props.invertTimestampAndActions}
                onHoverIn={props.onActionHoverIn} onHoverOut={props.onActionHoverOut} />;
            if (action.id === 'savePrompt' && savedArtifactId) return <Pressable key={action.id}
                testID={`transcript-message-saved-prompt:${props.message.id}`} accessibilityRole="button"
                accessibilityLabel={t('committedMessageActions.savedOpen')}
                onPress={() => source.navigate?.(promptCollectionItemHref('doc', savedArtifactId))}
                style={({ pressed }) => [styles.saved, pressed ? styles.savedPressed : null]}>
                <Icon name="check" size={ICON_SIZE.xs} color={theme.colors.state.success.foreground} />
                <Text style={styles.savedText} numberOfLines={1}>
                    {t('committedMessageActions.savedToLibrary')}{' · '}<Text style={styles.savedLink}>{t('common.open')}</Text>
                </Text>
            </Pressable>;
            return <View key={action.id} ref={action.id === 'savePrompt' ? saveAnchorRef : undefined} collapsable={false}
                style={props.invertTimestampAndActions ? styles.inverted : styles.button}><IconButton testID={`transcript-message-${action.id === 'savePrompt' ? 'save-prompt' : action.id === 'makeRepeatable' ? 'repeatable' : action.id}:${props.message.id}`}
                size={Platform.OS === 'web' ? 28 : resolveMinimumInteractiveTargetSize(Platform.OS)}
                icon={<Icon name={action.icon} size={ICON_SIZE.xs} color={action.id === 'copy' && action.icon === 'check'
                    ? theme.colors.state.success.foreground : theme.colors.text.secondary} />}
                accessibilityLabel={action.title}
                accessibilityHint={action.accessibilityHint}
                tooltip={action.title} minimumInteractiveTargetSize={resolveMinimumInteractiveTargetSize(Platform.OS)}
                variant="plain" onPress={action.onPress}
                onFocusChange={(focused) => focused ? props.onActionsFocus() : props.onActionsBlur()}
            /></View>;
        })}
    </MessageActionRow>;
    return <Pressable ref={anchorRef} collapsable={false}
        onHoverIn={props.onHoverIn} onHoverOut={props.onHoverOut}
        onLongPress={Platform.OS !== 'web' && items.length > 0 ? () => setMenuOpen(true) : undefined}>
        {props.children(row)}
        {Platform.OS !== 'web' && items.length > 0 ? <ContextMenu
            open={menuOpen} onOpenChange={setMenuOpen} anchorRef={anchorRef}
            items={items} onSelect={perform} placement="auto" variant="slim" showCategoryTitles={false}
        /> : null}
        {saveOpen && saveAvailable ? <SaveMessageAsPrompt
            messageId={props.message.id} text={props.selectableText!.text} serverId={props.serverId ?? source.serverId}
            anchorRef={saveAnchorRef} onClose={() => setSaveOpen(false)}
            onSaved={(artifactId) => { setSavedArtifactId(artifactId); setSaveOpen(false); }} /> : null}
    </Pressable>;
}

const styles = StyleSheet.create((theme) => ({
    button: { marginRight: 6 },
    inverted: { marginRight: 2 },
    saved: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 28, paddingHorizontal: 6, marginRight: 6, borderRadius: 14 },
    savedPressed: { backgroundColor: theme.colors.surface.pressed },
    savedText: { ...Typography.rowMeta(), color: theme.colors.text.secondary },
    savedLink: { color: theme.colors.text.link },
}));
