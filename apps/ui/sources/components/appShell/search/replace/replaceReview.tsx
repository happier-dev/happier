import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { KeyboardCommandHint } from '@/components/ui/keyboard/KeyHint';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { SelectionListDetailPaneContext } from '@/components/ui/selectionList/SelectionListDetailPaneContext';
import type { SelectionListOption, SelectionListSectionDescriptor } from '@/components/ui/selectionList';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
  buildReplacePreviewUnifiedDiff,
  previewMatchInsertText,
  replaceFileSelection,
  replaceMatchKey,
  summarizeReplaceResults,
  type WorkspaceReplaceApproval,
  type WorkspaceReplaceFileResult,
  type WorkspaceReplaceMatch,
  type WorkspaceReplaceMatcher,
  type WorkspaceReplaceModel,
  type WorkspaceReplacePreviewFile,
} from '@/sync/domains/workspaces/files/workspaceFileReplace';
import { t } from '@/text';
import { HAPPIER_RADIUS_V1 } from '@happier-dev/plugin-ui/environment';

/**
 * Replace across files inside Universal Search (P8 U2, lab RP1): the Text in files result list becomes
 * the review. Rows are SelectionList options (one highlight, the keyboard path and the detail column
 * stay the list's); this module only says what each row is.
 */

export const REPLACE_OPTION_PREFIX = 'replace:';
const NO_KEYS: ReadonlySet<string> = new Set();

function splitPath(
  path: string,
): Readonly<{ name: string; directory: string }> {
  const split = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const directory = split >= 0 ? path.slice(0, split) : '';
  const parts = directory.split(/[\\/]/).filter(Boolean);
  return {
    name: path.slice(split + 1),
    directory:
      parts.length > 3
        ? `${parts[0]}/${parts[1]}/…/${parts[parts.length - 1]}`
        : directory,
  };
}

/** A checkbox mark. The row is the control (pressing it includes or leaves out); this only shows its state. */
function SelectionMark({
  state,
}: Readonly<{ state: 'all' | 'some' | 'none' }>) {
  const { theme } = useUnistyles();
  const name: IconName =
    state === 'all'
      ? 'check-square'
      : state === 'some'
        ? 'minus-square'
        : 'square';
  return (
    <Icon
      name={name}
      size={ICON_SIZE.sm}
      weight={state === 'none' ? 'regular' : 'fill'}
      color={
        state === 'none'
          ? theme.colors.text.tertiary
          : theme.colors.text.primary
      }
    />
  );
}

function FileIdentity({
  path,
  dim = false,
}: Readonly<{ path: string; dim?: boolean }>) {
  const { theme } = useUnistyles();
  const { name, directory } = splitPath(path);
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: MENU_ROW_METRICS.iconMarginRightPx,
        minWidth: 0,
        flexShrink: 1,
      }}
    >
      <FileIcon fileName={name} size={ICON_SIZE.sm} appearance="line" />
      <Text
        numberOfLines={1}
        style={[
          Typography.variant('label'),
          {
            flexShrink: 1,
            color: dim
              ? theme.colors.text.secondary
              : theme.colors.text.primary,
          },
        ]}
      >
        <Text style={Typography.default('medium')}>{name}</Text>
        {directory ? (
          <Text
            style={[
              Typography.default(),
              { color: theme.colors.text.tertiary },
            ]}
          >{`  ${directory}`}</Text>
        ) : null}
      </Text>
    </View>
  );
}

