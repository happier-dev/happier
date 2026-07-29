import { z } from 'zod';

import { PluginIdSchema } from '@happier-dev/protocol';

import { AlgorithmQualifiedDigestSchema, PortableStorageIdSchema } from './commitRecord';

const ROLLING_FAILURE_WINDOW_MS = 5 * 60 * 1_000;
const CONTINUOUS_HEALTH_WINDOW_MS = 10 * 60 * 1_000;
const RECOVERY_FAILURE_THRESHOLD = 3;

const HealthStateSchema = z.enum(['pending', 'healthy', 'trial', 'quarantined']);
const TryOnceStateSchema = z.enum(['unavailable', 'available', 'consumed']);

export const PluginGenerationHealthRecordSchema = z.object({
  pluginId: PluginIdSchema,
  immutableGenerationId: PortableStorageIdSchema,
  fingerprint: AlgorithmQualifiedDigestSchema,
  state: HealthStateSchema,
  tryOnce: TryOnceStateSchema,
  eligibleFailures: z.array(z.object({
    attemptId: z.string().min(1).max(160),
    occurredAtMs: z.number().int().nonnegative(),
  }).strict()),
  consumedAttemptIds: z.array(z.string().min(1).max(160)),
  observation: z.object({
    daemonInstanceId: z.string().min(1).max(160),
    startedAtUptimeMs: z.number().int().nonnegative(),
  }).strict().nullable(),
}).strict().superRefine((record, context) => {
  const legal = record.state === 'quarantined'
    ? ['unavailable', 'available', 'consumed'].includes(record.tryOnce)
    : record.state === 'trial'
      ? record.tryOnce === 'consumed'
      : record.tryOnce === 'unavailable';
  if (!legal) context.addIssue({ code: 'custom', path: ['tryOnce'], message: 'Illegal health state and Try-once pair' });
  if (new Set(record.consumedAttemptIds).size !== record.consumedAttemptIds.length) {
    context.addIssue({ code: 'custom', path: ['consumedAttemptIds'], message: 'Duplicate consumed attempt id' });
  }
});
export type PluginGenerationHealthRecord = z.infer<typeof PluginGenerationHealthRecordSchema>;

export type GenerationAttemptClassification = Readonly<{
  pluginId: string;
  immutableGenerationId: string;
  attemptId: string;
  eligible: boolean;
  reason:
    | 'eligible_attributed_fatal'
    | 'pre_commit'
    | 'unattributed'
    | 'non_fatal'
    | 'ineligible_kind';
}>;

export function createPendingGenerationHealthRecord(input: Readonly<{
  pluginId: string;
  immutableGenerationId: string;
  fingerprint: string;
}>): PluginGenerationHealthRecord {
  return PluginGenerationHealthRecordSchema.parse({
    ...input,
    state: 'pending',
    tryOnce: 'unavailable',
    eligibleFailures: [],
    consumedAttemptIds: [],
    observation: null,
  });
}

export function createQuarantinedGenerationHealthRecord(input: Readonly<{
  pluginId: string;
  immutableGenerationId: string;
  fingerprint: string;
  tombstoneState: 'quarantined' | 'consumed';
}>): PluginGenerationHealthRecord {
  const { tombstoneState, ...identity } = input;
  return PluginGenerationHealthRecordSchema.parse({
    ...identity,
    state: 'quarantined',
    tryOnce: tombstoneState === 'consumed' ? 'consumed' : 'available',
    eligibleFailures: [],
    consumedAttemptIds: [],
    observation: null,
  });
}

export function classifyFatalGenerationAttempt(input: Readonly<{
  pluginId: string;
  attemptId: string;
  generationId: string;
  committed: boolean;
  kind: 'lazyActivation' | 'primaryBootstrap' | 'handler' | 'renderer' | 'session' | 'connectivity' | 'shutdown';
  outcome: 'fatal' | 'failure' | 'cancelled' | 'timeout';
  attributed: boolean;
}>): GenerationAttemptClassification {
  const identity = {
    pluginId: PluginIdSchema.parse(input.pluginId),
    immutableGenerationId: PortableStorageIdSchema.parse(input.generationId),
    attemptId: z.string().min(1).max(160).parse(input.attemptId),
  };
  if (!input.committed) return { ...identity, eligible: false, reason: 'pre_commit' };
  if (!input.attributed) return { ...identity, eligible: false, reason: 'unattributed' };
  if (input.outcome !== 'fatal') return { ...identity, eligible: false, reason: 'non_fatal' };
  if (input.kind !== 'lazyActivation' && input.kind !== 'primaryBootstrap') {
    return { ...identity, eligible: false, reason: 'ineligible_kind' };
  }
  return { ...identity, eligible: true, reason: 'eligible_attributed_fatal' };
}

export function recordGenerationAttemptResult(input: Readonly<{
  record: PluginGenerationHealthRecord;
  classification: GenerationAttemptClassification;
  nowMs: number;
}>): Readonly<{
  record: PluginGenerationHealthRecord;
  decision: 'excluded' | 'duplicate' | 'recorded' | 'recover_or_disable';
}> {
  const record = PluginGenerationHealthRecordSchema.parse(input.record);
  if (input.classification.pluginId !== record.pluginId) {
    throw new Error('Generation attempt plugin identity does not match its health record');
  }
  if (input.classification.immutableGenerationId !== record.immutableGenerationId) {
    throw new Error('Generation attempt generation identity does not match its health record');
  }
  if (!input.classification.eligible) return { record, decision: 'excluded' };
  if (record.consumedAttemptIds.includes(input.classification.attemptId)) return { record, decision: 'duplicate' };

  const windowStartMs = Math.max(0, input.nowMs - ROLLING_FAILURE_WINDOW_MS);
  const failures = record.eligibleFailures
    .filter((failure) => failure.occurredAtMs >= windowStartMs)
    .concat({ attemptId: input.classification.attemptId, occurredAtMs: input.nowMs });
  const consumedAttemptIds = record.consumedAttemptIds
    .concat(input.classification.attemptId);
  const next = PluginGenerationHealthRecordSchema.parse({
    ...record,
    eligibleFailures: failures,
    consumedAttemptIds,
    observation: null,
  });
  return {
    record: next,
    decision: failures.length >= RECOVERY_FAILURE_THRESHOLD ? 'recover_or_disable' : 'recorded',
  };
}

