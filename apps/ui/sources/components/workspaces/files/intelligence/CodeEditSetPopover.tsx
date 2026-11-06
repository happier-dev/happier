import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { LanguageIntelligenceCodeAction } from '@happier-dev/protocol/machines/languageIntelligence';
import type { WorkspaceFileEditSetFile } from '@happier-dev/protocol/machines/workspaceFiles';
import { buildWorkspaceFileRestoreOperation } from '@happier-dev/protocol/machines/workspaceFilesReplace';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import type { Rect } from '@/components/ui/code/editor/codeEditorTypes';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { decodeUtf8Base64 } from '@/scm/diff/fallbackUnifiedDiff';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import {
  machineLanguageIntelligenceApplyAction,
  machineLanguageIntelligencePreviewAction,
} from '@/sync/ops/machineLanguageIntelligence';
import { machineWorkspaceFileReplaceApply } from '@/sync/ops/machineWorkspaceFileReplace';
import { isDeclinedApproval } from '@/sync/domains/workspaces/files/workspaceFileReplace';
import { workspaceReadFile } from '@/sync/ops/workspaceFileSystem/fileReadWrite';
import { t } from '@/text';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useDeviceType } from '@/utils/platform/responsive';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';

import { CODE_CARD_WIDTH } from './CodeIntelligenceCard';
import { useFilePageBox } from './filePageBox';
import {
  buildEditSetPreviewDiff,
  countEditSetChanges,
} from './codeEditSetPreview';

/** Rename (F2) or quick fixes (⌘.) for one name, asked from the File page. */
export type CodeEditSetRequest = Readonly<{
  op: 'rename' | 'fixes';
  anchor: Rect | null;
  /** Zero-based line and UTF-16 column of the name. */
  line: number;
  character: number;
  symbol: string;
}>;

/**
 * A tree rename the language server would follow with importer edits (`code.file.rename.preview`): the
 * reviewed move and edits arrive with the request, so the review opens on them.
 */
export type FileRenameEditSetRequest = Readonly<{
  op: 'fileRename';
  newPath: string;
  files: readonly WorkspaceFileEditSetFile[];
}>;
type EditSetOp = CodeEditSetRequest['op'] | FileRenameEditSetRequest['op'];

export type CodeEditSetPopoverProps = Readonly<{
  request: CodeEditSetRequest;
  scope: WorkspaceScopeBase;
  accountId: string | null;
  filePath: string;
  languageId: string | null;
  /** The page's text; used for this file's diff while it has no unsaved edits. */
  readText: () => string;
  isUnsaved: () => boolean;
  /** Saves this file's editor; true when the disk now holds what the person sees. */
  save: () => Promise<boolean>;
  /**
   * Hands the Machine this page's current text and saved state. A save changes no text, so nothing else
   * tells the Machine its held copy is no longer unsaved; every request of this flow syncs first.
   */
  syncDocument: () => Promise<unknown>;
  /** "TypeScript · NLDW3" when a server answered on this page. */
  sourceLabel: string | null;
  onRequestClose: () => void;
}>;

type Receipt = Readonly<{
  path: string;
  status: string;
  reason?: string;
  renameTo?: string;
  hash?: string;
  edits?: readonly unknown[];
}>;
type Stage =
  | Readonly<{ kind: 'unsaved'; saving: boolean }>
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'naming'; value: string; previewing: boolean }>
  | Readonly<{
      kind: 'choosing';
      actions: readonly LanguageIntelligenceCodeAction[];
      fileHash: string;
    }>
  | Readonly<{
      kind: 'review';
      files: readonly WorkspaceFileEditSetFile[];
      newName?: string;
      action?: LanguageIntelligenceCodeAction;
      fileHash?: string;
      back?: Stage;
      applying: boolean;
      /** The person declined the last apply at its approval; the review stays, nothing was written. */
      declined?: boolean;
    }>
  | Readonly<{
      kind: 'result';
      receipts: readonly Receipt[];
      target: Readonly<{ machineId: string; rootPath: string; options: EditSetOptions; scopeKey: string }>;
      undo:
        | 'idle'
        | 'running'
        | Readonly<{ restored: number; changed: number; failed: boolean }>;
      /** The person declined the last Undo at its approval; the files keep the change. */
      undoDeclined?: boolean;
    }>
  /** `page`: said where the review was (an apply that failed), not at the name. */
  | Readonly<{ kind: 'note'; text: string; page?: boolean }>;

/** What the review and the apply need from their host: where, which file, and its editor if any. */
type EditSetHost = Readonly<{
  scope: WorkspaceScopeBase;
  filePath: string;
  languageId: string | null;
  readText?: () => string;
  isUnsaved?: () => boolean;
  syncDocument?: () => Promise<unknown>;
}>;
type EditSetOptions = Readonly<{ serverId?: string | null; accountId?: string | null }>;

/**
 * The review's file texts: the host editor's clean text for its own file, every other file read from
 * the Machine. One loader for the File page and the tree's review.
 */
function useEditSetTexts(latest: React.RefObject<EditSetHost>, alive: React.RefObject<boolean>) {
  const [texts, setTexts] = React.useState<ReadonlyMap<string, string | null>>(new Map());
  const loadTexts = React.useCallback(
    (files: readonly WorkspaceFileEditSetFile[]) => {
      const current = latest.current;
      const initial = new Map<string, string | null>();
      for (const file of files)
        if (file.path === current.filePath && current.readText && !current.isUnsaved?.())
          initial.set(file.path, current.readText());
      setTexts(initial);
      for (const file of files) {
        if (initial.has(file.path)) continue;
        void workspaceReadFile(current.scope, file.path).then(
          (response) => {
            if (!alive.current) return;
            setTexts((previous) =>
              new Map(previous).set(
                file.path,
                response.success ? decodeUtf8Base64(response.content) : null,
              ),
            );
          },
          () => {
            if (alive.current)
              setTexts((previous) => new Map(previous).set(file.path, null));
          },
        );
      }
    },
    [alive, latest],
  );
  return { texts, loadTexts };
}

/**
 * The one apply and Undo of a reviewed edit set: the guarded writer through the operation's Action,
 * then the canonical restore in reverse receipt order. Shared by the File page and the tree's review.
 */