/** The match line: number in a quiet gutter, the code with what goes (removed ink) and what comes (added ink). */
function MatchLine({
  file,
  match,
  matcher,
  included,
  gutterDigits,
}: Readonly<{
  file: WorkspaceReplacePreviewFile;
  match: WorkspaceReplaceMatch;
  matcher: WorkspaceReplaceMatcher;
  included: boolean;
  gutterDigits: number;
}>) {
  const { theme } = useUnistyles();
  const style = { ...Typography.variant('meta'), ...Typography.mono() };
  const text = match.text.trimStart();
  const shift = match.text.length - text.length;
  const start = Math.max(0, match.column16 - 1 - shift);
  const end = start + match.length16;
  const insert = included ? previewMatchInsertText(file, match, matcher) : '';
  const gutter = {
    minWidth: Math.ceil(gutterDigits * (style.fontSize ?? 12) * 0.6),
    textAlign: 'right' as const,
  };
  const ink = included
    ? theme.colors.text.primary
    : theme.colors.text.secondary;
  // Without the diff column beside the list (a phone), the line wraps so the change itself stays in view (lab RP1 Rp).
  const wrap = !React.useContext(SelectionListDetailPaneContext);
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: wrap ? 'flex-start' : 'center',
        gap: theme.space.s8,
        minWidth: 0,
      }}
    >
      <SelectionMark state={included ? 'all' : 'none'} />
      <Text
        useDefaultTypography={false}
        style={[
          style,
          Typography.tabular(),
          gutter,
          { color: theme.colors.text.tertiary },
        ]}
      >
        {match.line}
      </Text>
      <Text
        useDefaultTypography={false}
        numberOfLines={wrap ? undefined : 1}
        style={[style, { flex: 1, color: ink }]}
      >
        {text.slice(0, start)}
        {included ? (
          <>
            <Text
              useDefaultTypography={false}
              style={{
                backgroundColor: theme.colors.diff.inlineRemoved.background,
                color: theme.colors.diff.inlineRemoved.foreground,
              }}
            >
              {text.slice(start, end)}
            </Text>
            <Text
              useDefaultTypography={false}
              style={{
                backgroundColor: theme.colors.diff.inlineAdded.background,
                color: theme.colors.diff.inlineAdded.foreground,
              }}
            >
              {insert}
            </Text>
          </>
        ) : (
          <Text
            useDefaultTypography={false}
            style={{
              textDecorationLine: 'underline',
              textDecorationColor: theme.colors.text.tertiary,
            }}
          >
            {text.slice(start, end)}
          </Text>
        )}
        {text.slice(end)}
      </Text>
    </View>
  );
}

const QUIET_LINE_HEIGHT = Number(Typography.variant('meta').lineHeight);

function QuietLine({
  icon,
  label,
  tone = 'secondary',
  action,
}: Readonly<{
  icon?: IconName;
  label: string;
  tone?: 'secondary' | 'danger';
  action?: React.ReactNode;
}>) {
  const { theme } = useUnistyles();
  const color =
    tone === 'danger'
      ? theme.colors.state.danger.foreground
      : theme.colors.text.secondary;
  // The mark sits on the first line and the text wraps beside it (never under it) at phone width.
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s8,
        paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx,
        paddingVertical: MENU_ROW_METRICS.paddingVerticalPx,
      }}
    >
      {icon ? (
        <View style={{ height: QUIET_LINE_HEIGHT, justifyContent: 'center' }}>
          <Icon name={icon} size={ICON_SIZE.sm} color={color} />
        </View>
      ) : null}
      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: theme.space.s8 }}>
      <Text
        style={[
          Typography.variant('meta'),
          {
            color:
              tone === 'danger'
                ? theme.colors.text.primary
                : theme.colors.text.secondary,
            flexShrink: 1,
          },
        ]}
      >
        {label}
      </Text>
      {action}
      </View>
    </View>
  );
}

/** What waits, in the surface's own words: the replace, its preview, or its Undo. */
function approvalSubject(approval: WorkspaceReplaceApproval, files: number): string {
  return approval.operation === 'preview'
    ? t('universalSearch.replace.previewApprovalSubject')
    : approval.operation === 'restore'
      ? t('universalSearch.replace.undo')
      : t('universalSearch.replace.apply', { files: Math.max(files, 0) });
}

/**
 * A step waiting on the person's approval (their Settings › Actions ask for it): the shared pending line,
 * whose Review opens that request in the Inbox. Nothing here assumes it ran; once approved, the same
 * operation continues in the surface (progress, then the result and its Undo).
 */
function ReplaceApprovalLine({
  approval,
  files,
  onLeave,
}: Readonly<{ approval: WorkspaceReplaceApproval; files: number; onLeave?: () => void }>) {
  const router = useRouter();
  const { artifactId } = approval.request;
  const { serverId } = approval;
  const open = React.useCallback(() => {
    // An overlay can't stay above the page it opens: it steps aside (the request stays in the Inbox).
    onLeave?.();
    router.pushRetainingCurrent(buildApprovalHref(artifactId, serverId));
  }, [artifactId, onLeave, router, serverId]);
  // On the list's own line metrics, so its glyph starts where the list's text does.
  return (
    <View style={{ paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx, paddingVertical: MENU_ROW_METRICS.paddingVerticalPx }}>
      <ActionApprovalPendingNotice
        testID="replace-approval"
        presentation="line"
        summary={approvalSubject(approval, files)}
        message={t('approvals.waitingForYou')}
        onOpenApproval={open}
      />
    </View>
  );
}

