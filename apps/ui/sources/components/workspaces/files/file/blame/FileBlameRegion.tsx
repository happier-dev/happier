import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import type { EditorDecoration, Rect, TextEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Popover } from '@/components/ui/popover';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { resolveSessionTurnNumber } from '@/components/sessions/files/review/sessionTurnNumber';
import { useSessionSelector } from '@/sync/store/hooks';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { useSessionMessageAuthorshipScope } from '@/components/sessions/transcript/useSessionMessageAuthorshipScope';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import type {
  FileBlameRun,
  FileBlameSession,
  FileBlameTurn,
} from '@/sync/domains/session/changes/derivation/fileBlameRuns';
import {
  useFileBlame,
  type FileBlameScope,
  type UseFileBlameInput,
} from '@/sync/domains/session/changes/hooks/useFileBlame';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { t } from '@/text';

/**
 * Blame on the File page (P8 U5, lab BL1): a run column left of the line numbers in View and Changes,
 * and the run card. This module is a region the File page places; it owns the column's cells and the
 * card, the page owns where the code view sits.
 */

const PHONE_LANE_WIDTH_PX = 22;
const selectSessionTurns = (session: Session | null) => session?.sessionTurns?.turns ?? null;
const selectSessionAgentId = (session: Session | null) => session ? readSessionPresentationAgentId(session) : null;
const RECENCY_BAR_PX = 2;
/** Runs at least this strong in the View column read as the newer ones; Edit draws them stronger. */
const RECENT_RUN_OPACITY = 0.45;

type BlameLine = Readonly<{ run: FileBlameRun; start: boolean; index: number }>;

function runAge(run: FileBlameRun, nowMs: number): string | null {
  return run.ageMs === undefined
    ? null
    : formatRelativeTimeShort(nowMs - run.ageMs, nowMs);
}

/** Newer runs carry a stronger bar; uncommitted work is the newest there is. */
function recencyOpacity(run: FileBlameRun, ages: readonly number[]): number {
  if (run.ageMs === undefined || ages.length <= 1)
    return run.kind === 'commit' ? 0.25 : 0.7;
  const rank = ages.indexOf(run.ageMs);
  return 0.12 + 0.58 * (1 - rank / (ages.length - 1));
}

function RunMark({
  run,
  agentId,
  size,
}: Readonly<{ run: FileBlameRun; agentId: string | null; size: number }>) {
  const { theme } = useUnistyles();
  if (run.kind === 'session' && agentId)
    return <AgentIcon agentId={agentId} size={size} />;
  // A commit is a dot; uncommitted work nobody in this session wrote is a ring.
  const dot = Math.round(size * 0.4);
  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <View
        style={{
          width: dot,
          height: dot,
          borderRadius: dot / 2,
          ...(run.kind === 'uncommitted'
            ? { borderWidth: 1.5, borderColor: theme.colors.text.tertiary }
            : { backgroundColor: theme.colors.text.tertiary }),
        }}
      />
    </View>
  );
}

function lineRangeLabel(run: FileBlameRun): string {
  return run.lineCount === 1
    ? t('files.blame.line', { line: run.startLine })
    : t('files.blame.lines', {
        start: run.startLine,
        end: run.startLine + run.lineCount - 1,
      });
}

