import * as React from 'react';
import { AccessibilityInfo, Platform, Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
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

import {
  isVoiceDiagnosticsSessionCaptureAllowed,
  resolveVoiceDiagnosticsCaptureAuthorizationId,
  setVoiceDiagnosticsSessionCaptureAllowed,
} from './capturePolicy';
import {
  useVoiceDiagnosticsRuntimeStatus,
  type VoiceDiagnosticsRevocationObligation,
} from './runtimeStatus';
import {
  retryVoiceDiagnosticsRevocation,
  revokeVoiceDiagnosticsSessionAuthorization,
} from './runtimeRevocation';

const announcedIosFailures = new Map<string, VoiceDiagnosticsRevocationObligation>();
const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);

function isCurrentWebFocusTarget(target: FocusReturnTarget): boolean {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return false;
  const activeElement: unknown = document.activeElement;
  return activeElement === target;
}

export function VoiceDiagnosticsIndicator(props: Readonly<{
  focusFallbackRef?: FocusReturnRef;
  sessionId?: string | null;
}>) {
  const { theme } = useUnistyles();
  const rawVoice = useSetting('voice');
  const diagnostics = voiceSettingsParse(rawVoice).diagnostics;
  const runtimeStatus = useVoiceDiagnosticsRuntimeStatus();
  const persistenceScope = useActiveServerAccountScope();
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
  const activeForSession = explicitConsent && runtimeMayCapture && (!props.sessionId || sessionAllowed);
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
  React.useEffect(() => {
    const currentFailures = new Map<string, VoiceDiagnosticsRevocationObligation>(runtimeStatus.revocationObligations
      .filter((candidate) => candidate.status === 'failed')
      .map((candidate) => [`${candidate.key}:${candidate.revision}`, candidate] as const));
    for (const announcedId of announcedIosFailures.keys()) {
      if (!currentFailures.has(announcedId)) announcedIosFailures.delete(announcedId);
    }
    if (Platform.OS !== 'ios') return;
    for (const [announcementId, failure] of currentFailures) {
      if (announcedIosFailures.get(announcementId) === failure) continue;
      announcedIosFailures.set(announcementId, failure);
      AccessibilityInfo.announceForAccessibility(tLoose('settingsVoice.diagnostics.shutdownFailedIndicator'));
    }
  }, [runtimeStatus.revocationObligations]);
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
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 24 }}
    >
      <View
        accessibilityElementsHidden
        style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.status.error }}
      />
      <Text
        accessibilityLiveRegion={obligation?.status === 'failed' ? 'assertive' : undefined}
        accessibilityRole={obligation?.status === 'failed' ? 'alert' : undefined}
        style={{ color: theme.colors.text.secondary, fontSize: 12 }}
      >
        {tLoose(indicatorKey)}
      </Text>
      {showsAction ? (
        <>
          <Pressable
            ref={actionRef as any}
            accessibilityRole="button"
            accessibilityLabel={tLoose(obligation
              ? 'settingsVoice.diagnostics.retryShutdown'
              : 'settingsVoice.diagnostics.sessionOptOut')}
            disabled={obligation?.status === 'pending'}
            style={{
              minWidth: minimumInteractiveTargetSize,
              minHeight: minimumInteractiveTargetSize,
              justifyContent: 'center',
              paddingHorizontal: 6,
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
                  if (obligation) {
                    const result = await retryVoiceDiagnosticsRevocation({
                      obligation,
                      settings: diagnostics,
                      persistenceScope,
                    });
                    if (!result.ok) throw result.error;
                    if (!result.acknowledged) return;
                    restoreAcknowledgedFocus();
                    if (obligation.target.kind === 'session_authorization') {
                      const targetSessionId = obligation.target.sessionId;
                      setVoiceDiagnosticsSessionCaptureAllowed(targetSessionId, false);
                      if (mountedRef.current && currentSessionIdRef.current === targetSessionId) {
                        setSessionAllowed(false);
                      }
                    }
                    return;
                  }
                  const targetSessionId = props.sessionId;
                  const targetMachineId = runtimeStatus.machineId;
                  if (!targetSessionId || !targetMachineId) return;
                  const confirmed = await Modal.confirm(
                    tLoose('settingsVoice.diagnostics.sessionOptOutConfirmTitle'),
                    tLoose('settingsVoice.diagnostics.sessionOptOutConfirmBody'),
                    { confirmText: tLoose('settingsVoice.diagnostics.sessionOptOut') },
                  );
                  if (!confirmed) return;
                  const result = await revokeVoiceDiagnosticsSessionAuthorization({
                    machineId: targetMachineId,
                    sessionId: targetSessionId,
                    authorizationId: resolveVoiceDiagnosticsCaptureAuthorizationId(targetSessionId),
                  });
                  if (!result.ok) throw result.error;
                  if (!result.acknowledged) return;
                  restoreAcknowledgedFocus();
                  setVoiceDiagnosticsSessionCaptureAllowed(targetSessionId, false);
                  if (mountedRef.current && currentSessionIdRef.current === targetSessionId) {
                    setSessionAllowed(false);
                  }
                } catch {
                  if (!mountedRef.current) return;
                  await Modal.alert(
                    tLoose('common.error'),
                    tLoose(obligation
                      ? 'settingsVoice.diagnostics.shutdownFailedIndicator'
                      : 'settingsVoice.diagnostics.sessionOptOutFailed'),
                  );
                } finally {
                  actionInFlightRef.current = false;
                  focusedActionTargetRef.current = null;
                  focusLostOnActionRemovalRef.current = false;
                }
              })();
            }}
          >
            <Text style={{ color: theme.colors.text.secondary, fontSize: 11, textDecorationLine: 'underline' }}>
              {tLoose(obligation
                ? 'settingsVoice.diagnostics.retryShutdown'
                : 'settingsVoice.diagnostics.sessionOptOut')}
            </Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}
