import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Icon } from '@/components/ui/icons/Icon';
import { formatExactCount } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { hapticsError, hapticsSuccess } from '@/components/ui/theme/haptics';
import type { ScmWriteOperation, ScmWriteTerminalOperation } from '@/scm/operations/selectScmWriteOperation';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import type { ScmProjectOperationKind } from '@/sync/runtime/orchestration/projectManager';
import { t } from '@/text';
import { useElapsedTime } from '@/hooks/ui/useElapsedTime';
import { formatHappierAsOfTime } from '@happier-dev/plugin-ui/presentation';
import { useMachine, useServerScopedMachine } from '@/sync/domains/state/storage';

/** What the pane knew when an operation started, so its outcome can say how much moved (Pushed 3 commits). */
export type GitOutcomeFacts = Readonly<{
    ahead: number;
    behind: number;
    selectedCount: number;
    /** Uncommitted changes when the operation started (a dirty pull's reassurance). */
    changedCount?: number;
    upstream: string | null;
}>;

export type GitOutcomeRecovery = Readonly<{
    /** Read what origin has (a rejected push's recovery). */
    fetch?: () => void;
    /** Run the failed action again. */
    retry?: (action: ScmProjectOperationKind) => void;
    /** Re-read the working tree (a refresh that failed after a commit landed, or a machine that came back). */
    refresh?: () => void;
    openTerminal?: () => void;
    /** Bring the conflicted files into view. */
    showConflicts?: () => void;
    /** Put this branch on origin (an upstream is required). */
    publish?: () => void;
    /**
     * Pull again with an explicit, one-time choice (orchestrator decisions 1–2): keep uncommitted changes aside first
     * (highlighted) or let Git decide overlap; rebase (highlighted on feature branches) or merge when both moved.
     * Absent when the backend cannot honour a policy (`writeRemotePolicies`).
     */
    pullWith?: (policy: Readonly<{ dirtyPolicy?: 'autostash' | 'allow_git'; reconcile?: 'rebase' | 'merge' }>) => void;
    /** An explicitly chosen reconciliation, followed by a push only when the remote owner confirms success. */
    pullThenPush?: (policy: Readonly<{ reconcile: 'rebase' | 'merge' }>) => void;
    /** The branch is a feature branch (not the repository's default): rebase is the highlighted reconcile. */
    preferRebase?: boolean;
    /** Undo exactly the commit displayed by this result; the daemon rejects a changed HEAD. */
    undoCommit?: (expectedHeadOid: string) => void | Promise<unknown>;
}>;

/** A success line stays this long, then fades (Git lab round 3: "the line fades after 6 s or on the next action"). */
const SUCCESS_LINE_VISIBLE_MS = 6_000;

/** Actions whose progress already lives in the control that started them (the header action, the commit button). */
const PROGRESS_SHOWN_IN_CONTROL: ReadonlySet<ScmProjectOperationKind> = new Set(['commit', 'fetch', 'create_pr']);

/**
 * The Git pane's one outcome (Git lab C/S/SX): progress for work that has no control of its own, one quiet line
 * with a check when a write lands, and — when it fails — one notice where the eye already is, naming the cause
 * and one recovery. Nothing is a modal. It reads only the project operation owner's projection; the facts
 * captured when the operation started let it say how much moved.
 */