function formatDate(atMs: number): string {
  return new Date(atMs).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatClock(atMs: number): string {
  return new Date(atMs).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** The run card (lab BL1 B/U): who wrote these lines and the way to them. */
export function BlameCard({
  run,
  nowMs,
  agentId,
  onOpenCommit,
  onOpenTurn,
  onClose,
  inSession,
}: Readonly<{
  run: FileBlameRun;
  nowMs: number;
  agentId: string | null;
  /** Session pages can say no turn wrote the lines; project pages only know git's answer. */
  inSession: boolean;
  onOpenCommit?: (sha: string) => void;
  onOpenTurn?: (turn: FileBlameTurn) => void;
  onClose: () => void;
}>) {
  const { theme } = useUnistyles();
  const writeClipboard = useClipboardWrite();
  const meta = [
    Typography.variant('meta'),
    { color: theme.colors.text.secondary },
  ];
  const header = (children: React.ReactNode) => (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s12,
        paddingTop: theme.space.s12,
        paddingBottom: theme.space.s8,
      }}
    >
      {children}
    </View>
  );
  const footer = (actions: React.ReactNode, trailing: string) => (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s10,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
      }}
    >
      {actions}
      <View style={{ flex: 1 }} />
      <Text
        style={[
          Typography.variant('meta'),
          Typography.tabular(),
          { color: theme.colors.text.tertiary },
        ]}
      >
        {trailing}
      </Text>
    </View>
  );
  if (run.kind === 'commit') {
    const { commit } = run;
    const age = runAge(run, nowMs);
    return (
      <View testID="blame-card" style={{ minWidth: 280 }}>
        {header(
          <>
            <View
              style={{
                paddingHorizontal: theme.space.s6,
                paddingVertical: theme.space.s2,
                borderRadius: 4,
                backgroundColor: theme.colors.surface.selected,
              }}
            >
              <Text
                style={[
                  Typography.variant('meta'),
                  Typography.mono(),
                  { color: theme.colors.text.secondary },
                ]}
              >
                {commit.shortSha}
              </Text>
            </View>
            <Text
              numberOfLines={2}
              style={[
                Typography.variant('label', 'semiBold'),
                { flex: 1, color: theme.colors.text.primary },
              ]}
            >
              {commit.summary}
            </Text>
          </>,
        )}
        <Text
          style={[
            ...meta,
            {
              paddingHorizontal: theme.space.s12,
              paddingBottom: theme.space.s12,
            },
          ]}
        >
          {[commit.authorName, formatDate(commit.authoredAtMs), age]
            .filter(Boolean)
            .join(' · ')}
        </Text>
        {footer(
          <>
            {onOpenCommit ? (
              <TextLinkButton
                tone="strong"
                size="meta"
                label={t('files.blame.openCommit')}
                onPress={() => {
                  onClose();
                  onOpenCommit(commit.sha);
                }}
              />
            ) : null}
            <TextLinkButton
              tone="strong"
              size="meta"
              label={t('files.blame.copySha')}
              onPress={() => {
                void writeClipboard(commit.sha);
              }}
            />
          </>,
          lineRangeLabel(run),
        )}
      </View>
    );
  }
  if (run.kind === 'session') {
    const { turn } = run;
    return (
      <View testID="blame-card" style={{ minWidth: 280 }}>
        {header(
          <>
            {agentId ? (
              <AgentIcon agentId={agentId} size={ICON_SIZE.sm} />
            ) : null}
            <Text
              numberOfLines={1}
              style={[
                Typography.variant('label', 'semiBold'),
                { flex: 1, color: theme.colors.text.primary },
              ]}
            >{`${turn.agentLabel} · ${turn.label}`}</Text>
          </>,
        )}
        <Text
          style={[
            Typography.variant('body'),
            {
              color: theme.colors.text.secondary,
              paddingHorizontal: theme.space.s12,
              paddingBottom: theme.space.s12,
            },
          ]}
        >
          {t('files.blame.writtenIn', { title: turn.sessionTitle, time: formatClock(turn.writtenAtMs) })}
          {turn.requester ? ` ${t('files.blame.askedBy', { name: turn.requester.name })}` : ''}
        </Text>
        {footer(
          onOpenTurn ? (
            <TextLinkButton
              tone="strong"
              size="meta"
              label={t('files.blame.openTurn')}
              onPress={() => {
                onClose();
                onOpenTurn(turn);
              }}
            />
          ) : null,
          t('files.blame.uncommitted'),
        )}
      </View>
    );
  }
  return (
    <View testID="blame-card" style={{ minWidth: 280 }}>
      {header(
        <Text
          style={[
            Typography.variant('label', 'semiBold'),
            { color: theme.colors.text.primary },
          ]}
        >
          {t('files.blame.uncommitted')}
        </Text>,
      )}
      <Text
        style={[
          Typography.variant('body'),
          {
            color: theme.colors.text.secondary,
            paddingHorizontal: theme.space.s12,
            paddingBottom: theme.space.s12,
          },
        ]}
      >
        {inSession ? t('files.blame.uncommittedBody') : t('files.blame.uncommittedNoSession')}
      </Text>
      {footer(null, lineRangeLabel(run))}
    </View>
  );
}

