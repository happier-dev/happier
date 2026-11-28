import * as React from 'react';
import { machineServiceLogReadFailureReason } from './machineServicesPresentation';
import { Platform, View } from 'react-native';
import Reanimated, { FadeIn, withTiming } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { LogLine } from '@happier-dev/plugin-ui';
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
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useFindSurfaceRegistration } from '@/keyboard/KeyboardShortcutProvider';
import { isFindSurfaceTarget } from '@/keyboard/findSurfaceTarget';
import { t } from '@/text';
import { isSameActionInputOptionValue } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import type { MachineRecipeReferenceV1 } from '@happier-dev/protocol/machines/setup/machineRecipeReferenceV1';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useMachineSetupRecipeOptions } from '@/components/store/catalog/storeSoftware';
import { buildStoreListingRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { describeActionExecutionPrerequisite, presentActionExecutionFailure, resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';

import { useServiceOccurrenceLogViewer, type useNativeLogViewer } from './useMachineServiceLogViewer';

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
 * once (`machines.services.logs.read`); the canonical Resource follows from there.
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
  const { service, ...presentation } = props;
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
  return <ServiceOccurrenceLogs {...presentation} serviceId={service.serviceId} name={service.name}
    expectedGeneration={service.generation} />;
}

export function ServiceOccurrenceLogs(props: Readonly<{
  serverId: string;
  machineId: string;
  machineName: string;
  serviceId: string;
  expectedGeneration: string;
  name: string;
  active: boolean;
  onOpenEnvironment?: (() => void) | null;
}>) {
  const { machineName } = props;
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
  const logs = useServiceOccurrenceLogViewer({
    serverId: props.serverId,
    machineId: props.machineId,
    serviceId: props.serviceId,
    expectedGeneration: props.expectedGeneration,
    name: props.name,
    active: props.active,
    view,
    surfaceId: `machine-service-logs:${props.machineId}:${props.serviceId}`,
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

  const projection = logs.projection;
  if (projection?.kind === 'unavailable') {
    return (
      <UnavailableLogs
        reason={projection.reason}
        machineName={machineName}
        code={projection.reason}
        recipeRemedy={projection.recipeRemedy ? { serverId: props.serverId, machineId: props.machineId,
          ref: projection.recipeRemedy, presented: props.active } : null}
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
      const { code, message: _privateError, ...metadata } = first.error;
      const diagnosticDetail = presentActionExecutionFailure({ ...metadata, ok: false, errorCode: code },
        undefined, { closedCodesOnly: true }).technicalDetails.filter(line => line.key !== 'code')
        .map(line => line.label + ': ' + line.value).join('\n');
      const unavailable = ManagedServiceUnavailableReasonV1Schema.safeParse(
        ADMISSION_CODES.has(first.error.code) ? 'admission_unavailable' : first.error.code,
      );
      if (unavailable.success)
        return (
          <UnavailableLogs
            reason={unavailable.data}
            machineName={machineName}
            code={code}
            details={first.error.details}
            diagnosticDetail={diagnosticDetail}
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
          diagnosticCode={code}
          diagnosticDetail={diagnosticDetail}
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
    /**
     * A live band of the newest lines only (the Environment's deploy card, lab siaR3 Q8): that many lines, no scroll,
     * the oldest one quieter, the newest rising into place as it arrives. The whole log stays one press away.
     */
    tail?: number;
  }>,
) {
  if (props.tail !== undefined) return <NativeLogTail testID={props.testID} lines={props.lines} count={props.tail} />;
  return <NativeLogScroller {...props} />;
}

function NativeLogScroller(
  props: Readonly<{
    testID: string;
    lines: readonly ForgeCiLogLineV1[];
    getLineRanges: (lineId: string) => readonly FindTextRange[];
    revealedLine: number | null;
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
    <NativeLogLine line={item} digits={digits} ranges={getLineRanges(item.id)} revealed={revealedLine === item.number} />
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
const NO_RANGES: readonly FindTextRange[] = [];

/** The newest `count` lines, drawn as the scroller draws them; a line that arrives after the first paint rises 4 px. */
function NativeLogTail(props: Readonly<{ testID: string; lines: readonly ForgeCiLogLineV1[]; count: number }>) {
  const reducedMotion = useReducedMotionPreference();
  const shown = props.lines.slice(-props.count);
  const digits = String(props.lines[props.lines.length - 1]?.number ?? 1).length;
  // Lines present at the first paint simply show; only later arrivals move.
  const firstIds = React.useRef<ReadonlySet<string> | null>(null);
  if (firstIds.current === null) firstIds.current = new Set(shown.map(logLineKey));
  return (
    <CorePluginUiPresentationScope>
    <View testID={props.testID} style={styles.tail}>
      {shown.map((line, index) => (
        <Reanimated.View key={line.id} style={index === 0 && shown.length === props.count ? styles.tailOldest : null}
          entering={firstIds.current!.has(line.id) ? undefined : reducedMotion
            ? FadeIn.duration(motionTokens.inPlaceMorph.reducedCrossFadeMs) : logLineRise}>
          <LogLine style={styles.tailLine} gutter={{ value: String(line.number), minChars: digits }}
            message={{ tokens: line.tokens, plainText: line.plainText, ranges: NO_RANGES }} />
        </Reanimated.View>
      ))}
    </View>
    </CorePluginUiPresentationScope>
  );
}

/** The newest line rises 4 px as it fades in (lab siaR3 `r3-log`), on the owner's fast duration and standard curve. */
function logLineRise() {
  'worklet';
  return {
    initialValues: { opacity: 0, transform: [{ translateY: 4 }] },
    animations: {
      opacity: withTiming(1, { duration: motionTokens.durationMs.fast, easing: reanimatedMotionTokens.easing.standard }),
      transform: [{ translateY: withTiming(0, { duration: motionTokens.durationMs.fast, easing: reanimatedMotionTokens.easing.standard }) }],
    },
  };
}

/** One row per admitted line; an unchanged line keeps its row through a followed page. */
const NativeLogLine = React.memo(function NativeLogLine(
  props: Readonly<{
    line: ForgeCiLogLineV1;
    digits: number;
    ranges: readonly FindTextRange[];
    revealed: boolean;
  }>,
) {
  return (
    <LogLine
      style={[styles.line, props.revealed ? styles.revealed : null]}
      gutter={{ value: String(props.line.number), minChars: props.digits }}
      message={{ tokens: props.line.tokens, plainText: props.line.plainText, ranges: props.ranges }}
    />
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
    diagnosticDetail?: string;
    onOpenEnvironment?: (() => void) | null;
    /** The source's named recipe that would let it read; its Store listing on this Machine owns inputs and review. */
    recipeRemedy?: LogRecipeRemedyInput | null;
  }>,
) {
  const remedy = useLogRecipeRemedy(props.recipeRemedy ?? null, props.machineName);
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
      reason={redeploy ? t('machineServices.logs.remedy.redeployEnvironment') : remedy?.reason}
      {...(redeploy && props.onOpenEnvironment ? { action: { label: t('machineServices.groups.openEnvironment'),
        onPress: props.onOpenEnvironment, testID: 'machine-service-logs-open-environment' } }
        : remedy ? { action: remedy.action } : {})}
      diagnosticCode={props.code}
      diagnosticDetail={props.diagnosticDetail}
    />
  );
}

type LogRecipeRemedyInput = Readonly<{ serverId: string; machineId: string; ref: MachineRecipeReferenceV1; presented: boolean }>;

/**
 * A refused read that names its recipe (the journal reader for a refused journal) leads to that recipe's Store listing
 * on this Machine, the same door Setup's Add recipe opens: the listing asks for its inputs and runs the one review.
 * Its name comes from the Account's recipe declarations, read only while this state is shown.
 */
function useLogRecipeRemedy(input: LogRecipeRemedyInput | null, machineName: string) {
  const router = useRouter();
  const { binding } = useServerCredentialAccountScopeBinding(input?.serverId);
  const homeId = input ? getServerProfileById(input.serverId)?.serverIdentityId ?? null : null;
  const machineId = input?.machineId;
  const target = React.useMemo(() => binding && homeId && machineId
    ? { scope: binding.scope, machine: { serverIdentityId: homeId, machineId } } : null, [binding, homeId, machineId]);
  const demand = React.useMemo(() => ({ presented: input?.presented === true }), [input?.presented]);
  const recipes = useMachineSetupRecipeOptions(input ? target : null, demand);
  if (!input) return null;
  const recipe = recipes.state.options.find(option => isSameActionInputOptionValue(option.value, input.ref))?.label;
  return {
    reason: recipe ? t('machineServices.logs.remedy.recipe', { recipe, machine: machineName })
      : t('machineServices.logs.remedy.recipeUnnamed', { machine: machineName }),
    action: { label: t('managedMachines.add.action.setUp'), testID: 'machine-service-logs-set-up-recipe',
      disabled: target === null,
      onPress: () => { if (target) router.push(buildStoreListingRoute({ type: 'software', value: input.ref, target }) as never); } },
  };
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
    paddingHorizontal: theme.space.s12,
  },
  tail: {
    minWidth: 0,
  },
  tailLine: {
    paddingHorizontal: 0,
  },
  // The band's top fades into the card: the oldest line it holds is quieter than the rest.
  tailOldest: {
    opacity: 0.55,
  },
  revealed: {
    backgroundColor: theme.colors.surface.selected,
  },
  note: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
}));
