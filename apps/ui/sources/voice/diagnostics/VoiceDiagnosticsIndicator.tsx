import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '@happier-dev/plugin-ui/environment';
import { useHappierHitArea } from '@happier-dev/plugin-ui/presentation';
import { Text } from '@/components/ui/text/Text';
import {
  restoreFocusToBestTarget,
  type FocusReturnRef,
  type FocusReturnTarget,
} from '@/keyboard/focusReturn';
import { useSetting } from '@/sync/domains/state/storage';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { tLoose } from '@/text';
import { Modal } from '@/modal';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { presentActionTurnedOffNoticeIfOff } from '@/sync/ops/actions/actionTurnedOffNotice';
import { SettingsDeclarationActionOutputSchemasV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { VOICE_PRIVACY_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';
import { resolveActionSurfaceAvailability } from '@happier-dev/protocol/actions/actionSurfaceAvailability';
import { useSettingsSelector } from '@/sync/store/settingsReadHooks';

import {
  isVoiceDiagnosticsSessionCaptureAllowed,
} from './capturePolicy';
import {
  useVoiceDiagnosticsRuntimeStatus,
} from './runtimeStatus';

// The action draws at the WCAG 2.2 pointer floor under every pointer; a finger reaches past it through the hit area.
const minimumInteractiveTargetSize = HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE;
const actionRestingSize = { minWidth: minimumInteractiveTargetSize, minHeight: minimumInteractiveTargetSize };

function isCurrentWebFocusTarget(target: FocusReturnTarget): boolean {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return false;
  const activeElement: unknown = document.activeElement;
  return activeElement === target;
}

function DiagnosticsActionAnchor(props: Readonly<{
  wrap?: (action: React.ReactElement, operation: 'retry_shutdown' | 'session_opt_out') => React.ReactElement;
  shutdown: boolean;
  children: React.ReactElement;
}>) {
  return props.wrap?.(props.children, props.shutdown ? 'retry_shutdown' : 'session_opt_out') ?? props.children;
}

export function VoiceDiagnosticsIndicator(props: Readonly<{
  focusFallbackRef?: FocusReturnRef;
  sessionId?: string | null;
  wrapAction?: (action: React.ReactElement, operation: 'retry_shutdown' | 'session_opt_out') => React.ReactElement;
}>) {
  const { theme } = useUnistyles();
  const actionHitArea = useHappierHitArea({ restingStyle: () => actionRestingSize });
  const rawVoice = useSetting('voice');
  const diagnostics = voiceSettingsParse(rawVoice).diagnostics;
  const runtimeStatus = useVoiceDiagnosticsRuntimeStatus();
  const persistenceScope = useActiveServerAccountScope();
  const { execute } = useMountedActionExecution(persistenceScope);
  const actionAvailable = useSettingsSelector(settings => resolveActionSurfaceAvailability({
    actionId: 'settings.invoke', surface: 'ui', settings: settings.actionsSettingsV1,
  }).available, ['actionsSettingsV1']);
  const [sessionAllowed, setSessionAllowed] = React.useState(() =>
    isVoiceDiagnosticsSessionCaptureAllowed(props.sessionId),
  );
  const actionInFlightRef = React.useRef(false);
  const actionRef = React.useRef<FocusReturnTarget>(null);
  const focusedActionTargetRef = React.useRef<FocusReturnTarget>(null);
  const focusLostOnActionRemovalRef = React.useRef(false);
  const currentSessionIdRef = React.useRef(props.sessionId);
  const mountedRef = React.useRef(true);
  currentSessionIdRef.current = props.sessionId;
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  React.useEffect(() => {
    setSessionAllowed(isVoiceDiagnosticsSessionCaptureAllowed(props.sessionId));
  }, [props.sessionId]);
  const sessionCaptureAllowed = sessionAllowed && isVoiceDiagnosticsSessionCaptureAllowed(props.sessionId);

  const obligation = React.useMemo(() => {
    const matchingSession = props.sessionId
      ? runtimeStatus.revocationObligations.find((candidate) => (
        candidate.target.kind === 'session_authorization'
        && candidate.target.sessionId === props.sessionId
      ))
      : null;
    return matchingSession
      ?? runtimeStatus.revocationObligations.find((candidate) => candidate.status === 'failed')
      ?? runtimeStatus.revocationObligations[0]
      ?? null;
  }, [props.sessionId, runtimeStatus.revocationObligations]);
  const explicitConsent = diagnostics.enabled && diagnostics.consentVersion === 1;
  const runtimeMayCapture = runtimeStatus.phase !== 'inactive_confirmed';
  const activeForSession = explicitConsent && runtimeMayCapture && (!props.sessionId || sessionCaptureAllowed);
  const canStartSessionOptOut = Boolean(props.sessionId && runtimeStatus.machineId && runtimeMayCapture);
  const showsAction = Boolean(obligation || canStartSessionOptOut);
  const restoreAcknowledgedFocus = React.useCallback(() => {
    const focusedActionTarget = focusedActionTargetRef.current;
    const focusWasLostOnRemoval = focusLostOnActionRemovalRef.current;
    focusedActionTargetRef.current = null;
    focusLostOnActionRemovalRef.current = false;
    if (!mountedRef.current) {
      return;
    }
    if (!focusWasLostOnRemoval && !isCurrentWebFocusTarget(focusedActionTarget)) {
      return;
    }
    restoreFocusToBestTarget(undefined, props.focusFallbackRef);
  }, [props.focusFallbackRef]);
  React.useLayoutEffect(() => {
    const focusedActionTarget = focusedActionTargetRef.current;
    if (!focusedActionTarget || actionRef.current === focusedActionTarget) {
      return;
    }
    if (Platform.OS !== 'web' || typeof document === 'undefined') {
      focusedActionTargetRef.current = null;
      focusLostOnActionRemovalRef.current = false;
      return;
    }
    const activeElement: unknown = document.activeElement;
    if (activeElement === focusedActionTarget || activeElement === document.body) {
      focusLostOnActionRemovalRef.current = true;
      return;
    }
    focusedActionTargetRef.current = null;
    focusLostOnActionRemovalRef.current = false;
  });
  if (!obligation && !activeForSession) return null;

  const indicatorKey = obligation
    ? obligation.status === 'failed'
      ? 'settingsVoice.diagnostics.shutdownFailedIndicator'
      : 'settingsVoice.diagnostics.shutdownPendingIndicator'
    : runtimeStatus.phase === 'active'
      ? 'settingsVoice.diagnostics.activeIndicator'
      : runtimeStatus.phase === 'transitioning'
        ? 'settingsVoice.diagnostics.checkingIndicator'
        : 'settingsVoice.diagnostics.statusUnknownIndicator';

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        flexWrap: 'wrap',
        gap: theme.space.s6,
        minHeight: 24,
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s8,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s6 }}>
        <View
          accessibilityElementsHidden
          style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.status.error }}
        />
        <Text style={{ color: theme.colors.text.secondary, fontSize: 12, flexShrink: 1 }}>
          {tLoose(indicatorKey)}
        </Text>
      </View>
      {showsAction ? (
        <DiagnosticsActionAnchor wrap={props.wrapAction} shutdown={Boolean(obligation)}>
        <Pressable
          ref={actionRef as any}
          accessibilityRole="button"
          accessibilityLabel={tLoose(obligation
            ? 'settingsVoice.diagnostics.retryShutdown'
            : 'settingsVoice.diagnostics.sessionOptOut')}
          disabled={obligation?.status === 'pending' || !actionAvailable}
          accessibilityState={{ disabled: obligation?.status === 'pending' || !actionAvailable }}
          hitSlop={actionHitArea.hitSlop}
          onLayout={actionHitArea.onLayout}
          style={{
            minWidth: minimumInteractiveTargetSize,
            minHeight: minimumInteractiveTargetSize,
            alignSelf: 'flex-start',
            maxWidth: '100%',
            justifyContent: 'center',
            paddingHorizontal: theme.space.s6,
          }}
          onPress={() => {
              if (actionInFlightRef.current) return;
              actionInFlightRef.current = true;
              focusedActionTargetRef.current = isCurrentWebFocusTarget(actionRef.current)
                ? actionRef.current
                : null;
              focusLostOnActionRemovalRef.current = false;
              void (async () => {
                try {
                  const targetSessionId = obligation?.target.kind === 'session_authorization'
                    ? obligation.target.sessionId : props.sessionId;
                  const targetMachineId = runtimeStatus.machineId;
                  if (!obligation && (!targetSessionId || !targetMachineId)) return;
                  const outcome = await execute('settings.invoke', obligation ? {
                    anchor: VOICE_PRIVACY_SETTINGS.settings.diagnosticsRetryShutdown.anchor,
                    input: { kind: 'diagnostics_revocation', key: obligation.key, revision: obligation.revision },
                  } : {
                    anchor: VOICE_PRIVACY_SETTINGS.settings.diagnosticsSessionOptOut.anchor,
                    input: { kind: 'diagnostics_session', sessionId: targetSessionId, machineId: targetMachineId },
                  });
                  if (!outcome.ok && presentActionTurnedOffNoticeIfOff(outcome, 'settings.invoke')) return;
                  if (!outcome.ok && isActionApprovalDeclinedErrorCode(outcome.errorCode)) return;
                  requireActionSuccess(outcome);
                  const result = SettingsDeclarationActionOutputSchemasV1['settings.invoke'].parse(outcome.result);
                  if (result.status === 'unavailable') throw new Error(result.reason ?? 'diagnostics_unavailable');
                  if (result.status !== 'completed') return;
                  restoreAcknowledgedFocus();
                  if ((!obligation || obligation.target.kind === 'session_authorization')
                    && mountedRef.current && currentSessionIdRef.current === targetSessionId) {
                    setSessionAllowed(false);
                  }
                } catch {
                  if (!mountedRef.current) return;
                  if (obligation) return;
                  await Modal.alert(
                    tLoose('common.error'),
                    tLoose('settingsVoice.diagnostics.sessionOptOutFailed'),
                  );
                } finally {
                  actionInFlightRef.current = false;
                  focusedActionTargetRef.current = null;
                  focusLostOnActionRemovalRef.current = false;
                }
              })();
          }}
        >
          {actionHitArea.frame}
          <Text style={{ color: theme.colors.text.secondary, fontSize: 11, flexShrink: 1, textDecorationLine: 'underline' }}>
            {tLoose(obligation
              ? 'common.retry'
              : 'settingsVoice.diagnostics.sessionOptOut')}
          </Text>
        </Pressable>
        </DiagnosticsActionAnchor>
      ) : null}
    </View>
  );
}
