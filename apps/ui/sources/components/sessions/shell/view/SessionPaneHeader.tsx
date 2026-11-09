import * as React from 'react';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { readHappierVisibleLayoutWidth } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, type HappierFocusable } from '@happier-dev/plugin-ui/presentation';

import { DetailsTabHeader, type DetailsTabHeaderAction } from '@/components/appShell/panes/details/header/DetailsTabHeader';
import { SessionHeaderPullHost, SessionHeaderPullTarget } from '@/components/sessions/shell/SessionHeaderPull';
import { resolveOptionalSessionScreenTestId, useSessionScreenTestIdsEnabled } from '@/components/sessions/shell/sessionScreenTestIds';
import { executeSessionLifecycleAction } from '@/components/sessions/actions/sessionActionExecution';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import { SessionBotFaceMark } from '@/components/sessions/bots/SessionBotFaceMark';
import type { SessionBotFaceFacts } from '@/components/sessions/bots/face/sessionBotFaceFacts';
import type { BotActivity } from '@/components/sessions/bots/botActivity';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { HEADER_BAND_SUBTITLE_TEXT, HEADER_BAND_TITLE_TEXT } from '@/components/ui/layout/headerBand';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { PaneMainBody } from '@/components/ui/panels/paneMainComposerAnchor';
import { Text, TextInput } from '@/components/ui/text/Text';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Typography } from '@/constants/Typography';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { SessionHeaderTitleAccessoryCompactContext } from './sessionHeaderTitleCompact';

export type SessionPaneHeaderProps = Readonly<{
    title: string;
    /** A summary-only control beside the title (the role chip); detailed readers mount only after it opens. */
    titleAccessory?: React.ReactNode;
    /** Where the session runs: folder · machine (or a path), from the canonical display owner. */
    subtitle?: string;
    /** `head` keeps a path's end (the folder that tells sessions apart) when it truncates. */
    subtitleEllipsizeMode?: 'head' | 'tail';
    badges?: ReadonlyArray<string>;
    avatarId?: string;
    /** A Bot's face; drawn in the avatar slot in place of the generic avatar. */
    botFace?: SessionBotFaceFacts | null;
    /** The Bot's state, shown in its mouth; a Bot keeps its colour while it sleeps (lab R6 header). */
    botActivity?: BotActivity;
    /** Canonical machine-scoped Agent identity mark, shown in place of the avatar on request. */
    agentIdentity?: React.ReactNode;
    isConnected?: boolean;
    flavor?: string | null;
    /** The leads above a reporting Session, over the title (a leaf that draws nothing for a root). */
    lineage?: React.ReactNode;
    /** The header's controls: Next, attention, Follow, ⋯, the pane's Hide. */
    rightElement?: React.ReactNode;
    /** A phone screen's Back; absent beside a permanent sidebar, where there is no stack to pop. */
    onBackPress?: () => void;
    showBackButton?: boolean;
    includeTopInset?: boolean;
    /** Phone: pulling the identity or title down opens All tabs. */
    onPullAllTabs?: () => void;
    /**
     * Desktop: the title is the rename field (click it, or focus it and press Enter), written through the
     * same `session.title.set` Action menu Rename uses. Absent where the title cannot be renamed.
     */
    rename?: Readonly<{ sessionId: string; serverId: string | null }>;
    /** A Bot whose face this person may change: its face opens the face chooser (`session.bot.face.set`). */
    editBotFace?: Readonly<{ sessionId: string; serverId: string | null }>;
}>;

/**
 * The Session page's header (calm-shell `cshead.H1`/`H1p`): a data and interaction leaf over the one
 * entity header (`DetailsTabHeader` → `PaneHeader`). It chooses the identity mark from the person's
 * setting, composes the title with its role chip, lineage above it and folder · machine beneath, and
 * hands the controls to the band, which keeps them beside the title and compacts them when room is short.
 */
