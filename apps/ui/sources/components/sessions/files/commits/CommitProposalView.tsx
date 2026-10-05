import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { CommitProposal, CommitProposalChange, CommitProposalGroup } from './commitProposal';
import { CommitChangeRow, CommitGroupHeader, commitPartsStyles, type CommitMoveChoice, type CommitMoveTarget } from './CommitProposalParts';
import { CommitPlanGroupOutcome, CommitPlanOutcomeBanner, GroupMetaText, LandedMeta, type CommitPlanOutcomeActions } from './CommitPlanOutcome';
import { CommitProposalKeyboardShortcuts } from './CommitProposalKeyboardShortcuts';
import { CommitHookChanges, useCommitHookEvidence, type CommitHookEvidence, type ReadCommitHookDiff } from './CommitHookChanges';

export type CommitProposalViewLayout = 'wide' | 'phone';

export type CommitProposalActions = CommitPlanOutcomeActions & Readonly<{
    readHookDiff?: ReadCommitHookDiff;
    onEditMessage?: (groupId: string, message: string) => void;
    onMove?: (change: CommitProposalChange, target: CommitMoveTarget) => void;
    onMoveGroup?: (groupId: string, direction: -1 | 1) => void;
    onMergeWithNext?: (groupId: string) => void;
    onDiscard?: () => void;
    onRegenerate?: () => void;
    onStopAfterCurrent?: () => void;
}>;

export type CommitProposalViewProps = Readonly<{
    /** The projected proposal; null before one exists. */
    proposal: CommitProposal | null;
    /** none: nothing requested · writing: the model is grouping · ready: a proposal exists. */
    phase: 'none' | 'writing' | 'ready';
    branch: string | null;
    modelLabel: string | null;
    layout: CommitProposalViewLayout;
    actions: CommitProposalActions;
    /** The empty state's way in: propose for these pending changes. */
    start?: Readonly<{ onStart: () => void; busy: boolean; disabled: boolean; reason: string | null; modelPicker?: React.ReactNode }> | null;
    /** A commit the person asked for elsewhere (the Git pane's Open); the view scrolls it into view. */
    focusGroupId?: string | null;
    busy?: boolean;
    error?: string | null;
    /** Only while the view is on screen and in front (keyboard). */
    active?: boolean;
    /** A proposal was just discarded: one revision-checked Undo restores it. */
    onUndoDiscard?: (() => void) | null;
}>;

/** The reading column of the proposal (lab WT4-C1: about 820 px of a 1440 desktop). */
const COLUMN_MAX_WIDTH_PX = 820;

function focusKey(groupId: string | null, path: string): string {
    return `${groupId ?? 'leftOut'}:${path}`;
}

/**
 * The Commits view of pending changes (Walkthrough lab WT4-C1/C3/C4): ordered commits whose messages edit in
 * place, each with its exact changes; a Left out group that stays in the working tree; one primary Create. While
 * an accepted run applies, editing pauses and each commit shows its real state; every stop is one typed line.
 */