function useEditSetCommit(params: Readonly<{
  op: EditSetOp;
  stage: Stage;
  setStage: (stage: Stage) => void;
  latest: React.RefObject<EditSetHost>;
  alive: React.RefObject<boolean>;
  options: EditSetOptions;
}>) {
  const { op, stage, setStage, latest, alive, options } = params;
  // Reuse the mounted author's existing Account/interest and Inbox owner. The
  // domain clients below retain their native, typed Machine receipts.
  const author = useMountedActionExecution(options.serverId ?? latest.current.scope.serverId);
  const scopeKey = JSON.stringify([author.binding?.scope, author.binding?.revision,
    latest.current.scope.machineId, latest.current.scope.rootPath, options.accountId]);
  const currentScopeKey = React.useRef(scopeKey);
  currentScopeKey.current = scopeKey;
  const apply = React.useCallback(async () => {
    if (stage.kind !== 'review' || stage.applying) return;
    setStage({ ...stage, applying: true, declined: false });
    const current = latest.current;
    const target = { machineId: current.scope.machineId, rootPath: current.scope.rootPath, scopeKey,
      options: { serverId: options.serverId ?? current.scope.serverId, accountId: options.accountId ?? author.binding?.scope.accountId } };
    const path = current.filePath;
    const languageId = current.languageId;
    const continuationSignal = author.getSignal();
    const operation =
      stage.action && stage.fileHash
        ? {
            kind: 'codeAction' as const,
            action: stage.action,
            expectedHash: stage.fileHash,
          }
        : { kind: op === 'fileRename' ? ('fileRename' as const) : ('rename' as const), files: [...stage.files] };
    let response: Awaited<
      ReturnType<typeof machineLanguageIntelligenceApplyAction>
    >;
    try {
      await current.syncDocument?.().catch(() => null);
      if (!alive.current || continuationSignal.aborted || !author.isCurrent() || currentScopeKey.current !== scopeKey) return;
      response = await machineLanguageIntelligenceApplyAction(
        target.machineId,
        {
          rootPath: target.rootPath,
          path,
          ...(languageId ? { languageId } : {}),
          operation,
        },
        { ...target.options, continuationSignal, onApprovalPending: author.approval.requestApproval },
      );
    } catch {
      if (alive.current && !continuationSignal.aborted && author.isCurrent() && currentScopeKey.current === scopeKey)
        setStage({
          kind: 'note',
          text: t('files.pane.intelligence.outcomeUnknown'),
          page: true,
        });
      return;
    }
    if (!alive.current || continuationSignal.aborted || !author.isCurrent() || currentScopeKey.current !== scopeKey) return;
    if ('ok' in response && response.ok) {
      setStage({ kind: 'result', target, receipts: response.results, undo: 'idle' });
      return;
    }
    if ('errorCode' in response && isDeclinedApproval(response.errorCode)) {
      setStage({ ...stage, applying: false, declined: true });
      return;
    }
    // A request that may have reached the Machine never claims nothing happened.
    const unknown = 'errorCode' in response
      && (response.errorCode === 'outcome_unknown' || response.errorCode === 'outcome_uncertain' || response.errorCode === 'transport_failed');
    setStage({ kind: 'note', text: unknown ? t('files.pane.intelligence.outcomeUnknown') : t('files.pane.intelligence.editFailed'), page: true });
  }, [alive, author.approval.requestApproval, author.binding, author.getSignal, author.isCurrent, latest, op, options, scopeKey, setStage, stage]);

  const undo = React.useCallback(async () => {
    if (stage.kind !== 'result' || stage.undo !== 'idle' || stage.target.scopeKey !== scopeKey || !author.isCurrent()) return;
    const { receipts, target } = stage;
    const continuationSignal = author.getSignal();
    setStage({ kind: 'result', target, receipts, undo: 'running' });
    const operation = buildWorkspaceFileRestoreOperation(
      receipts as Parameters<typeof buildWorkspaceFileRestoreOperation>[0],
    );
    const response = await machineWorkspaceFileReplaceApply(
      target.machineId,
      { rootPath: target.rootPath, operation },
      { ...target.options, continuationSignal, onApprovalPending: author.approval.requestApproval },
    ).catch(() => null);
    if (!alive.current || continuationSignal.aborted || !author.isCurrent() || currentScopeKey.current !== scopeKey) return;
    if (response && !response.ok && 'errorCode' in response && isDeclinedApproval(response.errorCode)) {
      setStage({ kind: 'result', target, receipts, undo: 'idle', undoDeclined: true });
      return;
    }
    if (!response || !response.ok) {
      setStage({
        kind: 'result',
        target,
        receipts,
        undo: { restored: 0, changed: 0, failed: true },
      });
      return;
    }
    let restored = 0,
      changed = 0,
      failed = false;
    for (const result of response.results) {
      if (result.status === 'restored') restored += 1;
      else if (result.status === 'changed') changed += 1;
      else failed = true;
    }
    setStage({ kind: 'result', target, receipts, undo: { restored, changed, failed } });
  }, [alive, author.approval.requestApproval, author.getSignal, author.isCurrent, scopeKey, setStage, stage]);
  // An apply or Undo the person's Settings › Actions ask about waits here: the review (or result) stays,
  // and its band names the wait with the way to the request (the Inbox owns the decision).
  const router = useRouter();
  const approvalId = author.approval.approvalPending ? author.approval.approvalId : null;
  const approvalServerId = options.serverId ?? latest.current.scope.serverId;
  const committing = (stage.kind === 'review' && stage.applying) || (stage.kind === 'result' && stage.undo === 'running');
  const waiting = React.useMemo<EditSetWaiting | null>(() => approvalId && committing
    ? { open: () => router.pushRetainingCurrent(buildApprovalHref(approvalId, approvalServerId)) }
    : null, [approvalId, approvalServerId, committing, router]);
  return { apply, undo, release: author.cancel, waiting };
}

type EditSetWaiting = Readonly<{ open: () => void }>;

/** What the person's "no" at the approval left: said once, quietly, in the same status slot. */
function EditSetDeclinedLine(props: Readonly<{ text: string }>) {
  return (
    <Text variant="meta" numberOfLines={1} style={[styles.secondaryText, styles.footerStatus]} testID="code-edit-set-declined">
      {props.text}
    </Text>
  );
}

