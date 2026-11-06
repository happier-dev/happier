import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { AnsiText } from '@happier-dev/plugin-ui';
import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';
import type {
  MachineServiceRowV1,
  ManagedServiceUnavailableReasonV1,
} from '@happier-dev/protocol';
import type { ForgeCiLogLineV1 } from '@happier-dev/forge-ci/runtime';
import type { LogViewerControlsV1 } from '@happier-dev/forge-ci/ui';

import { CorePluginUiPresentationScope } from '@/components/plugins/surfaces/CorePluginUiPresentationScope';
import { NativeLogToolbar } from './NativeLogToolbar';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useFindSurfaceRegistration } from '@/keyboard/KeyboardShortcutProvider';
import { isFindSurfaceTarget } from '@/keyboard/findSurfaceTarget';
import { t } from '@/text';

import { useMachineServiceLogViewer } from './useMachineServiceLogViewer';

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
      if (ADMISSION_CODES.has(first.error.code))
        return (
          <UnavailableLogs
            reason="admission_unavailable"
            machineName={machineName}
            code={first.error.code}
          />
        );
      return (
        <SurfaceStateCard
          testID="machine-service-logs-error"
          kind="error"
          title={t('machineServices.logs.error.title')}
          reason={t('machineServices.logs.error.body', {
            machine: machineName,
          })}
          diagnosticCode={first.error.code}
          action={{
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
        onCopy={() => {
          void logs.copyLoaded();
        }}
        onSave={() => {
          void logs.exportLoaded();
        }}
      />
      {projection?.kind === 'index' && projection.secretMasking ? (
        <Text variant="meta" testID="machine-service-logs-masking" style={{ color: theme.colors.state.warning.foreground }}>
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
          reason={t('machineServices.logs.stale', { machine: machineName })}
          busy={
            logs.followed?.pending !== undefined &&
            logs.followed.pending !== 'idle'
          }
          action={{
            label: t('common.retry'),
            onPress: () => {
              void logs.followed?.refresh();
            },
          }}
        />
      ) : null}
      {viewer.lines.length === 0 ? (
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
        />
      )}
      {/* The section's description already says secret values are redacted; only a cut-off page adds a note. */}
      {truncated ? (
        <Text style={styles.note} testID="machine-service-logs-truncated">
          {t('machineServices.logs.truncated')}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The admitted lines on the log's inset band: a quiet number column, then the line as the program wrote it.
 * Every native log (a Machine service, a deployment step) shows its lines through this one band.
 */
export function NativeLogLines(
  props: Readonly<{
    testID: string;
    lines: readonly ForgeCiLogLineV1[];
    getLineRanges: (lineId: string) => readonly FindTextRange[];
    revealedLine: number | null;
  }>,
) {
  const digits = String(
    props.lines[props.lines.length - 1]?.number ?? 1,
  ).length;
  return (
    <CorePluginUiPresentationScope>
      <View style={styles.block} testID={props.testID}>
        {props.lines.map((line) => (
          <LogLine
            key={line.id}
            line={line}
            digits={digits}
            ranges={props.getLineRanges(line.id)}
            revealed={props.revealedLine === line.number}
          />
        ))}
      </View>
    </CorePluginUiPresentationScope>
  );
}

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
  }>,
) {
  return (
    <SurfaceStateCard
      testID={`machine-service-logs-unavailable-${props.reason}`}
      kind={props.reason === 'denied' ? 'denied' : 'unavailable'}
      title={t(`machineServices.logs.unavailable.${props.reason}`, {
        machine: props.machineName,
      })}
      diagnosticCode={props.code}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  logs: {
    gap: theme.space.s8,
  },
  block: {
    paddingVertical: theme.space.s8,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface.inset,
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
