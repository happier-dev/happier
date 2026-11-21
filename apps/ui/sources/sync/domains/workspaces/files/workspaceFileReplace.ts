import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import * as React from 'react';
import { buildWorkspaceFileRestoreOperation, computeFileReplacement } from '@happier-dev/protocol/machines/workspaceFilesReplace';
import type {
  DaemonWorkspaceFileReplaceApplyRequest,
  DaemonWorkspaceFileReplacePreviewResponse,
} from '@happier-dev/protocol/machines/workspaceFiles';
import { ActionApprovalRequestCreatedResultSchema, type ActionApprovalRequestCreatedResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { resolveMachineAbsolutePath } from '@/sync/domains/fileSystem/resolveMachineAbsolutePath';
import { normalizeLocalPathForComparison } from '@/utils/path/resolvePathRelativeToRoot';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import {
  machineWorkspaceFileReplaceApply,
  machineWorkspaceFileReplacePreview,
} from '@/sync/ops/machineWorkspaceFileReplace';

/**
 * Replace across files (P8 U2): the Universal Search result list is the review. This module owns the
 * review state (the preview on screen, which matches are left selected, the result and its Undo) and
 * derives everything the surface draws from it. Matching and replacement stay in the protocol's one
 * pure `computeFileReplacement`; the Machine applies through its guarded writer.
 */

export type WorkspaceReplaceMatcher = Readonly<{
  query: string;
  replacement: string;
  matchCase: boolean;
  regex: boolean;
}>;
type PreviewOk = Extract<
  DaemonWorkspaceFileReplacePreviewResponse,
  { ok: true }
>;
export type WorkspaceReplacePreviewFile = PreviewOk['files'][number];
export type WorkspaceReplaceMatch =
  WorkspaceReplacePreviewFile['matches'][number];
type ReplaceSelection = Extract<
  DaemonWorkspaceFileReplaceApplyRequest['operation'],
  { kind: 'replace' }
>['files'][number];
type InverseEdit = NonNullable<
  Extract<
    DaemonWorkspaceFileReplaceApplyRequest['operation'],
    { kind: 'restore' }
  >['files'][number]['edits']
>[number];

/** Excluded match keys per file path. A file absent from the map has every match selected. */
export type WorkspaceReplaceExclusions = ReadonlyMap<
  string,
  ReadonlySet<string>
>;

export type WorkspaceReplaceFileStatus =
  | 'replaced'
  | 'changed'
  | 'skipped'
  | 'failed'
  | 'cancelled'
  /** Undo put the reviewed text back. */
  | 'restored'
  /** Undo found other bytes in the file and left it alone. */
  | 'undoChanged';
export type WorkspaceReplaceFileResult = Readonly<{
  path: string;
  renameTo?: string;
  status: WorkspaceReplaceFileStatus;
  matchCount?: number;
  /** `unsaved` for a file the editor holds a draft of; otherwise the Machine's reason. */
  reason?: string;
  hash?: string;
  edits?: readonly InverseEdit[];
}>;

export type WorkspaceReplaceErrorCode =
  | 'invalid_pattern'
  | 'root_not_allowed'
  | 'root_not_found'
  | 'unavailable'
  | 'update_required'
  | 'failed'
  | 'approval_required'
  /** The approval was declined or withdrawn; nothing ran. */
  | 'declined'
  /** The apply request left but its answer never came back: what was written is unknown. */
  | 'outcome_unknown';

export function replaceMatchKey(
  match: Readonly<{ line: number; column16: number }>,
): string {
  return `${match.line}:${match.column16}`;
}

export function replaceFileSelection(
  file: WorkspaceReplacePreviewFile,
  excluded: WorkspaceReplaceExclusions,
): Readonly<{
  selected: number;
  total: number;
  state: 'all' | 'some' | 'none';
}> {
  const keys = excluded.get(file.path);
  const total = file.matches.length;
  const selected = keys
    ? file.matches.filter((match) => !keys.has(replaceMatchKey(match))).length
    : total;
  return {
    selected,
    total,
    state: selected === 0 ? 'none' : selected === total ? 'all' : 'some',
  };
}

function replacePathKey(path: string, rootPath?: string): string {
  return normalizeLocalPathForComparison(rootPath
    ? resolveMachineAbsolutePath({ rootPath, requestPath: path, pathKind: 'workspace_entry' }) : path,
    { preserveWhitespace: true }) ?? path;
}

function isUnsaved(path: string, unsaved: ReadonlySet<string>, rootPath?: string): boolean {
  return unsaved.has(replacePathKey(path, rootPath));
}

/** What Apply sends: loaded files with a selected match that the editor does not hold a draft of. */
export function buildReplaceApplyFiles(
  files: readonly WorkspaceReplacePreviewFile[],
  excluded: WorkspaceReplaceExclusions,
  unsavedPaths: readonly string[],
  rootPath?: string,
): ReplaceSelection[] {
  const unsaved = new Set(unsavedPaths.map(path => replacePathKey(path, rootPath)));
  return files.flatMap((file): ReplaceSelection[] => {
    if (
      isUnsaved(file.path, unsaved, rootPath) ||
      replaceFileSelection(file, excluded).state === 'none'
    )
      return [];
    const keys = excluded.get(file.path);
    const excludedMatches = keys
      ? file.matches
          .filter((match) => keys.has(replaceMatchKey(match)))
          .map(({ line, column16 }) => ({ line, column16 }))
      : [];
    return [
      {
        path: file.path,
        expectedHash: file.hash,
        ...(excludedMatches.length ? { excludedMatches } : {}),
      },
    ];
  });
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * One line after the selected matches on it are replaced, through the same pure function the Machine
 * applies, so the review shows what is written.
 */
export function previewReplacedLine(
  file: WorkspaceReplacePreviewFile,
  line: number,
  matcher: WorkspaceReplaceMatcher,
  excludedKeys: ReadonlySet<string>,
): string {
  const onLine = file.matches.filter((match) => match.line === line);
  const text = onLine[0]?.text ?? '';
  const excludedMatches = onLine
    .filter((match) => excludedKeys.has(replaceMatchKey(match)))
    .map((match) => ({ line: 1, column16: match.column16 }));
  if (excludedMatches.length === onLine.length) return text;
  const result = computeFileReplacement(
    encoder.encode(text),
    matcher,
    excludedMatches,
  );
  return result.kind === 'ok' ? decoder.decode(result.newBytes) : text;
}

/** What one match turns into, for the inline old → new mark in its row. */
export function previewMatchInsertText(
  file: WorkspaceReplacePreviewFile,
  match: WorkspaceReplaceMatch,
  matcher: WorkspaceReplaceMatcher,
): string {
  const others = file.matches
    .filter(
      (other) => other.line === match.line && other.column16 !== match.column16,
    )
    .map((other) => ({ line: 1, column16: other.column16 }));
  const result = computeFileReplacement(
    encoder.encode(match.text),
    matcher,
    others,
  );
  return result.kind === 'ok' ? (result.edits[0]?.insertText ?? '') : '';
}

/**
 * The per-file diff of the review as a standard unified patch (rendered by the shared `DiffViewer`):
 * each changed line with the context the preview returned; nearby matches share one hunk.
 */
export function buildReplacePreviewUnifiedDiff(
  file: WorkspaceReplacePreviewFile,
  matcher: WorkspaceReplaceMatcher,
  excludedKeys: ReadonlySet<string>,
): string {
  const known = new Map<number, string>();
  const changed = new Map<number, string>();
  for (const match of file.matches) {
    match.before.forEach((text, index) =>
      known.set(match.line - match.before.length + index, text),
    );
    match.after.forEach((text, index) =>
      known.set(match.line + 1 + index, text),
    );
    known.set(match.line, match.text);
  }
  for (const line of new Set(file.matches.map((match) => match.line))) {
    const next = previewReplacedLine(file, line, matcher, excludedKeys);
    if (next !== known.get(line)) changed.set(line, next);
  }
  const header = `--- a/${file.path}\n+++ b/${file.path}\n`;
  if (changed.size === 0) return header;
  const lines = [...known.keys()]
    .filter((line) => line >= 1)
    .sort((a, b) => a - b);
  // Contiguous known runs that contain a change become hunks; a gap in what the preview returned ends one.
  const hunks: number[][] = [];
  let run: number[] = [];
  for (const line of lines) {
    if (run.length && line !== run[run.length - 1]! + 1) {
      hunks.push(run);
      run = [];
    }
    run.push(line);
  }
  if (run.length) hunks.push(run);
  const body = hunks
    .filter((hunk) => hunk.some((line) => changed.has(line)))
    .map((hunk) => {
      const rows = hunk.flatMap((line) =>
        changed.has(line)
          ? [`-${known.get(line)}`, `+${changed.get(line)}`]
          : [` ${known.get(line)}`],
      );
      return `@@ -${hunk[0]},${hunk.length} +${hunk[0]},${hunk.length} @@\n${rows.join('\n')}\n`;
    });
  return header + body.join('');
}

export type WorkspaceReplaceSummary = Readonly<{
  replacedFiles: number;
  replacedMatches: number;
  changed: number;
  skipped: number;
  failed: number;
  cancelled: number;
  restored: number;
}>;

export function summarizeReplaceResults(
  results: readonly WorkspaceReplaceFileResult[],
): WorkspaceReplaceSummary {
  const summary = {
    replacedFiles: 0,
    replacedMatches: 0,
    changed: 0,
    skipped: 0,
    failed: 0,
    cancelled: 0,
    restored: 0,
  };
  for (const result of results) {
    if (result.status === 'replaced') {
      summary.replacedFiles += 1;
      summary.replacedMatches += result.matchCount ?? 0;
    } else if (result.status === 'changed' || result.status === 'undoChanged')
      summary.changed += 1;
    else if (result.status === 'skipped') summary.skipped += 1;
    else if (result.status === 'failed') summary.failed += 1;
    else if (result.status === 'cancelled') summary.cancelled += 1;
    else if (result.status === 'restored') summary.restored += 1;
  }
  return summary;
}

type Preview = Readonly<{
  key: string;
  targetKey: string;
  matcher: WorkspaceReplaceMatcher;
  files: readonly WorkspaceReplacePreviewFile[];
  /** Drafts omitted from this review stay excluded until a fresh preview. */
  excludedUnsavedPaths: ReadonlySet<string>;
  notText: number;
  hasMore: boolean;
  cursor?: Readonly<{ path: string }>;
  coverage: 'complete' | 'partial';
}>;

export type WorkspaceReplaceUndoOutcome = Readonly<{
  restored: number;
  /** Files whose bytes moved since the replace; Undo left them alone. */
  changed: number;
  error: WorkspaceReplaceErrorCode | null;
  approval?: ActionApprovalRequestCreatedResult;
}>;

export type WorkspaceReplaceApproval = Readonly<{
  operation: 'preview' | 'replace' | 'restore';
  /** The Home the request was created on (its Inbox). */
  serverId: string;
  /** `approved` once the person approved it and it runs; the surface then shows the operation's own progress. */
  status: 'waiting' | 'approved';
  request: ActionApprovalRequestCreatedResult;
}>;

type RetainedReplaceResult = Readonly<{
  key: string;
  scope: WorkspaceScopeBase;
  options: Readonly<{ serverId: string; accountId: string }>;
  results: readonly WorkspaceReplaceFileResult[];
}>;
type ApplySettlement = Readonly<{
  error: WorkspaceReplaceErrorCode | null;
  approval: WorkspaceReplaceApproval | null;
}>;
export type WorkspaceReplaceCloseOutcome = ApplySettlement & Readonly<{
  machineId: string;
  results: readonly WorkspaceReplaceFileResult[];
  undo: ((onApprovalPending: (registration: ActionApprovalContinuation) => void) => Promise<WorkspaceReplaceUndoOutcome | null>) | null;
}>;

export type WorkspaceReplaceModel = Readonly<{
  /** The preview on screen; it stays while a newer one loads. */
  preview: Preview | null;
  /** Files listed under "Unsaved in the editor, skipped". */
  unsavedFiles: readonly WorkspaceReplacePreviewFile[];
  /** Reviewable files (never the unsaved ones). */
  files: readonly WorkspaceReplacePreviewFile[];
  excluded: WorkspaceReplaceExclusions;
  loading: boolean;
  loadingMore: boolean;
  /** What is typed differs from the preview on screen. */
  stale: boolean;
  error: WorkspaceReplaceErrorCode | null;
  totals: Readonly<{
    selectedMatches: number;
    totalMatches: number;
    selectedFiles: number;
    totalFiles: number;
  }>;
  applying: boolean;
  undoing: boolean;
  results: readonly WorkspaceReplaceFileResult[] | null;
  applyError: WorkspaceReplaceErrorCode | null;
  /** A known, durable approval request; no file effect has been acknowledged. */
  approval: WorkspaceReplaceApproval | null;
  canApply: boolean;
  canUndo: boolean;
  /** The one retained operation's Undo, including when another folder is currently selected. */
  undoOnClose: Readonly<{
    machineId: string;
    results: readonly WorkspaceReplaceFileResult[];
    run: () => Promise<WorkspaceReplaceUndoOutcome | null>;
  }> | null;
  /** Close cancels cooperatively and retains the same operation's terminal receipt, even after unmount. */
  settleOnClose: () => Promise<WorkspaceReplaceCloseOutcome | null>;
  toggleFile: (path: string) => void;
  toggleMatch: (path: string, key: string) => void;
  loadMore: () => void;
  apply: () => Promise<void>;
  cancelApply: () => void;
  /** Resolves with what Undo did, or null when there was nothing to undo; usable after the surface closed. */
  undo: (path?: string) => Promise<WorkspaceReplaceUndoOutcome | null>;
  /** Back to the review (Review again / Done). */
  resetResults: () => void;
  retry: () => void;
}>;

const NO_EXCLUSIONS: WorkspaceReplaceExclusions = new Map();
const NO_FILES: readonly WorkspaceReplacePreviewFile[] = [];

function replaceWriteActionError(errorCode: string): WorkspaceReplaceErrorCode {
  // This family's native target refusal precedes operation acceptance and all
  // filesystem effects. Other failures do not establish that nothing was written.
  return errorCode === 'target_unavailable' ? 'unavailable' : 'outcome_unknown';
}

function createdApproval(registration: ActionApprovalContinuation, actionId: string): ActionApprovalRequestCreatedResult {
  return { kind: 'approval_request_created', artifactId: registration.artifactId, actionId };
}

function readReplaceApproval(response: unknown): ActionApprovalRequestCreatedResult | null {
  if (!response || typeof response !== 'object' || !('errorCode' in response)
    || response.errorCode !== 'approval_required' || !('details' in response)) return null;
  const parsed = ActionApprovalRequestCreatedResultSchema.safeParse(response.details);
  return parsed.success ? parsed.data : null;
}

function undoableResults(results: readonly WorkspaceReplaceFileResult[]) {
  return results.filter(
    (result): result is WorkspaceReplaceFileResult & { status: 'replaced' } =>
      result.status === 'replaced' && Boolean(result.hash && result.edits && (result.edits.length || result.renameTo)),
  );
}

function previewError(
  response: Awaited<ReturnType<typeof machineWorkspaceFileReplacePreview>>,
): WorkspaceReplaceErrorCode | null {
  if (response.ok) return null;
  if ('errorCode' in response)
    return response.errorCode === 'method_unavailable' || response.errorCode === 'update_required'
      ? 'update_required'
      : isActionApprovalDeclinedErrorCode(response.errorCode) ? 'declined' : 'unavailable';
  if (
    response.code === 'invalid_pattern' ||
    response.code === 'root_not_allowed' ||
    response.code === 'root_not_found'
  )
    return response.code;
  return 'failed';
}

/**
 * The review's state owner. `matcher` null means Replace mode is off. A result retains its original
 * target and Account so leaving the folder cannot retarget or discard its Undo.
 */
export function useWorkspaceReplace(
  input: Readonly<{
    scope: WorkspaceScopeBase | null;
    /** Presence disarms new effects without changing the selected target or a pending read's intent. */
    available?: boolean;
    accountLifetime: ServerAccountScopeLifetime | null;
    matcher: WorkspaceReplaceMatcher | null;
    unsavedPaths: readonly string[];
  }>,
): WorkspaceReplaceModel {
  const { scope, accountLifetime, matcher } = input;
  const available = input.available !== false;
  const accountId = accountLifetime?.scope.accountId ?? null;
  // The mounted Account owner's approval custody: a request the person approves continues to its own
  // answer here (preview, replace or Undo) instead of being retried. Writes keep
  // durable Inbox custody; previews retain only the current review's read intent.
  const author = useMountedActionExecution(accountLifetime?.scope ?? null);
  const authorRef = React.useRef(author);
  authorRef.current = author;
  const targetKey =
    scope && accountId
      ? JSON.stringify([tryBuildWorkspaceCacheKey(scope), accountId])
      : null;
  const key =
    targetKey && accountLifetime && matcher && matcher.query.length > 0
      ? JSON.stringify([
          targetKey,
          matcher.query,
          matcher.replacement,
          matcher.matchCase,
          matcher.regex,
        ])
      : null;
  const [retainedPreview, setPreview] = React.useState<Preview | null>(null);
  const preview = retainedPreview?.targetKey === targetKey ? retainedPreview : null;
  const [loadedKey, setLoadedKey] = React.useState<string | null>(null);
  const [error, setError] = React.useState<{
    key: string;
    code: WorkspaceReplaceErrorCode;
  } | null>(null);
  const [retryVersion, setRetryVersion] = React.useState(0);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [excluded, setExcluded] =
    React.useState<WorkspaceReplaceExclusions>(NO_EXCLUSIONS);
  // The operation closure outlives its mounted projection; there is still only one retained result.
  const retainedResult = React.useRef<RetainedReplaceResult | null>(null);
  const pendingRestoreApproval = React.useRef<string | null>(null);
  const [resultState, projectResultState] = React.useState<RetainedReplaceResult | null>(null);
  const setResultState = React.useCallback((next: React.SetStateAction<RetainedReplaceResult | null>) => {
    const result = typeof next === 'function' ? next(retainedResult.current) : next;
    retainedResult.current = result;
    if (!result) pendingRestoreApproval.current = null;
    projectResultState(result);
  }, []);
  const currentAccount = React.useRef(accountLifetime);
  currentAccount.current = accountLifetime;
  const pendingApply = React.useRef<Readonly<{
    key: string;
    scope: WorkspaceScopeBase;
    options: Readonly<{ serverId: string; accountId: string }>;
    completion: Promise<ApplySettlement>;
  }> | null>(null);
  const restoring = React.useRef(false);
  const results = resultState?.key === key ? resultState.results : null;
  const [applying, setApplying] = React.useState(false);
  const [undoing, setUndoing] = React.useState(false);
  const [applyFailure, setApplyFailure] = React.useState<Readonly<{
    key: string;
    code: WorkspaceReplaceErrorCode;
  }> | null>(null);
  const applyError = applyFailure?.key === key ? applyFailure.code : null;
  const resultAccountIsCurrent = resultState !== null
    && accountLifetime?.isCurrent() === true
    && accountLifetime.scope.accountId === resultState.options.accountId
    && accountLifetime.scope.serverId === resultState.options.serverId;
  const [approvalState, setApproval] = React.useState<Readonly<{ key: string; approval: WorkspaceReplaceApproval }> | null>(null);
  const storedApproval = approvalState && (approvalState.key === key
    || approvalState.approval.operation === 'restore' && approvalState.key === resultState?.key && resultAccountIsCurrent)
    ? approvalState.approval : null;
  const approvalDecided = storedApproval !== null && author.approval.approvalId === storedApproval.request.artifactId
    && (author.approval.approvalStatus === 'approved' || author.approval.approvalStatus === 'executing');
  const approval = React.useMemo<WorkspaceReplaceApproval | null>(
    () => storedApproval && approvalDecided ? { ...storedApproval, status: 'approved' } : storedApproval,
    [approvalDecided, storedApproval],
  );
  const applyController = React.useRef<AbortController | null>(null);
  const previewController = React.useRef<AbortController | null>(null);
  const options = React.useMemo(
    () => (scope && accountId ? { serverId: scope.serverId, accountId } : null),
    [scope?.serverId, accountId],
  );
  const unsavedSet = React.useMemo(
    () => new Set(input.unsavedPaths.map(path => replacePathKey(path, scope?.rootPath))),
    [input.unsavedPaths, scope?.rootPath],
  );
  const currentUnsavedSet = React.useRef(unsavedSet);
  currentUnsavedSet.current = unsavedSet;

  React.useEffect(() => {
    if (!key || !targetKey || !scope || !matcher || !options) {
      setPreview(null);
      setLoadedKey(null);
      setError(null);
      return;
    }
    // The review and its mounted author resolve the same real credential
    // binding. Do not lend an unbound author's soon-to-retire signal to a read.
    if (!author.ready) return;
    if (!available) {
      setLoadedKey(key);
      setError({ key, code: 'unavailable' });
      return;
    }
    const controller = new AbortController();
    previewController.current = controller;
    setLoadingMore(false);
    let current = true;
    const interest = mergeAbortSignals([controller.signal, authorRef.current.getSignal()]);
    void machineWorkspaceFileReplacePreview(
      scope.machineId,
      {
        rootPath: scope.rootPath,
        ...(scope.workspace ? { workspace: scope.workspace } : {}),
        query: matcher.query,
        replacement: matcher.replacement,
        matchCase: matcher.matchCase,
        regex: matcher.regex,
        contextLines: 2,
      },
      { ...options, signal: interest.signal, continuationSignal: interest.signal,
        onApprovalPending: (registration) => {
          if (!current) return;
          authorRef.current.approval.requestApproval(registration);
          // A retried preview that now waits replaces the line its earlier answer left.
          setError(null);
          setApproval({ key, approval: { operation: 'preview', serverId: options.serverId, status: 'waiting',
            request: createdApproval(registration, 'workspace.files.replace.preview') } });
        } },
    ).then(
      (response) => {
        if (!current) return;
        setLoadedKey(key);
        const pendingApproval = readReplaceApproval(response);
        if (pendingApproval) {
          setApproval({ key, approval: { operation: 'preview', serverId: options.serverId, status: 'waiting', request: pendingApproval } });
          setError(null);
          return;
        }
        setApproval(previous => previous?.approval.operation === 'preview' ? null : previous);
        const code = previewError(response);
        if (code || !response.ok) {
          setError({ key, code: code ?? 'failed' });
          return;
        }
        setError(null);
        setPreview({
          key,
          targetKey,
          matcher,
          files: response.files,
          excludedUnsavedPaths: new Set(response.files
            .filter(file => isUnsaved(file.path, currentUnsavedSet.current, scope.rootPath))
            .map(file => file.path)),
          notText: response.skipped.notText,
          hasMore: response.hasMore,
          ...(response.cursor ? { cursor: response.cursor } : {}),
          coverage: response.coverage,
        });
      },
      () => {
        if (current && !controller.signal.aborted) {
          setLoadedKey(key);
          setError({ key, code: 'unavailable' });
        }
      },
    );
    return () => {
      current = false;
      controller.abort();
      interest.dispose();
      if (previewController.current === controller) previewController.current = null;
    };
    // `matcher` and `scope` are captured through `key`, which names every field the request reads.
    // Presence is checked when this intent starts, not a reason to reissue an
    // unchanged read or abandon its approval. An initially offline read exposes Retry.
  }, [key, retryVersion, options, author.ready]);

  const loadMore = React.useCallback(() => {
    const controller = previewController.current;
    if (!authorRef.current.ready || !available || !preview?.cursor || preview.key !== key || !scope || !options || loadingMore || !controller || controller.signal.aborted) return;
    const { matcher: reviewed, cursor, key: previewKey } = preview;
    const interest = mergeAbortSignals([controller.signal, authorRef.current.getSignal()]);
    setLoadingMore(true);
    void machineWorkspaceFileReplacePreview(
      scope.machineId,
      {
        rootPath: scope.rootPath,
        ...(scope.workspace ? { workspace: scope.workspace } : {}),
        query: reviewed.query,
        replacement: reviewed.replacement,
        matchCase: reviewed.matchCase,
        regex: reviewed.regex,
        contextLines: 2,
        cursor,
      },
      { ...options, signal: interest.signal, continuationSignal: interest.signal,
        onApprovalPending: (registration) => {
          if (interest.signal.aborted) return;
          authorRef.current.approval.requestApproval(registration);
          setApproval({ key: previewKey, approval: { operation: 'preview', serverId: options.serverId, status: 'waiting',
            request: createdApproval(registration, 'workspace.files.replace.preview') } });
        } },
    )
      .then((response) => {
        if (interest.signal.aborted) return;
        const pendingApproval = readReplaceApproval(response);
        if (pendingApproval) {
          setApproval({ key: previewKey, approval: { operation: 'preview', serverId: options.serverId, status: 'waiting', request: pendingApproval } });
          return;
        }
        setApproval(previous => previous?.key === previewKey && previous.approval.operation === 'preview' ? null : previous);
        if (!response.ok) return;
        setPreview((previous) =>
          previous && previous.key === previewKey
            ? {
                ...previous,
                files: [...previous.files, ...response.files],
                excludedUnsavedPaths: new Set([...previous.excludedUnsavedPaths, ...response.files
                  .filter(file => isUnsaved(file.path, currentUnsavedSet.current, scope.rootPath))
                  .map(file => file.path)]),
                notText: previous.notText + response.skipped.notText,
                hasMore: response.hasMore,
                cursor: response.cursor,
                coverage: response.coverage,
              }
            : previous,
        );
      }, () => {
        if (!interest.signal.aborted) setError({ key: previewKey, code: 'unavailable' });
      })
      .finally(() => {
        interest.dispose();
        if (previewController.current === controller) setLoadingMore(false);
      });
  }, [available, key, loadingMore, options, preview, scope]);

  const allFiles = preview?.files ?? NO_FILES;
  const unsavedFiles = React.useMemo(
    () => allFiles.filter((file) => preview?.excludedUnsavedPaths.has(file.path)
      || isUnsaved(file.path, unsavedSet, scope?.rootPath)),
    [allFiles, preview?.excludedUnsavedPaths, unsavedSet, scope?.rootPath],
  );
  const files = React.useMemo(
    () =>
      unsavedFiles.length
        ? allFiles.filter((file) => !preview?.excludedUnsavedPaths.has(file.path)
          && !isUnsaved(file.path, unsavedSet, scope?.rootPath))
        : allFiles,
    [allFiles, preview?.excludedUnsavedPaths, unsavedFiles.length, unsavedSet, scope?.rootPath],
  );
  const totals = React.useMemo(() => {
    let selectedMatches = 0;
    let totalMatches = 0;
    let selectedFiles = 0;
    for (const file of files) {
      const selection = replaceFileSelection(file, excluded);
      selectedMatches += selection.selected;
      totalMatches += selection.total;
      if (selection.selected > 0) selectedFiles += 1;
    }
    return {
      selectedMatches,
      totalMatches,
      selectedFiles,
      totalFiles: files.length,
    };
  }, [excluded, files]);
  const stale = preview !== null && preview.key !== key;
  const loading = key !== null && loadedKey !== key;
  const currentError = error && error.key === key ? error.code : null;

  const toggleFile = React.useCallback(
    (path: string) => {
      const file = allFiles.find((entry) => entry.path === path);
      if (!file) return;
      setExcluded((previous) => {
        const next = new Map(previous);
        if (replaceFileSelection(file, previous).state === 'all')
          next.set(path, new Set(file.matches.map(replaceMatchKey)));
        else next.delete(path);
        return next;
      });
    },
    [allFiles],
  );
  const toggleMatch = React.useCallback((path: string, matchKey: string) => {
    setExcluded((previous) => {
      const next = new Map(previous);
      const keys = new Set(previous.get(path));
      if (keys.has(matchKey)) keys.delete(matchKey);
      else keys.add(matchKey);
      if (keys.size) next.set(path, keys);
      else next.delete(path);
      return next;
    });
  }, []);

  const canApply =
    author.ready &&
    available &&
    !stale &&
    !loading &&
    !currentError &&
    !approval &&
    !applying &&
    results === null &&
    preview !== null &&
    totals.selectedMatches > 0;
  const apply = React.useCallback(async () => {
    if (!canApply || !preview || !scope || !options || pendingApply.current) return;
    const selection = buildReplaceApplyFiles(allFiles, excluded, [...preview.excludedUnsavedPaths], scope.rootPath);
    // A selected target becoming dirty invalidates the whole reviewed set. Do
    // not silently drop it and dispatch writes for the remaining targets.
    if (selection.some(file => isUnsaved(file.path, currentUnsavedSet.current, scope.rootPath))) {
      setError({ key: preview.key, code: 'failed' });
      return;
    }
    const controller = new AbortController();
    applyController.current = controller;
    setApplying(true);
    setApplyFailure(null);
    setApproval(null);
    pendingRestoreApproval.current = null;
    // Set by the continuation, so the settled answer knows an approval stood between request and effect.
    const awaited = { approval: null as WorkspaceReplaceApproval | null };
    const completion = (async (): Promise<ApplySettlement> => {
    try {
      const response = await machineWorkspaceFileReplaceApply(
        scope.machineId,
        {
          rootPath: scope.rootPath,
          ...(scope.workspace ? { workspace: scope.workspace } : {}),
          operation: {
            kind: 'replace',
            matcher: preview.matcher,
            files: selection,
          },
        },
        { ...options, signal: controller.signal, continuationSignal: authorRef.current.getSignal(),
          onApprovalPending: (registration) => {
            authorRef.current.approval.requestApproval(registration);
            awaited.approval = { operation: 'replace', serverId: options.serverId, status: 'waiting',
              request: createdApproval(registration, 'workspace.files.replace') };
            setApproval({ key: preview.key, approval: awaited.approval });
          } },
      );
      const settled = awaited.approval;
      if (settled) {
        setApproval(previous => previous?.approval === settled ? null : previous);
      }
      if (!response.ok) {
        const pendingApproval = readReplaceApproval(response);
        if (pendingApproval) {
          const approval: WorkspaceReplaceApproval = { operation: 'replace', serverId: options.serverId, status: 'waiting', request: pendingApproval };
          setApproval({ key: preview.key, approval });
          return { error: null, approval };
        }
        if (settled && 'errorCode' in response) {
          if (isActionApprovalDeclinedErrorCode(response.errorCode)) {
            setApplyFailure({ key: preview.key, code: 'declined' });
            return { error: 'declined', approval: null };
          }
          // The surface let go of the request (closed, Account changed): it is still in the Inbox, not an unknown write.
          if (response.errorCode === 'action_account_scope_changed') return { error: null, approval: settled };
        }
        // A known native refusal differs from an unconfirmed Machine outcome; never replay either.
        const code: WorkspaceReplaceErrorCode = 'errorCode' in response
            ? replaceWriteActionError(response.errorCode)
            : response.code === 'invalid_pattern'
              ? 'invalid_pattern'
              : response.code === 'root_not_allowed'
                ? 'root_not_allowed'
                : 'failed';
        setApplyFailure({ key: preview.key, code });
        return { error: code, approval: null };
      }
      const cancelled = new Set(response.cancelled ?? []);
      const answered = new Set(response.results.map(result => result.path));
      setResultState({ key: preview.key, scope, options, results: [
        ...response.results.map((result): WorkspaceReplaceFileResult => ({
          ...result,
        })),
        ...selection
          .filter(
            (file) =>
              !answered.has(file.path) &&
              (cancelled.has(file.path) || response.truncated),
          )
          .map((file): WorkspaceReplaceFileResult => cancelled.has(file.path)
            ? { path: file.path, status: 'cancelled' }
            : { path: file.path, status: 'failed', reason: 'transport_ceiling' }),
        ...unsavedFiles.map((file): WorkspaceReplaceFileResult => ({
          path: file.path,
          status: 'skipped',
          reason: 'unsaved',
        })),
      ] });
      return { error: null, approval: null };
    } catch {
      setApplyFailure({ key: preview.key, code: 'outcome_unknown' });
      return { error: 'outcome_unknown', approval: null };
    } finally {
      applyController.current = null;
      setApplying(false);
    }
    })();
    pendingApply.current = { key: preview.key, scope, options, completion };
    try { await completion; }
    finally { pendingApply.current = null; }
  }, [allFiles, canApply, excluded, options, preview, scope, setResultState, unsavedFiles]);
  const cancelApply = React.useCallback(() => {
    applyController.current?.abort();
  }, []);

  const undoable = React.useMemo(
    () => undoableResults(resultState?.results ?? []),
    [resultState],
  );
  const canRestore = undoable.length > 0 && !undoing && !applying && !approval && resultAccountIsCurrent;
  const canUndo = results !== null && canRestore;
  const restore = React.useCallback(
    async (path?: string, inSurface = false, onApprovalPending?: (registration: ActionApprovalContinuation) => void): Promise<WorkspaceReplaceUndoOutcome | null> => {
      const resultState = retainedResult.current;
      const account = currentAccount.current;
      if (!resultState || restoring.current || applyController.current || pendingRestoreApproval.current === resultState.key
        || !account?.isCurrent() || account.scope.accountId !== resultState.options.accountId
        || account.scope.serverId !== resultState.options.serverId) return null;
      const targets = undoableResults(resultState.results).filter(
        (result) => path === undefined || result.path === path,
      );
      if (!targets.length) return null;
      restoring.current = true;
      setUndoing(true);
      setApplyFailure(null);
      const requestApproval = inSurface && authorRef.current.isCurrent()
        ? authorRef.current.approval.requestApproval : onApprovalPending;
      const awaited = { approval: null as WorkspaceReplaceApproval | null };
      try {
        const response = await machineWorkspaceFileReplaceApply(
          resultState.scope.machineId,
          {
            rootPath: resultState.scope.rootPath,
            ...(resultState.scope.workspace ? { workspace: resultState.scope.workspace } : {}),
            operation: buildWorkspaceFileRestoreOperation(targets),
          },
          requestApproval ? { ...resultState.options,
            ...(inSurface ? { continuationSignal: authorRef.current.getSignal() } : {}),
            onApprovalPending: (registration) => {
              requestApproval(registration);
              pendingRestoreApproval.current = resultState.key;
              awaited.approval = { operation: 'restore', serverId: resultState.options.serverId, status: 'waiting',
                request: createdApproval(registration, 'workspace.files.replace') };
              setApproval({ key: resultState.key, approval: awaited.approval });
            } } : resultState.options,
        );
        const settled = awaited.approval;
        if (settled) {
          if (pendingRestoreApproval.current === resultState.key) pendingRestoreApproval.current = null;
          setApproval(previous => previous?.approval === settled ? null : previous);
        }
        if (!response.ok) {
          const pendingApproval = readReplaceApproval(response);
          if (pendingApproval) {
            pendingRestoreApproval.current = resultState.key;
            setApproval({ key: resultState.key, approval: { operation: 'restore', serverId: resultState.options.serverId,
              status: 'waiting', request: pendingApproval } });
            setApplyFailure(null);
            return { restored: 0, changed: 0, error: 'approval_required', approval: pendingApproval };
          }
          if (settled && 'errorCode' in response) {
            if (isActionApprovalDeclinedErrorCode(response.errorCode)) {
              setApplyFailure({ key: resultState.key, code: 'declined' });
              return { restored: 0, changed: 0, error: 'declined' };
            }
            if (response.errorCode === 'action_account_scope_changed')
              return { restored: 0, changed: 0, error: 'approval_required', approval: settled.request };
          }
          const error = 'errorCode' in response ? replaceWriteActionError(response.errorCode) : 'failed';
          setApplyFailure({ key: resultState.key, code: error });
          return { restored: 0, changed: 0, error };
        }
        const outcome = new Map(
          response.results.map((result) => [result.path, result]),
        );
        let restoredCount = 0;
        let changedCount = 0;
        let failedCount = response.truncated
          ? targets.filter(target => !outcome.has(target.path)).length
          : 0;
        for (const restored of response.results) {
          if (restored.status === 'restored') restoredCount += 1;
          else if (restored.status === 'changed') changedCount += 1;
          else failedCount += 1;
        }
        const counted: WorkspaceReplaceUndoOutcome = {
          restored: restoredCount,
          changed: changedCount,
          error: failedCount > 0 ? 'failed' : null,
        };
        setResultState((previous) => {
          if (previous !== resultState) return previous;
          return {
            ...previous,
            results: previous.results.map((result): WorkspaceReplaceFileResult => {
              const restored = outcome.get(result.path);
              if (!restored) return result;
              if (restored.status === 'restored')
                return {
                  path: result.path,
                  status: 'restored',
                  matchCount: result.matchCount,
                };
              if (restored.status === 'changed')
                return {
                  path: result.path,
                  status: 'undoChanged',
                  matchCount: result.matchCount,
                };
              return { ...result, reason: restored.reason ?? result.reason };
            }),
          };
        });
        return counted;
      } catch {
        setApplyFailure({ key: resultState.key, code: 'outcome_unknown' });
        return { restored: 0, changed: 0, error: 'outcome_unknown' };
      } finally {
        restoring.current = false;
        setUndoing(false);
      }
    },
    [setResultState],
  );
  const undo = React.useCallback(
    (path?: string) => canUndo ? restore(path, true) : Promise.resolve(null),
    [canUndo, restore],
  );
  const undoOnClose = React.useMemo(() => canRestore && resultState ? {
    machineId: resultState.scope.machineId,
    results: undoable,
    run: () => restore(),
  } : null, [canRestore, restore, resultState, undoable]);

  const settleOnClose = React.useCallback(async (): Promise<WorkspaceReplaceCloseOutcome | null> => {
    const operation = pendingApply.current;
    applyController.current?.abort();
    // Cancellation stops future files, not custody of the admitted operation's answer.
    const settlement = operation ? await operation.completion : { error: null, approval: null };
    const retained = retainedResult.current;
    const target = operation ?? retained;
    const account = currentAccount.current;
    if (!target || !account?.isCurrent() || account.scope.accountId !== target.options.accountId
      || account.scope.serverId !== target.options.serverId) return null;
    const results = retained?.key === target.key ? retained.results : [];
    return { ...settlement, machineId: target.scope.machineId, results,
      undo: !restoring.current && pendingRestoreApproval.current !== target.key && undoableResults(results).length > 0
        ? onApprovalPending => restore(undefined, false, onApprovalPending) : null };
  }, [restore]);

  const resetResults = React.useCallback(() => {
    setResultState(null);
    setApplyFailure(null);
    setApproval(null);
    setExcluded(NO_EXCLUSIONS);
    setLoadedKey(null);
    setRetryVersion((value) => value + 1);
  }, [setResultState]);
  const retry = React.useCallback(
    () => {
      setLoadedKey(null);
      setRetryVersion((value) => value + 1);
    },
    [],
  );

  // One model identity per change, so the review's rows rebuild only when something they show changed.
  return React.useMemo(
    () => ({
    preview,
    unsavedFiles,
    files,
    excluded,
    loading,
    loadingMore,
    stale,
    error: currentError,
    totals,
    applying,
    undoing,
    results,
    applyError,
    approval,
    canApply,
    canUndo,
    undoOnClose,
    settleOnClose,
    toggleFile,
    toggleMatch,
    loadMore,
    apply,
    cancelApply,
    undo,
    resetResults,
    retry,
  }),
    [apply, applyError, applying, approval, canApply, canUndo, cancelApply, currentError, excluded, files, loadMore, loading, loadingMore, preview, resetResults, results, retry, settleOnClose, stale, toggleFile, toggleMatch, totals, undo, undoOnClose, undoing, unsavedFiles],
  );
}
