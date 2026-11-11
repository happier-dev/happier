import * as React from 'react';
import { Platform, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { HappierPressable, happierFocusRingStyle } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { resolveMessageActionNeighbourGapPx } from './messageActionNeighbourGap';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/forms/dropdown/ContextMenu';
import { MessageActionIconButton } from './MessageActionIconButton';
import { SelectMessageButton } from '../messageSelection/SelectMessageButton';
import { useSessionTranscriptSource } from '../source/SessionTranscriptSourceContext';
import { MessageActionRow } from './MessageActionRow';
import { MessagePinButton } from './MessagePinButton';
import { PluginMessageActionsView } from './PluginMessageActions';
import { useCommittedMessageActions, type CommittedMessageAction, type CommittedMessageActionInput } from './useCommittedMessageActions';
import { SaveMessageAsPrompt } from './SaveMessageAsPrompt';
import { DiscussionSourceMarkers } from '@/components/discussions/SessionDiscussionSourceLinks';
import { SaveMemoryDecisionSheet } from '@/components/memory/SaveMemoryDecisionSheet';
import { seedMemoryDecisionFromMessage } from '@/components/memory/memoryDecisionSeed';
import type { SessionMessageRefV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageRefV1';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { promptCollectionItemHref } from '@/components/settings/prompts/collection/promptCollectionModel';
import { useWorkflowMakeRepeatable } from '@/components/workflows/authoring/useWorkflowMakeRepeatable';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import type { RowActionHoverHost } from './rowActionRevealHost';
import { isTranscriptRowBodyTap, openTranscriptRowTouchActions, toggleTranscriptRowTouchActions, useTranscriptRowNativeTap } from './transcriptRowTouchReveal';
import { ReadAloudReadinessSubscription } from './ReadAloudReadinessSubscription';

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
    /** On a touch host, the message key that a tap or long-press opens; null where hover reveals the row. */
    touchRevealKey: string | null;
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
    // Save as prompt and Save as decision open from the ⋯ (or the native hold), anchored to it.
    const overflowAnchorRef = React.useRef<View>(null);
    const [menuOpen, setMenuOpen] = React.useState(false);
    const [saveOpen, setSaveOpen] = React.useState(false);
    const [savedArtifactId, setSavedArtifactId] = React.useState<string | null>(null);
    const [decisionSeedSource, setDecisionSeedSource] = React.useState<SessionMessageRefV1 | null>(null);
    const [decisionSaved, setDecisionSaved] = React.useState(false);
    const { actions, pinAvailability, pluginActions, makeRepeatableSource, setMakeRepeatableCapability, committedMessage,
        observeReadAloudReadiness, setReadAloudReadiness } = useCommittedMessageActions({
        ...props, openSavePrompt: () => setSaveOpen(true), openSaveDecision: setDecisionSeedSource,
    }, { rowVisible: props.showActions, menuVisible: menuOpen });
    React.useEffect(() => { setSaveOpen(false); setMenuOpen(false); setSavedArtifactId(null); setDecisionSeedSource(null); setDecisionSaved(false); }, [props.message.id]);
    const availableActions = actions.filter((action) => action.available);
    const saveAvailable = availableActions.some((action) => action.id === 'savePrompt');
    React.useEffect(() => { if (!saveAvailable) setSaveOpen(false); }, [saveAvailable]);
    /** One menu row per action, for the native hold (every action) and the row's ⋯ (its overflow actions). */
    const toMenuItems = (list: readonly CommittedMessageAction[]): ContextMenuItem[] => list.flatMap((action) => action.menuItems
        ? [...action.menuItems]
        : action.id === 'pin' && props.settings.transcriptMessagePinActionEnabled === false
            ? [] : [{
                id: action.id, title: action.title,
                testID: `${actionTestIdPrefix(action.id)}:${props.message.id}`,
                disabled: action.disabled,
                icon: <Icon name={action.icon} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />,
                ...(action.id === 'savePrompt' ? { subtitle: t('committedMessageActions.savePromptHint') } : {}),
                ...(action.disabledReason ? { subtitle: action.disabledReason } : {}),
            }, ...(action.disabledRecovery ? [{
                id: `${action.id}:recovery`, title: action.disabledRecovery.title,
                icon: <Icon name="gear" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />,
            }] : [])]);
    const items = toMenuItems(availableActions);
    // A saved prompt or decision confirms in the row until the row is recycled.
    const savedInRow = (id: string) => (id === 'savePrompt' && savedArtifactId !== null) || (id === 'saveDecision' && decisionSaved);
    const rowActions = availableActions.filter((action) => action.id !== 'plugins' && action.id !== 'pin'
        && (action.placement === 'row' || savedInRow(action.id)));
    const overflowItems = toMenuItems(availableActions.filter((action) => action.id !== 'plugins'
        && action.placement === 'overflow' && !savedInRow(action.id)));
    // The gap to the neighbouring action (its `marginRight`) is split between the two hit areas.
    const actionGapPx = props.invertTimestampAndActions ? theme.space.s2 : theme.space.s6;
    const neighbourGapPx = resolveMessageActionNeighbourGapPx(theme);
    const hasNativeMenu = Platform.OS !== 'web' && items.length > 0;
    const touchRevealKey = props.touchRevealKey;
    // Native: a tap on the message itself opens its timestamp and actions (a link or control inside only presses
    // itself); a hold opens the same actions as a menu. The Tap never cancels the touches of views inside.
    const nativeTap = useTranscriptRowNativeTap(Platform.OS === 'web' ? null : touchRevealKey);
    const onNativeTapEnd = nativeTap.onTapEnd;
    const nativeGesture = React.useMemo(() => Gesture.Exclusive(
        Gesture.LongPress().enabled(hasNativeMenu).runOnJS(true).onStart(() => setMenuOpen(true)),
        Gesture.Tap().enabled(touchRevealKey !== null).cancelsTouchesInView(false).runOnJS(true)
            .onEnd((_event, success) => onNativeTapEnd(success)),
    ), [hasNativeMenu, touchRevealKey, onNativeTapEnd]);
    // Coarse-pointer web: a tap on the message body toggles it, a long-press (contextmenu) opens it.
    const webTouchProps = Platform.OS === 'web' && touchRevealKey !== null ? {
        onClick: (event: { target: unknown }) => {
            if (isTranscriptRowBodyTap(event.target, anchorRef.current)) toggleTranscriptRowTouchActions(touchRevealKey, anchorRef.current);
        },
        onContextMenu: () => openTranscriptRowTouchActions(touchRevealKey, anchorRef.current),
    } : null;
    const openActions = React.useCallback(() => {
        if (touchRevealKey !== null) openTranscriptRowTouchActions(touchRevealKey, anchorRef.current);
    }, [touchRevealKey]);
    const perform = (id: string) => {
        setMenuOpen(false);
        if (id.startsWith('plugin:')) {
            const action = pluginActions.menuActions.find((candidate) => `plugin:${candidate.qualifiedActionId}` === id);
            if (action) pluginActions.openAction(action);
            return;
        }
        const action = availableActions.find((candidate) => candidate.id === id);
        const recovery = availableActions.find((candidate) => `${candidate.id}:recovery` === id)?.disabledRecovery;
        if (recovery) { recovery.onPress(); return; }
        if (action && !action.disabled) void action.onPress();
    };
    // A pinned message keeps its pin in the row (the pinned state, and Unpin); Pin itself waits under ⋯.
    const pinAction = availableActions.find((action) => action.id === 'pin' && action.placement === 'row');
    const focusChange = (focused: boolean) => focused ? props.onActionsFocus() : props.onActionsBlur();
    const row = <MessageActionRow
        isWeb={Platform.OS === 'web'} messageId={props.message.id}
        showActions={props.showActions} showPinAction={props.showPinAction}
        pinAction={pinAction ? <MessagePinButton availability={pinAvailability} onTogglePin={props.onToggleMessagePin}
            testID={`transcript-message-pin:${props.message.id}`} invertedActionsLayout={props.invertTimestampAndActions}
            onFocusChange={focusChange} /> : null}
        onActionsFocus={props.onActionsFocus} onActionsBlur={props.onActionsBlur}
        onOpenActions={touchRevealKey !== null && !props.showActions ? openActions : undefined}
        timestampText={props.timestampText} timestampGlyph={props.timestampGlyph
            ? <Icon name={props.timestampGlyph} size={ICON_SIZE.xxs} color={theme.colors.text.tertiary} /> : undefined}
        invertTimestampAndActions={props.invertTimestampAndActions}
    >
        {rowActions.map((action) => {
            if (action.id === 'select') return <SelectMessageButton key={action.id} messageId={props.message.id}
                enabled visible role={props.selectableText?.role} previewText={props.selectableText?.text}
                testID={`transcript-message-select:${props.message.id}`} invertedActionsLayout={props.invertTimestampAndActions}
                onFocusChange={focusChange} />;
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
                <Icon name="seal-check" size={ICON_SIZE.xs} color={theme.colors.state.success.foreground} />
                <Text style={styles.savedText} numberOfLines={1}>{t('memoryContext.memory.savedAsDecision')}</Text>
            </View>;
            return <MessageActionIconButton key={action.id} testID={`${actionTestIdPrefix(action.id)}:${props.message.id}`}
                icon={action.icon}
                stateColor={action.id === 'copy' && action.icon === 'check' ? theme.colors.state.success.foreground : undefined}
                accessibilityLabel={action.title} accessibilityHint={action.accessibilityHint}
                disabled={action.disabled} disabledReason={action.disabledReason}
                onDisabledPress={action.disabledRecovery?.onPress}
                invertedActionsLayout={props.invertTimestampAndActions}
                onPress={action.onPress} onFocusChange={focusChange} />;
        })}
        <PluginMessageActionsView actions={pluginActions} invertedActionsLayout={props.invertTimestampAndActions}
            hostOverflowItems={overflowItems} onSelectHostOverflow={perform} overflowAnchorRef={overflowAnchorRef} />
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
            anchorRef={overflowAnchorRef} onClose={() => setSaveOpen(false)}
            onSaved={(artifactId) => { setSavedArtifactId(artifactId); setSaveOpen(false); }} /> : null}
        {decisionSeedSource && props.selectableText ? <SaveMemoryDecisionSheet
            seed={seedMemoryDecisionFromMessage(decisionSeedSource, props.selectableText.text)}
            anchorRef={overflowAnchorRef} onClose={() => setDecisionSeedSource(null)}
            onSaved={() => { setDecisionSeedSource(null); setDecisionSaved(true); }} /> : null}
    </>;
    return <>
        {observeReadAloudReadiness ? <ReadAloudReadinessSubscription onChange={setReadAloudReadiness} /> : null}
        {makeRepeatableSource ? <MakeRepeatableSubscription
            source={makeRepeatableSource} text={props.selectableText!.text} onChange={setMakeRepeatableCapability}
        /> : null}
        {Platform.OS === 'web' ? (
            <View ref={anchorRef} collapsable={false} {...props.hoverProps} {...webTouchProps}>
                {contents}
            </View>
        ) : (
            // A parent RN Pressable acquires the JS responder before a hesitant child scroll.
            // Keep the native host passive; RNGH recognizes a hold only after its native defaults
            // (500ms / 10pt movement) are met, without holding the child scroll's responder.
            <GestureDetector gesture={nativeGesture}>
                <View ref={anchorRef} collapsable={false} {...nativeTap.hostProps}>{contents}</View>
            </GestureDetector>
        )}
    </>;
}

/** The row and menu testID of each action (stable for tests and QA). */
function actionTestIdPrefix(id: CommittedMessageAction['id']): string {
    const name = id === 'savePrompt' ? 'save-prompt' : id === 'saveDecision' ? 'save-decision' : id === 'makeRepeatable' ? 'repeatable' : id;
    return `transcript-message-${name}`;
}

const styles = StyleSheet.create((theme) => ({
    saved: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, height: 28, paddingHorizontal: theme.space.s6, marginRight: theme.space.s6, borderRadius: 14 },
    savedPressed: { backgroundColor: theme.colors.surface.pressed },
    savedText: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
    savedLink: { color: theme.colors.text.link },
}));