export const SessionPaneHeader = React.memo(function SessionPaneHeader(props: SessionPaneHeaderProps) {
    const { theme } = useUnistyles();
    const identityMode = useSetting('sessionHeaderIdentityDisplay');
    const testIdsEnabled = useSessionScreenTestIdsEnabled();
    const isConnected = props.isConnected ?? true;
    const editing = useSessionTitleEditor(props.rename ?? null, props.title);
    const conversationColumnPx = useLayoutMaxWidth('conversation');
    // Begin and Cancel are the editor's mounted current-context commands (P1 operation table): each exists only
    // while it can act, so the other retires with the editor's state.
    const titleCommands = React.useMemo(() => editing.draft !== null
        ? [{ key: 'session.header.title.cancel', title: t('sessionInfo.cancelRenameSession'), invoke: editing.cancel }]
        : editing.canBegin ? [{ key: 'session.header.title.begin', title: t('sessionInfo.renameSession'), invoke: editing.begin }] : [],
    [editing.begin, editing.canBegin, editing.cancel, editing.draft]);
    useCurrentUiContextLocalCommands(titleCommands);
    // Which identity leads the header is the person's call. `agentLogo` with no resolvable agent renders
    // nothing rather than silently falling back to the avatar.
    const identity = identityMode === 'none' ? null
        : identityMode === 'agentLogo' ? props.agentIdentity ?? null
            : props.botFace ? (props.editBotFace
                // A Bot this header may edit offers its face chooser from the face itself (lab R6 header).
                ? <SessionBotFaceMark sessionId={props.editBotFace.sessionId} serverId={props.editBotFace.serverId} facts={props.botFace} size={32} mood={props.botActivity} />
                : <SessionBotFace facts={props.botFace} size={32} mood={props.botActivity} />)
                : props.avatarId ? <Avatar id={props.avatarId} size={32} monochrome={!isConnected} flavor={props.flavor} /> : null;
    const pullable = props.onPullAllTabs !== undefined;
    const titleControl = (
        <PullTarget pullable={pullable}>
            {editing.draft !== null ? (
                <TextInput
                    testID="session-header-title-input"
                    value={editing.draft}
                    onChangeText={editing.setDraft}
                    accessibilityLabel={t('sessionInfo.renameSession')}
                    placeholder={t('sessionInfo.renameSessionPlaceholder')}
                    autoFocus
                    selectTextOnFocus
                    onKeyPress={editing.onKeyPress}
                    onSubmitEditing={editing.save}
                    style={[styles.title, styles.titleInput]}
                />
            ) : (
                <SessionHeaderTitle title={props.title} accessory={props.titleAccessory}
                    onBeginRename={props.rename ? editing.begin : undefined}
                    triggerRef={editing.titleTriggerRef} lineageAbove={props.lineage != null} />
            )}
        </PullTarget>
    );
    const buttons = React.useMemo<readonly DetailsTabHeaderAction[] | undefined>(() => editing.draft === null ? undefined : [
        { label: t('common.cancel'), onPress: editing.cancel, testID: 'session-header-title-cancel' },
        { label: t('common.save'), tone: 'primary', onPress: editing.save, busy: editing.saving,
            disabled: !editing.draft.trim(), testID: 'session-header-title-save' },
    ], [editing.cancel, editing.draft, editing.save, editing.saving]);
    const backTestID = resolveOptionalSessionScreenTestId(testIdsEnabled, 'session-header-back');
    const header = (
        <DetailsTabHeader
            testID="session-header"
            title={props.title}
            leading={identity ? (
                <PullTarget pullable={pullable}>
                    <View testID={resolveOptionalSessionScreenTestId(testIdsEnabled, 'session-header-avatar')}>{identity}</View>
                </PullTarget>
            ) : undefined}
            titleControl={titleControl}
            overline={props.lineage}
            metaLeading={props.badges?.length || props.subtitle ? (
                <View style={styles.metadataRow} testID={resolveOptionalSessionScreenTestId(testIdsEnabled, 'session-header-metadata')}>
                    {props.subtitle ? <SessionHeaderSubtitle text={props.subtitle} mode={props.subtitleEllipsizeMode ?? 'tail'} /> : null}
                    {props.badges?.map((badge, index) => (
                        <StatusPill key={`${badge}:${index}`} variant="neutral" chrome="plain" hideDot
                            foregroundColor={theme.colors.text.secondary}
                            label={badge} labelVariant="phrase" labelNumberOfLines={1}
                            testID={resolveOptionalSessionScreenTestId(testIdsEnabled, `session-header-badge:${index}`)} />
                    ))}
                </View>
            ) : undefined}
            actions={editing.draft === null ? props.rightElement : undefined}
            buttons={buttons}
            notice={editing.reason ? <Text testID="session-header-title-reason" style={styles.reason}>{editing.reason}</Text> : undefined}
            navigation={props.showBackButton !== false && props.onBackPress ? {
                onBack: props.onBackPress,
                includeTopInset: props.includeTopInset !== false,
                ...(backTestID ? { backTestID } : {}),
            } : undefined}
            actionsFit="compact"
            // The title and controls stand on the transcript's and composer's column (owner 11-08).
            columnMaxWidthPx={conversationColumnPx}
        />
    );
    return (
        // The covered main column withdraws its header from focus and assistive technology with the body.
        <PaneMainBody style={styles.container}>
            {pullable ? (
                <SessionHeaderPullHost onOpen={props.onPullAllTabs!} hintTop={0} testID="session-header-band">{header}</SessionHeaderPullHost>
            ) : header}
        </PaneMainBody>
    );
});

const LINEAGE_SEAM_HIT_REACH = { top: 0 } as const;

