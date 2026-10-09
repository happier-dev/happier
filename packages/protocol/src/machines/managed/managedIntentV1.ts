import * as z from 'zod/mini';
import { lazyDefinition } from '../../lazyZodSchema.js';
import { ActionOperationGetV1RequestSchema } from '../../actions/operations/v1.js';
import { ManagedRefusalCodeV1Schema } from './providerFactsV1.js';
import { RetentionV1Schema, ManagedControllerV1Schema } from './managedMachineV1.js';
import { ManagedCommittedIdleEvidenceV1Schema } from './actionsV1.js';

const id = () => z.string().check(z.trim(), z.minLength(1));
const revision = () => z.int().check(z.gte(0));

/** Reviewed installation replacement, admitted through the same managed row revision. */
export const DevcontainerRebuildIntentV1Schema = lazyDefinition(() => z.strictObject({
  managedMachineId: id(), expectedRevision: revision(), kind: z.literal('rebuild'), reviewedEffectDigest: id(),
}));
export type DevcontainerRebuildIntentV1 = Readonly<z.infer<typeof DevcontainerRebuildIntentV1Schema>>;

/** Immediate CAS and deferred idle intents have distinct, closed admission contracts. */
export const ManagedIntentInputSchema = lazyDefinition(() => z.discriminatedUnion('when', [
  z.strictObject({ homeId: id(), managedId: id(), when: z.literal('now'),
    expectedRevision: revision(), intent: z.enum(['start', 'stop', 'suspend', 'resume', 'delete']) }),
  z.strictObject({ homeId: id(), managedId: id(), when: z.literal('after-idle'),
    intent: z.enum(['stop', 'delete']), afterMs: z.optional(RetentionV1Schema.def.options[1].def.shape.afterMs) }),
]));

export const ManagedIntentResultSchema = lazyDefinition(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('accepted'), managedId: id(), intentRevision: revision(),
    operation: ActionOperationGetV1RequestSchema }),
  z.strictObject({ kind: z.literal('conflict'), currentRevision: revision() }),
  z.strictObject({ kind: z.literal('refused'), code: ManagedRefusalCodeV1Schema }),
]));

/** Content-free projection only; live inventory, attribution and owner references stay host-internal. */
export const ActivityDecisionV1Schema = lazyDefinition(() => {
  const reasons = z.array(z.enum(['session', 'finite', 'terminal', 'service', 'transfer',
    'handoff', 'sync', 'setup', 'input', 'execution_run', 'workflow_run', 'coverage_unknown']));
  return z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('busy'), reasons }),
    z.strictObject({ kind: z.literal('unknown'), reasons }),
    z.strictObject({ kind: z.literal('idle'), since: z.number().check(z.gte(0)) }),
  ]);
});

export type ManagedIntentInput = Readonly<z.infer<typeof ManagedIntentInputSchema>>;
export type ManagedIntentResult = Readonly<z.infer<typeof ManagedIntentResultSchema>>;
export type ActivityDecisionV1 = Readonly<z.infer<typeof ActivityDecisionV1Schema>>;

export const MANAGED_ACTIVITY_READ_RPC_METHOD = 'managed.activity.read';
export const MANAGED_ADMISSION_DRAIN_CONFIRM_RPC_METHOD = 'managed.admission.drain.confirm';

/** Exact retained-row correlation; requester authority comes from signed Machine ingress. */
export const ManagedActivityReadRequestV1Schema = lazyDefinition(() => z.strictObject({
  homeId: id(), managedId: id(), expectedRevision: revision(), controller: ManagedControllerV1Schema,
}));
export const ManagedAdmissionDrainConfirmRequestV1Schema = lazyDefinition(() => z.strictObject({
  homeId: id(), managedId: id(), expectedRevision: revision(), controller: ManagedControllerV1Schema,
  action: z.enum(['begin', 'resume']),
}));
export const ManagedActivityBridgeResultV1Schema = lazyDefinition(() => z.union([
  ActivityDecisionV1Schema,
  z.strictObject({ kind: z.literal('idle'), since: z.number().check(z.gte(0)),
    evidence: ManagedCommittedIdleEvidenceV1Schema }),
  z.strictObject({ kind: z.literal('refused'), code: z.enum([
    'admission_unavailable', 'intent_conflict', 'controller_unavailable',
  ]) }),
]));
export type ManagedActivityReadRequestV1 = Readonly<z.infer<typeof ManagedActivityReadRequestV1Schema>>;
export type ManagedAdmissionDrainConfirmRequestV1 = Readonly<z.infer<typeof ManagedAdmissionDrainConfirmRequestV1Schema>>;
export type ManagedActivityBridgeResultV1 = Readonly<z.infer<typeof ManagedActivityBridgeResultV1Schema>>;

/** A reference to accepted work, never prompt content or a native power approval. */
export const ManagedWakeTargetV1Schema = lazyDefinition(() => {
  const session = z.strictObject({ homeId: id(), sessionId: id() });
  return z.strictObject({
    homeId: id(), managedId: id(), enrolledMachineId: id(), expectedIntentRevision: revision(),
    controller: ManagedControllerV1Schema,
    origin: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('session-input'), session, pendingRequestId: id(),
        requestedAt: z.int().check(z.gte(0)) }),
      z.strictObject({ kind: z.literal('finite-command'), actionRequestId: id() }),
      z.strictObject({ kind: z.literal('workflow-assignment'), runId: id(), revision: revision(),
        assignment: z.strictObject({ machineId: id() }) }),
      z.strictObject({ kind: z.literal('context-delivery'), session,
        delivery: z.strictObject({ runId: id(), revision: revision() }) }),
    ]),
    reason: z.literal('admitted-work'),
  });
});
export type ManagedWakeTargetV1 = Readonly<z.infer<typeof ManagedWakeTargetV1Schema>>;

/** Existing accepted work is reread on reconnect; this is not a persisted wake queue. */
export const ManagedWakeTargetsReadRequestV1Schema = lazyDefinition(() => z.strictObject({
  homeId: id(), controller: ManagedControllerV1Schema,
}));
export const ManagedWakeTargetsReadResultV1Schema = lazyDefinition(() => z.strictObject({
  targets: z.array(ManagedWakeTargetV1Schema),
}));
export type ManagedWakeTargetsReadRequestV1 = Readonly<z.infer<typeof ManagedWakeTargetsReadRequestV1Schema>>;
export type ManagedWakeTargetsReadResultV1 = Readonly<z.infer<typeof ManagedWakeTargetsReadResultV1Schema>>;