function StatusHeading({
  label,
  trailing,
}: Readonly<{ label: string; trailing?: string }>) {
  const { theme } = useUnistyles();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: theme.space.s8,
        paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx,
        paddingTop: MENU_ROW_METRICS.paddingVerticalPx,
        paddingBottom: theme.space.s2,
      }}
    >
      <Text
        numberOfLines={1}
        style={[
          Typography.variant('label', 'semiBold'),
          Typography.tabular(),
          { flex: 1, color: theme.colors.text.primary },
        ]}
      >
        {label}
      </Text>
      {trailing ? (
        <Text
          numberOfLines={1}
          style={[
            Typography.variant('meta'),
            { color: theme.colors.text.tertiary },
          ]}
        >
          {trailing}
        </Text>
      ) : null}
    </View>
  );
}

function Count({ label }: Readonly<{ label: string }>) {
  const { theme } = useUnistyles();
  return (
    <Text
      style={[
        Typography.variant('meta'),
        Typography.tabular(),
        { color: theme.colors.text.tertiary },
      ]}
    >
      {label}
    </Text>
  );
}

/** The detail column (lab RP1 right): the file's diff as it will be written, through the shared diff renderer. */
function ReplaceFileDetail({
  file,
  matcher,
  excludedKeys,
  note,
  headline,
  inColumn = true,
}: Readonly<{
  file: WorkspaceReplacePreviewFile;
  matcher: WorkspaceReplaceMatcher;
  excludedKeys: ReadonlySet<string>;
  note: string;
  headline: string;
  /** In the detail column it owns its scroll; pushed as a phone step it flows in the list's scroll. */
  inColumn?: boolean;
}>) {
  const { theme } = useUnistyles();
  const patch = React.useMemo(
    () => buildReplacePreviewUnifiedDiff(file, matcher, excludedKeys),
    [excludedKeys, file, matcher],
  );
  const { name } = splitPath(file.path);
  const diff = (
    <DiffViewer
      mode="unified"
      unifiedDiff={patch}
      filePath={file.path}
      wrapLines
      showPrefix
      presentationStyleOverride="unified"
    />
  );
  return (
    <View testID="replace-file-detail" style={inColumn ? { flex: 1, minHeight: 0 } : undefined}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: MENU_ROW_METRICS.iconMarginRightPx,
          paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx,
          paddingVertical: MENU_ROW_METRICS.paddingVerticalPx,
        }}
      >
        <FileIcon fileName={name} size={ICON_SIZE.sm} appearance="line" />
        <Text
          numberOfLines={1}
          style={[
            Typography.variant('label', 'semiBold'),
            { flexShrink: 1, color: theme.colors.text.primary },
          ]}
        >
          <Text style={Typography.default('medium')}>{name}</Text>
          <Text
            style={[
              Typography.default(),
              Typography.tabular(),
              { color: theme.colors.text.tertiary },
            ]}
          >{`  · ${headline}`}</Text>
        </Text>
      </View>
      {/* The column's one scroll owner: a long diff scrolls under its headline, the note stays below it. */}
      {inColumn ? (
        <ScrollView style={{ flex: 1, minHeight: 0 }} testID="replace-file-detail-scroll">{diff}</ScrollView>
      ) : diff}
      <Text
        style={[
          Typography.variant('meta'),
          {
            color: theme.colors.text.secondary,
            paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx,
            paddingVertical: MENU_ROW_METRICS.paddingVerticalPx,
          },
        ]}
      >
        {note}
      </Text>
    </View>
  );
}

export type ReplaceReviewContext = Readonly<{
  model: WorkspaceReplaceModel;
  matcher: WorkspaceReplaceMatcher;
  /** "happier" in "No text in happier matches …". */
  scopeLabel: string;
  machineLabel: string;
  /** A folder is in scope and its Account is current (otherwise Text in files is unavailable too). */
  available: boolean;
  /** The Machine holding the folder answers. */
  reachable: boolean;
  /** Commits the open-at-line result for a row, so the list's activation opens it. */
  commitOpen: (path: string, line: number) => void;
  /** No detail column beside the list (phone): each file offers its diff as a pushed step instead. */
  compact: boolean;
  /** The surface is an overlay: opening an approval request closes it first. */
  onLeaveForApproval?: () => void;
}>;

function matchOptionId(path: string, match: WorkspaceReplaceMatch): string {
  return `${REPLACE_OPTION_PREFIX}match:${path}:${replaceMatchKey(match)}`;
}

function fileOptionId(path: string): string {
  return `${REPLACE_OPTION_PREFIX}file:${path}`;
}