export const CommitProposalView = React.memo(function CommitProposalView(props: CommitProposalViewProps) {
    const { theme } = useUnistyles();
    const insets = useSafeAreaInsets();
    const phone = props.layout === 'phone';
    const { proposal, actions } = props;
    const hookEvidence = useCommitHookEvidence(proposal?.outcome?.kind === 'hookChanged' ? proposal.outcome : null, actions.readHookDiff);
    const hookActions = React.useMemo(() => ({ ...actions, onIncludeHookChanges: actions.onIncludeHookChanges
        ? () => { if (hookEvidence.state === 'ready') actions.onIncludeHookChanges?.(); } : undefined }), [actions, hookEvidence.state]);
    const [focused, setFocused] = React.useState<string | null>(null);
    const [openGroups, setOpenGroups] = React.useState<ReadonlySet<string>>(() => new Set());
    const scrollRef = React.useRef<ScrollView | null>(null);
    const groupY = React.useRef(new Map<string, number>());
    /** Group positions are measured inside the groups column; the column's own offset completes them. */
    const groupsTop = React.useRef(0);

    // The commit to bring into view: the one asked for elsewhere, else the one a hook paused for the person.
    const pausedGroupId = proposal?.outcome?.kind === 'hookChanged' ? proposal.outcome.groupId : null;
    const scrollTarget = props.focusGroupId ?? pausedGroupId;
    const scrolledTo = React.useRef<string | null>(null);
    const scrollToGroup = React.useCallback((groupId: string) => {
        const y = groupY.current.get(groupId);
        if (y === undefined) return;
        scrolledTo.current = groupId;
        scrollRef.current?.scrollTo({ y: Math.max(0, groupsTop.current + y - 12), animated: true });
    }, []);
    React.useEffect(() => {
        if (!scrollTarget) { scrolledTo.current = null; return; }
        if (props.focusGroupId) setOpenGroups((current) => (current.has(props.focusGroupId!) ? current : new Set(current).add(props.focusGroupId!)));
        if (scrolledTo.current !== scrollTarget) scrollToGroup(scrollTarget);
    }, [props.focusGroupId, scrollTarget, scrollToGroup]);

    const choices = React.useMemo<CommitMoveChoice[] | null>(() => (proposal && !proposal.locked
        ? proposal.groups.filter((group) => group.editable).map((group) => ({ number: group.number, groupId: group.id, message: group.message }))
        : null), [proposal]);

    // ⌥1–9 move the focused change into that commit, ⌥N into a new one after its commit, ⌥0 leave it out.
    const onMove = actions.onMove;
    const onShortcut = React.useCallback((key: number | 'new' | 'leftOut') => {
        if (!proposal || !focused || !onMove || proposal.locked) return;
        const [groupId, ...rest] = focused.split(':');
        const path = rest.join(':');
        const group = groupId === 'leftOut' ? null : proposal.groups.find((candidate) => candidate.id === groupId) ?? null;
        const change = (group ? group.changes : proposal.leftOut).find((candidate) => candidate.path === path);
        if (!change) return;
        if (key === 'leftOut') { if (group) onMove(change, { kind: 'leftOut' }); return; }
        if (key === 'new') {
            const after = group ?? proposal.groups[proposal.groups.length - 1];
            if (after) onMove(change, { kind: 'newGroupAfter', groupId: after.id });
            return;
        }
        const target = proposal.groups[key - 1];
        if (target && target.editable && target.id !== group?.id) onMove(change, { kind: 'group', groupId: target.id });
    }, [focused, onMove, proposal]);

    if (props.phase !== 'ready' || !proposal) {
        return (
            <View style={styles.root}>
                {props.onUndoDiscard && props.phase === 'none' ? (
                    <View style={styles.discarded}>
                        <SurfaceStateCard
                            testID="commit-proposal-discarded"
                            size="line"
                            kind="success"
                            title={t('commitProposal.discarded')}
                            action={{ label: t('commitProposal.undo'), testID: 'commit-proposal-undo-discard', onPress: props.onUndoDiscard }}
                            accessibilitySemantics="status"
                        />
                    </View>
                ) : null}
                {props.phase === 'writing' ? (
                    <SurfaceStateCard testID="commit-proposal-writing" kind="loading" title={t('commitProposal.none.writing')} />
                ) : (
                    <SurfaceStateCard
                        testID="commit-proposal-none"
                        kind="empty"
                        iconName="git-commit"
                        title={t('commitProposal.none.title')}
                        reason={props.start?.reason ?? t('commitProposal.none.reason')}
                        action={props.start ? {
                            label: t('commitProposal.none.propose'),
                            testID: 'commit-proposal-start',
                            onPress: props.start.onStart,
                            disabled: props.start.disabled || props.start.busy,
                        } : undefined}
                    />
                )}
                {props.phase === 'none' && props.start?.modelPicker ? <View style={styles.startPicker}>{props.start.modelPicker}</View> : null}
            </View>
        );
    }

    const total = proposal.groups.length;
    const outcome = proposal.outcome;
    const remaining = total - proposal.landedCount;
    const editing = !proposal.locked;
    const canCreate = editing && remaining > 0 && Boolean(actions.onCreate) && proposal.emptyGroupIds.length === 0;
    const pausedForHook = outcome?.kind === 'hookChanged';
    const hasLanded = proposal.landedCount > 0;
    const who = props.modelLabel ?? t('commitProposal.modelFallback');

    const header = proposal.applying || pausedForHook ? (
        <View style={styles.head}>
            <View style={styles.headText}>
                <Text style={[styles.title, phone ? styles.titlePhone : null]} accessibilityRole="header">{t('commitProposal.applying.title', { count: total })}</Text>
                <Text style={styles.subtitle}>{phone ? t('commitProposal.applying.bodyPhone') : t('commitProposal.applying.body')}</Text>
            </View>
        </View>
    ) : (
        <View style={styles.head}>
            <View style={styles.headText}>
                <Text style={[styles.title, phone ? styles.titlePhone : null]} accessibilityRole="header">
                    {phone ? t('commitProposal.titlePhone', { count: total }) : t('commitProposal.title', { count: total })}
                </Text>
                <Text style={styles.subtitle}>
                    {phone
                        ? t('commitProposal.proposedByPhone', { committed: proposal.committedFileCount, total: proposal.totalFileCount })
                        : `${t('commitProposal.proposedBy', { who, committed: proposal.committedFileCount, total: proposal.totalFileCount })} ${editing && actions.onMove ? t('commitProposal.moveHint', { max: Math.min(9, total) }) : ''}`}
                </Text>
            </View>
            {!phone && actions.onRegenerate && editing ? (
                <RoundButton
                    testID="commit-proposal-regenerate"
                    size="small"
                    display="inverted"
                    title={t('commitProposal.regenerate')}
                    leading={<Icon name="arrows-clockwise" size={15} color={theme.colors.text.primary} />}
                    onPress={actions.onRegenerate}
                />
            ) : null}
        </View>
    );

    const isOpen = (group: CommitProposalGroup, index: number) => {
        if (openGroups.has(group.id)) return true;
        if (group.state === 'landed') return false;
        if (group.state === 'paused') return true;
        if (group.state === 'failed') return false;
        if (phone) return index === 0 && !proposal.applying && !hasLanded;
        return group.state !== 'notCreated' || group.editable;
    };
    const toggle = (groupId: string) => setOpenGroups((current) => {
        const next = new Set(current);
        if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
        return next;
    });

    const groupCards = proposal.groups.map((group, index) => (
        <CommitGroupCard
            key={group.id}
            group={group}
            proposal={proposal}
            choices={choices}
            open={isOpen(group, index)}
            onToggle={toggle}
            focusedKey={focused}
            onFocusKey={setFocused}
            actions={pausedForHook ? hookActions : actions}
            hookEvidence={hookEvidence}
            phone={phone}
            highlighted={group.id === props.focusGroupId}
            onLayoutY={(y) => {
                groupY.current.set(group.id, y);
                if (group.id === scrollTarget && scrolledTo.current !== scrollTarget) scrollToGroup(group.id);
            }}
        />
    ));

    const leftOut = proposal.leftOut.length > 0 ? (
        <View testID="commit-left-out" style={[commitPartsStyles.card, commitPartsStyles.cardQuiet]}>
            <View style={styles.leftOutHead}>
                <View style={styles.leftOutMark}><Icon name="stack" size={16} color={theme.colors.text.tertiary} /></View>
                <View style={styles.headText}>
                    <Text style={styles.leftOutTitle}>{t('commitProposal.leftOut.title')}</Text>
                    <Text style={styles.subtitleSmall}>{t('commitProposal.leftOut.description')}</Text>
                </View>
            </View>
            {proposal.leftOut.map((change) => (
                <CommitChangeRow
                    key={change.key}
                    change={change}
                    groupNumber={null}
                    choices={choices}
                    focused={focused === focusKey(null, change.path)}
                    onFocus={() => setFocused(focusKey(null, change.path))}
                    onMove={actions.onMove}
                    phone={phone}
                />
            ))}
        </View>
    ) : null;

    const footer = (() => {
        if (outcome?.kind === 'complete' || outcome?.kind === 'stopped') return null;
        if (pausedForHook && phone) {
            return (
                <View style={[styles.pbar, { paddingBottom: Math.max(insets.bottom, 12) }]}>
                    {actions.onCancel ? <RoundButton size="normal" display="secondary" title={t('commitProposal.outcome.cancel')} onPress={actions.onCancel} /> : null}
                    {actions.onIncludeHookChanges ? <View style={styles.grow}><RoundButton testID="commit-plan-include-hook" size="normal"
                        title={t('commitProposal.outcome.includePhone')} disabled={hookEvidence.state !== 'ready'} onPress={hookActions.onIncludeHookChanges} /></View> : null}
                </View>
            );
        }
        if (proposal.applying || pausedForHook) {
            const stopping = proposal.application?.stopAfterCurrent === true;
            return (
                <FooterBar phone={phone} bottomInset={insets.bottom}>
                    <Text style={styles.footerText} numberOfLines={2}>
                        <Text style={styles.footerStrong}>{t('commitProposal.applying.created', { landed: proposal.landedCount, total })}</Text>
                        {phone ? t('commitProposal.applying.createdRestPhone') : t('commitProposal.applying.createdRest')}
                    </Text>
                    {actions.onStopAfterCurrent && proposal.applying ? (
                        <RoundButton
                            testID="commit-plan-stop-after"
                            size="small"
                            display="secondary"
                            disabled={stopping}
                            title={stopping ? t('commitProposal.applying.stopping') : phone ? t('commitProposal.applying.stopAfterThisShort') : t('commitProposal.applying.stopAfterThis')}
                            onPress={actions.onStopAfterCurrent}
                        />
                    ) : null}
                </FooterBar>
            );
        }
        if (!editing) return null;
        const createLabel = phone
            ? t('commitProposal.footer.createShort', { count: remaining })
            : hasLanded ? t('commitProposal.outcome.createRest', { count: remaining }) : t('commitProposal.footer.create', { count: remaining });
        const blocked = proposal.emptyGroupIds.length > 0;
        return (
            <FooterBar phone={phone} bottomInset={insets.bottom}>
                <Text style={[styles.footerText, blocked ? styles.footerWarning : null]} numberOfLines={2}>
                    {blocked ? t('commitProposal.footer.emptyGroupReason') : phone ? t('commitProposal.footer.phone') : (
                        <>
                            <Text style={styles.footerStrong}>{t('commitProposal.footer.commits', { count: remaining })}</Text>
                            {props.branch ? t('commitProposal.footer.onBranch', { branch: props.branch }) : t('commitProposal.footer.detached')}
                        </>
                    )}
                </Text>
                {!phone && actions.onDiscard ? (
                    <RoundButton testID="commit-proposal-discard" size="small" display="inverted" title={t('commitProposal.footer.discard')} onPress={actions.onDiscard} />
                ) : null}
                {actions.onCreate ? (
                    <RoundButton
                        testID="commit-proposal-create"
                        size={phone ? 'normal' : 'small'}
                        title={createLabel}
                        disabled={!canCreate || props.busy === true}
                        loading={props.busy === true}
                        accessibilityHint={blocked ? t('commitProposal.footer.emptyGroupReason') : undefined}
                        onPress={actions.onCreate}
                    />
                ) : null}
            </FooterBar>
        );
    })();

    return (
        <View style={styles.root}>
            <CommitProposalKeyboardShortcuts enabled={props.active !== false && editing && Boolean(focused)} onMove={onShortcut} />
            <ScrollView ref={scrollRef} style={styles.scroll} contentContainerStyle={[styles.content, phone ? styles.contentPhone : null]}>
                <View style={styles.column}>
                    {header}
                    {props.error ? (
                        <Text style={styles.error} accessibilityLiveRegion="polite">{props.error}</Text>
                    ) : null}
                    {outcome && outcome.kind !== 'hookChanged' && outcome.kind !== 'hookFailed' ? (
                        <View style={styles.outcome}>
                            <CommitPlanOutcomeBanner proposal={proposal} branch={props.branch} actions={actions} />
                        </View>
                    ) : null}
                    <View style={styles.groups} onLayout={(event) => { groupsTop.current = event.nativeEvent.layout.y; }}>
                        {groupCards}
                        {leftOut}
                    </View>
                </View>
            </ScrollView>
            {footer}
        </View>
    );
});