export const GitOutcomeLine = React.memo(function GitOutcomeLine(props: Readonly<{
    operation: ScmWriteOperation | null;
    facts: GitOutcomeFacts;
    machineName: string | null;
    /** The session's machine answers right now (an unreachable machine is said as such, never as a Git failure). */
    machineReachable?: boolean;
    machineId?: string | null;
    serverId?: string;
    machineLastSeenAt?: number | null;
    authenticationCommand?: string | null;
    recovery: GitOutcomeRecovery;
    /** Phones get one light haptic when a write lands and one warning haptic on failure. */
    haptics: boolean;
}>) {
    const { operation } = props;
    const runningRemote = operation && (operation.phase === 'running' || operation.phase === 'queued') && (operation.action === 'push' || operation.action === 'pull');
    const elapsedSeconds = useElapsedTime(runningRemote ? operation.at : null);
    const factsAtStartRef = React.useRef(new Map<string, GitOutcomeFacts>());
    const [dismissedId, setDismissedId] = React.useState<string | null>(null);

    // Remember what the pane knew when this operation started; its outcome reads it.
    if (operation && (operation.phase === 'queued' || operation.phase === 'running') && !factsAtStartRef.current.has(operation.id)) {
        factsAtStartRef.current.clear();
        factsAtStartRef.current.set(operation.id, props.facts);
    }
    const factsAtStart = operation ? factsAtStartRef.current.get(operation.id) ?? null : null;

    const operationId = operation?.id ?? null;
    const phase = operation?.phase ?? null;
    const tone = phase === null || phase === 'queued' || phase === 'running' || phase === 'cancelled'
        ? null
        : phase === 'succeeded' ? 'success' : 'attention';
    React.useEffect(() => {
        if (!operationId || !props.haptics || !tone) return;
        if (tone === 'success') void hapticsSuccess();
        else void hapticsError();
    }, [operationId, props.haptics, tone]);

    React.useEffect(() => {
        if (phase !== 'succeeded' || !operationId) return;
        const timer = setTimeout(() => setDismissedId(operationId), SUCCESS_LINE_VISIBLE_MS);
        return () => clearTimeout(timer);
    }, [operationId, phase]);

    const dismiss = React.useCallback(() => setDismissedId(operationId), [operationId]);
    if (!operation || operation.id === dismissedId) return null;

    if (operation.phase === 'queued' || operation.phase === 'running') {
        if (PROGRESS_SHOWN_IN_CONTROL.has(operation.action)) return null;
        return (
            <OutcomeFrame>
                <SurfaceStateCard
                    testID="session-git-outcome-running"
                    size="line"
                    kind="loading"
                    title={operation.action === 'push' || operation.action === 'pull'
                        ? t(operation.action === 'push' ? 'sessionGitPane.fidelity.pushing' : 'sessionGitPane.fidelity.pulling', { count: operation.action === 'push' ? props.facts.ahead : props.facts.behind, target: props.facts.upstream ?? t('sessionGitPane.flow.failed.origin') })
                        : runningTitle(operation.action)}
                    reason={runningRemote ? [operation.progressText, t('sessionGitPane.fidelity.elapsed', { seconds: elapsedSeconds })].filter(Boolean).join(' · ') : operation.progressText || undefined}
                    accessibilitySemantics="status"
                />
            </OutcomeFrame>
        );
    }
    // The person backed out of an ask: nothing to say.
    if (operation.phase === 'cancelled') return null;
    if (operation.phase === 'succeeded') {
        return (
            <OutcomeFrame>
                <SuccessLine operation={operation} facts={factsAtStart} undoCommit={props.recovery.undoCommit} />
            </OutcomeFrame>
        );
    }
    const Notice = props.machineReachable === false ? OfflineAttentionNotice : AttentionNotice;
    return (
        <OutcomeFrame>
            <Notice
                key={operation.id}
                operation={operation}
                machineName={props.machineName}
                machineReachable={props.machineReachable !== false}
                upstream={factsAtStart?.upstream ?? props.facts.upstream}
                facts={factsAtStart}
                recovery={props.recovery}
                onDismiss={dismiss}
                authenticationCommand={props.authenticationCommand}
                machineId={props.machineId}
                serverId={props.serverId}
                machineLastSeenAt={props.machineLastSeenAt}
            />
        </OutcomeFrame>
    );
});

/** Retained operation results stay still when the pane opens on them. */
function OutcomeFrame(props: Readonly<{ children: React.ReactNode }>) {
    return <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 6 }}>{props.children}</View>;
}

function SuccessLine(props: Readonly<{ operation: Extract<ScmWriteTerminalOperation, { phase: 'succeeded' | 'effect_applied_with_warning' }>; facts: GitOutcomeFacts | null; undoCommit?: GitOutcomeRecovery['undoCommit'] }>) {
    const { theme } = useUnistyles();
    const copy = successCopy(props.operation, props.facts);
    const sha = props.operation.action === 'commit' && props.operation.phase === 'succeeded' ? props.operation.result?.sha : undefined;
    const undoCommit = props.undoCommit;
    return (
        <SurfaceStateCard
            testID="session-git-outcome-succeeded"
            size="line"
            kind="success"
            title={copy.title}
            reason={copy.detail ?? undefined}
            action={sha && undoCommit ? { label: t('sessionGitPane.flow.undo.action'), testID: 'session-git-outcome-undo', onPress: () => undoCommit(sha) } : undefined}
            icon={<Icon name="check-circle" size={16} color={theme.colors.state.success.foreground} />}
            accessibilitySemantics="status"
        />
    );
}

type AttentionOperation = Exclude<ScmWriteTerminalOperation, { phase: 'succeeded' | 'cancelled' }>;
type NoticeAction = { label: string; onPress: () => void };

