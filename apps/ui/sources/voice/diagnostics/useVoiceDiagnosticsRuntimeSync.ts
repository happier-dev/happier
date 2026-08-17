import * as React from 'react';

import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import {
  useActiveServerAccountScope,
  useMachineCliDetectionTarget,
  useMachineCliDetectionTargets,
} from '@/sync/store/hooks';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useVoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';

import { publishVoiceDiagnosticsRuntimeStatus, useVoiceDiagnosticsRuntimeStatus } from './runtimeStatus';
import {
  applyVoiceDiagnosticsMachinePolicy,
  clearRestoredVoiceDiagnosticsMachineRevocations,
  declareVoiceDiagnosticsMachinePolicyIntent,
  disableVoiceDiagnosticsOnMachine,
  revalidateVoiceDiagnosticsSessionRevocationsAfterRuntimeReconnect,
  restorePersistedVoiceDiagnosticsMachineRevocations,
  retryVoiceDiagnosticsRevocation,
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
  const runtimeStatus = useVoiceDiagnosticsRuntimeStatus();
  const formerMachineRevocations = React.useMemo(() => (
    runtimeStatus.revocationObligations.filter(
      (candidate) => candidate.target.kind === 'machine_policy' && candidate.target.machineId !== machineId,
    )
  ), [machineId, runtimeStatus.revocationObligations]);
  const formerMachineIds = React.useMemo(
    () => formerMachineRevocations.map((candidate) => candidate.target.machineId),
    [formerMachineRevocations],
  );
  const formerMachineTargets = useMachineCliDetectionTargets(formerMachineIds);
  const previousSelectionRef = React.useRef<Readonly<{
    machineId: string | null;
    persistenceScope: ServerAccountScope | null;
  }>>({ machineId: null, persistenceScope: null });
  const transitionTailRef = React.useRef<Promise<void>>(Promise.resolve());
  const generationRef = React.useRef(0);
  const previousRuntimeTargetRef = React.useRef<Readonly<{
    machineId: string | null;
    daemonStateVersion: number;
    isOnline: boolean;
  }> | null>(null);
  // This is only the mounted-hook cancellation/currentness book-keeping for
  // rendered exact targets. The policy intent, request serialization, and
  // persisted acknowledgement remain owned by runtimeRevocation.
  const formerMachineRevalidationsRef = React.useRef(new Map<string, Readonly<{
    daemonStateVersion: number;
    isOnline: boolean;
    controller: AbortController | null;
  }>>());

  React.useEffect(() => {
    for (const { controller } of formerMachineRevalidationsRef.current.values()) controller?.abort();
    formerMachineRevalidationsRef.current.clear();
    if (persistenceScope) {
      restorePersistedVoiceDiagnosticsMachineRevocations(persistenceScope);
    } else {
      clearRestoredVoiceDiagnosticsMachineRevocations();
    }
  }, [persistenceScope]);

  React.useEffect(() => () => {
    for (const { controller } of formerMachineRevalidationsRef.current.values()) controller?.abort();
  }, []);

  React.useEffect(() => {
    const revalidations = formerMachineRevalidationsRef.current;
    const currentMachineIds = new Set(formerMachineRevocations.map((candidate) => candidate.target.machineId));
    for (const [candidateMachineId, revalidation] of revalidations) {
      if (currentMachineIds.has(candidateMachineId)) continue;
      revalidation.controller?.abort();
      revalidations.delete(candidateMachineId);
    }

    for (const obligation of formerMachineRevocations) {
      const target = obligation.target;
      if (target.kind !== 'machine_policy') continue;
      const machineTarget = formerMachineTargets[target.machineId] ?? {
        daemonStateVersion: 0,
        isOnline: false,
      };
      const previousRevalidation = revalidations.get(target.machineId);
      const runtimeCurrentnessChanged = !previousRevalidation
        || !previousRevalidation.isOnline
        || machineTarget.daemonStateVersion > previousRevalidation.daemonStateVersion;
      const activeRevalidationHasStaleCurrentness = Boolean(previousRevalidation?.controller && (
        previousRevalidation.daemonStateVersion !== machineTarget.daemonStateVersion
        || previousRevalidation.isOnline !== machineTarget.isOnline
      ));
      const replacesOwnStalePendingRevalidation = obligation.status === 'pending'
        && activeRevalidationHasStaleCurrentness;
      if (activeRevalidationHasStaleCurrentness) previousRevalidation?.controller?.abort();

      const shouldRetryFailedRevocation = obligation.status === 'failed' && runtimeCurrentnessChanged;
      if (!machineTarget.isOnline || (!shouldRetryFailedRevocation && !replacesOwnStalePendingRevalidation)) {
        revalidations.set(target.machineId, {
          daemonStateVersion: machineTarget.daemonStateVersion,
          isOnline: machineTarget.isOnline,
          controller: activeRevalidationHasStaleCurrentness ? null : previousRevalidation?.controller ?? null,
        });
        continue;
      }

      const controller = new AbortController();
      const revalidation = {
        daemonStateVersion: machineTarget.daemonStateVersion,
        isOnline: machineTarget.isOnline,
        controller,
      };
      revalidations.set(target.machineId, revalidation);
      void retryVoiceDiagnosticsRevocation({
        obligation,
        settings: diagnostics,
        persistenceScope,
        signal: controller.signal,
      }).then(
        () => {
          const currentRevalidation = revalidations.get(target.machineId);
          if (currentRevalidation?.controller === controller) {
            revalidations.set(target.machineId, { ...currentRevalidation, controller: null });
          }
        },
        () => {
          const currentRevalidation = revalidations.get(target.machineId);
          if (currentRevalidation?.controller === controller) {
            revalidations.set(target.machineId, { ...currentRevalidation, controller: null });
          }
        },
      );
    }
  }, [
    diagnostics,
    formerMachineRevocations,
    formerMachineTargets,
    persistenceScope,
  ]);

  React.useEffect(() => {
    const generation = ++generationRef.current;
    const controller = new AbortController();
    const previousRuntimeTarget = previousRuntimeTargetRef.current;
    const reconnectedCurrentMachine = Boolean(
      machineId
      && isOnline
      && previousRuntimeTarget?.machineId === machineId
      && (
        !previousRuntimeTarget.isOnline
        || daemonStateVersion > previousRuntimeTarget.daemonStateVersion
      ),
    );
    previousRuntimeTargetRef.current = { machineId, daemonStateVersion, isOnline };
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
      ? declareVoiceDiagnosticsMachinePolicyIntent({ machineId, kind: 'disable', persistenceScope })
      : null;
    publishVoiceDiagnosticsRuntimeStatus({ machineId, phase: 'transitioning' });

    const transition = async () => {
      if (generationRef.current !== generation || controller.signal.aborted) return;
      if (reconnectedCurrentMachine && machineId && shouldEnableCurrentMachine) {
        await revalidateVoiceDiagnosticsSessionRevocationsAfterRuntimeReconnect(machineId, controller.signal);
      }
      if (generationRef.current !== generation || controller.signal.aborted) return;
      let previousMachineShutdownSucceeded = true;
      if (previousMachineId && previousMachineDisableIntent) {
        const result = await disableVoiceDiagnosticsOnMachine({
          machineId: previousMachineId,
          settings: diagnostics,
          signal: controller.signal,
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
          signal: controller.signal,
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
