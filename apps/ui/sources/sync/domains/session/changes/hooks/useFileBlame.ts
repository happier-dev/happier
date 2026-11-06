import * as React from 'react';
import { SCM_OPERATION_ERROR_CODES, type ScmBlameFileResponse } from '@happier-dev/protocol/scm';
import { compareTurnChangeSetChronology } from '@happier-dev/protocol/sessions/changes/mergeTurnChangeSets';
import { normalizeRepositoryFilePath } from '@happier-dev/protocol/sessions/changes/reconcileWithScmSnapshot';

import { machineScmBlameFile } from '@/sync/ops/machineScmBlame';
import { resolveVisibleAccountActorPresentation } from '@/sync/domains/account/accountActorPresentation';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

import { deriveFileBlameRuns, type FileBlameRun, type FileBlameSession } from '../derivation/fileBlameRuns';
import { deriveLatestTurnScopedChangeSet } from '../derivation/deriveLatestTurnScopedChangeSet';
import { useDerivedSessionChangeSet } from './useDerivedSessionChangeSet';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';

export type FileBlameScope = WorkspaceScopeBase & Readonly<{
    accountId: string;
}>;
export type UseFileBlameInput = Readonly<{
    scope: FileBlameScope | null;
    path: string;
    /** Saved bytes currently shown by the File page; hash has the Machine's raw-byte basis. */
    content: Readonly<{ text: string; hash: string }> | null;
    session?: FileBlameSession | null;
    enabled: boolean;
    /** Admit a new read only on the active page; an existing approval retains its read intent. */
    active?: boolean;
    readBlame: boolean;
    /** Canonical SCM refresh completion; HEAD can change while file bytes stay identical. */
    revision?: string | number | null;
    /** Refresh saved bytes before retrying the Machine's typed stale-file response. */
    refreshContent?: () => Promise<void>;
    /** The File page supplies its canonical primary-Turn label by identity, never a file-change count. */
    labels: Readonly<{ uncommitted: string; turn: (turnId: string) => string }>;
}>;
export type UseFileBlameResult = Readonly<{
    runs: readonly FileBlameRun[];
    loading: boolean;
    error: string | null;
    errorCode: string | null;
    stale: boolean;
    noHistory: boolean;
    refresh: () => void;
}>;

type BlameSnapshot = Readonly<{ key: string; resourceKey: string; response: ScmBlameFileResponse; observedAtMs: number }>;
const NO_RUNS: readonly FileBlameRun[] = [];
const retainedResultDeliveredByInvocation = () => {};