/** One recovery for the outcome, from what the operation owner says can be done next (`nextActions`). */
/** Two explicit choices the owner asks for (`choose_dirty_policy`, `choose_reconcile`), highlighted one first. */
function choicesFor(operation: AttentionOperation, recovery: GitOutcomeRecovery): readonly [NoticeAction, NoticeAction] | null {
    const pullWith = recovery.pullWith;
    const kinds = new Set(operation.outcome.nextActions.map((next) => next.kind));
    if (kinds.has('choose_dirty_policy') && pullWith) {
        return [
            { label: t('sessionGitPane.flow.choices.keepAsideAndPull'), onPress: () => pullWith({ dirtyPolicy: 'autostash' }) },
            { label: t('sessionGitPane.flow.choices.pullIfNoOverlap'), onPress: () => pullWith({ dirtyPolicy: 'allow_git' }) },
        ];
    }
    if (kinds.has('choose_reconcile')) {
        const reconcile = operation.action === 'push' && recovery.pullThenPush ? recovery.pullThenPush : pullWith;
        if (!reconcile) return null;
        const rebase = { label: t('sessionGitPane.flow.choices.rebase'), onPress: () => reconcile({ reconcile: 'rebase' }) };
        const merge = { label: t('sessionGitPane.flow.choices.merge'), onPress: () => reconcile({ reconcile: 'merge' }) };
        return recovery.preferRebase === false ? [merge, rebase] : [rebase, merge];
    }
    return null;
}

function recoveryFor(operation: AttentionOperation, recovery: GitOutcomeRecovery): NoticeAction | null {
    const retry = recovery.retry && RETRYABLE.has(operation.action) ? () => recovery.retry?.(operation.action) : null;
    for (const next of operation.outcome.nextActions) {
        switch (next.kind) {
            case 'resolve_conflicts':
                if (recovery.showConflicts) return { label: t('sessionGitPane.flow.recover.showConflicts'), onPress: recovery.showConflicts };
                break;
            // Divergence choices (rebase / merge) land with the git-logic pull policies; until then, read what origin has.
            case 'choose_reconcile':
                if (recovery.fetch) return { label: t('sessionGitPane.flow.recover.fetch'), onPress: recovery.fetch };
                break;
            case 'configure_upstream':
                if (recovery.publish) return { label: t('sessionGitPane.flow.action.publish'), onPress: recovery.publish };
                break;
            case 'refresh':
                if (recovery.refresh) return { label: t('sessionGitPane.flow.recover.checkAgain'), onPress: recovery.refresh };
                break;
            case 'retry':
                if (retry) return { label: t('sessionGitPane.flow.recover.tryAgain'), onPress: retry };
                break;
            case 'open_url': {
                const url = next.url;
                return { label: t('sessionGitPane.flow.recover.open'), onPress: () => { void openExternalUrl(url); } };
            }
            default:
                break;
        }
    }
    return null;
}