/** The shared pending-approval line, in the band's (or the sheet footer's) status slot. */
function EditSetWaitingLine(props: Readonly<{ waiting: EditSetWaiting }>) {
  // The line hugs its words, so its open control sits right after "Waiting for your approval" rather
  // than at the slot's far edge beside the band's own buttons.
  return (
    <View style={styles.waitingLine}>
      <ActionApprovalPendingNotice presentation="line" message={t('approvals.waitingForYou')}
        onOpenApproval={props.waiting.open} testID="code-edit-set-approval" />
    </View>
  );
}

/**
 * The fixes for the problem at the name lead (LSP `quickfix` kinds); whole-file source actions such as
 * organizing imports follow. The server's order is kept within each group.
 */
function orderFixesFirst(actions: readonly LanguageIntelligenceCodeAction[]): readonly LanguageIntelligenceCodeAction[] {
  const isFix = (action: LanguageIntelligenceCodeAction) => action.kind === 'quickfix' || Boolean(action.kind?.startsWith('quickfix.'));
  return [...actions.filter(isFix), ...actions.filter((action) => !isFix(action))];
}

/** The name stages are the intelligence card's width (LS1); the review takes the page body. */
const POPOVER_WIDTH = CODE_CARD_WIDTH;
const POPOVER_MAX_HEIGHT = 560;

function refusalText(
  result: Readonly<{ status: string; reason?: string; errorCode?: string }>,
  op: CodeEditSetRequest['op'],
): string {
  if (result.status === 'loading')
    return t('files.pane.intelligence.editLoading');
  if (
    result.status === 'unavailable' &&
    (result.reason === 'no_capable_server' ||
      result.reason === 'method_unavailable')
  )
    return op === 'rename'
      ? t('files.pane.intelligence.renameUnavailable')
      : t('files.pane.intelligence.fixesUnavailable');
  return t('files.pane.intelligence.editFailed');
}

/**
 * Semantic edits on the File page (P7 U7): the rename field or the fix list at the name, then the
 * edit set as the review renderer's diffs, one apply through the guarded writer, its per-file results
 * and one Undo through the canonical restore. On desktop the name stages are a card at the name, kept
 * inside the File page's width, and the review and its result take the page body like Changes do
 * (a band over per-file diffs); phones keep every stage in the shared sheet. Mount it inside the page
 * body so the review covers exactly that region.
 */
