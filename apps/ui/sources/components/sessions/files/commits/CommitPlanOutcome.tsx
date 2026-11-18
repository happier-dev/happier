import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

import type { CommitPlanOutcome, CommitProposal, CommitProposalGroup } from './commitProposal';
import { CommitGroupMark } from './CommitProposalParts';

/** The person's ways forward from a stopped or waiting run; each is absent when its owner cannot act now. */
export type CommitPlanOutcomeActions = Readonly<{
    /** Accept again: the first commit after a signing pre-flight, or the remaining suffix after a stop. */
    onCreate?: () => void;
    onCancel?: () => void;
    onIncludeHookChanges?: () => void;
    onRecover?: () => void;
    onProposeAgain?: () => void;
    onAskSession?: () => void;
    onShowInGit?: () => void;
}>;

export function shortSha(sha: string): string {
    return sha.slice(0, 7);
}

function joinFileNames(paths: readonly string[]): string {
    const names = paths.map((path) => path.slice(path.lastIndexOf('/') + 1));
    if (names.length <= 1) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

/**
 * The lines that sit above the proposal (lab WT4-C4): signing checked before the first commit, a moved branch,
 * an unconfirmed outcome, a stop or a failure the writer named. Each says what happened, what stays, and one
 * way forward; nothing here rolls back or retries on its own.
 */
export function CommitPlanOutcomeBanner(props: Readonly<{
    proposal: CommitProposal;
    branch: string | null;
    actions: CommitPlanOutcomeActions;
}>) {
    const outcome = props.proposal.outcome;
    if (!outcome) return null;
    const { actions } = props;
    switch (outcome.kind) {
        case 'signing':
            return (
                <AttentionBanner
                    testID="commit-plan-outcome-signing"
                    title={t('commitProposal.outcome.signingTitle')}
                    description={`${t('commitProposal.outcome.signingBody')} ${t('commitProposal.outcome.signingHint')}.`}
                    action={actions.onCreate ? { label: t('commitProposal.outcome.tryAgain'), onPress: actions.onCreate } : null}
                    secondaryAction={actions.onCancel ? { label: t('commitProposal.outcome.cancel'), onPress: actions.onCancel } : null}
                    details={outcome.message ? [outcome.message] : undefined}
                    announce="alert"
                />
            );
        case 'headMoved':
            return (
                <AttentionBanner
                    testID="commit-plan-outcome-head-moved"
                    title={t('commitProposal.outcome.headMoved', { branch: props.branch ?? 'HEAD' })}
                    description={t('commitProposal.outcome.headMovedBody')}
                    action={actions.onProposeAgain ? { label: t('commitProposal.outcome.proposeAgain'), onPress: actions.onProposeAgain } : null}
                    announce="alert"
                />
            );
        case 'unknown':
            return (
                <AttentionBanner
                    testID="commit-plan-outcome-unknown"
                    tone="neutral"
                    title={t('commitProposal.outcome.unknownTitle')}
                    description={t('commitProposal.outcome.unknownBody')}
                    action={actions.onRecover ? { label: t('commitProposal.outcome.checkAgain'), onPress: actions.onRecover } : null}
                    announce="alert"
                />
            );
        case 'failed':
            return (
                <AttentionBanner
                    testID={`commit-plan-outcome-failed:${outcome.reason}`}
                    title={failedTitle(outcome.reason)}
                    description={t('commitProposal.outcome.failedBody')}
                    action={actions.onCreate && outcome.remainingCount > 0 ? { label: t('commitProposal.outcome.tryAgain'), onPress: actions.onCreate } : null}
                    details={outcome.message ? [outcome.message] : undefined}
                    announce="alert"
                />
            );
        case 'stopped':
            return <CommitPlanStoppedSummary proposal={props.proposal} branch={props.branch} actions={actions} />;
        case 'complete':
            return (
                <SurfaceStateCard
                    testID="commit-plan-outcome-complete"
                    size="line"
                    kind="success"
                    title={t('commitProposal.outcome.completeTitle', { count: outcome.landedCount })}
                    reason={[props.branch ? t('commitProposal.outcome.onBranch', { branch: props.branch }) : null, t('commitProposal.outcome.completeBody')].filter(Boolean).join(' · ')}
                    accessibilitySemantics="status"
                />
            );
        default:
            // A hook's change or failure is said inside its own commit (see CommitPlanGroupOutcome).
            return null;
    }
}

function failedTitle(reason: string): string {
    switch (reason) {
        case 'staging_conflict': return t('commitProposal.outcome.failed.staging_conflict');
        case 'selection_conflict': return t('commitProposal.outcome.failed.selection_conflict');
        case 'source_changed': return t('commitProposal.outcome.failed.source_changed');
        case 'publication_warning': return t('commitProposal.outcome.failed.publication_warning');
        case 'cancelled': return t('commitProposal.outcome.failed.cancelled');
        default: return t('commitProposal.outcome.failed.writer_failed');
    }
}

/** After any stop: what landed with its SHA, what did not, and the one way on (lab WT4-C4 "Stopped partway"). */
function CommitPlanStoppedSummary(props: Readonly<{ proposal: CommitProposal; branch: string | null; actions: CommitPlanOutcomeActions }>) {
    const { proposal } = props;
    const remaining = proposal.groups.length - proposal.landedCount;
    return (
        <View testID="commit-plan-outcome-stopped" style={styles.summary} accessibilityLiveRegion="polite">
            <Text style={styles.summaryTitle}>{t('commitProposal.outcome.stoppedTitle', { landed: proposal.landedCount, total: proposal.groups.length })}</Text>
            {remaining > 0 ? <Text style={styles.summaryBody}>{t('commitProposal.outcome.stoppedBody', { count: remaining })}</Text> : null}
            <View style={styles.summaryList}>
                {proposal.groups.map((group, index) => (
                    <View key={group.id} style={[styles.summaryRow, index > 0 ? styles.summaryRowDivided : null]}>
                        <CommitGroupMark number={group.number} state={group.state === 'landed' ? 'landed' : 'notCreated'} />
                        <View style={styles.summaryText}>
                            <Text style={styles.summaryMessage} numberOfLines={1}>{group.message}</Text>
                            <Text style={styles.summaryMeta}>
                                {group.landedSha
                                    ? <><Text style={styles.mono}>{shortSha(group.landedSha)}</Text>{props.branch ? ` · ${t('commitProposal.outcome.onBranch', { branch: props.branch })}` : ''}</>
                                    : `${t('commitProposal.state.notCreatedShort')} · ${t('commitProposal.fileCount', { count: group.changes.length })}`}
                            </Text>
                        </View>
                    </View>
                ))}
            </View>
            {remaining > 0 && props.actions.onCreate || props.actions.onShowInGit ? (
                <View style={styles.actions}>
                    {remaining > 0 && props.actions.onCreate ? (
                        <RoundButton testID="commit-plan-create-rest" size="small" title={t('commitProposal.outcome.createRest', { count: remaining })} onPress={props.actions.onCreate} />
                    ) : null}
                    {props.actions.onShowInGit ? (
                        <RoundButton size="small" display="secondary" title={t('commitProposal.outcome.showInGit')} onPress={props.actions.onShowInGit} />
                    ) : null}
                </View>
            ) : null}
        </View>
    );
}

/**
 * The outcome that belongs to one commit, drawn inside it: a hook that changed files (include or cancel), a hook
 * that failed (its output), or a landed commit whose message a hook rewrote (shown, allowed).
 */
export function CommitPlanGroupOutcome(props: Readonly<{
    group: CommitProposalGroup;
    outcome: CommitPlanOutcome | null;
    actions: CommitPlanOutcomeActions;
    phone: boolean;
    hookEvidenceReady?: boolean;
    hookChanges?: React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    const { group, outcome, actions } = props;
    if (group.rewrittenMessage) {
        const original = group.message.trim();
        const lines = group.rewrittenMessage.replace(/\n+$/, '').split('\n');
        // The note names what the block shows, so it heads the block instead of riding the landed line (lab WT4-C4).
        return (
            <View style={styles.log} testID={`commit-group-rewritten:${group.id}`}>
                <Text style={styles.logCaption}>{t('commitProposal.state.rewritten')}</Text>
                {lines.map((line, index) => (
                    <Text key={index} style={[styles.logText, index > 0 && line.trim() && !original.includes(line.trim()) ? { color: theme.colors.state.success.textForeground } : null]}>
                        {line || ' '}
                    </Text>
                ))}
            </View>
        );
    }
    if (outcome?.kind === 'hookChanged' && outcome.groupId === group.id) {
        const message = outcome.landedCount > 0
            ? t('commitProposal.outcome.waitsAfterLanded', { count: outcome.landedCount })
            : t('commitProposal.outcome.waits');
        return (
            <View style={styles.inset} testID={`commit-group-hook-changed:${group.id}`}>
                <Text style={styles.insetText}>
                    <Text style={styles.insetStrong}>
                        {outcome.hookName
                            ? t('commitProposal.outcome.hookChangedBy', { hook: outcome.hookName, files: joinFileNames(outcome.paths) })
                            : t('commitProposal.outcome.hookChanged', { files: joinFileNames(outcome.paths) })}
                    </Text>
                    {` ${message}`}
                </Text>
                {props.hookChanges}
                {props.phone ? null : (
                    <View style={styles.actions}>
                        {actions.onIncludeHookChanges ? (
                            <RoundButton testID="commit-plan-include-hook" size="small" title={t('commitProposal.outcome.include')}
                                disabled={!props.hookEvidenceReady} onPress={actions.onIncludeHookChanges} />
                        ) : null}
                        {actions.onCancel ? (
                            <RoundButton testID="commit-plan-cancel-commit" size="small" display="inverted" title={t('commitProposal.outcome.cancelCommit')} onPress={actions.onCancel} />
                        ) : null}
                    </View>
                )}
            </View>
        );
    }
    if (outcome?.kind === 'hookFailed' && outcome.groupId === group.id) {
        return (
            <View style={styles.inset} testID={`commit-group-hook-failed:${group.id}`}>
                <Text style={styles.insetText}>
                    <Text style={styles.insetStrong}>
                        {outcome.hookName ? t('commitProposal.outcome.hookFailedBy', { hook: outcome.hookName }) : t('commitProposal.outcome.hookFailed')}
                    </Text>
                    {` ${t('commitProposal.outcome.hookFailedBody')}`}
                </Text>
                {outcome.output ? (
                    <View style={[styles.log, styles.logFlush]}><Text style={styles.logText} selectable>{outcome.output.replace(/\n+$/, '')}</Text></View>
                ) : null}
                <View style={styles.actions}>
                    {actions.onCreate ? (
                        <RoundButton testID="commit-plan-try-again" size="small" title={t('commitProposal.outcome.tryAgain')} onPress={actions.onCreate} />
                    ) : null}
                    {actions.onAskSession ? (
                        <RoundButton size="small" display="secondary" title={t('commitProposal.outcome.askSessionToFix')} onPress={actions.onAskSession} />
                    ) : null}
                </View>
            </View>
        );
    }
    return null;
}

/** A landed commit's line (lab WT4-C3): its SHA, when it was committed, and "signed" only when it was. A rewritten message heads its own block below. */
export function LandedMeta(props: Readonly<{ sha: string; committedAtMs: number | null; signed: boolean }>) {
    const { theme } = useUnistyles();
    const parts = [
        props.committedAtMs !== null ? t('commitProposal.state.landedAt', { time: formatAsOfTime(props.committedAtMs) }) : t('commitProposal.state.landed'),
        props.signed ? t('commitProposal.state.signed') : null,
    ].filter((part): part is string => part !== null);
    return (
        <Text style={styles.metaText} testID="commit-group-landed-meta">
            <Text style={[styles.mono, { color: theme.colors.text.secondary }]}>{shortSha(props.sha)}</Text>
            {` · ${parts.join(' · ')}`}
        </Text>
    );
}

export function GroupMetaText(props: Readonly<{ children: React.ReactNode; tone?: 'warning' | 'danger' | null; icon?: 'lock' | null }>) {
    const { theme } = useUnistyles();
    const color = props.tone === 'warning' ? theme.colors.state.warning.textForeground
        : props.tone === 'danger' ? theme.colors.state.danger.textForeground : undefined;
    return (
        <View style={styles.metaRow}>
            {props.icon ? <Icon name={props.icon} size={12} color={theme.colors.text.tertiary} /> : null}
            <Text style={[styles.metaText, color ? { color } : null]}>{props.children}</Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    summary: {
        padding: 18,
        borderRadius: 14,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.strong,
        backgroundColor: theme.colors.surface.base,
    },
    summaryTitle: { ...Typography.variant('heading'), lineHeight: 23, color: theme.colors.text.primary,  },
    summaryBody: { marginTop: theme.space.s4, ...Typography.variant('reading'),  color: theme.colors.text.secondary,  },
    summaryList: { marginTop: theme.space.s10 },
    summaryRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s12, paddingVertical: theme.space.s10 },
    summaryRowDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border.default },
    summaryText: { flex: 1, minWidth: 0 },
    summaryMessage: { ...Typography.variant('heading'),  color: theme.colors.text.primary,  },
    summaryMeta: { ...Typography.variant('body'),  color: theme.colors.text.tertiary,  },
    // Inline in a meta line: mono takes the surrounding role's size.
    mono: { ...Typography.mono() },
    actions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: theme.space.s8, marginTop: theme.space.s12 },
    inset: { paddingLeft: 50, paddingRight: theme.space.s16, paddingBottom: theme.space.s16, paddingTop: theme.space.s2 },
    insetText: { ...Typography.variant('reading'),  color: theme.colors.text.secondary,  },
    insetStrong: { color: theme.colors.text.primary, ...Typography.default('semiBold') },
    log: {
        marginLeft: 50,
        marginRight: theme.space.s16,
        marginBottom: theme.space.s16,
        paddingHorizontal: 14,
        paddingVertical: theme.space.s12,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.inset,
    },
    logFlush: { marginLeft: 0, marginRight: 0, marginBottom: 0, marginTop: theme.space.s10 },
    // Hook output is terminal text (D8): mono at the meta size with a log's leading.
    logText: { ...Typography.variant('meta'), lineHeight: 19, color: theme.colors.text.secondary, ...Typography.mono() },
    logCaption: { ...Typography.variant('meta'), color: theme.colors.text.tertiary, marginBottom: theme.space.s6 },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4 },
    metaText: { ...Typography.variant('body'),  color: theme.colors.text.tertiary,  },
}));
