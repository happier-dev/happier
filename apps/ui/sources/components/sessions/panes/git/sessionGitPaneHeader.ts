/**
 * What the session Git pane says in its pane header (Git lab A/S/ST/CF): where you are, the one change count,
 * and one trailing action — the next sync step, chosen from the actions the pane's owners actually offer (it
 * never invents an action the backend or policy does not allow). Commit is not a header action: the commit form
 * owns it, and while a commit is ready the header step steps down to secondary. One primary per view.
 */
import type { ScmOperationState } from '@happier-dev/protocol';
import type { ScmWriteOperation } from '@/scm/operations/selectScmWriteOperation';

export type SessionGitPaneHeaderFact =
    | Readonly<{ kind: 'branch'; branch: string }>
    | Readonly<{ kind: 'changed'; count: number }>
    | Readonly<{ kind: 'clean' }>
    | Readonly<{ kind: 'asOf'; at: number }>
    | Readonly<{ kind: 'operation'; operation: ScmOperationState['kind']; sourceRef: string | null }>
    | Readonly<{ kind: 'toPush'; count: number }>
    | Readonly<{ kind: 'toPull'; count: number }>;

type RemoteActionLike = Readonly<{ key: string; disabled: boolean }>;

export type SessionGitPaneActionKey = 'push' | 'pull' | 'fetch' | 'publish' | 'create-pr' | 'open-pr' | 'resolve' | 'up-to-date';
export type SessionGitPaneActionEmphasis = 'primary' | 'secondary' | 'quiet' | 'attention';
export type SessionGitPaneAction = Readonly<{
    key: SessionGitPaneActionKey;
    /** Commits it moves (Push 3), conflicts to resolve, or the open pull request's number; `null` otherwise. */
    count: number | null;
    disabled: boolean;
    reason?: string;
}>;
export type SessionGitPaneHeaderAction = SessionGitPaneAction & Readonly<{ emphasis: SessionGitPaneActionEmphasis }>;

export type SessionGitPaneActions = Readonly<{
    primary: SessionGitPaneHeaderAction;
    menu: readonly SessionGitPaneAction[];
}>;

/** One status decision for the Git header and its action menu. The UI supplies availability; this resolver never performs an operation. */
export function resolveSessionGitPaneActions(input: Readonly<{
    changedCount: number;
    ahead: number;
    behind: number;
    upstream: string | null;
    hasConflicts: boolean;
    conflictCount?: number;
    prState: 'none' | 'open' | 'unknown';
    prNumber?: number | null;
    canCreatePr: boolean;
    canOpenPrPage?: boolean;
    /** Something is selected and has a message: the commit form is the one primary. */
    commitReady: boolean;
    remoteActions: readonly RemoteActionLike[];
    writeOperation?: ScmWriteOperation | null;
}>): SessionGitPaneActions {
    const offered = (key: string) => input.remoteActions.find((action) => action.key === key);
    const remote = (key: 'pull' | 'push' | 'fetch' | 'publish', count: number | null): SessionGitPaneAction => {
        const action = offered(key);
        return { key, count, disabled: action?.disabled ?? true, ...(!action ? { reason: 'unavailable' } : {}) };
    };
    const canPr = input.canCreatePr || input.canOpenPrPage === true;
    const createPr: SessionGitPaneAction = {
        key: 'create-pr', count: null, disabled: !canPr, ...(!canPr ? { reason: 'unavailable' } : {}),
    };
    const menu: SessionGitPaneAction[] = [
        remote('push', input.ahead),
        remote('pull', input.behind),
        remote('fetch', null),
        createPr,
    ];
    if (!input.upstream) menu.unshift(remote('publish', null));

    const step = (action: SessionGitPaneAction): SessionGitPaneHeaderAction => ({
        ...action,
        emphasis: input.commitReady || action.disabled ? 'secondary' : 'primary',
    });
    let primary: SessionGitPaneHeaderAction;
    if (input.hasConflicts) {
        primary = { key: 'resolve', count: input.conflictCount ?? 0, disabled: false, emphasis: 'primary' };
    } else if (!input.upstream && offered('publish')) {
        primary = step(remote('publish', null));
    } else if (input.behind > 0 && offered('pull')) {
        primary = step(remote('pull', input.behind));
        const operation = input.writeOperation;
        if (!primary.disabled && operation?.phase === 'needs_input' && operation.action === 'push' && operation.outcome.errorCode === 'REMOTE_NON_FAST_FORWARD') primary = { ...primary, emphasis: 'attention' };
    } else if (input.ahead > 0 && offered('push')) {
        primary = step(remote('push', input.ahead));
    } else if (input.prState === 'open' && typeof input.prNumber === 'number') {
        primary = { key: 'open-pr', count: input.prNumber, disabled: false, emphasis: 'quiet' };
    } else {
        primary = { key: 'up-to-date', count: null, disabled: true, emphasis: 'quiet' };
    }
    return { primary, menu };
}

/** The header's live line: the branch and the one change count; a count the action already carries is not repeated. */
export function resolveSessionGitPaneHeaderFacts(input: Readonly<{
    branch: string | null;
    changedCount: number;
    ahead: number;
    behind: number;
    primaryKey: SessionGitPaneActionKey | null;
    operation?: Pick<ScmOperationState, 'kind' | 'sourceRef'> | null;
    asOf?: number | null;
}>): readonly SessionGitPaneHeaderFact[] {
    const facts: SessionGitPaneHeaderFact[] = [];
    if (input.branch) facts.push({ kind: 'branch', branch: input.branch });
    if (typeof input.asOf === 'number') {
        facts.push({ kind: 'asOf', at: input.asOf });
        return facts;
    }
    if (input.operation) {
        facts.push({ kind: 'operation', operation: input.operation.kind, sourceRef: input.operation.sourceRef ?? null });
        return facts;
    }
    facts.push(input.changedCount > 0 ? { kind: 'changed', count: input.changedCount } : { kind: 'clean' });
    if (input.ahead > 0 && input.primaryKey !== 'push') facts.push({ kind: 'toPush', count: input.ahead });
    if (input.behind > 0 && input.primaryKey !== 'pull') facts.push({ kind: 'toPull', count: input.behind });
    return facts;
}