export function CodeEditSetPopover(
  props: CodeEditSetPopoverProps,
): React.ReactElement {
  const { request } = props;
  const latest = React.useRef(props);
  latest.current = props;
  const options = React.useMemo(
    () => ({ serverId: props.scope.serverId, accountId: props.accountId }),
    [props.accountId, props.scope.serverId],
  );
  const [stage, setStage] = React.useState<Stage>(() =>
    props.isUnsaved()
      ? { kind: 'unsaved', saving: false }
      : { kind: 'loading' },
  );
  const alive = React.useRef(true);
  React.useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const address = React.useMemo(
    () => ({
      rootPath: props.scope.rootPath,
      path: props.filePath,
      line: request.line + 1,
      symbol: request.symbol,
      ...(props.languageId ? { languageId: props.languageId } : {}),
    }),
    [
      props.filePath,
      props.languageId,
      props.scope.rootPath,
      request.line,
      request.symbol,
    ],
  );

  const begin = React.useCallback(async () => {
    setStage({ kind: 'loading' });
    await latest.current.syncDocument().catch(() => null);
    if (!alive.current) return;
    const machineId = latest.current.scope.machineId;
    const result = await machineLanguageIntelligencePreviewAction(
      machineId,
      request.op === 'rename' ? 'code.rename.preview' : 'code.codeActions.list',
      address,
      options,
    );
    if (!alive.current) return;
    if (result.status === 'ok' && result.kind === 'prepareRename') {
      const target = result.targets[0];
      if (!target)
        setStage({
          kind: 'note',
          text: t('files.pane.intelligence.cannotRename'),
        });
      else
        setStage({
          kind: 'naming',
          value: target.placeholder ?? request.symbol,
          previewing: false,
        });
      return;
    }
    if (result.status === 'ok' && result.kind === 'codeActions') {
      setStage(
        result.actions.length && result.fileHash
          ? {
              kind: 'choosing',
              actions: orderFixesFirst(result.actions),
              fileHash: result.fileHash,
            }
          : { kind: 'note', text: t('files.pane.intelligence.noFixes') },
      );
      return;
    }
    if (
      result.status === 'error' &&
      result.errorCode === 'unsaved_editor_changes'
    ) {
      setStage({ kind: 'unsaved', saving: false });
      return;
    }
    setStage({ kind: 'note', text: refusalText(result, request.op) });
  }, [address, options, request.op, request.symbol]);

  React.useEffect(() => {
    if (stage.kind === 'loading') void begin();
    // Runs once per opening; later stages are driven by the person.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The review reads each file it shows; the page's own clean text needs no read.
  const { texts, loadTexts } = useEditSetTexts(latest, alive);

  const preview = React.useCallback(
    async (value: string) => {
      const name = value.trim();
      if (!name || name === request.symbol) return;
      setStage({ kind: 'naming', value, previewing: true });
      await latest.current.syncDocument().catch(() => null);
      if (!alive.current) return;
      const result = await machineLanguageIntelligencePreviewAction(
        latest.current.scope.machineId,
        'code.rename.preview',
        { ...address, newName: name },
        options,
      );
      if (!alive.current) return;
      if (result.status === 'ok' && result.kind === 'rename') {
        if (!result.files.length) {
          setStage({
            kind: 'note',
            text: t('files.pane.intelligence.nothingToChange'),
          });
          return;
        }
        loadTexts(result.files);
        setStage({
          kind: 'review',
          files: result.files,
          newName: name,
          back: { kind: 'naming', value, previewing: false },
          applying: false,
        });
        return;
      }
      if (
        result.status === 'error' &&
        result.errorCode === 'unsaved_editor_changes'
      ) {
        setStage({ kind: 'unsaved', saving: false });
        return;
      }
      setStage({ kind: 'note', text: refusalText(result, 'rename') });
    },
    [address, loadTexts, options, request.symbol],
  );

  const choose = React.useCallback(
    (action: LanguageIntelligenceCodeAction, fileHash: string, back: Stage) => {
      if (action.disabledReason) return;
      loadTexts(action.files);
      setStage({
        kind: 'review',
        files: action.files,
        action,
        fileHash,
        back,
        applying: false,
      });
    },
    [loadTexts],
  );

  const { apply, undo, release, waiting } = useEditSetCommit({ op: request.op, stage, setStage, latest, alive, options });
  const close = React.useCallback(() => { release(); props.onRequestClose(); }, [release, props.onRequestClose]);

  const saveFirst = React.useCallback(async () => {
    setStage({ kind: 'unsaved', saving: true });
    const saved = await latest.current.save();
    if (!alive.current) return;
    if (saved) void begin();
    else setStage({ kind: 'unsaved', saving: false });
  }, [begin]);

  const back = React.useCallback(
    () =>
      setStage((previous) =>
        previous.kind === 'review' && previous.back && !previous.applying
          ? previous.back
          : previous,
      ),
    [],
  );
  const phone = useDeviceType() === 'phone';
  const pageBox = useFilePageBox();
  const anchor = request.anchor;
  const popoverAnchor = React.useMemo(
    () =>
      anchor
        ? {
            kind: 'rect' as const,
            rect: {
              left: anchor.x,
              top: anchor.y,
              width: Math.max(1, anchor.width),
              height: Math.max(1, anchor.height),
            },
            coordinateSpace: 'window' as const,
          }
        : null,
    [anchor?.x, anchor?.y, anchor?.width, anchor?.height],
  );

  const body = (
    <CodeEditSetBody
      request={request}
      stage={stage}
      texts={texts}
      filePath={props.filePath}
      sourceLabel={props.sourceLabel}
      onChangeName={(value) =>
        setStage((previous) =>
          previous.kind === 'naming' ? { ...previous, value } : previous,
        )
      }
      onPreview={preview}
      onChoose={choose}
      onApply={apply}
      onBack={back}
      onUndo={undo}
      onSave={saveFirst}
      onClose={close}
      waiting={waiting}
    />
  );
  if (!phone && (stage.kind === 'review' || stage.kind === 'result' || (stage.kind === 'note' && stage.page)))
    return (
      <CodeEditSetPage
        request={request}
        stage={stage}
        texts={texts}
        filePath={props.filePath}
        onApply={apply}
        onBack={back}
        onUndo={undo}
        onClose={close}
        waiting={waiting}
      />
    );
  return (
    <>
    {pageBox.box}
    <Popover
      open
      anchor={popoverAnchor ?? undefined}
      backdrop={false}
      boundaryRef={null}
      horizontalBoundaryRef={pageBox.ref}
      onRequestClose={close}
      phonePresentation="sheet"
      sheetHeader="none"
      sheetMaterial="solid"
      accessibilityLabel={
        request.op === 'rename'
          ? t('files.pane.intelligence.renameTitle')
          : t('files.pane.intelligence.fixesTitle')
      }
      portal={{
        web: true,
        native: true,
        matchAnchorWidth: false,
        anchorAlign: 'start',
      }}
      placement="bottom"
      flip
      gap={4}
      minWidth={0}
      maxWidthCap={POPOVER_WIDTH}
      maxHeightCap={POPOVER_MAX_HEIGHT}
    >
      {({ presentation, maxHeight, maxWidth }) =>
        presentation === 'sheet' ? (
          <View style={styles.sheet} testID="code-edit-set-sheet">
            {body}
          </View>
        ) : (
          <FloatingOverlay
            maxHeight={Math.min(maxHeight, POPOVER_MAX_HEIGHT)}
            role="panel"
          >
            <View
              testID="code-edit-set-card"
              style={{
                width: Math.min(POPOVER_WIDTH, maxWidth),
                maxHeight: Math.min(maxHeight, POPOVER_MAX_HEIGHT),
              }}
            >
              {body}
            </View>
          </FloatingOverlay>
        )
      }
    </Popover>
    </>
  );
}

/**
 * The tree's rename review (it has no page body): the same review, apply, result and Undo as the File
 * page, over the move and importer edits the language server proposed. It fills its host's box.
 */
export function FileRenameEditSet(
  props: Readonly<{
    request: FileRenameEditSetRequest;
    scope: WorkspaceScopeBase;
    accountId: string | null;
    /** The file being renamed. */
    filePath: string;
    onRenameOnly: () => void;
    onRequestClose: () => void;
  }>,
): React.ReactElement {
  const host: EditSetHost = { scope: props.scope, filePath: props.filePath, languageId: null };
  const latest = React.useRef(host);
  latest.current = host;
  const alive = React.useRef(true);
  React.useEffect(() => () => { alive.current = false; }, []);
  const options = React.useMemo(
    () => ({ serverId: props.scope.serverId, accountId: props.accountId }),
    [props.accountId, props.scope.serverId],
  );
  const [stage, setStage] = React.useState<Stage>({ kind: 'review', files: props.request.files, applying: false });
  const { texts, loadTexts } = useEditSetTexts(latest, alive);
  React.useEffect(() => {
    loadTexts(props.request.files);
    // The reviewed files are fixed for this review.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { apply, undo, release, waiting } = useEditSetCommit({ op: 'fileRename', stage, setStage, latest, alive, options });
  const close = React.useCallback(() => { release(); props.onRequestClose(); }, [release, props.onRequestClose]);
  if (stage.kind !== 'review' && stage.kind !== 'result' && stage.kind !== 'note') return <></>;
  return (
    <CodeEditSetPage
      request={props.request}
      stage={stage}
      texts={texts}
      filePath={props.filePath}
      onApply={apply}
      onBack={close}
      onUndo={undo}
      onClose={close}
      onRenameOnly={() => { release(); props.onRenameOnly(); }}
      waiting={waiting}
    />
  );
}

type PageStage = Extract<Stage, { kind: 'review' | 'result' | 'note' }>;

/** The page's own file leads; the others keep the server's order. */
function orderPageFirst<T extends Readonly<{ path: string }>>(files: readonly T[], filePath: string): readonly T[] {
  const own = files.filter((file) => file.path === filePath);
  return own.length ? [...own, ...files.filter((file) => file.path !== filePath)] : files;
}

/** Desktop review and result in the page body: one band (what, how much, the actions) over the files. */
function CodeEditSetPage(
  props: Readonly<{
    request: CodeEditSetRequest | FileRenameEditSetRequest;
    stage: PageStage;
    texts: ReadonlyMap<string, string | null>;
    filePath: string;
    onApply: () => void;
    onBack: () => void;
    onUndo: () => void;
    onClose: () => void;
    /** The tree's review also offers the plain move, without the server's edits. */
    onRenameOnly?: () => void;
    waiting: EditSetWaiting | null;
  }>,
) {
  const { theme } = useUnistyles();
  const { stage, request } = props;
  const rename = request.op === 'rename';
  const fileRename = request.op === 'fileRename' ? request : null;
  // Only the tree's review reaches a phone here (the File page keeps its sheet there): the band keeps
  // what changes and the way out; the commit moves to a footer.
  const phone = useDeviceType() === 'phone';
  const latest = React.useRef(props);
  latest.current = props;
  // Esc steps back to the name from the review and leaves from the result, as the card did; it claims
  // Escape above the page, so the File page stays open under its own review.
  useEscapeLayer({
    enabled: Platform.OS === 'web',
    priority: ESCAPE_LAYER_PRIORITIES.overlay,
    allowEditableTarget: true,
    onEscape: () => {
      const current = latest.current;
      if (current.stage.kind === 'review' && current.stage.applying) return true;
      if (current.stage.kind === 'review' && current.stage.back) current.onBack();
      else current.onClose();
      return true;
    },
  });

  if (stage.kind === 'review') {
    const counts = countEditSetChanges(stage.files);
    const commandOnly = Boolean(stage.action?.hasCommand) && stage.files.length === 0;
    const empty = stage.files.length === 0 && !commandOnly;
    const leave = stage.back ? (
      <RoundButton size="small" display="secondary" title={t('common.back')} disabled={stage.applying}
        onPress={props.onBack} testID="code-edit-set-back" />
    ) : fileRename ? (
      <RoundButton size="small" display="secondary" title={t('common.cancel')} disabled={stage.applying}
        onPress={props.onClose} testID="code-edit-set-cancel" />
    ) : null;
    const commit = (
      <>
        {fileRename && props.onRenameOnly ? (
          <RoundButton size="small" display="secondary" title={t('files.pane.intelligence.renameOnly')} disabled={stage.applying}
            onPress={props.onRenameOnly} testID="code-edit-set-rename-only" />
        ) : null}
        {empty ? null : (
          <RoundButton size="small"
            title={stage.action ? t('files.pane.intelligence.applyFix')
              : fileRename ? t('files.pane.intelligence.renameAndUpdateImports')
              : t('files.pane.intelligence.renameInFiles', { files: counts.files })}
            loading={stage.applying} onPress={props.onApply} testID="code-edit-set-apply" />
        )}
      </>
    );
    return (
      <View style={[styles.page, { backgroundColor: theme.colors.surface.base }]} testID="code-edit-set-page">
        <View style={styles.band}>
          <View style={styles.bandText}>
            {/* The primary names the verb ("Rename in 2 files"); the title is what changes. */}
            <Text variant="label" emphasis={stage.action ? 'semiBold' : undefined} numberOfLines={2}
              style={[styles.primaryText, stage.action ? null : styles.mono]}>
              {stage.action
                ? stage.action.title
                : fileRename
                  ? t('files.pane.intelligence.renameTo', { from: props.filePath, to: fileRename.newPath })
                  : t('files.pane.intelligence.renameTo', { from: request.op === 'fileRename' ? '' : request.symbol, to: stage.newName ?? '' })}
            </Text>
            {props.waiting ? <EditSetWaitingLine waiting={props.waiting} />
              : stage.declined ? <EditSetDeclinedLine text={t('files.pane.intelligence.applyDeclined')} />
              : commandOnly || empty ? null : (
              <Text variant="meta" numberOfLines={1} style={[styles.tertiaryText, styles.tabular]}>
                {t('files.pane.intelligence.changesInFiles', counts)}
              </Text>
            )}
          </View>
          {phone ? leave : <View style={styles.bandActions}>{leave}{commit}</View>}
        </View>
        <ScrollView style={styles.pageScroll} contentContainerStyle={styles.pageContent} testID="code-edit-set-review">
          {commandOnly || empty ? (
            <Text variant="body" style={[styles.secondaryText, styles.pageNote]}>
              {empty ? t('files.pane.intelligence.nothingToChange') : t('files.pane.intelligence.runsCommand')}
            </Text>
          ) : (
            orderPageFirst(stage.files, props.filePath).map((file, index) => (
              <EditSetFile key={file.path} file={file} text={props.texts.get(file.path)} inPage breakBefore={index > 0} />
            ))
          )}
          {stage.action?.hasCommand && !commandOnly ? (
            <Text variant="meta" style={[styles.tertiaryText, styles.pageNote]}>
              {t('files.pane.intelligence.alsoRunsCommand')}
            </Text>
          ) : null}
        </ScrollView>
        {/* Phones keep the commit within thumb reach, as the shared review sheet does. */}
        {phone ? <Footer>{commit}</Footer> : null}
      </View>
    );
  }

  if (stage.kind === 'note') {
    // An apply that failed says why where its review was, with the one way out.
    return (
      <View style={[styles.page, { backgroundColor: theme.colors.surface.base }]} testID="code-edit-set-page">
        <View style={styles.band} testID="code-edit-set-note">
          <Icon name="warning" size={ICON_SIZE.sm} color={theme.colors.state.warning.foreground} />
          <Text variant="label" numberOfLines={2} style={[styles.primaryText, styles.bandText]}>{stage.text}</Text>
          <RoundButton size="small" title={t('common.done')} onPress={props.onClose} testID="code-edit-set-done" />
        </View>
      </View>
    );
  }

  const written = stage.receipts.filter((receipt) => receipt.status === 'replaced');
  const undo = stage.undo;
  const undone = typeof undo === 'object' ? undo : null;
  const moved = fileRename ? written.find((receipt) => receipt.renameTo) : undefined;
  const title = undone && undone.restored > 0
    ? t('files.pane.intelligence.undone', { files: undone.restored })
    : written.length
      ? moved?.renameTo
        ? t('files.pane.intelligence.fileRenamed', { name: moved.renameTo.slice(moved.renameTo.lastIndexOf('/') + 1) })
        : rename || fileRename ? t('files.pane.intelligence.renamed', { files: written.length }) : t('files.pane.intelligence.fixApplied')
      : t('files.pane.intelligence.nothingChanged');
  return (
    <View style={[styles.page, { backgroundColor: theme.colors.surface.base }]} testID="code-edit-set-page">
      <View style={styles.band} testID="code-edit-set-result">
        <Icon name={written.length ? 'check' : 'warning'} size={ICON_SIZE.sm}
          color={written.length ? theme.colors.text.secondary : theme.colors.state.warning.foreground} />
        <View style={styles.bandText}>
          <Text variant="label" emphasis="semiBold" numberOfLines={1} style={styles.primaryText}>
            {title}
          </Text>
          {props.waiting ? <EditSetWaitingLine waiting={props.waiting} />
            : stage.undoDeclined ? <EditSetDeclinedLine text={t('files.pane.intelligence.undoDeclined')} /> : null}
        </View>
        {written.length && !undone ? (
          <RoundButton size="small" display="secondary" title={t('common.undo')} loading={undo === 'running'}
            onPress={props.onUndo} testID="code-edit-set-undo" />
        ) : null}
        <RoundButton size="small" title={t('common.done')} onPress={props.onClose} testID="code-edit-set-done" />
      </View>
      <ScrollView style={styles.pageScroll} contentContainerStyle={styles.pageContent} testID="code-edit-set-results">
        {/* Every file says what happened; written files stay quiet (the band says it once). */}
        {orderPageFirst(stage.receipts, props.filePath).map((receipt) => (
          <ResultRow key={`${receipt.path}:${receipt.status}`} receipt={receipt} undone={Boolean(undone && undone.restored > 0)} />
        ))}
        {undone && undone.changed > 0 ? (
          <Text variant="meta" style={[styles.tertiaryText, styles.pageNote]}>
            {t('files.pane.intelligence.undoChanged', { files: undone.changed })}
          </Text>
        ) : null}
        {undone?.failed ? (
          <Text variant="meta" style={[styles.failureText, styles.pageNote]}>
            {t('files.pane.intelligence.undoFailed')}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

function ResultRow(props: Readonly<{ receipt: Receipt; inset?: 'page' | 'card'; undone?: boolean }>) {
  const { theme } = useUnistyles();
  const { receipt } = props;
  // A moved file reads "retry.ts → attempt.ts" until an Undo moves it back.
  const moved = receipt.renameTo && !props.undone ? receipt.renameTo : null;
  const slash = receipt.path.lastIndexOf('/');
  const from = receipt.path.slice(slash + 1);
  const to = moved ? moved.slice(moved.lastIndexOf('/') + 1) : from;
  const name = to !== from ? t('files.pane.intelligence.renameTo', { from, to }) : from;
  const path = moved ?? receipt.path;
  const directory = path.lastIndexOf('/') > 0 ? path.slice(0, path.lastIndexOf('/')) : '';
  const written = receipt.status === 'replaced';
  const reason = written
    ? null
    : receipt.status === 'changed'
      ? t('files.pane.intelligence.resultChanged')
      : receipt.status === 'skipped'
        ? t('files.pane.intelligence.resultSkipped')
        : t('files.pane.intelligence.resultFailed', { reason: receipt.reason ?? '' });
  return (
    <View style={[styles.fileHeader, props.inset === 'card' ? null : styles.pageInset]} testID="code-edit-set-result-file">
      <FileIcon fileName={name} size={ICON_SIZE.sm} appearance="line" />
      <Text numberOfLines={1} style={[Typography.variant('label'), styles.fileName]}>
        <Text style={[Typography.default('medium'), styles.primaryText]}>{name}</Text>
        {directory ? <Text style={styles.tertiaryText}>{`  ${directory}`}</Text> : null}
      </Text>
      {reason ? (
        <Text variant="meta" numberOfLines={1}
          style={receipt.status === 'failed' ? styles.failureText : styles.tertiaryText}>
          {reason}
        </Text>
      ) : (
        <Icon name="check" size={ICON_SIZE.sm} color={theme.colors.text.tertiary} />
      )}
    </View>
  );
}

function CodeEditSetBody(
  props: Readonly<{
    request: CodeEditSetRequest;
    stage: Stage;
    texts: ReadonlyMap<string, string | null>;
    filePath: string;
    sourceLabel: string | null;
    onChangeName: (value: string) => void;
    onPreview: (value: string) => void;
    onChoose: (
      action: LanguageIntelligenceCodeAction,
      fileHash: string,
      back: Stage,
    ) => void;
    onApply: () => void;
    onBack: () => void;
    onUndo: () => void;
    onSave: () => void;
    onClose: () => void;
    waiting: EditSetWaiting | null;
  }>,
) {
  const { theme } = useUnistyles();
  const { stage, request } = props;
  const rename = request.op === 'rename';
  const header = (
    <View style={styles.header}>
      <Text
        variant="label"
        emphasis="semiBold"
        style={styles.primaryText}
        numberOfLines={1}
      >
        {rename
          ? t('files.pane.intelligence.renameTitle')
          : t('files.pane.intelligence.fixesTitle')}
      </Text>
      <Text
        variant="meta"
        numberOfLines={1}
        style={[styles.mono, styles.tertiaryText, styles.headerName]}
      >
        {request.symbol}
      </Text>
    </View>
  );

  if (
    stage.kind === 'loading' ||
    stage.kind === 'note' ||
    stage.kind === 'unsaved'
  ) {
    return (
      <>
        {header}
        <View style={styles.block} testID={`code-edit-set-${stage.kind}`}>
          <Text
            variant="body"
            style={
              stage.kind === 'loading'
                ? styles.tertiaryText
                : styles.secondaryText
            }
          >
            {stage.kind === 'loading'
              ? rename
                ? t('files.pane.intelligence.preparingRename')
                : t('files.pane.intelligence.lookingForFixes')
              : stage.kind === 'unsaved'
                ? t('files.pane.intelligence.saveFirst')
                : stage.text}
          </Text>
        </View>
        {stage.kind === 'unsaved' ? (
          <Footer>
            <RoundButton
              size="small"
              display="secondary"
              title={t('common.cancel')}
              onPress={props.onClose}
              testID="code-edit-set-cancel"
            />
            <RoundButton
              size="small"
              title={t('common.save')}
              loading={stage.saving}
              onPress={props.onSave}
              testID="code-edit-set-save"
            />
          </Footer>
        ) : stage.kind === 'note' ? (
          <Footer>
            <RoundButton
              size="small"
              display="secondary"
              title={t('common.done')}
              onPress={props.onClose}
              testID="code-edit-set-done"
            />
          </Footer>
        ) : null}
      </>
    );
  }

  if (stage.kind === 'naming') {
    return (
      <>
        {header}
        <View style={styles.block}>
          <TextInput
            testID="code-rename-input"
            value={stage.value}
            onChangeText={props.onChangeName}
            onSubmitEditing={() => props.onPreview(stage.value)}
            accessibilityLabel={t('files.pane.intelligence.newName')}
            autoFocus
            selectTextOnFocus
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            editable={!stage.previewing}
            style={[Typography.variant('body'), styles.mono, styles.input]}
          />
          <Text variant="meta" style={styles.tertiaryText}>
            {stage.previewing
              ? t('files.pane.intelligence.findingUses')
              : t('files.pane.intelligence.renameHint')}
          </Text>
        </View>
        <Footer>
          <RoundButton
            size="small"
            display="secondary"
            title={t('common.cancel')}
            onPress={props.onClose}
            testID="code-edit-set-cancel"
          />
          <RoundButton
            size="small"
            title={t('files.pane.intelligence.previewRename')}
            disabled={
              !stage.value.trim() || stage.value.trim() === request.symbol
            }
            loading={stage.previewing}
            onPress={() => props.onPreview(stage.value)}
            testID="code-rename-preview"
          />
        </Footer>
      </>
    );
  }

  if (stage.kind === 'choosing') {
    return (
      <>
        {header}
        <ScrollView style={styles.scroll} testID="code-fixes-list">
          {stage.actions.map((action, index) => (
            <SelectableRow
              key={`${action.serverId}:${index}`}
              testID={`code-fix-${index}`}
              presentation="menu"
              title={action.title}
              {...(action.disabledReason
                ? { subtitle: action.disabledReason }
                : {})}
              left={
                <Icon
                  name="lightbulb"
                  size={ICON_SIZE.sm}
                  color={theme.colors.text.secondary}
                />
              }
              disabled={Boolean(action.disabledReason)}
              onPress={() => props.onChoose(action, stage.fileHash, stage)}
            />
          ))}
        </ScrollView>
        {props.sourceLabel ? (
          <Footer>
            <Text
              variant="meta"
              numberOfLines={1}
              style={[styles.tertiaryText, styles.footerStatus]}
            >
              {props.sourceLabel}
            </Text>
          </Footer>
        ) : null}
      </>
    );
  }

  if (stage.kind === 'review') {
    const counts = countEditSetChanges(stage.files);
    const commandOnly =
      Boolean(stage.action?.hasCommand) && stage.files.length === 0;
    // A server action can carry no edit and no command: say so and offer nothing to apply.
    const empty = stage.files.length === 0 && !commandOnly;
    return (
      <>
        <View style={styles.header}>
          <Text
            variant="label"
            emphasis="semiBold"
            style={[styles.primaryText, stage.action ? null : styles.mono]}
            numberOfLines={1}
          >
            {stage.action
              ? stage.action.title
              : t('files.pane.intelligence.renameTo', {
                  from: request.symbol,
                  to: stage.newName ?? '',
                })}
          </Text>
        </View>
        <ScrollView style={styles.scroll} testID="code-edit-set-review">
          {commandOnly || empty ? (
            <View style={styles.block}>
              <Text variant="body" style={styles.secondaryText}>
                {empty ? t('files.pane.intelligence.nothingToChange') : t('files.pane.intelligence.runsCommand')}
              </Text>
            </View>
          ) : (
            orderPageFirst(stage.files, props.filePath).map((file) => (
              <EditSetFile
                key={file.path}
                file={file}
                text={props.texts.get(file.path)}
              />
            ))
          )}
          {stage.action?.hasCommand && !commandOnly ? (
            <View style={styles.block}>
              <Text variant="meta" style={styles.tertiaryText}>
                {t('files.pane.intelligence.alsoRunsCommand')}
              </Text>
            </View>
          ) : null}
        </ScrollView>
        <Footer>
          {props.waiting ? (
            <View style={styles.footerStatus}><EditSetWaitingLine waiting={props.waiting} /></View>
          ) : stage.declined ? (
            <EditSetDeclinedLine text={t('files.pane.intelligence.applyDeclined')} />
          ) : (
            <Text
              variant="meta"
              numberOfLines={1}
              style={[styles.secondaryText, styles.tabular, styles.footerStatus]}
            >
              {commandOnly || empty
                ? ''
                : t('files.pane.intelligence.changesInFiles', counts)}
            </Text>
          )}
          {stage.back ? (
            <RoundButton
              size="small"
              display="secondary"
              title={t('common.back')}
              disabled={stage.applying}
              onPress={props.onBack}
              testID="code-edit-set-back"
            />
          ) : null}
          {empty ? null : <RoundButton
            size="small"
            title={
              stage.action
                ? t('files.pane.intelligence.applyFix')
                : t('files.pane.intelligence.renameInFiles', {
                    files: counts.files,
                  })
            }
            loading={stage.applying}
            onPress={props.onApply}
            testID="code-edit-set-apply"
          />}
        </Footer>
      </>
    );
  }

  // Results: what was written, what was left alone and why, and one Undo for all of it.
  const written = stage.receipts.filter(
    (receipt) => receipt.status === 'replaced',
  );
  const undo = stage.undo;
  const title =
    typeof undo === 'object' && undo.restored > 0
      ? t('files.pane.intelligence.undone', { files: undo.restored })
      : written.length
        ? rename
          ? t('files.pane.intelligence.renamed', { files: written.length })
          : t('files.pane.intelligence.fixApplied')
        : t('files.pane.intelligence.nothingChanged');
  return (
    <>
      <View style={styles.header} testID="code-edit-set-result">
        <Icon
          name={written.length ? 'check' : 'warning'}
          size={ICON_SIZE.sm}
          color={
            written.length
              ? theme.colors.text.secondary
              : theme.colors.state.warning.foreground
          }
        />
        <Text
          variant="label"
          emphasis="semiBold"
          style={styles.primaryText}
          numberOfLines={1}
        >
          {title}
        </Text>
      </View>
      {/* Every file says what happened, as in the page's result. */}
      <View style={styles.resultList}>
        {orderPageFirst(stage.receipts, props.filePath).map((receipt) => (
          <ResultRow key={`${receipt.path}:${receipt.status}`} receipt={receipt} inset="card"
            undone={typeof undo === 'object' && undo.restored > 0} />
        ))}
        {typeof undo === 'object' && undo.changed > 0 ? (
          <Text variant="meta" style={[styles.tertiaryText, styles.block]}>
            {t('files.pane.intelligence.undoChanged', { files: undo.changed })}
          </Text>
        ) : null}
        {typeof undo === 'object' && undo.failed ? (
          <Text variant="meta" style={[styles.failureText, styles.block]}>
            {t('files.pane.intelligence.undoFailed')}
          </Text>
        ) : null}
      </View>
      <Footer>
        {props.waiting ? (
          <View style={styles.footerStatus}><EditSetWaitingLine waiting={props.waiting} /></View>
        ) : stage.undoDeclined ? (
          <EditSetDeclinedLine text={t('files.pane.intelligence.undoDeclined')} />
        ) : null}
        {written.length && typeof undo !== 'object' ? (
          <RoundButton
            size="small"
            display="secondary"
            title={t('common.undo')}
            loading={undo === 'running'}
            onPress={props.onUndo}
            testID="code-edit-set-undo"
          />
        ) : null}
        <RoundButton
          size="small"
          title={t('common.done')}
          onPress={props.onClose}
          testID="code-edit-set-done"
        />
      </Footer>
    </>
  );
}

function EditSetFile(
  props: Readonly<{
    file: WorkspaceFileEditSetFile;
    text: string | null | undefined;
    /** In the page body the file rows align with the band's inset. */
    inPage?: boolean;
    breakBefore?: boolean;
  }>,
) {
  const { file } = props;
  const slash = file.path.lastIndexOf('/');
  const name = file.path.slice(slash + 1);
  const directory = slash > 0 ? file.path.slice(0, slash) : '';
  // A file that only moves has no text change to show; its header says where it goes.
  const moveOnly = Boolean(file.renameTo) && file.edits.length === 0;
  const patch = React.useMemo(
    () =>
      !moveOnly && typeof props.text === 'string'
        ? buildEditSetPreviewDiff(file, props.text)
        : null,
    [file, moveOnly, props.text],
  );
  const count = file.edits.length + (file.renameTo ? 1 : 0);
  const movedName = file.renameTo ? file.renameTo.slice(file.renameTo.lastIndexOf('/') + 1) : null;
  const movedDirectory = file.renameTo ? file.renameTo.slice(0, Math.max(0, file.renameTo.lastIndexOf('/'))) : '';
  return (
    <View testID="code-edit-set-file" style={props.breakBefore ? styles.fileBreak : null}>
      <View style={[styles.fileHeader, props.inPage ? styles.pageInset : null]}>
        <FileIcon fileName={name} size={ICON_SIZE.sm} appearance="line" />
        <Text
          numberOfLines={1}
          style={[Typography.variant('label'), styles.fileName]}
        >
          <Text style={[Typography.default('medium'), styles.primaryText]}>
            {movedName && movedName !== name ? t('files.pane.intelligence.renameTo', { from: name, to: movedName }) : name}
          </Text>
          {directory || movedDirectory ? (
            <Text style={styles.tertiaryText}>
              {`  ${movedDirectory && movedDirectory !== directory ? t('files.pane.intelligence.renameTo', { from: directory, to: movedDirectory }) : directory}`}
            </Text>
          ) : null}
        </Text>
        <Text variant="meta" style={[styles.tertiaryText, styles.tabular]}>
          {String(count)}
        </Text>
      </View>
      {moveOnly ? null : patch ? (
        <DiffViewer
          mode="unified"
          unifiedDiff={patch}
          filePath={file.renameTo ?? file.path}
          wrapLines
          showPrefix
          presentationStyleOverride="unified"
        />
      ) : (
        <Text variant="meta" style={[styles.tertiaryText, styles.fileNote, props.inPage ? styles.pageInset : null]}>
          {props.text === undefined
            ? t('files.pane.intelligence.readingFile')
            : t('files.pane.intelligence.changesNotShown', { count })}
        </Text>
      )}
    </View>
  );
}

function Footer(props: Readonly<{ children: React.ReactNode }>) {
  return <View style={styles.footer}>{props.children}</View>;
}

const styles = StyleSheet.create((theme) => ({
  sheet: {
    paddingBottom: theme.space.s12,
  },
  page: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  band: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingLeft: theme.space.s16,
    paddingRight: theme.space.s12,
    paddingVertical: theme.space.s8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border.subtle,
  },
  bandText: {
    flex: 1,
    minWidth: 0,
    gap: theme.space.s2,
  },
  bandActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  /** Files after the first are set off by one ink hairline, like the Changes body's file breaks. */
  fileBreak: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  pageScroll: {
    flex: 1,
    minHeight: 0,
  },
  pageContent: {
    paddingBottom: theme.space.s16,
  },
  resultList: {
    paddingBottom: theme.space.s4,
  },
  pageInset: {
    paddingHorizontal: theme.space.s16,
  },
  pageNote: {
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s12,
    paddingTop: theme.space.s10,
    paddingBottom: theme.space.s6,
  },
  headerName: {
    flexShrink: 1,
  },
  block: {
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s8,
    gap: theme.space.s6,
  },
  input: {
    color: theme.colors.input.text,
    backgroundColor: theme.colors.input.background,
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.space.s10,
    paddingVertical: theme.space.s6,
  },
  scroll: {
    flexShrink: 1,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  fileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s12,
    paddingTop: theme.space.s10,
    paddingBottom: theme.space.s6,
  },
  fileName: {
    flex: 1,
    minWidth: 0,
  },
  fileNote: {
    paddingHorizontal: theme.space.s12,
    paddingBottom: theme.space.s8,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  footerStatus: {
    flex: 1,
    minWidth: 0,
  },
  waitingLine: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  mono: {
    ...Typography.mono(),
  },
  tabular: {
    ...Typography.tabular(),
  },
  primaryText: {
    color: theme.colors.text.primary,
  },
  secondaryText: {
    color: theme.colors.text.secondary,
  },
  tertiaryText: {
    color: theme.colors.text.tertiary,
  },
  failureText: {
    color: theme.colors.state.danger.foreground,
  },
}));