function staticLine(
  id: string,
  label: string,
  content: React.ReactNode,
): SelectionListOption {
  // A line, not a choice: it reads at full strength and the keyboard passes over it.
  return {
    id: `${REPLACE_OPTION_PREFIX}${id}`,
    label,
    disabled: true,
    content,
  };
}

function reviewSections(
  context: ReplaceReviewContext,
): SelectionListSectionDescriptor[] {
  const { model, matcher } = context;
  const preview = model.preview;
  if (!context.available) {
    const label = t('universalSearch.content.unavailable');
    return [{ kind: 'static', id: 'replace:state', options: [staticLine('unavailable', label, <QuietLine icon="info" label={label} />)] }];
  }
  if (!context.reachable) {
    return [
      {
        kind: 'static',
        id: 'replace:state',
        options: [
          staticLine(
            'offline',
            t('universalSearch.replace.offline', {
              machine: context.machineLabel,
            }),
            <QuietLine
              icon="wifi-slash"
              label={t('universalSearch.replace.offline', {
                machine: context.machineLabel,
              })}
            />,
          ),
        ],
      },
    ];
  }
  if (model.error === 'declined') {
    // Nothing failed: the person said no. The review can ask again.
    const label = t('universalSearch.replace.previewDeclined');
    return [{ kind: 'static', id: 'replace:state', options: [staticLine('declined', label, <QuietLine icon="info" label={label}
      action={<TextLinkButton tone="strong" size="meta" label={t('universalSearch.replace.retry')} onPress={model.retry} />} />)] }];
  }
  if (model.error) {
    const label =
      model.error === 'invalid_pattern'
        ? t('universalSearch.replace.invalidPattern')
        : model.error === 'update_required'
          ? t('universalSearch.replace.updateRequired', {
              machine: context.machineLabel,
            })
          : t('universalSearch.replace.failed', {
              machine: context.machineLabel,
            });
    return [
      {
        kind: 'static',
        id: 'replace:state',
        options: [
          staticLine(
            'error',
            label,
            <QuietLine
              icon="x-circle"
              tone="danger"
              label={label}
              action={
                model.error === 'invalid_pattern' ? undefined : (
                  <TextLinkButton
                    tone="strong"
                    size="meta"
                    label={t('universalSearch.replace.retry')}
                    onPress={model.retry}
                  />
                )
              }
            />,
          ),
        ],
      },
    ];
  }
  if (!preview && model.approval?.operation === 'preview' && model.approval.status === 'waiting') {
    const label = t('approvals.waitingForYou');
    return [{ kind: 'static', id: 'replace:state', options: [
      staticLine('approval', label, <ReplaceApprovalLine approval={model.approval} files={0} onLeave={context.onLeaveForApproval} />),
    ] }];
  }
  if (!preview) {
    // First preview on its way: skeleton-free, the list keeps the search's own loading row.
    return [
      {
        kind: 'static',
        id: 'replace:state',
        options: [
          staticLine(
            'loading',
            t('universalSearch.replace.updating'),
            <QuietLine label={t('universalSearch.replace.updating')} />,
          ),
        ],
      },
    ];
  }
  if (model.files.length === 0 && model.unsavedFiles.length === 0) {
    return [
      {
        kind: 'static',
        id: 'replace:state',
        options: [
          staticLine(
            'empty',
            t('universalSearch.replace.noMatches', {
              query: matcher.query,
              scope: context.scopeLabel,
            }),
            <QuietLine
              icon="magnifying-glass"
              label={t('universalSearch.replace.noMatches', {
                query: matcher.query,
                scope: context.scopeLabel,
              })}
            />,
          ),
        ],
      },
    ];
  }
  const { totals } = model;
  const status =
    totals.selectedMatches === totals.totalMatches
      ? t('universalSearch.replace.matchesInFiles', {
          matches: totals.totalMatches,
          files: totals.totalFiles,
        })
      : t('universalSearch.replace.selectedOfMatches', {
          selected: totals.selectedMatches,
          total: totals.totalMatches,
          files: totals.totalFiles,
        });
  const renamesFiles = model.files.some((file) => {
    const { name } = splitPath(file.path);
    return matcher.matchCase
      ? name.includes(matcher.query)
      : name.toLowerCase().includes(matcher.query.toLowerCase());
  });
  const options: SelectionListOption[] = [
    staticLine(
      'status',
      status,
      <StatusHeading
        label={status}
        trailing={
          !matcher.regex && renamesFiles
            ? t('universalSearch.replace.fileNamesNotRenamed')
            : undefined
        }
      />,
    ),
  ];
  for (const file of model.files) {
    const selection = replaceFileSelection(file, model.excluded);
    const keys = model.excluded.get(file.path) ?? NO_KEYS;
    const headline = t('universalSearch.replace.selectedOf', {
      selected: selection.selected,
      total: selection.total,
    });
    const detail = (inColumn = true) => (
      <ReplaceFileDetail
        file={file}
        matcher={matcher}
        excludedKeys={keys}
        headline={headline}
        note={t('universalSearch.replace.whatYouSee')}
        inColumn={inColumn}
      />
    );
    const gutterDigits = String(
      Math.max(...file.matches.map((match) => match.line)),
    ).length;
    options.push({
      id: fileOptionId(file.path),
      label: file.path,
      accessibilityLabel: t('universalSearch.replace.includeFile', {
        file: splitPath(file.path).name,
      }),
      icon: () => <SelectionMark state={selection.state} />,
      labelContent: () => (
        <FileIdentity path={file.path} dim={selection.state === 'none'} />
      ),
      rightAccessory: () => (
        <Count
          label={selection.state === 'all' ? String(selection.total) : headline}
        />
      ),
      detailContent: detail,
      onSelect: () => model.toggleFile(file.path),
    });
    for (const match of file.matches) {
      const included = !keys.has(replaceMatchKey(match));
      options.push({
        id: matchOptionId(file.path, match),
        label: `${file.path}:${match.line}`,
        accessibilityLabel: t('universalSearch.replace.includeMatch', {
          line: match.line,
          text: match.text.trim(),
        }),
        icon: () => <View style={{ width: MENU_ROW_METRICS.iconBoxSizePx }} />,
        labelContent: () => (
          <MatchLine
            file={file}
            match={match}
            matcher={matcher}
            included={included}
            gutterDigits={gutterDigits}
          />
        ),
        detailContent: detail,
        onSelect: () => model.toggleMatch(file.path, replaceMatchKey(match)),
      });
    }
    if (context.compact) {
      // Lists push details on a phone (lab rp-Rp "Show as diff ›").
      const { name } = splitPath(file.path);
      options.push({
        id: `${REPLACE_OPTION_PREFIX}diff:${file.path}`,
        label: t('universalSearch.replace.showAsDiff'),
        icon: () => <View style={{ width: MENU_ROW_METRICS.iconBoxSizePx }} />,
        openStep: {
          id: `replace-diff:${file.path}`,
          title: name,
          disableInputFilter: true,
          sections: [{ kind: 'static', id: 'replace:diff', options: [
            staticLine(`diff-body:${file.path}`, name, detail(false)),
          ] }],
        },
      });
    }
  }
  if (preview.hasMore) {
    options.push({
      id: `${REPLACE_OPTION_PREFIX}more`,
      label: t('universalSearch.replace.showMore'),
      loading: model.loadingMore,
      icon: () => <View style={{ width: MENU_ROW_METRICS.iconBoxSizePx }} />,
      onSelect: model.loadMore,
    });
  }
  const sections: SelectionListSectionDescriptor[] = [
    { kind: 'static', id: 'replace:review', options },
  ];
  if (model.unsavedFiles.length) {
    sections.push({
      kind: 'static',
      id: 'replace:unsaved',
      title: t('universalSearch.replace.unsavedSection'),
      count: model.unsavedFiles.length,
      options: model.unsavedFiles.map((file) => ({
        id: `${REPLACE_OPTION_PREFIX}unsaved:${file.path}`,
        label: file.path,
        icon: () => <View style={{ width: MENU_ROW_METRICS.iconBoxSizePx }} />,
        labelContent: () => <FileIdentity path={file.path} dim />,
        rightAccessory: () => (
          <Count label={t('universalSearch.replace.saveFirst')} />
        ),
        onSelect: () =>
          context.commitOpen(file.path, file.matches[0]?.line ?? 1),
      })),
    });
  }
  if (preview.notText > 0 || preview.coverage === 'partial') {
    const label = [
      preview.notText > 0
        ? t('universalSearch.replace.notText', { count: preview.notText })
        : null,
      preview.coverage === 'partial' && !preview.hasMore
        ? t('universalSearch.replace.partial')
        : null,
    ]
      .filter(Boolean)
      .join(' ');
    sections.push({
      kind: 'static',
      id: 'replace:notes',
      options: [
        staticLine('notes', label, <QuietLine icon="info" label={label} />),
      ],
    });
  }
  return sections;
}