export function beginGenerationHealthObservation(input: Readonly<{
  record: PluginGenerationHealthRecord;
  daemonInstanceId: string;
  daemonUptimeMs: number;
}>): PluginGenerationHealthRecord {
  return PluginGenerationHealthRecordSchema.parse({
    ...PluginGenerationHealthRecordSchema.parse(input.record),
    observation: { daemonInstanceId: input.daemonInstanceId, startedAtUptimeMs: input.daemonUptimeMs },
  });
}

export function markGenerationHealthyAfterStaticReconciliation(
  recordInput: PluginGenerationHealthRecord,
): PluginGenerationHealthRecord {
  const record = PluginGenerationHealthRecordSchema.parse(recordInput);
  if (record.state === 'quarantined') return record;
  return PluginGenerationHealthRecordSchema.parse({
    ...record,
    state: 'healthy',
    tryOnce: 'unavailable',
    eligibleFailures: [],
    observation: null,
  });
}

export function completeGenerationHealthObservation(input: Readonly<{
  record: PluginGenerationHealthRecord;
  daemonInstanceId: string;
  daemonUptimeMs: number;
}>): Readonly<{
  record: PluginGenerationHealthRecord;
  decision: 'restart_required' | 'monitoring' | 'healthy';
}> {
  const record = PluginGenerationHealthRecordSchema.parse(input.record);
  if (!record.observation || record.observation.daemonInstanceId !== input.daemonInstanceId) {
    return {
      record: PluginGenerationHealthRecordSchema.parse({ ...record, observation: null }),
      decision: 'restart_required',
    };
  }
  if (input.daemonUptimeMs - record.observation.startedAtUptimeMs < CONTINUOUS_HEALTH_WINDOW_MS) {
    return { record, decision: 'monitoring' };
  }
  return {
    record: PluginGenerationHealthRecordSchema.parse({
      ...record, state: 'healthy', tryOnce: 'unavailable', observation: null, eligibleFailures: [],
    }),
    decision: 'healthy',
  };
}

export function consumeGenerationTryOnce(recordInput: PluginGenerationHealthRecord): PluginGenerationHealthRecord {
  const record = PluginGenerationHealthRecordSchema.parse(recordInput);
  if (record.state !== 'quarantined' || record.tryOnce !== 'available') {
    throw new Error('Generation Try once is unavailable or already consumed');
  }
  return PluginGenerationHealthRecordSchema.parse({ ...record, state: 'trial', tryOnce: 'consumed', observation: null });
}

type LastKnownGoodEligibility = Readonly<{
  available: boolean;
  automaticRecoveryEligible: boolean;
}> | null;

function recoveryAction(lastKnownGood: LastKnownGoodEligibility): 'rollback_to_lkg' | 'disable_plugin' {
  return lastKnownGood?.available === true && lastKnownGood.automaticRecoveryEligible === true
    ? 'rollback_to_lkg'
    : 'disable_plugin';
}

export function resolveAutomaticGenerationRecovery(input: Readonly<{
  record: PluginGenerationHealthRecord;
  lastKnownGood: LastKnownGoodEligibility;
}>): Readonly<{
  record: PluginGenerationHealthRecord;
  action: 'rollback_to_lkg' | 'disable_plugin';
}> {
  const record = PluginGenerationHealthRecordSchema.parse(input.record);
  if (record.eligibleFailures.length < RECOVERY_FAILURE_THRESHOLD || record.state === 'trial') {
    throw new Error('Automatic generation recovery threshold has not been reached');
  }
  return Object.freeze({
    record: PluginGenerationHealthRecordSchema.parse({
      ...record, state: 'quarantined', tryOnce: 'available', observation: null,
    }),
    action: recoveryAction(input.lastKnownGood),
  });
}

export function resolveFailedGenerationTrial(input: Readonly<{
  record: PluginGenerationHealthRecord;
  lastKnownGood: LastKnownGoodEligibility;
}>): Readonly<{
  record: PluginGenerationHealthRecord;
  action: 'rollback_to_lkg' | 'disable_plugin';
}> {
  const record = PluginGenerationHealthRecordSchema.parse(input.record);
  if (record.state !== 'trial' || record.tryOnce !== 'consumed') {
    throw new Error('Generation is not executing a consumed Try-once trial');
  }
  return Object.freeze({
    record: PluginGenerationHealthRecordSchema.parse({
      ...record, state: 'quarantined', tryOnce: 'consumed', observation: null,
    }),
    action: recoveryAction(input.lastKnownGood),
  });
}

export const PLUGIN_GENERATION_HEALTH_POLICY_V1 = Object.freeze({
  rollingFailureWindowMs: ROLLING_FAILURE_WINDOW_MS,
  continuousHealthWindowMs: CONTINUOUS_HEALTH_WINDOW_MS,
  recoveryFailureThreshold: RECOVERY_FAILURE_THRESHOLD,
});