function AttentionNotice(props: Readonly<{
    operation: AttentionOperation;
    machineName: string | null;
    machineReachable: boolean;
    upstream: string | null;
    facts: GitOutcomeFacts | null;
    recovery: GitOutcomeRecovery;
    onDismiss: () => void;
    authenticationCommand?: string | null;
    machineId?: string | null;
    serverId?: string;
    machineLastSeenAt?: number | null;
}>) {
    const { operation, recovery } = props;
    const { theme } = useUnistyles();
    const [reconcileOpen, setReconcileOpen] = React.useState(false);
    const outcome = operation.outcome;
    const errorCode = 'errorCode' in outcome ? outcome.errorCode : undefined;
    const machine = operation.machine ?? props.machineName ?? t('sessionGitPane.flow.failed.thisMachine');
    const target = props.upstream ?? t('sessionGitPane.flow.failed.origin');
    let title: string;
    let description: string;
    let tone: 'warning' | 'neutral' | 'danger' = 'warning';
    const deferredPushReconcile = operation.action === 'push' && recovery.pullThenPush && operation.outcome.nextActions.some((next) => next.kind === 'choose_reconcile');
    const choices = !deferredPushReconcile || reconcileOpen ? choicesFor(operation, recovery) : null;
    let action = choices ? choices[0] : recoveryFor(operation, recovery);
    let secondaryAction: NoticeAction | null = choices ? choices[1] : null;
    if (deferredPushReconcile && !reconcileOpen) action = { label: t('sessionGitPane.fidelity.pullThenPush'), onPress: () => setReconcileOpen(true) };
    if (operation.phase === 'effect_applied_with_warning') {
        // The write happened; something after it did not. Say what landed first.
        title = operation.action === 'commit' ? t('sessionGitPane.flow.failed.refreshTitle') : successCopy(operation, props.facts).title;
        description = operation.message || t('sessionGitPane.flow.failed.refreshBody');
    } else if (operation.phase === 'outcome_unknown') {
        tone = 'neutral';
        title = t('sessionGitPane.flow.failed.unknownTitle');
        description = t('sessionGitPane.flow.failed.unknownBody');
        action = action ?? (recovery.refresh ? { label: t('sessionGitPane.flow.recover.checkAgain'), onPress: recovery.refresh } : null);
    } else if (!props.machineReachable) {
        tone = 'neutral';
        title = t('sessionGitPane.flow.failed.offlineTitle', { machine });
        description = props.machineLastSeenAt ? t('sessionGitPane.fidelity.lastSeen', { when: formatHappierAsOfTime(props.machineLastSeenAt) }) : t('sessionGitPane.flow.failed.offlineBody');
        action = recovery.refresh ? { label: t('sessionGitPane.flow.recover.checkAgain'), onPress: recovery.refresh } : null;
    } else if (operation.phase === 'conflicted' || errorCode === 'CONFLICTING_WORKTREE' || errorCode === 'BRANCH_OPERATION_IN_PROGRESS') {
        title = t('sessionGitPane.flow.failed.conflictTitle');
        description = t('sessionGitPane.flow.failed.conflictBody');
        action = action ?? (recovery.showConflicts ? { label: t('sessionGitPane.flow.recover.showConflicts'), onPress: recovery.showConflicts } : null);
    } else if (operation.outcome.nextActions.some((next) => next.kind === 'choose_dirty_policy')) {
        const count = props.facts?.changedCount ?? 0;
        title = t('sessionGitPane.flow.choices.dirtyTitle', { count, formatted: formatExactCount(count) });
        description = t('sessionGitPane.flow.choices.dirtyBody');
    } else if (errorCode === 'REMOTE_NON_FAST_FORWARD' || errorCode === 'REMOTE_FF_ONLY_REQUIRED') {
        title = t('sessionGitPane.flow.failed.rejectedTitle', { target });
        description = choices
            ? (operation.action === 'push' ? t('sessionGitPane.flow.choices.divergedPushBody') : t('sessionGitPane.flow.choices.divergedPullBody'))
            : t('sessionGitPane.flow.failed.rejectedBody');
    } else if (errorCode === 'REMOTE_AUTH_REQUIRED') {
        tone = 'danger';
        title = t('sessionGitPane.flow.failed.authTitle', { provider: operation.provider ?? target, machine });
        description = props.authenticationCommand ? t('sessionGitPane.fidelity.authenticationHint', { command: props.authenticationCommand, machine }) : t('sessionGitPane.flow.failed.authBody', { machine });
        action = recovery.openTerminal ? { label: t('sessionGitPane.fidelity.openTerminal'), onPress: recovery.openTerminal } : action ?? (recovery.retry && RETRYABLE.has(operation.action) ? { label: t('sessionGitPane.flow.recover.tryAgain'), onPress: () => recovery.retry?.(operation.action) } : null);
    } else if (errorCode === 'REMOTE_NETWORK_FAILED') {
        title = t('sessionGitPane.flow.failed.networkTitle', { target });
        description = t('sessionGitPane.flow.failed.networkBody');
        action = action ?? (recovery.retry && RETRYABLE.has(operation.action) ? { label: t('sessionGitPane.flow.recover.tryAgain'), onPress: () => recovery.retry?.(operation.action) } : null);
    } else {
        title = failedTitle(operation.action);
        description = operation.message;
    }
    return (
        <View>
            <AttentionBanner
                placement="inline"
                testID={`session-git-outcome-${operation.phase}`}
                tone={tone}
                title={title}
                description={description}
                icon={!props.machineReachable ? <Icon name="wifi-slash" size={16} color={theme.colors.state.neutral.foreground} /> : errorCode === 'REMOTE_AUTH_REQUIRED' ? <Icon name="lock" size={16} color={theme.colors.state.danger.foreground} /> : undefined}
                action={action ? { ...action, display: 'default' } : null}
                secondaryAction={secondaryAction ? { ...secondaryAction, display: 'inverted' } : null}
                announce="alert"
                onDismiss={props.onDismiss}
            />
        </View>
    );
}