function resultLine(
  result: WorkspaceReplaceFileResult,
  machineLabel: string,
): Readonly<{ icon: IconName; danger: boolean; label: string }> {
  switch (result.status) {
    case 'replaced':
      return {
        icon: 'check-circle',
        danger: false,
        label: t('universalSearch.replace.resultReplaced', {
          count: result.matchCount ?? 0,
        }),
      };
    case 'restored':
      return {
        icon: 'arrow-arc-left',
        danger: false,
        label: t('universalSearch.replace.resultRestored'),
      };
    case 'changed':
      return {
        icon: 'info',
        danger: false,
        label: t('universalSearch.replace.resultChanged'),
      };
    case 'undoChanged':
      return {
        icon: 'info',
        danger: false,
        label: t('universalSearch.replace.resultUndoChanged'),
      };
    case 'cancelled':
      return {
        icon: 'info',
        danger: false,
        label: t('universalSearch.replace.resultCancelled'),
      };
    case 'skipped':
      return {
        icon: 'info',
        danger: false,
        label:
          result.reason === 'unsaved'
            ? t('universalSearch.replace.resultUnsaved')
            : t('universalSearch.replace.resultSkipped'),
      };
    case 'failed':
      return {
        icon: 'x-circle',
        danger: true,
        label: t('universalSearch.replace.resultFailed', {
          machine: machineLabel,
        }),
      };
  }
}