/**
 * The title with its role chip. The title keeps its natural width when it can; the chip is
 * whole or compact (never cut), measured whole only in its full form so the compact form never flips
 * back. On desktop the title is the rename field's place: click or Enter begins editing.
 */
function SessionHeaderTitle(props: Readonly<{
    title: string;
    accessory?: React.ReactNode;
    onBeginRename?: () => void;
    triggerRef?: (instance: HappierFocusable | null) => void;
    /** The lineage breadcrumb sits flush above the title: its hit area keeps that side, the title's stops at the seam. */
    lineageAbove?: boolean;
}>) {
    const { theme } = useUnistyles();
    const [rowWidth, setRowWidth] = React.useState(0);
    const [titleWidth, setTitleWidth] = React.useState(0);
    const [accessoryWidth, setAccessoryWidth] = React.useState(0);
    const compactAccessory = props.accessory != null && rowWidth > 0 && titleWidth > 0 && accessoryWidth > 0
        && titleWidth + theme.space.s6 + accessoryWidth > rowWidth;
    const measure = (set: React.Dispatch<React.SetStateAction<number>>) => (event: LayoutChangeEvent) => {
        const visibleWidth = readHappierVisibleLayoutWidth(event.nativeEvent.layout.width);
        if (visibleWidth === null) return;
        const width = Math.round(visibleWidth);
        set((current) => current === width ? current : width);
    };
    const titleText = (hovered: boolean) => (
        <Text numberOfLines={1} ellipsizeMode="tail" accessibilityRole="header"
            style={[styles.title, hovered ? styles.titleHovered : null]}>{props.title}</Text>
    );
    return (
        <View style={styles.titleRow} testID="session-header-title-row" onLayout={props.accessory ? measure(setRowWidth) : undefined}>
            {props.accessory ? (
                <Text testID="session-header-title-measure" numberOfLines={1} aria-hidden accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants" onLayout={measure(setTitleWidth)}
                    style={[styles.title, styles.titleMeasure]}>{props.title}</Text>
            ) : null}
            {props.onBeginRename ? (
                <HappierPressable testID="session-header-title" accessibilityRole="button"
                    accessibilityLabel={props.title} accessibilityHint={t('sessionInfo.renameSession')}
                    onPress={props.onBeginRename} controlRef={props.triggerRef}
                    hitReach={props.lineageAbove ? LINEAGE_SEAM_HIT_REACH : undefined} style={(state) => [styles.titlePress,
                        focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}>
                    {(state) => titleText(state.hovered)}
                </HappierPressable>
            ) : <View testID="session-header-title" style={styles.titlePress}>{titleText(false)}</View>}
            {props.accessory ? (
                <View testID="session-header-title-accessory" style={styles.titleAccessory}
                    onLayout={compactAccessory ? undefined : measure(setAccessoryWidth)}>
                    <SessionHeaderTitleAccessoryCompactContext.Provider value={compactAccessory}>
                        {props.accessory}
                    </SessionHeaderTitleAccessoryCompactContext.Provider>
                </View>
            ) : null}

        </View>
    );
}

/**
 * Folder · machine, or a path. A path keeps its end when it truncates: native ellipsizes at the head;
 * the web, which has no head ellipsis, sets the line right to left while the text itself stays left to
 * right, so overflow is cut at the start without reordering the path.
 */
function SessionHeaderSubtitle(props: Readonly<{ text: string; mode: 'head' | 'tail' }>) {
    const webHead = props.mode === 'head' && Platform.OS === 'web';
    return (
        <Text testID="session-header-subtitle" numberOfLines={1} ellipsizeMode={webHead ? undefined : props.mode}
            style={[styles.subtitle, webHead ? styles.subtitleHeadWeb : null]}>
            {webHead ? <Text style={styles.subtitleHeadTextWeb}>{props.text}</Text> : props.text}
        </Text>
    );
}

function PullTarget(props: Readonly<{ pullable: boolean; children: React.ReactNode }>) {
    if (!props.pullable) return <>{props.children}</>;
    return <SessionHeaderPullTarget style={styles.pullTarget}>{props.children}</SessionHeaderPullTarget>;
}

type SessionTitleEditor = Readonly<{
    draft: string | null;
    canBegin: boolean;
    /** The title trigger takes focus back when editing ends by Escape, Cancel or an acknowledged save. */
    titleTriggerRef: (instance: HappierFocusable | null) => void;
    saving: boolean;
    reason: string | null;
    setDraft: (value: string) => void;
    begin: () => void;
    cancel: () => void;
    save: () => void;
    onKeyPress: (event: { nativeEvent: { key: string; isComposing?: boolean }; preventDefault?: () => void }) => void;
}>;

/**
 * The inline title editor's local draft (Discussion's rename pattern): Enter saves outside an IME
 * composition, Escape cancels, blur keeps the draft. Only an acknowledged save ends editing; a refusal,
 * failure or pending approval keeps the draft with its reason. Writes through `session.title.set`.
 */
function useSessionTitleEditor(target: SessionPaneHeaderProps['rename'] | null, title: string): SessionTitleEditor {
    const [draft, setDraftState] = React.useState<string | null>(null);
    const [saving, setSaving] = React.useState(false);
    const [reason, setReason] = React.useState<string | null>(null);
    const draftRef = React.useRef(draft);
    draftRef.current = draft;
    const savingRef = React.useRef(saving);
    savingRef.current = saving;
    const returnFocusRef = React.useRef(false);
    const titleTriggerRef = React.useCallback((instance: HappierFocusable | null) => {
        if (!instance || !returnFocusRef.current) return;
        returnFocusRef.current = false;
        instance.focus?.();
    }, []);
    const canBegin = target !== null && Platform.OS === 'web';
    const begin = React.useCallback(() => {
        if (!target || Platform.OS !== 'web') return;
        setReason(null);
        setDraftState(title);
    }, [target, title]);
    const cancel = React.useCallback(() => {
        if (draftRef.current !== null) returnFocusRef.current = true;
        setDraftState(null);
        setReason(null);
    }, []);
    const setDraft = React.useCallback((value: string) => setDraftState(value), []);
    const save = React.useCallback(() => {
        const next = draftRef.current?.trim();
        if (!target || !next || savingRef.current) return;
        if (next === title.trim()) { cancel(); return; }
        const lifetime = captureActiveServerAccountScopeCurrentness();
        setSaving(true);
        setReason(null);
        void executeSessionLifecycleAction('session.title.set', target.sessionId, { serverId: target.serverId }, next)
            .then((result) => {
                if (!lifetime.isCurrent()) return;
                if (result.success) { returnFocusRef.current = true; setDraftState(null); return; }
                setReason(result.code === 'approval_request_created' ? t('sessionInfo.renameWaitingForApproval')
                    : result.message ?? t('sessionInfo.failedToRenameSession'));
            }, () => { if (lifetime.isCurrent()) setReason(t('sessionInfo.failedToRenameSession')); })
            .finally(() => { if (lifetime.isCurrent()) setSaving(false); });
    }, [cancel, target, title]);
    const onKeyPress = React.useCallback<SessionTitleEditor['onKeyPress']>((event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.nativeEvent.key === 'Escape') { event.preventDefault?.(); cancel(); }
    }, [cancel]);
    return { draft, canBegin, titleTriggerRef, saving, reason, setDraft, begin, cancel, save, onKeyPress };
}

