import type { MachineSetupEffectPlanV1 } from '@happier-dev/cli-common/machineSetup';
import type { MachineFirewallTransitionIntentV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { MachineReachabilityPostureV1 } from '@happier-dev/protocol';
import type { MachineMetadataFieldDefinitionV1, MachineMetadataFieldPortV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';
import type { MachineElevationDependencies } from '@/machines/adminAccess/runElevatedEffect';
import type { MachineElevatedResultV1, MachineFirewallRecoveryV1, MachineFirewallRestorationV1 } from '@happier-dev/protocol/machines/adminAccessV1';
import type { MachineNativeEffectContext } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import type { OwnDaemonReachabilityProof } from './observeOwnDaemonReachability';
import { mutateMachineMetadataFieldV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';
import { runElevatedMachineFirewallPlans } from '@/machines/adminAccess/runElevatedEffect';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';

export type RetainedSshTransitionInput = Readonly<{
  machineId: string; installationId: string; operationId: string;
  expectedMetadataVersion: number; current: MachineReachabilityPostureV1 | null; desired: MachineReachabilityPostureV1;
  basis: Extract<MachineSetupEffectPlanV1['basis'], { kind: 'setup' }>;
  firewallIntent: MachineFirewallTransitionIntentV1;
  port: MachineMetadataFieldPortV1;
  field: MachineMetadataFieldDefinitionV1<MachineReachabilityPostureV1 | null>;
  native: MachineNativeEffectContext;
  elevation: Omit<MachineElevationDependencies, 'verifyCurrent'>;
  readDaemonProof(): Promise<OwnDaemonReachabilityProof>;
  signal?: AbortSignal;
}>;

type TransitionResult = Readonly<{
  status: 'applied' | 'unchanged' | 'rolledBack' | 'outcome_unknown' | 'recoveryRequired' | 'refused';
  /** Last confirmed field read/write, not a current-state assertion on unknown. */
  metadataVersion: number; posture: MachineReachabilityPostureV1 | null;
  effectAttempted: boolean; errorCode?: string;
  failure?: Extract<MachineElevatedResultV1, { outcome: 'outcome_unknown' }>['failure'] | Readonly<{
    kind: 'daemon_reachability_unavailable'; reason: 'required_fact_unavailable'; requiredFact: 'homeRoutedDaemonAck';
    errorCode?: string;
  }>;
  /** Exact native capture for the existing offline recovery card, not a store. */
  recovery?: MachineFirewallRecoveryV1;
  restoration?: MachineFirewallRestorationV1;
}>;

/** Prepared for the posture branch of the one reachability host. Native staging,
 * validation and exact undo stay inside P10/P20; this owner settles posture. */
export async function executeRetainedSshTransition(input: RetainedSshTransitionInput): Promise<TransitionResult> {
  let posture = input.current, metadataVersion = input.expectedMetadataVersion, effectAttempted = false;
  let acknowledgedWrite = false, metadataUncertain = false, nativeRestored = false;
  let recovery: MachineFirewallRecoveryV1 | undefined, restoration: MachineFirewallRestorationV1 | undefined;
  let failure: TransitionResult['failure'];
  const alreadyDesired = input.field.equal(input.current, input.desired);
  let failureCode: string | undefined;
  const result = (status: TransitionResult['status'], errorCode?: string): TransitionResult => ({
    status, posture, metadataVersion, effectAttempted, ...(errorCode ? { errorCode } : {}),
    ...(recovery ? { recovery } : {}), ...(restoration ? { restoration } : {}),
    ...(failure ? { failure } : {}),
  });
  // The caller already admitted authority. P30 owns that context; P10's
  // later callbacks consume cancellation, never re-read Home authority or
  // metadata. The canonical field writer handles the owned-field comparison.
  const cancelled = () => input.signal?.aborted || input.native.operation.signal?.aborted;
  try {
    // P10/root binds this reviewed intent in its one CHECK -> APPLY, reads
    // protected native facts, and materializes the actual A/FINAL programs.
    // Actual post-change daemon reachability is observed once per phase.
    if (cancelled()) return result('refused', 'cancelled');
    const elevated = await machineNativeEffectAdmission.runStage(input.native, () =>
      runElevatedMachineFirewallPlans({ machineId: input.machineId, operationId: input.operationId,
        signal: input.signal, basis: input.basis, firewallIntent: input.firewallIntent,
        async onStage(stage) {
          recovery ??= stage.recovery;
          if (stage.planIndex === 0) input.elevation.emit?.({ type: 'machine.reachability.recovery', data: {
            machineId: input.machineId, installationId: input.installationId, operationId: input.operationId, recovery,
          } });
          if (cancelled()) { failureCode = 'cancelled'; return 'undo'; }
          const daemon = await input.readDaemonProof();
          if (cancelled()) { failureCode = 'cancelled'; return 'undo'; }
          if (daemon.status !== 'ready') {
            failureCode = daemon.status === 'unavailable' ? 'machine_unavailable' : 'required_fact_unavailable';
            failure = { kind: 'daemon_reachability_unavailable', reason: 'required_fact_unavailable', requiredFact: 'homeRoutedDaemonAck',
              ...(daemon.errorCode ? { errorCode: daemon.errorCode } : {}) };
            return 'undo';
          }
          if (!await stage.verifyNative()) { failureCode = 'enforcement_unknown'; return 'undo'; }
          if (cancelled()) { failureCode = 'cancelled'; return 'undo'; }
          if (stage.planIndex === 0) return 'continue';
          const written = await mutateMachineMetadataFieldV1({ expectedMetadataVersion: metadataVersion,
            expectedPolicy: posture, policy: input.desired, comparison: 'field' }, input.port, input.field, { signal: input.signal });
          if (written.status !== 'applied' && written.status !== 'satisfied' && written.status !== 'unchanged') {
            metadataUncertain = written.status === 'outcomeUnknown';
            failureCode = written.status === 'outcomeUnknown' ? 'outcome_unknown' : 'plan_changed'; return 'undo';
          }
          posture = written.policy; metadataVersion = written.metadataVersion;
          acknowledgedWrite = true;
          return 'commit';
        },
      }, { ...input.elevation, verifyCurrent: async () => !cancelled(),
        emit(event) {
          if (event.type === 'machine.setup.progress' && event.data && typeof event.data === 'object'
            && Reflect.get(event.data, 'phase') === 'apply' && Reflect.get(event.data, 'status') === 'started') effectAttempted = true;
          input.elevation.emit?.(event);
        },
      }));
    restoration = 'restoration' in elevated ? elevated.restoration : undefined;
    failure = ('failure' in elevated ? elevated.failure : undefined) ?? failure;
    nativeRestored = restoration?.status === 'verified';
    if (elevated.outcome === 'applied' && acknowledgedWrite) return result(alreadyDesired ? 'unchanged' : 'applied');
    if (acknowledgedWrite && nativeRestored) {
      // Required compensation is not optional work: cancellation must not skip
      // it. The field owner refuses a concurrently changed posture and rebases
      // unrelated fields; it never blindly restores a whole old snapshot.
      const restored = await mutateMachineMetadataFieldV1({ expectedMetadataVersion: metadataVersion,
        expectedPolicy: posture, policy: input.current, comparison: 'field' }, input.port, input.field);
      if (restored.status !== 'applied' && restored.status !== 'satisfied' && restored.status !== 'unchanged')
        return result('recoveryRequired', 'posture_restore_unavailable');
      posture = restored.policy; metadataVersion = restored.metadataVersion;
    }
    if (metadataUncertain) return result('outcome_unknown', 'outcome_unknown');
    // Only the native owner's positive restoration can guide compensation;
    // generic failed/cancelled event statuses never establish that proof.
    if (nativeRestored) return elevated.outcome === 'outcome_unknown'
      ? result('outcome_unknown', 'outcome_unknown') : result('rolledBack', failureCode
        ?? (elevated.outcome === 'not_applied' ? elevated.reasonCode : 'outcome_unknown'));
    if (elevated.outcome === 'not_applied') return result('refused',
      failure?.kind === 'native_check_unavailable' && failure.reason === 'required_fact_unavailable'
        ? failure.reason : elevated.reasonCode);
    if (elevated.outcome === 'needs_attendance') return result('refused', 'needs_attendance');
    return result('outcome_unknown', 'outcome_unknown');
  } catch {
    return result(effectAttempted ? 'outcome_unknown' : 'refused', 'outcome_unknown');
  }
}