function BlameCell({
  line,
  width,
  compact,
  agentId,
  recency,
  active,
  nowMs,
  onPress,
  registerAnchor,
}: Readonly<{
  line: BlameLine | null;
  width: number;
  compact: boolean;
  agentId: string | null;
  recency: number;
  active: boolean;
  nowMs: number;
  onPress: (run: FileBlameRun) => void;
  registerAnchor: (runId: string, node: View | null) => void;
}>) {
  const { theme } = useUnistyles();
  const frame = { width, flex: 1, flexDirection: 'row' as const };
  if (!line) return <View style={frame} />;
  const { run, start } = line;
  const age = start && !compact ? runAge(run, nowMs) : null;
  return (
    <View
      ref={start ? (node) => registerAnchor(run.id, node) : undefined}
      style={[
        frame,
        start && line.index > 0
          ? { borderTopWidth: 1, borderTopColor: theme.colors.border.default }
          : null,
      ]}
    >
      <HappierPressable
        onPress={() => onPress(run)}
        accessibilityRole="button"
        tabIndex={start ? 0 : -1}
        accessibilityLabel={`${run.label}, ${lineRangeLabel(run)}`}
        testID={start ? `blame-run:${run.startLine}` : undefined}
        style={{
          flex: 1,
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: theme.space.s6,
          paddingHorizontal: compact ? 0 : theme.space.s8,
          justifyContent: compact ? 'center' : 'flex-start',
          backgroundColor: active ? theme.colors.surface.selected : undefined,
        }}
      >
        {start ? (
          compact ? (
            <View style={{ paddingTop: theme.space.s2 }}>
              <RunMark run={run} agentId={agentId} size={12} />
            </View>
          ) : (
            <>
              {run.kind === 'session' && agentId ? (
                <View style={{ paddingTop: theme.space.s2 }}>
                  <AgentIcon agentId={agentId} size={12} />
                </View>
              ) : null}
              <Text
                numberOfLines={1}
                style={[
                  Typography.variant('meta'),
                  {
                    flex: 1,
                    color:
                      run.kind === 'uncommitted'
                        ? theme.colors.text.tertiary
                        : theme.colors.text.secondary,
                  },
                ]}
              >
                {run.label}
              </Text>
              {age ? (
                <Text
                  style={[
                    Typography.variant('meta'),
                    Typography.tabular(),
                    { color: theme.colors.text.tertiary },
                  ]}
                >
                  {age}
                </Text>
              ) : null}
            </>
          )
        ) : null}
      </HappierPressable>
      <View
        style={{
          width: RECENCY_BAR_PX,
          backgroundColor: theme.colors.text.primary,
          opacity: recency,
        }}
      />
    </View>
  );
}

export type FileBlameRegionInput = Readonly<{
  scope: FileBlameScope | null;
  path: string;
  content: Readonly<{ text: string; hash: string }> | null;
  enabled: boolean;
  active?: boolean;
  readBlame: boolean;
  revision?: UseFileBlameInput['revision'];
  refreshContent?: UseFileBlameInput['refreshContent'];
  /** The mounted code editor's existing decoration channel; Markdown rich editing has no gutter. */
  editor?: TextEditorHandle | null;
  /** The Session whose File page this is; its turns attribute uncommitted lines. Project pages pass null. */
  sessionAddress: SessionAddress | null;
  /** Phone: the 22 px glyph column and a run sheet. */
  compact: boolean;
  onOpenCommit?: (sha: string) => void;
  onOpenTurn?: (turn: FileBlameTurn) => void;
}>;