const styles = StyleSheet.create((theme) => ({
    container: {
        position: 'relative',
        zIndex: 100,
    },
    // The title row takes the room the band leaves it (never only its content), so its measured width is
    // the room the chip is judged against: a content-sized row could only ever shrink the chip to its
    // mark and never see the room come back (the chip stayed a bare glyph beside an ample header).
    pullTarget: {
        flexShrink: 1,
        flexGrow: 1,
        minWidth: 0,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        minWidth: 0,
        flexShrink: 1,
        flexGrow: 1,
    },
    titlePress: {
        flexShrink: 1,
        minWidth: 0,
        borderRadius: theme.borderRadius.sm,
    },
    title: {
        ...HEADER_BAND_TITLE_TEXT,
        ...Typography.default('semiBold'),
        color: theme.colors.chrome.header.foreground,
        flexShrink: 1,
    },
    titleHovered: {
        color: theme.colors.text.primary,
    },
    titleInput: {
        flex: 1,
        minWidth: 0,
        paddingVertical: 0,
    },
    // Measures the title's natural width off-flow; never drawn, never read aloud.
    titleMeasure: {
        position: 'absolute',
        left: 0,
        top: 0,
        opacity: 0,
        pointerEvents: 'none',
        flexShrink: 0,
    },
    // The title owns the row: the role chip takes its compact form before the name is cut.
    titleAccessory: {
        flexShrink: 100,
        minWidth: 0,
        overflow: 'hidden',
    },
    metadataRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        flexShrink: 1,
        minWidth: 0,
    },
    subtitle: {
        ...HEADER_BAND_SUBTITLE_TEXT,
        ...Typography.default(),
        marginTop: 0,
        flexShrink: 1,
        minWidth: 0,
        color: theme.colors.text.secondary,
    },
    subtitleHeadWeb: {
        writingDirection: 'rtl',
        textAlign: 'left',
    },
    subtitleHeadTextWeb: {
        writingDirection: 'ltr',
        unicodeBidi: 'isolate',
    },
    reason: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        paddingHorizontal: theme.space.s16,
        paddingBottom: theme.space.s6,
    },
}));