/** One commit of the proposal: its header, its exact rows when open, and the outcome that belongs to it. */
export const CommitGroupCard = React.memo(function CommitGroupCard(props: Readonly<{
    group: CommitProposalGroup;
    proposal: CommitProposal;
    choices: readonly CommitMoveChoice[] | null;
    open: boolean;
    onToggle: (groupId: string) => void;
    focusedKey: string | null;
    onFocusKey: (key: string) => void;
    actions: CommitProposalActions;
    phone: boolean;
    highlighted?: boolean;
    onLayoutY?: (y: number) => void;
    hookEvidence?: CommitHookEvidence;
}>) {
    const { group, proposal, actions, phone, open } = props;
    const outcome = proposal.outcome;
    const editableGroups = proposal.groups.filter((candidate) => candidate.editable);
    const editableIndex = editableGroups.indexOf(group);
    const onToggle = props.onToggle;
    const onLayoutY = props.onLayoutY;
    const meta = (() => {
        switch (group.state) {
            case 'landed': return group.landedSha ? <LandedMeta sha={group.landedSha} rewritten={group.rewrittenMessage !== null} committedAtMs={group.committedAtMs} signed={group.signed} /> : null;
            case 'writing': return <GroupMetaText>{t('commitProposal.state.writing')}</GroupMetaText>;
            case 'waiting': return <GroupMetaText>{t('commitProposal.state.waiting')}</GroupMetaText>;
            case 'paused': {
                const count = outcome?.kind === 'hookChanged' ? outcome.paths.length : 0;
                const hook = outcome?.kind === 'hookChanged' ? outcome.hookName : null;
                return <GroupMetaText>{hook ? t('commitProposal.state.pausedBy', { hook, count }) : t('commitProposal.state.paused', { count })}</GroupMetaText>;
            }
            case 'failed': {
                const hook = outcome?.kind === 'hookFailed' && outcome.groupId === group.id ? outcome.hookName : null;
                return <GroupMetaText>{hook ? t('commitProposal.state.hookFailedBy', { hook }) : t('commitProposal.state.failed')}</GroupMetaText>;
            }
            case 'unknown': return <GroupMetaText>{t('commitProposal.state.unknown')}</GroupMetaText>;
            case 'notCreated': return <GroupMetaText>{group.editable ? t('commitProposal.state.notCreated') : t('commitProposal.state.notCreatedShort')}</GroupMetaText>;
            case 'editable':
                return group.changes.length === 0
                    ? <GroupMetaText tone="warning">{t('commitProposal.group.empty')}</GroupMetaText>
                    : <GroupMetaText>{t('commitProposal.fileCount', { count: group.changes.length })}</GroupMetaText>;
        }
    })();
    return (
        <View
            testID={`commit-group:${group.id}`}
            onLayout={onLayoutY ? (event) => onLayoutY(event.nativeEvent.layout.y) : undefined}
            style={[commitPartsStyles.card, props.highlighted ? styles.cardFocused : null]}
        >
            <CommitGroupHeader
                group={group}
                phone={phone}
                meta={(
                    <Pressable
                        disabled={!phone && group.state !== 'landed' && group.state !== 'failed'}
                        onPress={() => onToggle(group.id)}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: open }}
                        style={styles.metaPress}
                    >
                        {meta}
                    </Pressable>
                )}
                canMoveUp={editableIndex > 0}
                canMoveDown={editableIndex >= 0 && editableIndex < editableGroups.length - 1}
                canMerge={editableIndex >= 0 && editableIndex < editableGroups.length - 1}
                onEditMessage={actions.onEditMessage}
                onMoveGroup={actions.onMoveGroup}
                onMergeWithNext={actions.onMergeWithNext}
                onToggle={() => onToggle(group.id)}
            />
            {open ? group.changes.map((change) => (
                <CommitChangeRow
                    key={change.key}
                    change={change}
                    groupNumber={group.number}
                    choices={group.editable ? props.choices : null}
                    focused={props.focusedKey === focusKey(group.id, change.path)}
                    onFocus={() => props.onFocusKey(focusKey(group.id, change.path))}
                    onMove={actions.onMove}
                    phone={phone}
                />
            )) : null}
            <CommitPlanGroupOutcome group={group} outcome={outcome} actions={actions} phone={phone}
                hookEvidenceReady={props.hookEvidence?.state === 'ready'}
                hookChanges={outcome?.kind === 'hookChanged' && outcome.groupId === group.id && props.hookEvidence
                    ? <CommitHookChanges evidence={props.hookEvidence} groupNumber={group.number} phone={phone} /> : null} />
        </View>
    );
});

