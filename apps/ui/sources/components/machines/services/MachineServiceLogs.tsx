import * as React from 'react';
import { machineServiceLogReadFailureReason } from './machineServicesPresentation';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { AnsiText } from '@happier-dev/plugin-ui';
import { HAPPIER_PAGE_METRICS, type FindTextRange } from '@happier-dev/plugin-ui/presentation';
import type {
  MachineServiceRowV1,
  ManagedServiceUnavailableReasonV1,
} from '@happier-dev/protocol';
import { ManagedServiceUnavailableReasonV1Schema } from '@happier-dev/protocol/local/services/nativeLogsV1';
import type { ForgeCiLogLineV1 } from '@happier-dev/forge-ci/runtime';
import type { LogViewerControlsV1 } from '@happier-dev/forge-ci/ui';

import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import { VirtualizedList, type VirtualizedListRef } from '@/components/ui/lists/virtualized';
import { NativeLogToolbar } from './NativeLogToolbar';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useFindSurfaceRegistration } from '@/keyboard/KeyboardShortcutProvider';
import { isFindSurfaceTarget } from '@/keyboard/findSurfaceTarget';
import { t } from '@/text';
import { describeActionExecutionPrerequisite, resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';

import { useMachineServiceLogViewer, type useNativeLogViewer } from './useMachineServiceLogViewer';

/** The viewer model's tail state (SOS-GAP-LOGS): the viewport reports where the reader is, the model counts arrivals. */
export type NativeLogNavigation = Pick<ReturnType<typeof useNativeLogViewer>['navigation'], 'following' | 'setAtLatest' | 'newLineCount' | 'jumpToLatest'>;

/** Codes for a log read the Machine refused because this device's Account can't be admitted there yet. */
const ADMISSION_CODES = new Set([
  'service_admission_unavailable',
  'admission_unavailable',
]);

type LogViewState = NonNullable<
  ReturnType<LogViewerControlsV1['view']['getSnapshot']>
>;

/**
 * A native log's presentation state for the shared log viewer: which lines are shown and the line Find revealed.
 * Native logs (a Machine service, a deployment step) have no steps or groups, so only the shared operations apply.
 */
export function createNativeLogView(): LogViewerControlsV1['view'] {
  let state: LogViewState = {
    selection: { kind: 'all' },
    groupExpanded: {},
    revealedLine: null,
    timestampsVisible: true,
  };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    invoke(operation) {
      if (operation.kind === 'setSelection')
        state = { ...state, selection: operation.selection };
      else if (operation.kind === 'revealLine')
        state = { ...state, revealedLine: operation.line };
      else
        state = {
          ...state,
          groupExpanded: {
            ...state.groupExpanded,
            [operation.groupId]: operation.expanded,
          },
        };
      for (const listener of listeners) listener();
    },
  };
}

/**
 * A service's logs (lab `machine/services/detail` → Logs) in the shared log viewer: Find, copy and save work on the
 * admitted, redacted lines; Follow keeps reading while the page is shown. Opening the page asks for the latest lines
 * once (`machines.services.logs.read`); the canonical Resource follows from there (`useMachineServiceLogViewer`).
 * Last-known lines stay on screen through a stale or failing follow and through a source change.
 */
