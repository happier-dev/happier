import * as React from 'react';

import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { useActiveServerAccountScope, useMachineCliDetectionTarget } from '@/sync/store/hooks';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useVoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';

import { publishVoiceDiagnosticsRuntimeStatus } from './runtimeStatus';
import {
  applyVoiceDiagnosticsMachinePolicy,
  clearRestoredVoiceDiagnosticsMachineRevocations,
  declareVoiceDiagnosticsMachinePolicyIntent,
  disableVoiceDiagnosticsOnMachine,
  restorePersistedVoiceDiagnosticsMachineRevocations,
} from './runtimeRevocation';

/**
 * Re-applies the account-owned fail-closed policy whenever the selected voice
 * machine, its daemon runtime, or diagnostics settings change. Failed
 * shutdowns remain explicit, exact-machine privacy obligations until that
 * daemon confirms the revoke.
 */
export function useVoiceDiagnosticsRuntimeSync(rawVoiceSettings: unknown): void {
  const parsed = React.useMemo(() => voiceSettingsParse(rawVoiceSettings), [rawVoiceSettings]);
  const diagnostics = parsed.diagnostics;
  const { machineId } = useVoiceExecutionMachinePresentation();
  const { daemonStateVersion, isOnline } = useMachineCliDetectionTarget(machineId);
  const persistenceScope = useActiveServerAccountScope();
  const previousSelectionRef = React.useRef<Readonly<{
    machineId: string | null;
    persistenceScope: ServerAccountScope | null;
  }>>({ machineId: null, persistenceScope: null });
  const transitionTailRef = React.useRef<Promise<void>>(Promise.resolve());
  const generationRef = React.useRef(0);

  React.useEffect(() => {
    if (persistenceScope) {
      restorePersistedVoiceDiagnosticsMachineRevocations(persistenceScope);
    } else {
      clearRestoredVoiceDiagnosticsMachineRevocations();
    }
  }, [persistenceScope]);

  React.useEffect(() => {
    const generation = ++generationRef.current;
    const controller = new AbortController();
    const previousSelection = previousSelectionRef.current;
    previousSelectionRef.current = { machineId, persistenceScope };
    const selectionScopeChanged = previousSelection.persistenceScope === null && persistenceScope === null
      ? false
      : !areServerAccountScopesEqual(previousSelection.persistenceScope, persistenceScope);
    const previousMachineId = previousSelection.machineId;
    const previousMachineDisableIntent = previousMachineId
      && (previousMachineId !== machineId || selectionScopeChanged)
      ? declareVoiceDiagnosticsMachinePolicyIntent({
        machineId: previousMachineId,
        kind: 'disable',
        persistenceScope: previousSelection.persistenceScope,
      })
      : null;
    const shouldEnableCurrentMachine = diagnostics.enabled && diagnostics.consentVersion === 1;
    const currentMachineEnableIntent = machineId && shouldEnableCurrentMachine
      ? declareVoiceDiagnosticsMachinePolicyIntent({ machineId, kind: 'enable', persistenceScope })
      : null;
    const currentMachineDisableIntent = machineId && !shouldEnableCurrentMachine
      ? declareVoiceDiagnosticsMachinePolicyIntent({ machineId, kind: 'disable' })
      : null;
    publishVoiceDiagnosticsRuntimeStatus({ machineId, phase: 'transitioning' });

    const transition = async () => {
      let previousMachineShutdownSucceeded = true;
      if (previousMachineId && previousMachineDisableIntent) {
        const result = await disableVoiceDiagnosticsOnMachine({
          machineId: previousMachineId,
          settings: diagnostics,
          intent: previousMachineDisableIntent,
        });
        previousMachineShutdownSucceeded = result.ok && result.acknowledged;
      }
      if (generationRef.current !== generation || controller.signal.aborted) return;
      if (!machineId) {
        publishVoiceDiagnosticsRuntimeStatus({
          machineId: null,
          phase: previousMachineShutdownSucceeded ? 'inactive_confirmed' : 'status_unknown',
        });
        return;
      }
      if (!diagnostics.enabled || diagnostics.consentVersion !== 1) {
        const result = await disableVoiceDiagnosticsOnMachine({
          machineId,
          settings: diagnostics,
          intent: currentMachineDisableIntent ?? undefined,
        });
        if (generationRef.current === generation && !controller.signal.aborted) {
          publishVoiceDiagnosticsRuntimeStatus({
            machineId,
            phase: result.ok && result.acknowledged ? 'inactive_confirmed' : 'status_unknown',
          });
        }
        return;
      }
      await applyVoiceDiagnosticsMachinePolicy({
        machineId,
        settings: diagnostics,
        signal: controller.signal,
        intent: currentMachineEnableIntent ?? undefined,
      })
        .then((result) => {
          if (generationRef.current !== generation || controller.signal.aborted) return;
          if (!result.applied || !result.acknowledged) {
            publishVoiceDiagnosticsRuntimeStatus({ machineId, phase: 'status_unknown' });
            return;
          }
          publishVoiceDiagnosticsRuntimeStatus({
            machineId,
            phase: result.status.settings.enabled && result.status.settings.consentVersion === 1
              ? 'active'
              : 'inactive_confirmed',
          });
        })
        .catch(() => {
          // The request outcome is unknown: the daemon may have applied the
          // policy before the response was lost, so the UI must not claim off.
          if (generationRef.current === generation && !controller.signal.aborted) {
            publishVoiceDiagnosticsRuntimeStatus({ machineId, phase: 'status_unknown' });
          }
        });
    };
    transitionTailRef.current = transitionTailRef.current.then(transition, transition);
    return () => controller.abort();
  }, [daemonStateVersion, diagnostics, isOnline, machineId, persistenceScope]);
}