/** The machine heartbeat subscription exists only while this offline notice is mounted. */
function OfflineAttentionNotice(props: React.ComponentProps<typeof AttentionNotice>) {
    const id = props.machineId ?? '';
    const scoped = useServerScopedMachine(props.serverId, props.serverId ? id : '');
    const legacy = useMachine(props.serverId ? '' : id);
    const machine = props.serverId ? scoped : legacy;
    return <AttentionNotice {...props} machineLastSeenAt={props.machineLastSeenAt ?? machine?.activeAt ?? null} />;
}

const RETRYABLE: ReadonlySet<ScmProjectOperationKind> = new Set(['push', 'pull', 'fetch']);

function runningTitle(action: ScmProjectOperationKind): string {
    switch (action) {
        case 'commit_undo': return t('sessionGitPane.flow.undo.running');
        case 'branch_switch': return t('sessionGitPane.flow.running.branchSwitch');
        case 'branch_create': return t('sessionGitPane.flow.running.branchCreate');
        case 'stash_create': return t('sessionGitPane.flow.running.stashCreate');
        case 'discard': return t('sessionGitPane.flow.running.discard');
        case 'revert': return t('sessionGitPane.flow.running.revert');
        default: return t('sessionGitPane.flow.running.generic');
    }
}

function failedTitle(action: ScmProjectOperationKind): string {
    switch (action) {
        case 'commit_undo': return t('sessionGitPane.flow.undo.failed');
        case 'commit': return t('sessionGitPane.flow.failed.commitTitle');
        case 'push': return t('sessionGitPane.flow.failed.pushTitle');
        case 'pull': return t('sessionGitPane.flow.failed.pullTitle');
        case 'fetch': return t('sessionGitPane.flow.failed.fetchTitle');
        case 'create_pr': return t('sessionGitPane.flow.failed.pullRequestTitle');
        default: return t('sessionGitPane.flow.failed.genericTitle');
    }
}

function successCopy(
    operation: Extract<ScmWriteTerminalOperation, { phase: 'succeeded' | 'effect_applied_with_warning' }>,
    facts: GitOutcomeFacts | null,
): { title: string; detail: string | null } {
    const target = facts?.upstream ?? t('sessionGitPane.flow.failed.origin');
    switch (operation.action) {
        case 'commit_undo': return { title: t('sessionGitPane.flow.undo.done'), detail: t('sessionGitPane.flow.undo.staged') };
        case 'commit': {
            const count = facts?.selectedCount ?? 0;
            return {
                title: count > 0
                    ? t('sessionGitPane.flow.done.commitFiles', { count, formatted: formatExactCount(count) })
                    : t('sessionGitPane.flow.done.commit'),
                detail: operation.result?.sha ? operation.result.sha.slice(0, 7) : null,
            };
        }
        case 'push': {
            const count = facts?.ahead ?? 0;
            return {
                title: count > 0
                    ? t('sessionGitPane.flow.done.pushCommits', { count, formatted: formatExactCount(count) })
                    : t('sessionGitPane.flow.done.push'),
                detail: t('sessionGitPane.flow.done.upToDate', { target }),
            };
        }
        case 'pull': {
            const count = facts?.behind ?? 0;
            const changed = facts?.changedCount ?? 0;
            return {
                title: count > 0
                    ? t('sessionGitPane.flow.done.pullCommits', { count, formatted: formatExactCount(count) })
                    : t('sessionGitPane.flow.done.pull'),
                // Git refuses (or stashes and restores exactly) rather than touching uncommitted work, and a pull
                // that could not restore it reports a conflict instead of success — so a successful pull over
                // uncommitted changes left them as they were.
                detail: changed > 0 && operation.phase === 'succeeded'
                    ? t('sessionGitPane.flow.done.untouched', { count: changed, formatted: formatExactCount(changed) })
                    : null,
            };
        }
        case 'fetch': return { title: t('sessionGitPane.flow.done.fetch', { target }), detail: null };
        case 'branch_switch': return { title: t('sessionGitPane.flow.done.branchSwitch'), detail: null };
        case 'branch_create': return { title: t('sessionGitPane.flow.done.branchCreate'), detail: null };
        case 'stash_create': return { title: t('sessionGitPane.flow.done.stashCreate'), detail: null };
        case 'discard': return { title: t('sessionGitPane.flow.done.discard'), detail: null };
        case 'revert': return { title: t('sessionGitPane.flow.done.revert'), detail: null };
        case 'create_pr': return { title: t('sessionGitPane.flow.done.pullRequest'), detail: null };
        default: return { title: t('sessionGitPane.flow.done.generic'), detail: null };
    }
}
