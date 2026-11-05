import * as React from 'react';
import { Platform, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { HappierPressable, happierFocusRingStyle } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { resolveMessageActionNeighbourGapPx } from './messageActionNeighbourGap';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/forms/dropdown/ContextMenu';
import { SelectMessageButton } from '../messageSelection/SelectMessageButton';
import { useSessionTranscriptSource } from '../source/SessionTranscriptSourceContext';
import { MessageActionRow } from './MessageActionRow';
import { MessagePinButton } from './MessagePinButton';
import { PluginMessageActionsView } from './PluginMessageActions';
import { useCommittedMessageActions, type CommittedMessageActionInput } from './useCommittedMessageActions';
import { SaveMessageAsPrompt } from './SaveMessageAsPrompt';
import { DiscussionSourceMarkers } from '@/components/discussions/SessionDiscussionSourceLinks';
import { SaveMemoryDecisionSheet, seedMemoryDecisionFromMessage } from '@/components/memory/SaveMemoryDecisionSheet';
import type { SessionMessageRefV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageRefV1';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { promptCollectionItemHref } from '@/components/settings/prompts/collection/promptCollectionModel';
import { useWorkflowMakeRepeatable } from '@/components/workflows/authoring/useWorkflowMakeRepeatable';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import type { RowActionHoverHost } from './rowActionRevealHost';

type Props = Omit<CommittedMessageActionInput, 'openSavePrompt' | 'openSaveDecision'> & Readonly<{
    showActions: boolean;
    showPinAction: boolean;
    timestampText: string | null;
    /** A glyph that leads the timestamp line (the Voice planet on a spoken turn's marker). */
    timestampGlyph?: IconName;
    invertTimestampAndActions: boolean;
    onActionsFocus: () => void;
    onActionsBlur: () => void;
    hoverProps?: RowActionHoverHost['hoverProps'];
    onActionHoverIn?: () => void;
    onActionHoverOut?: () => void;
    children: (row: React.ReactNode) => React.ReactNode;
}>;

/** Only an eligible committed action mounts workflow availability subscriptions. */
function MakeRepeatableSubscription(props: Readonly<{
    source: NonNullable<ReturnType<typeof useCommittedMessageActions>['makeRepeatableSource']>;
    text: string;
    onChange: ReturnType<typeof useCommittedMessageActions>['setMakeRepeatableCapability'];
}>) {
    const repeatable = useWorkflowMakeRepeatable({
        sessionId: props.source.sessionId, serverId: props.source.serverId,
        message: { id: props.source.messageId, text: props.text },
    });
    // Refresh the committed text closure without a publication/render wave for each text delta.
    const openRepeatable = useEventCallback(async () => { await repeatable.openRepeatable(); });
    React.useLayoutEffect(() => {
        props.onChange(repeatable.available ? { source: props.source, available: true, openRepeatable } : null);
        return () => props.onChange(null);
    }, [props.onChange, props.source, repeatable.available, openRepeatable]);
    return null;
}

/** The committed row and its native long-press menu share the same admitted actions. */
export function CommittedMessageActions(props: Props) {
    const { theme } = useUnistyles();
    const source = useSessionTranscriptSource();
    const anchorRef = React.useRef<View>(null);
    const saveAnchorRef = React.useRef<View>(null);
    const [menuOpen, setMenuOpen] = React.useState(false);
    const [saveOpen, setSaveOpen] = React.useState(false);
    const [savedArtifactId, setSavedArtifactId] = React.useState<string | null>(null);
    const decisionAnchorRef = React.useRef<View>(null);
    const [decisionSeedSource, setDecisionSeedSource] = React.useState<SessionMessageRefV1 | null>(null);
    const [decisionSaved, setDecisionSaved] = React.useState(false);
    const { actions, pinAvailability, pluginActions, makeRepeatableSource, setMakeRepeatableCapability, committedMessage } = useCommittedMessageActions({
        ...props, openSavePrompt: () => setSaveOpen(true), openSaveDecision: setDecisionSeedSource,
    }, { rowVisible: props.showActions, menuVisible: menuOpen });
    React.useEffect(() => { setSaveOpen(false); setMenuOpen(false); setSavedArtifactId(null); setDecisionSeedSource(null); setDecisionSaved(false); }, [props.message.id]);
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
    // The gap to the neighbouring action (its `marginRight`) is split between the two hit areas.
    const actionGapPx = props.invertTimestampAndActions ? theme.space.s2 : theme.space.s6;
    const neighbourGapPx = resolveMessageActionNeighbourGapPx(theme);
    const hasNativeMenu = Platform.OS !== 'web' && items.length > 0;
    const nativeMenuHold = React.useMemo(() => Gesture.LongPress()
        .enabled(hasNativeMenu)
        .runOnJS(true)
        .onStart(() => setMenuOpen(true)), [hasNativeMenu]);
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
        timestampText={props.timestampText} timestampGlyph={props.timestampGlyph
            ? <Icon name={props.timestampGlyph} size={ICON_SIZE.xxs} color={theme.colors.text.tertiary} /> : undefined}
        invertTimestampAndActions={props.invertTimestampAndActions}
    >
        {availableActions.filter((action) => action.id !== 'pin').map((action) => {
            if (action.id === 'plugins') return <PluginMessageActionsView key={action.id} actions={pluginActions} invertedActionsLayout={props.invertTimestampAndActions} />;
            if (action.id === 'select') return <SelectMessageButton key={action.id} messageId={props.message.id}
                enabled visible role={props.selectableText?.role} previewText={props.selectableText?.text}
                testID={`transcript-message-select:${props.message.id}`} invertedActionsLayout={props.invertTimestampAndActions}
                onHoverIn={props.onActionHoverIn} onHoverOut={props.onActionHoverOut} />;
            if (action.id === 'savePrompt' && savedArtifactId) return <HappierPressable key={action.id}
                testID={`transcript-message-saved-prompt:${props.message.id}`} accessibilityRole="button"
                accessibilityLabel={t('committedMessageActions.savedOpen')}
                onPress={() => source.navigate?.(promptCollectionItemHref('doc', savedArtifactId))}
                hitReach={{ left: actionGapPx / 2, right: actionGapPx / 2, top: neighbourGapPx / 2, bottom: neighbourGapPx / 2 }}
                style={({ pressed, focused }) => [styles.saved, pressed ? styles.savedPressed : null,
                    happierFocusRingStyle({ visible: focused, color: theme.colors.border.focus })]}>
                <Icon name="check" size={ICON_SIZE.xs} color={theme.colors.state.success.foreground} />
                <Text style={styles.savedText} numberOfLines={1}>
                    {t('committedMessageActions.savedToLibrary')}{' · '}<Text style={styles.savedLink}>{t('common.open')}</Text>
                </Text>
            </HappierPressable>;
            if (action.id === 'saveDecision' && decisionSaved) return <View key={action.id} testID={`transcript-message-saved-decision:${props.message.id}`}
                style={styles.saved} accessibilityLiveRegion="polite">
                <Icon name="check" size={ICON_SIZE.xs} color={theme.colors.state.success.foreground} />
                <Text style={styles.savedText} numberOfLines={1}>{t('memoryContext.memory.savedAsDecision')}</Text>
            </View>;
            return <View key={action.id} ref={action.id === 'savePrompt' ? saveAnchorRef : action.id === 'saveDecision' ? decisionAnchorRef : undefined} collapsable={false}
                style={props.invertTimestampAndActions ? styles.inverted : styles.button}><IconButton testID={`transcript-message-${action.id === 'savePrompt' ? 'save-prompt' : action.id === 'saveDecision' ? 'save-decision' : action.id === 'makeRepeatable' ? 'repeatable' : action.id}:${props.message.id}`}
                size={28}
                icon={<Icon name={action.icon} size={ICON_SIZE.xs} color={action.id === 'copy' && action.icon === 'check'
                    ? theme.colors.state.success.foreground : theme.colors.text.secondary} />}
                accessibilityLabel={action.title}
                accessibilityHint={action.accessibilityHint}
                tooltip={action.title} interactiveTargetGapPx={actionGapPx} interactiveTargetVerticalGapPx={neighbourGapPx}
                variant="plain" onPress={action.onPress}
                onFocusChange={(focused) => focused ? props.onActionsFocus() : props.onActionsBlur()}
            /></View>;
        })}
    </MessageActionRow>;
    // A Discussion started on this answer (lab T3-D) stays under the answer, ahead of its hover actions.
    const markers = <DiscussionSourceMarkers source={committedMessage} navigate={source.navigate} />;
    const contents = <>
        {props.children(<>{markers}{row}</>)}
        {hasNativeMenu ? <ContextMenu
            open={menuOpen} onOpenChange={setMenuOpen} anchorRef={anchorRef}
            items={items} onSelect={perform} placement="auto" variant="slim" showCategoryTitles={false}
        /> : null}
        {saveOpen && saveAvailable ? <SaveMessageAsPrompt
            messageId={props.message.id} text={props.selectableText!.text} serverId={props.serverId ?? source.serverId}
            anchorRef={saveAnchorRef} onClose={() => setSaveOpen(false)}
            onSaved={(artifactId) => { setSavedArtifactId(artifactId); setSaveOpen(false); }} /> : null}
        {decisionSeedSource && props.selectableText ? <SaveMemoryDecisionSheet
            seed={seedMemoryDecisionFromMessage(decisionSeedSource, props.selectableText.text)}
            anchorRef={decisionAnchorRef} onClose={() => setDecisionSeedSource(null)}
            onSaved={() => { setDecisionSeedSource(null); setDecisionSaved(true); }} /> : null}
    </>;
    return <>
        {makeRepeatableSource ? <MakeRepeatableSubscription
            source={makeRepeatableSource} text={props.selectableText!.text} onChange={setMakeRepeatableCapability}
        /> : null}
        {Platform.OS === 'web' ? (
            <View ref={anchorRef} collapsable={false} {...props.hoverProps}>
                {contents}
            </View>
        ) : (
            // A parent RN Pressable acquires the JS responder before a hesitant child scroll.
            // Keep the native host passive; RNGH recognizes a hold only after its native defaults
            // (500ms / 10pt movement) are met, without holding the child scroll's responder.
            <GestureDetector gesture={nativeMenuHold}>
                <View ref={anchorRef} collapsable={false}>{contents}</View>
            </GestureDetector>
        )}
    </>;
}

const styles = StyleSheet.create((theme) => ({
    button: { marginRight: theme.space.s6 },
    inverted: { marginRight: theme.space.s2 },
    saved: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, height: 28, paddingHorizontal: theme.space.s6, marginRight: theme.space.s6, borderRadius: 14 },
    savedPressed: { backgroundColor: theme.colors.surface.pressed },
    savedText: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
    savedLink: { color: theme.colors.text.link },
}));