export type FileBlameRegion = Readonly<{
  runs: readonly FileBlameRun[];
  /** Pass to `CodeLinesView renderLeadingLane`; undefined while blame is off. */
  renderLeadingLane: ((line: CodeLine) => React.ReactNode) | undefined;
  /** The run card, mounted once beside the code view. */
  card: React.ReactNode;
  /** One quiet note above the code (untracked file, an error); null when none applies. */
  note: Readonly<{ tone: 'info' | 'danger'; text: string }> | null;
  /** The open card's run, for the code view to emphasize. */
  emphasizedLines: Readonly<{ startLine: number; lineCount: number }> | null;
  refresh: () => void;
}>;

/** The blame region: run cells for the code view, the card, and its one note. */
export function useFileBlameRegion(
  input: FileBlameRegionInput,
): FileBlameRegion {
  const { theme } = useUnistyles();
  const sessionId = input.sessionAddress?.sessionId ?? '';
  const serverId = input.sessionAddress?.serverId;
  // Narrow reads: each selector returns a primitive or the stored reference, so unrelated Session
  // updates do not re-render the code view.
  const turns = useSessionSelector(sessionId, serverId, selectSessionTurns);
  const agentId = useSessionSelector(sessionId, serverId, selectSessionAgentId);
  const sessionTitle = useSessionSelector(sessionId, serverId, React.useCallback((session: Session | null) => session ? getSessionName(session, serverId) : '', [serverId]));
  const authorship = useSessionMessageAuthorshipScope(sessionId, serverId);
  const session = React.useMemo<FileBlameSession | null>(() => input.sessionAddress ? {
    address: input.sessionAddress, agentLabel: agentId ? resolveAgentCatalogTitle(agentId) : t('files.blame.agentFallback'),
    title: sessionTitle, authorship,
  } : null, [agentId, authorship, input.sessionAddress, sessionTitle]);
  const turnLabel = React.useCallback(
    (turnId: string) => {
      const number = resolveSessionTurnNumber(turns, turnId);
      return number === null
        ? t('files.blame.turnUnknown')
        : t('files.blame.turn', { number });
    },
    [turns],
  );
  const labels = React.useMemo(
    () => ({ uncommitted: t('files.blame.uncommitted'), turn: turnLabel }),
    [turnLabel],
  );
  const blame = useFileBlame({
    scope: input.scope,
    path: input.path,
    content: input.content,
    enabled: input.enabled,
    active: input.active,
    readBlame: input.readBlame,
    session,
    labels,
    revision: input.revision,
    refreshContent: input.refreshContent,
  });
  const [nowMs] = React.useState(() => Date.now());
  const [openRunId, setOpenRunId] = React.useState<string | null>(null);
  const anchors = React.useRef(new Map<string, View>());
  const anchorRef = React.useRef<View | null>(null);
  const registerAnchor = React.useCallback(
    (runId: string, node: View | null) => {
      if (node) anchors.current.set(runId, node);
      else anchors.current.delete(runId);
    },
    [],
  );
  const linesByNumber = React.useMemo(() => {
    const map = new Map<number, BlameLine>();
    blame.runs.forEach((run, index) => {
      for (let offset = 0; offset < run.lineCount; offset++)
        map.set(run.startLine + offset, { run, start: offset === 0, index });
    });
    return map;
  }, [blame.runs]);
  const ages = React.useMemo(
    () =>
      [
        ...new Set(
          blame.runs.flatMap((run) =>
            run.ageMs === undefined ? [] : [run.ageMs],
          ),
        ),
      ].sort((a, b) => a - b),
    [blame.runs],
  );
  // The column is as wide as its longest label needs (no constant), within a reading-friendly band.
  const width = React.useMemo(() => {
    if (input.compact) return PHONE_LANE_WIDTH_PX;
    const longest = blame.runs.reduce(
      (max, run) =>
        Math.max(max, run.label.length + (runAge(run, nowMs)?.length ?? 0)),
      0,
    );
    const charPx = (Typography.variant('meta').fontSize ?? 12) * 0.56;
    return Math.round(
      Math.min(
        260,
        Math.max(
          120,
          longest * charPx + theme.space.s8 * 2 + theme.space.s6 * 2 + 14,
        ),
      ),
    );
  }, [blame.runs, input.compact, nowMs, theme.space.s6, theme.space.s8]);
  // In Edit the run has no cell to hang from; the card opens at the run's first line in the editor.
  const [editorAnchor, setEditorAnchor] = React.useState<Rect | null>(null);
  const openRun = React.useCallback((run: FileBlameRun, lineRect: Rect | null = null) => {
    anchorRef.current = anchors.current.get(run.id) ?? null;
    setEditorAnchor(lineRect);
    setOpenRunId((current) => (current === run.id ? null : run.id));
  }, []);
  const active = input.enabled && input.readBlame && blame.runs.length > 0;
  const editorDecorations = React.useMemo<readonly EditorDecoration[]>(() => active ? blame.runs.map((run) => ({
    layer: 'blame', id: `blame:${run.id}`, startLine: run.startLine, lineCount: run.lineCount, runId: run.id,
    tone: recencyOpacity(run, ages) >= RECENT_RUN_OPACITY ? 'recent' : 'older',
  })) : [], [active, ages, blame.runs]);
  React.useEffect(() => {
    const editor = input.editor;
    if (!editor?.setDecorations) return;
    editor.setDecorations('blame', editorDecorations);
    return () => editor.setDecorations?.('blame', []);
  }, [input.editor, editorDecorations]);
  React.useEffect(() => {
    if (!active || !input.editor?.onDecorationPress) return;
    return input.editor.onDecorationPress((layer, decoration) => {
      if (layer !== 'blame' || !('runId' in decoration)) return;
      const run = blame.runs.find((entry) => entry.id === decoration.runId);
      if (run) openRun(run, input.editor?.getLineRect?.(run.startLine) ?? null);
    });
  }, [active, input.editor, blame.runs, openRun]);
  const renderLeadingLane = React.useMemo(
    () =>
      active
        ? (line: CodeLine) => {
            const entry = line.newLine
              ? (linesByNumber.get(line.newLine) ?? null)
              : null;
            return (
              <BlameCell
                line={entry}
                width={width}
                compact={input.compact}
                agentId={agentId}
                nowMs={nowMs}
                recency={entry ? recencyOpacity(entry.run, ages) : 0}
                active={entry?.run.id === openRunId}
                onPress={openRun}
                registerAnchor={registerAnchor}
              />
            );
          }
        : undefined,
    [
      active,
      agentId,
      ages,
      input.compact,
      linesByNumber,
      nowMs,
      openRun,
      openRunId,
      registerAnchor,
      width,
    ],
  );

  const openIndex = openRunId
    ? blame.runs.findIndex((run) => run.id === openRunId)
    : -1;
  const open = openIndex >= 0 ? blame.runs[openIndex]! : null;
  const close = React.useCallback(() => setOpenRunId(null), []);
  // A run open from Edit hangs from its line there; stepping keeps that line's place.
  const editorRect = editorAnchor && input.editor ? editorAnchor : null;
  const step = (delta: number) => {
    const next = blame.runs[openIndex + delta];
    if (next) {
      anchorRef.current = anchors.current.get(next.id) ?? anchorRef.current;
      if (editorRect) setEditorAnchor(input.editor?.getLineRect?.(next.startLine) ?? editorRect);
      setOpenRunId(next.id);
    }
  };
  const card = open ? (
    <Popover
      open
      anchorRef={anchorRef}
      anchor={editorRect ? { kind: 'rect', rect: { left: editorRect.x, top: editorRect.y, width: Math.max(1, editorRect.width), height: Math.max(1, editorRect.height) }, coordinateSpace: 'window' } : undefined}
      onRequestClose={close}
      placement="bottom"
      phonePresentation="sheet"
      // The card leads with its own title; the sheet keeps only its grabber (lab bl-Bp).
      sheetHeader="none"
      accessibilityLabel={open.label}
      portal={{
        web: true,
        native: true,
        matchAnchorWidth: false,
        sizeToContent: true,
      }}
    >
      {({ maxHeight, presentation }) => (
        <FloatingOverlay role="panel" maxHeight={maxHeight}>
          <BlameCard
            run={open}
            inSession={input.sessionAddress !== null}
            nowMs={nowMs}
            agentId={agentId}
            onOpenCommit={input.onOpenCommit}
            onOpenTurn={input.onOpenTurn}
            onClose={close}
          />
          {presentation === 'sheet' ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: theme.space.s16,
                paddingVertical: theme.space.s8,
              }}
            >
              <IconButton
                variant="plain"
                icon={
                  <Icon
                    name="caret-up"
                    size={ICON_SIZE.sm}
                    color={theme.colors.text.secondary}
                  />
                }
                accessibilityLabel={t('files.blame.previousRun')}
                disabled={openIndex <= 0}
                onPress={() => step(-1)}
              />
              <Text
                style={[
                  Typography.variant('meta'),
                  Typography.tabular(),
                  { color: theme.colors.text.tertiary },
                ]}
              >
                {t('files.blame.runOf', {
                  index: openIndex + 1,
                  total: blame.runs.length,
                })}
              </Text>
              <IconButton
                variant="plain"
                icon={
                  <Icon
                    name="caret-down"
                    size={ICON_SIZE.sm}
                    color={theme.colors.text.secondary}
                  />
                }
                accessibilityLabel={t('files.blame.nextRun')}
                disabled={openIndex >= blame.runs.length - 1}
                onPress={() => step(1)}
              />
            </View>
          ) : null}
        </FloatingOverlay>
      )}
    </Popover>
  ) : null;
  const sessionRuns = blame.runs.filter((run) => run.kind === 'session');
  const note: FileBlameRegion['note'] =
    !input.enabled || !input.readBlame
      ? null
      : blame.noHistory
        ? {
            tone: 'info',
            text:
              sessionRuns.length === blame.runs.length && sessionRuns[0]
                ? t('files.blame.newFileByTurn', {
                    agent: sessionRuns[0].turn.agentLabel,
                    turn: sessionRuns[0].turn.label,
                  })
                : t('files.blame.noHistory'),
          }
        : blame.error
          ? { tone: 'danger', text: t('files.blame.failed') }
          : null;
  return { runs: blame.runs, renderLeadingLane, card, note, emphasizedLines: open, refresh: blame.refresh };
}

/** The region's one note above the code (lab BL1 N): quiet, one line, said once. */
export function FileBlameNote({ note }: Readonly<{ note: NonNullable<FileBlameRegion['note']> }>) {
    const { theme } = useUnistyles();
    const color = note.tone === 'danger' ? theme.colors.state.danger.foreground : theme.colors.text.secondary;
    return <View testID="file-blame-note" style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s8,
        paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s8, borderBottomWidth: 1, borderBottomColor: theme.colors.border.default }}>
        <Icon name={note.tone === 'danger' ? 'warning-circle' : 'info'} size={ICON_SIZE.sm} color={color} />
        <Text style={[Typography.variant('meta'), { flex: 1, color: theme.colors.text.secondary }]}>{note.text}</Text>
    </View>;
}