export function useFileBlame(input: UseFileBlameInput): UseFileBlameResult {
    const { scope, content } = input;
    const [refreshVersion, setRefreshVersion] = React.useState(0);
    const [snapshot, setSnapshot] = React.useState<BlameSnapshot | null>(null);
    const refresh = React.useCallback(() => setRefreshVersion((value) => value + 1), []);
    const active = input.enabled && input.readBlame && Boolean(
        scope?.machineId && scope.serverId && scope.accountId && content?.hash && input.path,
    );
    const resourceKey = active ? JSON.stringify([
        scope?.machineId, scope?.rootPath, scope?.serverId, scope?.accountId, input.path, content?.hash,
    ]) : null;
    const key = resourceKey ? JSON.stringify([resourceKey, refreshVersion, input.revision ?? null]) : null;
    const machineId = scope?.machineId;
    const rootPath = scope?.rootPath;
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    const path = input.path;
    const hash = content?.hash;
    const pageActive = input.active !== false;
    const invocation = React.useRef<Readonly<{ key: string; controller: AbortController }> | null>(null);
    const approval = useActionApprovalContinuation({ scopeKey: key ?? 'blame-disabled', serverId: serverId ?? '',
        onExecuted: retainedResultDeliveredByInvocation });
    const requestApproval = React.useRef(approval.requestApproval);
    requestApproval.current = approval.requestApproval;

    // Inbox navigation retains this File page but makes it inactive. Only a
    // changed read intent or unmount retires its controller, not that navigation.
    React.useEffect(() => {
        return () => {
            if (invocation.current?.key !== key) return;
            invocation.current.controller.abort();
            invocation.current = null;
        };
    }, [key]);
    React.useEffect(() => {
        if (!pageActive || !key || !resourceKey || !machineId || !hash || invocation.current?.key === key) return;
        const controller = new AbortController();
        invocation.current = { key, controller };
        void machineScmBlameFile(machineId, { cwd: rootPath, path, expectedHash: hash }, {
            serverId, accountId, signal: controller.signal,
            onApprovalPending: registration => { if (!controller.signal.aborted) requestApproval.current(registration); },
        }).then((response) => {
            if (!controller.signal.aborted) setSnapshot({ key, resourceKey, response, observedAtMs: Date.now() });
        }, (error: unknown) => {
            if (controller.signal.aborted) return;
            setSnapshot({ key, resourceKey, observedAtMs: Date.now(), response: {
                success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, error: error instanceof Error ? error.message : String(error),
            } });
        });
    }, [pageActive, key, resourceKey, machineId, rootPath, path, hash, serverId, accountId]);

    // Machine scope and Session evidence must describe the same Home. Project pages read no turns.
    const session = active && pageActive && input.session && input.session.address.serverId === serverId ? input.session : null;
    const derived = useDerivedSessionChangeSet(session?.address ?? null, rootPath);
    const turns = React.useMemo(() => {
        if (!session) return [];
        const filePath = normalizeRepositoryFilePath(path, rootPath);
        return [...(derived.sessionChangeSet?.turns ?? [])].sort(compareTurnChangeSetChronology).map((turn, order) => {
            const evidence = deriveLatestTurnScopedChangeSet({
                sessionId: session.address.sessionId, repoRootPath: rootPath, latestTurnChangeSet: turn,
            })?.files.find((file) => file.filePath === filePath) ?? null;
            const actor = derived.turnRequestersById.get(turn.turnId);
            const requester = resolveVisibleAccountActorPresentation({
                actor, ...session.authorship,
            });
            const label = input.labels.turn(turn.turnId);
            return {
                turnId: turn.turnId, order, label, evidence,
                presentation: {
                    turnId: turn.turnId, sessionId: session.address.sessionId, label,
                    agentLabel: session.agentLabel, sessionTitle: session.title, writtenAtMs: turn.derivedAt,
                    requester: actor && requester ? { actor, name: requester.name } : null,
                },
            };
        });
    }, [session?.address.sessionId, session?.address.serverId, session?.agentLabel, session?.title,
        session?.authorship.viewerScope, session?.authorship.hasOtherNamedCollaborator,
        derived.sessionChangeSet, derived.turnRequestersById, path, rootPath, input.labels.turn]);

    const currentSnapshot = resourceKey && snapshot?.resourceKey === resourceKey ? snapshot : null;
    const response = currentSnapshot?.response;
    const errorCode = response && !response.success ? response.errorCode ?? null : null;
    const noHistory = errorCode === 'untracked' || errorCode === 'unsupported_path';
    const stale = errorCode === 'stale_file';
    const refreshContent = React.useRef(input.refreshContent);
    refreshContent.current = input.refreshContent;
    React.useEffect(() => {
        if (!stale || !refreshContent.current) return;
        let current = true;
        void refreshContent.current().then(() => { if (current) refresh(); }, () => {});
        return () => { current = false; };
        // A repeated stale result waits for explicit refresh or new saved bytes. It never polls.
    }, [stale, resourceKey, refresh]);
    const runs = React.useMemo(() => {
        if (!currentSnapshot || !content) return NO_RUNS;
        const blame = currentSnapshot.response;
        if (!blame.success && !noHistory) return NO_RUNS;
        const lineCount = content.text === '' ? 0 : content.text.split('\n').length - (content.text.endsWith('\n') ? 1 : 0);
        return deriveFileBlameRuns({
            response: blame.success ? blame : { success: true, commits: [], ranges: lineCount > 0
                ? [{ startLine: 1, lineCount, commitIndex: null }] : [] },
            text: content.text, turns, uncommittedLabel: input.labels.uncommitted, nowMs: currentSnapshot.observedAtMs,
        });
    }, [currentSnapshot, content?.text, noHistory, turns, input.labels.uncommitted]);
    return {
        runs, loading: key !== null && currentSnapshot?.key !== key && (pageActive || invocation.current?.key === key),
        error: response && !response.success && !noHistory ? response.error ?? null : null,
        errorCode, stale, noHistory, refresh,
    };
}