function ResultStatusMark({
  icon,
  danger,
}: Readonly<{ icon: IconName; danger: boolean }>) {
  const { theme } = useUnistyles();
  return (
    <Icon
      name={icon}
      size={ICON_SIZE.sm}
      color={
        danger
          ? theme.colors.state.danger.foreground
          : theme.colors.text.secondary
      }
    />
  );
}

function ResultLabel({ path, line }: Readonly<{ path: string; line: string }>) {
  const { theme } = useUnistyles();
  return (
    <View style={{ gap: theme.space.s2, minWidth: 0 }}>
      <FileIdentity path={path} />
      <Text
        numberOfLines={2}
        style={[
          Typography.variant('meta'),
          { color: theme.colors.text.secondary },
        ]}
      >
        {line}
      </Text>
    </View>
  );
}

function resultSections(
  context: ReplaceReviewContext,
  results: readonly WorkspaceReplaceFileResult[],
): SelectionListSectionDescriptor[] {
  const { model, matcher } = context;
  const previewFiles = new Map(
    (model.preview?.files ?? []).map((file) => [file.path, file]),
  );
  const row = (result: WorkspaceReplaceFileResult): SelectionListOption => {
    const line = resultLine(result, context.machineLabel);
    const file = previewFiles.get(result.path);
    const action =
      result.status === 'replaced' && model.canUndo ? (
        <TextLinkButton
          tone="strong"
          size="meta"
          label={t('universalSearch.replace.undo')}
          onPress={() => {
            void model.undo(result.path);
          }}
        />
      ) : result.status === 'changed' ||
        result.status === 'failed' ||
        result.status === 'cancelled' ? (
        <TextLinkButton
          tone="strong"
          size="meta"
          label={t('universalSearch.replace.reviewAgain')}
          onPress={model.resetResults}
        />
      ) : null;
    return {
      id: `${REPLACE_OPTION_PREFIX}result:${result.path}`,
      label: result.path,
      accessibilityLabel: `${result.path}, ${line.label}`,
      icon: () => <ResultStatusMark icon={line.icon} danger={line.danger} />,
      labelContent: () => <ResultLabel path={result.path} line={line.label} />,
      ...(action
        ? { rightAccessory: action, rightAccessoryOutsidePressable: true }
        : {}),
      // Only a written file shows what was written; an undone file is back as it was (its row says so).
      ...(file && result.status === 'replaced'
        ? {
            detailContent: () => (
              <ReplaceFileDetail
                file={file}
                matcher={matcher}
                excludedKeys={model.excluded.get(file.path) ?? NO_KEYS}
                headline={line.label}
                note={t('universalSearch.replace.undoNote')}
              />
            ),
          }
        : {}),
      onSelect: () =>
        context.commitOpen(result.path, file?.matches[0]?.line ?? 1),
    };
  };
  const written = results.filter((result) => result.status !== 'skipped');
  const skipped = results.filter((result) => result.status === 'skipped');
  const sections: SelectionListSectionDescriptor[] = [];
  if (written.length)
    sections.push({
      kind: 'static',
      id: 'replace:results',
      options: written.map(row),
    });
  if (skipped.length)
    sections.push({
      kind: 'static',
      id: 'replace:skipped',
      title: t('universalSearch.replace.skippedSection'),
      options: skipped.map(row),
    });
  return sections;
}