export function MachineServiceLogs(
  props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    service: MachineServiceRowV1;
    active: boolean;
    /** Opens the service's Environment, where its Deploy lives: the one action of a redeploy remedy. */
    onOpenEnvironment?: (() => void) | null;
  }>,
) {
  const { service, machineName } = props;
  const { theme } = useUnistyles();
  const [view] = React.useState(createNativeLogView);
  const root = React.useRef<View>(null);
  const inputFocused = React.useRef(false);
  const containsFocus = React.useCallback(() => {
    if (Platform.OS !== 'web') return true;
    const node = root.current as unknown as HTMLElement | null;
    return Boolean(
      node &&
      typeof document !== 'undefined' &&
      document.activeElement &&
      node.contains(document.activeElement),
    );
  }, []);
  const isInputFocused = React.useCallback(() => inputFocused.current, []);
  const logs = useMachineServiceLogViewer({
    serverId: props.serverId,
    machineId: props.machineId,
    service,
    active: props.active,
    view,
    surfaceId: `machine-service-logs:${props.machineId}:${service.serviceId}`,
    containsFocus,
    isInputFocused,
  });
  const viewer = logs.viewer;
  const shared = viewer?.findRegistration ?? null;
  const registration = React.useMemo(
    () =>
      shared
        ? {
            ...shared,
            containsTarget: (target: unknown) =>
              isFindSurfaceTarget(
                root.current as unknown as Element | null,
                target,
              ),
          }
        : null,
    [shared],
  );
  useFindSurfaceRegistration(registration);
  const findOpen = viewer?.findSnapshot.isOpen === true && props.active;

  if (!service.capabilities.logs || service.generation === null) {
    return (
      <SurfaceStateCard
        testID="machine-service-logs-none"
        kind="unavailable"
        size="line"
        title={t('machineServices.logs.none', { service: service.name })}
      />
    );
  }
  const projection = logs.projection;
  if (projection?.kind === 'unavailable') {
    return (
      <UnavailableLogs
        reason={projection.reason}
        machineName={machineName}
        code={projection.reason}
      />
    );
  }
  const first = logs.first;
  if (!logs.index || !viewer) {
    if (first.kind === 'approval') {
      return (
        <SurfaceStateCard
          testID="machine-service-logs-approval"
          kind="warning"
          size="line"
          title={t('machineServices.logs.approval')}
        />
      );
    }
    if (first.kind === 'failed') {
      const unavailable = ManagedServiceUnavailableReasonV1Schema.safeParse(
        ADMISSION_CODES.has(first.error.code) ? 'admission_unavailable' : first.error.code,
      );
      if (unavailable.success)
        return (
          <UnavailableLogs
            reason={unavailable.data}
            machineName={machineName}
            code={first.error.code}
            details={first.error.details}
            onOpenEnvironment={props.onOpenEnvironment ?? null}
          />
        );
      return (
        <SurfaceStateCard
          testID="machine-service-logs-error"
          kind="error"
          size="line"
          title={t('machineServices.logs.error.title')}
          reason={machineServiceLogReadFailureReason(first.error, machineName)}
          diagnosticCode={first.error.code}
          action={describeActionExecutionPrerequisite(first.error.code) ? undefined : {
            label: t('common.retry'),
            onPress: () => {
              void logs.readAgain();
            },
          }}
        />
      );
    }
    if (projection?.kind === 'sourceChanged')
      return <SourceChanged onReadAgain={logs.readAgain} />;
    return (
      <SurfaceStateCard
        testID="machine-service-logs-reading"
        kind="loading"
        size="line"
        title={t('machineServices.logs.reading')}
      />
    );
  }

  const truncated = projection?.kind === 'index' && projection.truncated;
  const readAt = first.kind === 'read' ? first.readAt : null;
  return (
    <View ref={root} style={styles.logs} testID="machine-service-logs">
      <NativeLogToolbar
        findOpen={findOpen}
        viewer={viewer}
        partTestID={(part) => `machine-service-logs-${part}`}
        inputFocused={inputFocused}
        follow={{ on: logs.follow, toggle: () => logs.setFollow((value) => !value) }}
        navigation={logs.navigation}
        onCopy={() => {
          void logs.copyLoaded();
        }}
        onSave={() => {
          void logs.exportLoaded();
        }}
      />
      {projection?.kind === 'index' && projection.secretMasking ? (
        <Text variant="meta" testID="machine-service-logs-masking" style={{ color: theme.colors.state.warning.textForeground }}>
          {t('machineServices.logs.maskingIncomplete')}
        </Text>
      ) : null}
      {projection?.kind === 'sourceChanged' ? (
        <SourceChanged onReadAgain={logs.readAgain} />
      ) : logs.stale ? (
        <SurfaceFreshnessLine
          testID="machine-service-logs-stale"
          asOf={readAt}
          tone="warning"
          reason={resolveActionExecutionErrorMessage(logs.followed?.error, t('machineDetailPage.security.staleFailed'), { safeToRetry: true })}
          busy={
            logs.followed?.pending !== undefined &&
            logs.followed.pending !== 'idle'
          }
          action={describeActionExecutionPrerequisite(logs.followed?.error?.code) ? undefined : {
            label: t('common.retry'),
            onPress: () => {
              void logs.followed?.refresh();
            },
          }}
        />
      ) : null}
      {isNativeLogBlank(viewer.lines) ? (
        <SurfaceStateCard
          testID="machine-service-logs-empty"
          kind="empty"
          size="line"
          title={t('machineServices.logs.empty')}
        />
      ) : (
        <NativeLogLines
          testID="machine-service-logs-lines"
          lines={viewer.lines}
          getLineRanges={viewer.getLineRanges}
          revealedLine={viewer.viewState?.revealedLine ?? null}
          navigation={logs.navigation}
        />
      )}
      {/* Only a cut-off page adds a note under the lines. */}
      {truncated ? (
        <Text style={styles.note} testID="machine-service-logs-truncated">
          {t('machineServices.logs.truncated')}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Whether a native log has nothing to show yet: no lines, or only blank ones (a program that has
 * printed nothing but line breaks). Every native log shows its empty state instead of numbered blanks.
 */
export function isNativeLogBlank(lines: readonly ForgeCiLogLineV1[]): boolean {
  return lines.every((line) => line.plainText.trim().length === 0);
}

/**
 * The admitted lines on the log's inset band: a quiet number column, then the line as the program wrote it.
 * Every native log (a Machine service, a deployment step) shows its lines through this one band: a bounded,
 * virtualized viewport (a long reading block's height) that keeps the newest line in view while following, holds
 * the reader's place when they scroll up (new lines still arrive and are counted by the viewer model) and scrolls
 * a revealed line (a Find hit, Jump to latest) into view.
 */
export function NativeLogLines(
  props: Readonly<{
    testID: string;
    lines: readonly ForgeCiLogLineV1[];
    getLineRanges: (lineId: string) => readonly FindTextRange[];
    revealedLine: number | null;
    /** Absent where the log never grows past its first read (a finished command): it only scrolls. */
    navigation?: NativeLogNavigation | null;
  }>,
) {
  const { theme } = useUnistyles();
  const { lines, getLineRanges, revealedLine } = props;
  const list = React.useRef<VirtualizedListRef>(null);
  const digits = String(lines[lines.length - 1]?.number ?? 1).length;
  const setAtLatest = props.navigation?.setAtLatest;
  const following = props.navigation ? props.navigation.following : true;
  const followingRef = React.useRef(following);
  followingRef.current = following;
  const linesRef = React.useRef(lines);
  linesRef.current = lines;
  // A following log opens on its newest line, so the list's first scroll report already reads "at latest".
  const initialScrollIndex = React.useRef(following && lines.length > 0 ? lines.length - 1 : undefined).current;
  const tolerance = theme.space.s8;
  const renderItem = React.useCallback(({ item }: { item: ForgeCiLogLineV1 }) => (
    <LogLine line={item} digits={digits} ranges={getLineRanges(item.id)} revealed={revealedLine === item.number} />
  ), [digits, getLineRanges, revealedLine]);
  // Where the reader is is the viewport's fact; whether lines are unseen is the viewer model's.
  const onScroll = React.useCallback((event: Readonly<{ nativeEvent: Readonly<{
    contentOffset: Readonly<{ y: number }>; layoutMeasurement: Readonly<{ height: number }>; contentSize: Readonly<{ height: number }>;
  }> }>) => {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    setAtLatest?.(contentOffset.y + layoutMeasurement.height >= contentSize.height - tolerance);
  }, [setAtLatest, tolerance]);
  const onContentSizeChange = React.useCallback(() => {
    if (followingRef.current) list.current?.scrollToEnd?.({ animated: false });
  }, []);
  // Back to following (Jump to latest, Follow) brings the newest line into view.
  React.useEffect(() => {
    if (following) list.current?.scrollToEnd?.({ animated: false });
  }, [following]);
  React.useEffect(() => {
    if (revealedLine === null) return;
    const index = linesRef.current.findIndex((line) => line.number === revealedLine);
    if (index >= 0) list.current?.scrollToIndex({ index, animated: false, viewPosition: 0.5 });
  }, [revealedLine]);
  return (
    <CorePluginUiPresentationScope>
      <VirtualizedList
        ref={list}
        testID={props.testID}
        data={lines}
        keyExtractor={logLineKey}
        renderItem={renderItem}
        style={styles.block}
        contentContainerStyle={styles.blockContent}
        initialScrollIndex={initialScrollIndex}
        maintainVisibleContentPosition
        scrollEventThrottle={16}
        onScroll={onScroll}
        onContentSizeChange={onContentSizeChange}
      />
    </CorePluginUiPresentationScope>
  );
}

const logLineKey = (line: ForgeCiLogLineV1) => line.id;

/** One row per admitted line; an unchanged line keeps its row through a followed page. */
const LogLine = React.memo(function LogLine(
  props: Readonly<{
    line: ForgeCiLogLineV1;
    digits: number;
    ranges: readonly FindTextRange[];
    revealed: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  return (
    <View style={[styles.line, props.revealed ? styles.revealed : null]}>
      <Text
        style={[styles.number, { minWidth: props.digits * theme.space.s8 }]}
      >
        {String(props.line.number)}
      </Text>
      <View style={styles.text}>
        <AnsiText
          tokens={props.line.tokens}
          plainText={props.line.plainText}
          ranges={props.ranges}
        />
      </View>
    </View>
  );
});

function SourceChanged(
  props: Readonly<{ onReadAgain: () => void | Promise<void> }>,
) {
  return (
    <SurfaceStateCard
      testID="machine-service-logs-restarted"
      kind="warning"
      size="line"
      title={t('machineServices.logs.restarted')}
      action={{
        label: t('machineServices.logs.readAgain'),
        onPress: () => {
          void props.onReadAgain();
        },
      }}
    />
  );
}

function UnavailableLogs(
  props: Readonly<{
    reason: ManagedServiceUnavailableReasonV1;
    machineName: string;
    code: string;
    details?: unknown;
    onOpenEnvironment?: (() => void) | null;
  }>,
) {
  const redeploy = props.reason === 'secret_redaction_unavailable'
    && props.details !== null && typeof props.details === 'object'
    && 'remedy' in props.details && props.details.remedy === 'redeploy_environment';
  return (
    <SurfaceStateCard
      testID={`machine-service-logs-unavailable-${props.reason}`}
      kind={props.reason === 'denied' ? 'denied' : 'unavailable'}
      size="line"
      title={t(`machineServices.logs.unavailable.${props.reason}`, {
        machine: props.machineName,
      })}
      reason={redeploy ? t('machineServices.logs.remedy.redeployEnvironment') : undefined}
      {...(redeploy && props.onOpenEnvironment ? { action: { label: t('machineServices.groups.openEnvironment'),
        onPress: props.onOpenEnvironment, testID: 'machine-service-logs-open-environment' } } : {})}
      diagnosticCode={props.code}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  logs: {
    gap: theme.space.s8,
  },
  block: {
    maxHeight: HAPPIER_PAGE_METRICS.readingClipHeightPx,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface.inset,
  },
  blockContent: {
    paddingVertical: theme.space.s8,
  },
  line: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s12,
    paddingHorizontal: theme.space.s12,
  },
  revealed: {
    backgroundColor: theme.colors.surface.selected,
  },
  number: {
    ...Typography.variant('meta'),
    ...Typography.mono(),
    ...Typography.tabular(),
    color: theme.colors.text.tertiary,
    textAlign: 'right',
  },
  text: {
    flex: 1,
    minWidth: 0,
  },
  note: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
}));