function FooterBar(props: Readonly<{ phone: boolean; bottomInset: number; children: React.ReactNode }>) {
    return (
        <View testID="commit-proposal-footer" style={[styles.footer, props.phone ? { paddingHorizontal: 14, paddingBottom: Math.max(props.bottomInset, 12) } : null]}>
            <View style={[styles.footerInner, props.phone ? styles.footerInnerPhone : null]}>{props.children}</View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface.base },
    scroll: { flex: 1 },
    content: { paddingHorizontal: 40, paddingTop: 28, paddingBottom: 40 },
    contentPhone: { paddingHorizontal: 14, paddingTop: 18 },
    column: { width: '100%', maxWidth: COLUMN_MAX_WIDTH_PX, alignSelf: 'center' },
    head: { flexDirection: 'row', alignItems: 'flex-end', gap: 16, marginBottom: 18 },
    headText: { flex: 1, minWidth: 0 },
    title: { fontSize: 23, lineHeight: 29, letterSpacing: -0.4, color: theme.colors.text.primary, ...Typography.default('bold') },
    titlePhone: { fontSize: 25, lineHeight: 31 },
    subtitle: { marginTop: 4, fontSize: 15, lineHeight: 22, color: theme.colors.text.secondary, ...Typography.default() },
    subtitleSmall: { marginTop: 2, fontSize: 14.5, lineHeight: 21, color: theme.colors.text.secondary, ...Typography.default() },
    error: { marginBottom: 12, fontSize: 13.5, lineHeight: 19, color: theme.colors.state.danger.foreground, ...Typography.default() },
    outcome: { marginBottom: 14 },
    groups: { gap: 14 },
    cardFocused: { borderColor: theme.colors.state.active.border },
    metaPress: { alignSelf: 'flex-start' },
    leftOutHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingLeft: 16, paddingRight: 16, paddingVertical: 14 },
    leftOutMark: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
    leftOutTitle: { fontSize: 16, lineHeight: 23, color: theme.colors.text.secondary, ...Typography.default('semiBold') },
    discarded: { width: '100%', maxWidth: COLUMN_MAX_WIDTH_PX, alignSelf: 'center', paddingHorizontal: 16, paddingTop: 16 },
    startPicker: { alignSelf: 'center', width: '100%', maxWidth: 420, paddingHorizontal: 16 },
    footer: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 40,
        paddingVertical: 12,
    },
    footerInner: { width: '100%', maxWidth: COLUMN_MAX_WIDTH_PX, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 12 },
    footerInnerPhone: { maxWidth: undefined },
    footerText: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: 20, color: theme.colors.text.secondary, ...Typography.default() },
    footerStrong: { color: theme.colors.text.primary, ...Typography.default('semiBold') },
    footerWarning: { color: theme.colors.state.warning.foreground },
    pbar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 14,
        paddingTop: 12,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    grow: { flex: 1 },
}));