export function buildReplaceReviewSections(
  context: ReplaceReviewContext,
): SelectionListSectionDescriptor[] {
  // Retained rows and their diff always describe the matcher that produced them, even while the
  // current query is incomplete or invalid. Current-request errors use the existing error state.
  const reviewed = context.model.preview
    ? { ...context, matcher: context.model.preview.matcher }
    : context;
  return context.model.results
    ? resultSections(reviewed, context.model.results)
    : reviewSections(reviewed);
}

/** The result row that replaces the list header after Apply (lab RP1 D): what happened, and Undo all. */
export function ReplaceResultSummary({
  model,
  machineLabel,
  onLeaveForApproval,
}: Readonly<{ model: WorkspaceReplaceModel; machineLabel: string; onLeaveForApproval?: () => void }>) {
  const { theme } = useUnistyles();
  // Waiting replaces nothing on screen: the review (or its result, for Undo) stays where it was, and this
  // line sits where the result will land. A preview that has nothing on screen yet waits in the list.
  const waiting = model.approval?.status === 'waiting' && (model.preview || model.results) ? model.approval : null;
  const approvalLine = waiting
    ? <ReplaceApprovalLine approval={waiting} files={model.totals.selectedFiles} onLeave={onLeaveForApproval} />
    : null;
  if (!model.results && !model.applyError) {
    return approvalLine ? (
      <View style={{ paddingTop: theme.space.s4 }}>{approvalLine}</View>
    ) : null;
  }
  if (!model.results) {
    const declined = model.applyError === 'declined';
    return (
      <View
        style={{
          paddingTop: theme.space.s4,
        }}
      >
        <QuietLine
          icon={declined ? 'info' : 'warning'}
          tone={declined ? 'secondary' : 'danger'}
          label={
            declined
              ? t('universalSearch.replace.replaceDeclined')
              : model.applyError === 'outcome_unknown'
                ? t('universalSearch.replace.outcomeUnknown', {
                    machine: machineLabel,
                  })
                : t('universalSearch.replace.applyFailed', {
                    machine: machineLabel,
                  })
          }
        />
      </View>
    );
  }
  // An Undo that didn't finish says why under the result it would have changed.
  const undoNote = model.applyError === 'declined'
    ? <QuietLine icon="info" label={t('universalSearch.replace.undoDeclined')} />
    : model.applyError === 'outcome_unknown'
      ? <QuietLine icon="warning" tone="danger" label={t('universalSearch.replace.outcomeUnknown', { machine: machineLabel })} />
      // Refused before writing: nothing ran, so the result and its Undo stay as they were.
      : model.applyError === 'unavailable'
        ? <QuietLine icon="warning" tone="danger" label={t('universalSearch.replace.undoDidntRun', { machine: machineLabel })} />
        : model.applyError
          ? <QuietLine icon="warning" tone="danger" label={t('universalSearch.replace.undoFailed', { machine: machineLabel })} />
          : null;
  const summary = summarizeReplaceResults(model.results);
  const allUndone = summary.replacedFiles === 0 && summary.restored > 0;
  const title = allUndone
    ? t('universalSearch.replace.undoneTitle')
    : summary.replacedFiles > 0
      ? t('universalSearch.replace.replacedTitle', {
          matches: summary.replacedMatches,
          files: summary.replacedFiles,
        })
      : t('universalSearch.replace.nothingReplaced');
  const details = [
    summary.changed > 0
      ? t('universalSearch.replace.summaryChanged', { count: summary.changed })
      : null,
    summary.failed > 0
      ? t('universalSearch.replace.summaryFailed', { count: summary.failed })
      : null,
    summary.skipped > 0
      ? t('universalSearch.replace.summarySkipped', { count: summary.skipped })
      : null,
    summary.cancelled > 0
      ? t('universalSearch.replace.summaryCancelled', {
          count: summary.cancelled,
        })
      : null,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <View
      style={{ paddingTop: theme.space.s4 }}
    >
      <View
        testID="replace-result-summary"
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space.s12,
          paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx,
          paddingVertical: theme.space.s10,
          borderRadius: HAPPIER_RADIUS_V1.sm,
          backgroundColor: theme.colors.surface.selected,
        }}
      >
        <Icon
          name={
            summary.failed > 0 && summary.replacedFiles === 0
              ? 'x-circle'
              : 'check-circle'
          }
          size={ICON_SIZE.md}
          color={
            summary.failed > 0 && summary.replacedFiles === 0
              ? theme.colors.state.danger.foreground
              : theme.colors.text.primary
          }
        />
        <View style={{ flex: 1, minWidth: 0, gap: theme.space.s2 }}>
          <Text
            style={[
              Typography.variant('label', 'semiBold'),
              Typography.tabular(),
              { color: theme.colors.text.primary },
            ]}
          >
            {title}
          </Text>
          {details ? (
            <Text
              style={[
                Typography.variant('meta'),
                { color: theme.colors.text.secondary },
              ]}
            >
              {details}
            </Text>
          ) : null}
        </View>
        {(model.canUndo || model.undoing) && !waiting ? (
          <RoundButton
            size="small"
            display="secondary"
            title={t('universalSearch.replace.undoAll')}
            leading={
              <Icon
                name="arrow-arc-left"
                size={ICON_SIZE.sm}
                color={theme.colors.text.primary}
              />
            }
            loading={model.undoing}
            onPress={() => {
              void model.undo();
            }}
            testID="replace-undo-all"
          />
        ) : null}
      </View>
      {undoNote}
      {approvalLine}
    </View>
  );
}

