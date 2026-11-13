import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { PluginUiHostReadReferenceV1 } from '@happier-dev/protocol/plugins/ui/client';

import { createNativeLogView, isNativeLogBlank, NativeLogLines } from '@/components/machines/services/MachineServiceLogs';
import { NativeLogToolbar } from '@/components/machines/services/NativeLogToolbar';
import { useNativeLogViewer } from '@/components/machines/services/useMachineServiceLogViewer';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { useFindSurfaceRegistration } from '@/keyboard/KeyboardShortcutProvider';
import { isFindSurfaceTarget } from '@/keyboard/findSurfaceTarget';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { describeActionExecutionPrerequisite, resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';

const FIRST = Object.freeze({ kind: 'idle' as const });
const readFirst = async () => {};

/** Platform runtime acquisition uses the canonical Resource; Forge owns its native log presentation. */
export function DeploymentRuntimeLogs(props: Readonly<{
  serverId: string;
  reference: Extract<PluginUiHostReadReferenceV1, { hostRead: 'deployments.logs' }>;
  active: boolean;
}>) {
  const { theme } = useUnistyles();
  const { binding: lifetime } = useServerCredentialAccountScopeBinding(props.serverId);
  const [view] = React.useState(createNativeLogView);
  const root = React.useRef<View>(null);
  const inputFocused = React.useRef(false);
  const containsFocus = React.useCallback(() => {
    if (Platform.OS !== 'web') return true;
    const node = root.current as unknown as HTMLElement | null;
    return Boolean(node && typeof document !== 'undefined' && document.activeElement && node.contains(document.activeElement));
  }, []);
  const isInputFocused = React.useCallback(() => inputFocused.current, []);
  const sourceKey = JSON.stringify([lifetime?.scope.accountId ?? null, props.reference]);
  const logs = useNativeLogViewer({ first: FIRST, read: readFirst, accountLifetime: lifetime,
    reference: props.reference, sourceKey, active: props.active, fileName: 'runtime.log', view,
    surfaceId: `deployment-runtime-log:${sourceKey}`, containsFocus, isInputFocused });
  const { viewer, projection } = logs;
  const shared = viewer?.findRegistration ?? null;
  const registration = React.useMemo(() => shared ? { ...shared,
    containsTarget: (target: unknown) => isFindSurfaceTarget(root.current as unknown as Element | null, target),
  } : null, [shared]);
  useFindSurfaceRegistration(registration);
  const error = logs.first.kind === 'failed' ? logs.first.error : logs.followed?.error;
  const title = t('machineServices.logs.error.title');
  const reason = resolveActionExecutionErrorMessage(error, title, { safeToRetry: true });
  const retry = () => { void logs.readAgain(); };
  return (
    <View ref={root} style={styles.logs} testID="deployment-runtime-logs">
      <NativeLogToolbar testID="deployment-runtime-logs-toolbar" viewer={viewer}
        findOpen={viewer?.findSnapshot.isOpen === true && props.active}
        partTestID={(part) => `deployment-runtime-logs-${part}`} inputFocused={inputFocused}
        follow={{ on: logs.follow, toggle: () => logs.setFollow(value => !value) }} navigation={logs.navigation}
        copyDisabled={!logs.index} saveDisabled={!logs.index}
        onCopy={() => { void logs.copyLoaded(); }} onSave={() => { void logs.exportLoaded(); }} />
      {logs.stale && logs.index ? (
        <SurfaceFreshnessLine testID="deployment-runtime-logs-stale" asOf={null} tone="warning"
          reason={resolveActionExecutionErrorMessage(error, t('machineServices.logs.truncated'), { safeToRetry: true })}
          busy={logs.followed?.pending !== undefined && logs.followed.pending !== 'idle'}
          action={describeActionExecutionPrerequisite(error?.code) ? undefined : { label: t('common.retry'), onPress: retry }} />
      ) : error || projection?.kind === 'unavailable' || projection?.kind === 'sourceChanged' ? (
        <SurfaceStateCard testID="deployment-runtime-logs-error" kind="error" size="line" title={title}
          reason={reason === title ? undefined : reason} diagnosticCode={error?.code ?? (projection?.kind === 'unavailable' ? projection.reason : undefined)}
          action={describeActionExecutionPrerequisite(error?.code) ? undefined : { label: t('common.retry'), onPress: retry }} />
      ) : null}
      {!logs.index || !viewer ? (
        error || projection?.kind === 'unavailable' || projection?.kind === 'sourceChanged' ? null : (
          <SurfaceStateCard testID="deployment-runtime-logs-reading" kind="loading" size="line" title={t('machineServices.logs.reading')} />
        )
      ) : isNativeLogBlank(viewer.lines) ? (
        <SurfaceStateCard testID="deployment-runtime-logs-empty" kind="empty" size="line" title={t('machineServices.logs.empty')} />
      ) : <NativeLogLines testID="deployment-runtime-logs-lines" lines={viewer.lines}
        getLineRanges={viewer.getLineRanges} revealedLine={viewer.viewState?.revealedLine ?? null} navigation={logs.navigation} />}
      {projection?.kind === 'index' && projection.truncated ? (
        <Text variant="meta" testID="deployment-runtime-logs-truncated" style={{ color: theme.colors.text.secondary }}>
          {t('machineServices.logs.truncated')}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create(theme => ({ logs: { gap: theme.space.s8 } }));
