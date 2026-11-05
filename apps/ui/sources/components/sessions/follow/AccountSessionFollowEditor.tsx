import * as React from 'react';
import { projectAccountSessionFollowEditorStateV1, type PersonalFollowOnceV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import type { SetSessionFollowRequest } from '@happier-dev/protocol/sessions/follow/api';
import type { FollowPolicyEditorEditV1 } from '@happier-dev/protocol/sessions/follow/followPolicyEditorV1';

import { HappierDivider, joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { BareSectionContent } from '@/components/ui/lists/BareSectionContent';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useListPresentation } from '@/components/ui/lists/listPresentation';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { FollowPolicyEditorBinding, FollowPolicySection } from './FollowPolicyEditorBinding';
import { projectAccountSessionFollowPolicyEditor, type AccountSessionFollowEditorSnapshot } from './accountSessionFollowController';
import type { AccountVoiceFollowReadiness } from './accountVoiceFollowReadiness';

/** What the editor hands its host: the header's words and mark, the scrolling body and the fixed footer. */
export type AccountSessionFollowEditorParts = Readonly<{
    title: string;
    subtitle: string;
    mark: React.ReactNode;
    body: React.ReactNode;
    footer: React.ReactNode;
}>;

export type AccountSessionFollowEditorProps = Readonly<{
    state: AccountSessionFollowEditorSnapshot;
    /** One policy edit, applied by the controller's existing writer. */
    onEditPolicy(edit: FollowPolicyEditorEditV1): void;
    voiceReadiness: AccountVoiceFollowReadiness;
    archived: boolean;
    /**
     * A linked external Session whose Background sync is off. Following it still
     * works, but Happier only sees the external source while that Session is
     * attached, so the editor says so instead of promising delivery.
     */
    externalBackgroundSyncOff?: boolean;
    onSet(preferences: SetSessionFollowRequest): void;
    onRemove(): void;
    onRetry(): void;
    onOpenNotificationSettings(): void;
    /**
     * One-shot "Notify me once", on top of the level and then it ends. `sourceTurnId` is the turn in
     * progress (null when none, so "When this turn ends" is not offered). Absent where it cannot apply.
     */
    notifyOnce?: Readonly<{
        sourceTurnId: string | null;
        onOnce(once: PersonalFollowOnceV1 | null): Promise<void> | void;
    }>;
    /** The followed Session's identity mark, beside the header. */
    sessionMark?: React.ReactNode;
    /** Done: the host closes the popover or leaves the page. */
    onClose?(): void;
    /** Who else follows it (you excluded); null while unknown, so nothing is claimed. */
    alsoFollowing?: Readonly<{ people: number; sessions: number }> | null;
    onOpenPeople?(): void;
    /** The quiet-hours window in effect ("22:00–07:00"), `on` when it has several, null when off. */
    quietHours?: string | null;
    /** Places the parts: a popover panel or a page. Absent, they are stacked in place. */
    frame?(parts: AccountSessionFollowEditorParts): React.ReactNode;
}>;

/**
 * The one personal Follow editor (lab P2-A): what following does and where updates arrive, the shared
 * level editor (each level with its meaning, the chosen one's breakdown), Voice and Notify me once under
 * a divider, quiet hours and who else follows it as quiet links, then Turn off · Done on one footer row.
 * The popover and the phone page place the same parts.
 */
export function AccountSessionFollowEditor(props: AccountSessionFollowEditorProps) {
    const { state } = props;
    const isSessionOwner = state.projection?.isSessionOwner === true;
    // Effective state, not the raw row: a Session owner with no stored choice is
    // permanently tracked and Important-eligible at the Home.
    const effective = state.projection
        ? projectAccountSessionFollowEditorStateV1({ follow: state.projection.follow, isSessionOwner })
        : null;
    // The same canonical projection the controller hook exposes, read from this editor's snapshot.
    const editorState = React.useMemo(() => projectAccountSessionFollowPolicyEditor(state), [state]);
    const policyModel = editorState.model;
    const deliveryEnabled = editorState.deliveryEnabled;
    // Voice is read from the canonical editor projection and written as a policy edit.
    const includeInVoice = state.draft?.includeInVoice ?? effective?.includeInVoice ?? false;
    const canManage = state.projection?.capabilities.manageFollow === true;
    const canEdit = canManage && !props.archived;
    const disabled = !state.online || state.saving || !canEdit;
    // Nothing is claimed before the first read: an owner is tracked, so "Follow" would be false.
    const pending = state.loading && !state.projection;
    const voiceReadiness = props.voiceReadiness;
    // `eligible` is the nominal case the row subtitle already describes, so it has
    // no status line: repeating that sentence directly beneath itself would spend a
    // row saying nothing new.
    const voiceDeliveryTitle = voiceReadiness === 'waiting_for_runtime'
        ? t('session.follow.voice.waitingRuntime')
        : voiceReadiness === 'waiting_encrypted'
            ? t('session.follow.voice.waitingEncrypted')
            : voiceReadiness === 'runtime_unsupported'
                ? t('session.follow.voice.unsupported')
                : voiceReadiness === 'provider_withheld'
                    ? t('session.follow.voice.providerWithheld')
                    : voiceReadiness === 'pending'
                        ? t('session.follow.voice.initialSnapshotPending')
                        : null;
    const error = state.error === 'session_not_found'
        ? t('session.follow.accessLost')
        : state.error === 'credential_scope_denied'
            ? t('errors.permissionDenied')
            : state.error === 'session_archived'
                ? t('session.follow.archived')
                : state.error === 'feature_unavailable' || state.error === 'account_inactive'
                    ? t('common.unavailable')
                    : t('errors.unknownError');

    const onceRow = props.notifyOnce && state.projection && !props.archived
        ? <NotifyOnceRow once={state.projection.follow?.once ?? null} disabled={disabled} {...props.notifyOnce} />
        : null;
    const policyEditor = policyModel
        ? <FollowPolicyEditorBinding testID="session-follow-policy" model={policyModel} disabled={disabled} onEditPolicy={props.onEditPolicy} />
        : null;
    const also = props.alsoFollowing;
    const alsoCount = also ? also.people + also.sessions : 0;

    const body = <>
        {pending ? <ItemGroup>
            <Item title={t('common.loading')} loading showChevron={false} mode="info" />
        </ItemGroup> : null}
        {!state.online || state.error ? <ItemGroup>
            <Item
                testID="session-follow-error"
                title={!state.online ? t('session.follow.offline') : error}
                mode="info"
                titleLines={0}
                accessibilityLiveRegion="polite"
                showChevron={false}
            />
            {state.online ? <Item testID="session-follow-retry" title={t('common.retry')} onPress={props.onRetry} showChevron={false} /> : null}
        </ItemGroup> : null}
        {props.archived && !pending ? <ItemGroup surface="none">
            <Item testID="session-follow-archived" title={t('session.follow.archived')} mode="info" titleLines={0} showChevron={false} />
        </ItemGroup> : null}
        {policyModel ? <>
            <FollowPolicySection>{policyEditor}</FollowPolicySection>
            <FollowOptionsDivider />
            <ItemGroup>
                <Item
                    title={t('session.follow.voice.title')}
                    subtitle={t('session.follow.voice.subtitle')}
                    titleLines={0}
                    showChevron={false}
                    rightElement={<Switch
                        testID="session-follow-voice"
                        value={includeInVoice}
                        disabled={disabled}
                        onValueChange={(enabled) => props.onEditPolicy({ kind: 'voice', enabled })}
                    />}
                />
                {includeInVoice && voiceDeliveryTitle ? <Item
                    testID="session-follow-voice-delivery"
                    title={voiceDeliveryTitle}
                    mode="info"
                    titleLines={0}
                    accessibilityLiveRegion="polite"
                /> : null}
                {onceRow}
            </ItemGroup>
            {props.externalBackgroundSyncOff ? <ItemGroup surface="none">
                <Item
                    testID="session-follow-external-attached-only"
                    title={t('session.follow.editor.externalAttachedOnly')}
                    mode="info"
                    titleLines={0}
                    showChevron={false}
                />
            </ItemGroup> : null}
        </> : null}
        {!policyModel && state.projection && !props.archived ? <>
            <ItemGroup surface="none">
                <Item testID="session-follow-not-following" title={isSessionOwner ? t('session.follow.editor.suppressed') : t('session.follow.editor.notFollowing')}
                    mode="info" titleLines={0} showChevron={false} />
            </ItemGroup>
            {onceRow ? <ItemGroup>{onceRow}</ItemGroup> : null}
        </> : null}
        {/* Quiet facts that change what reaches you, each a plain link to where it is changed. */}
        <ItemGroup surface="none">
            <BareSectionContent>
                <View style={styles.links}>
                    <Text style={styles.note} testID="session-follow-quiet-hours">
                        {props.quietHours ? <>{props.quietHours === 'on' ? t('session.follow.editor.quietHoursOn')
                            : t('session.follow.editor.quietHours', { range: props.quietHours })}{' '}</> : null}
                        <TextLinkButton size="meta" label={t('session.follow.settingsLink')} onPress={props.onOpenNotificationSettings}
                            testID="session-follow-settings" />
                    </Text>
                    {alsoCount > 0 && also && props.onOpenPeople ? <Text style={styles.note}>
                        {t('session.follow.editor.alsoFollow', {
                            facts: joinHappierFacts(
                                also.people > 0 ? t('session.collaboration.pane.followersPeople', { count: also.people }) : null,
                                also.sessions > 0 ? t('session.collaboration.pane.followersSessions', { count: also.sessions }) : null,
                            ),
                            count: alsoCount,
                        })}{' · '}
                        <TextLinkButton size="meta" label={t('session.follow.editor.people')} onPress={props.onOpenPeople}
                            testID="session-follow-people" />
                    </Text> : null}
                </View>
            </BareSectionContent>
        </ItemGroup>
    </>;

    // Owner tracking survives suppression, but the delivery choice is editable in both states.
    // Nothing is offered before the first read.
    // Leaving is a choice about the whole follow, so it stands at the footer's start as quiet danger text, apart
    // from the Done that closes the panel. An owner stays tracked, so what it can do is turn delivery off.
    const footer = pending ? null : <SectionButtonRow
        trailing={!deliveryEnabled ? <RoundButton
            testID="session-follow-follow"
            title={t('session.follow.follow')}
            disabled={!state.online || state.saving || !state.projection || !canManage || props.archived}
            onPress={() => {
                if (props.archived) return;
                props.onSet({ notificationLevel: 'important', includeInVoice: false });
            }}
        /> : <RoundButton testID="session-follow-done" title={t('common.done')} onPress={() => props.onClose?.()} />}
    >{deliveryEnabled ? <RoundButton
        testID="session-follow-unfollow"
        display="quietDestructive"
        title={isSessionOwner ? t('session.follow.editor.turnOff') : t('session.follow.unfollow')}
        disabled={!state.online || state.saving || !canManage}
        onPress={props.onRemove}
    /> : null}</SectionButtonRow>;

    const parts: AccountSessionFollowEditorParts = {
        // What following does, and the one sentence of where its updates arrive.
        title: t('session.follow.editor.panelTitle'),
        subtitle: t('session.follow.editor.panelSubtitle'),
        mark: props.sessionMark ?? null,
        body,
        footer,
    };
    return <>{props.frame ? props.frame(parts) : <>{parts.body}{parts.footer}</>}</>;
}

/**
 * The hairline above the secondary options. On a page the sections are sheets and already stand apart; a
 * popover separates them with this one hairline. It reads the list presentation where it is mounted.
 */
function FollowOptionsDivider() {
    const { theme } = useUnistyles();
    if (useListPresentation() === 'page') return null;
    return <HappierDivider color={theme.colors.border.default} style={styles.divider} testID="session-follow-divider" />;
}

type OnceChoice = 'off' | 'turn' | 'attention';

/** One field select: Off, When this turn ends (only while a turn runs), When it next needs you. */
function NotifyOnceRow(props: Readonly<{
    once: PersonalFollowOnceV1 | null;
    sourceTurnId: string | null;
    disabled: boolean;
    onOnce(once: PersonalFollowOnceV1 | null): Promise<void> | void;
}>) {
    const [open, setOpen] = React.useState(false);
    const selected: OnceChoice = props.once?.kind === 'turn_finished' ? 'turn' : props.once?.kind === 'first_needs_you' ? 'attention' : 'off';
    const items: DropdownMenuItem[] = [
        { id: 'off', title: t('session.follow.once.off') },
        ...(props.sourceTurnId !== null || selected === 'turn' ? [{ id: 'turn', title: t('session.follow.once.turn') }] : []),
        { id: 'attention', title: t('session.follow.once.attention') },
    ];
    const titles: Record<OnceChoice, string> = {
        off: t('session.follow.once.off'), turn: t('session.follow.once.turn'), attention: t('session.follow.once.attention'),
    };
    return <DropdownMenu
        testID="session-follow-once"
        open={open}
        onOpenChange={(next) => setOpen(next && !props.disabled)}
        variant="selectable"
        search={false}
        selectedId={selected}
        showCategoryTitles={false}
        matchTriggerWidth={false}
        connectToTrigger
        rowKind="item"
        itemTrigger={{
            title: t('session.follow.once.title'),
            subtitle: t('session.follow.once.subtitle'),
            showSelectedSubtitle: false,
            detailFormatter: () => titles[selected],
            itemProps: { subtitleLines: 0, disabled: props.disabled },
        }}
        items={items}
        onSelect={(id) => {
            setOpen(false);
            if (id === selected) return;
            if (id === 'turn' && props.sourceTurnId === null) return;
            void props.onOnce(id === 'turn' ? { kind: 'turn_finished', sourceTurnId: props.sourceTurnId! }
                : id === 'attention' ? { kind: 'first_needs_you' } : null);
        }}
    />;
}

const styles = StyleSheet.create((theme) => ({
    // The divider stands on the rows' edges, like the hairlines between them.
    divider: { marginHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx, marginVertical: theme.space.s4 },
    links: { gap: theme.space.s4, paddingTop: theme.space.s4 },
    note: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
}));