/** The footer's one action: Replace in N files while reviewing, Stop while applying, Done after. */
export function ReplaceFooterAction({
  model,
  onDone,
  compact,
}: Readonly<{
  model: WorkspaceReplaceModel;
  onDone: () => void;
  compact: boolean;
}>) {
  const { theme } = useUnistyles();
  if (model.results) {
    return (
      <RoundButton
        size="small"
        display="secondary"
        title={t('universalSearch.replace.done')}
        onPress={onDone}
        testID="replace-done"
      />
    );
  }
  const files = model.totals.selectedFiles;
  // While an approval is pending the header line says so; the footer neither spins nor offers Stop.
  const waiting = model.approval?.status === 'waiting';
  const applying = model.applying && !waiting;
  const status = waiting
    ? null
    : applying
    ? t('universalSearch.replace.applying', { files })
    : model.loading || model.stale
      ? t('universalSearch.replace.updating')
      : compact
        ? t('universalSearch.replace.matchesInFiles', {
            matches: model.totals.selectedMatches,
            files,
          })
        : null;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
        ...(compact ? { flex: 1 } : {}),
      }}
    >
      {status ? (
        <Text
          numberOfLines={1}
          style={[
            Typography.variant('meta'),
            Typography.tabular(),
            {
              flex: compact ? 1 : undefined,
              color: theme.colors.text.secondary,
            },
          ]}
        >
          {status}
        </Text>
      ) : null}
      {applying ? (
        <RoundButton
          size="small"
          display="secondary"
          title={t('universalSearch.replace.stop')}
          onPress={model.cancelApply}
          testID="replace-stop"
        />
      ) : null}
      {!compact && !model.applying ? <KeyboardCommandHint commandId="search.replace.apply" /> : null}
      <RoundButton
        size="small"
        title={t('universalSearch.replace.apply', {
          files: Math.max(files, 0),
        })}
        disabled={!model.canApply}
        loading={applying}
        onPress={() => {
          void model.apply();
        }}
        testID="replace-apply"
      />
    </View>
  );
}

/** "Replace with" under the query (lab RP1): the chevron folds it away again. */
export function ReplaceField({
  value,
  onChangeText,
  onHide,
  autoFocus,
}: Readonly<{
  value: string;
  onChangeText: (value: string) => void;
  onHide: () => void;
  /** Opened from its toggle: the person is about to type the replacement. */
  autoFocus: boolean;
}>) {
  const { theme } = useUnistyles();
  return (
    <View
      testID="universal-search:replace-field"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
      }}
    >
      <IconButton
        testID="universal-search:replace-hide"
        variant="plain"
        icon={
          <Icon
            name="caret-down"
            size={ICON_SIZE.sm}
            color={theme.colors.text.tertiary}
          />
        }
        accessibilityLabel={t('universalSearch.replace.hide')}
        tooltip={t('universalSearch.replace.hide')}
        onPress={onHide}
      />
      <Text
        style={[
          Typography.variant('body'),
          { color: theme.colors.text.tertiary },
        ]}
      >
        {t('universalSearch.replace.field')}
      </Text>
      <TextInput
        testID="universal-search:replace-input"
        value={value}
        onChangeText={onChangeText}
        accessibilityLabel={t('universalSearch.replace.field')}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoFocus={autoFocus}
        style={[
          Typography.variant('body'),
          Typography.mono(),
          {
            flex: 1,
            minWidth: 0,
            paddingVertical: 0,
            color: theme.colors.input.text,
          },
        ]}
      />
    </View>
  );
}
