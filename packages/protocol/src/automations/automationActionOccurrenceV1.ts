import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { AutomationOccurredAtV1Schema } from './automationOccurredAtV1.js';
import { AutomationTriggerIdSchema, AutomationTriggerRevisionSchema } from './automationTriggerIdentity.js';
import { AutomationTriggerActionIdV1Schema, AutomationActionPhaseV1Schema, AutomationActionOutcomeV1Schema } from './automationActionIdentityV1.js';

const identifier = z.string().check(z.trim(), z.minLength(1));

function checkSettledActionStatus(evidence: Readonly<{ phase: string; status?: string }>,
    context: { addIssue: (issue: { code: 'custom'; path: string[]; message: string }) => void }) {
    if (evidence.phase === 'after' && evidence.status === undefined) {
        context.addIssue({ code: 'custom', path: ['status'], message: 'An after Action has a terminal status' });
    }
}

/** Safe provenance only: authored input, output and error text never enter this envelope. */
export const AutomationActionRunEvidenceV1Schema = lazyZodSchema(() => z.strictObject({
    actionId: AutomationTriggerActionIdV1Schema,
    requestId: identifier,
    phase: AutomationActionPhaseV1Schema,
    status: z.optional(z.enum(['succeeded', 'failed'])),
    outcome: z.optional(AutomationActionOutcomeV1Schema),
    errorCode: z.optional(identifier),
    machineId: z.optional(identifier),
    originRunId: z.optional(identifier),
}).check(z.superRefine(checkSettledActionStatus)));
export type AutomationActionRunEvidenceV1 = z.infer<typeof AutomationActionRunEvidenceV1Schema>;

export const AutomationActionOccurrenceEvidenceV1Schema = lazyZodSchema(() => z.strictObject({
    ...AutomationActionRunEvidenceV1Schema.shape,
    v: z.literal(1),
    kind: z.literal('action'),
    occurredAt: AutomationOccurredAtV1Schema,
    // Typed identities stay in the host. Only the subject owner's digest crosses Home.
    subjects: z.array(z.strictObject({ role: z.enum(['operand', 'context']), kind: identifier, key: identifier })),
}).check(z.superRefine(checkSettledActionStatus)));
export type AutomationActionOccurrenceEvidenceV1 = z.infer<typeof AutomationActionOccurrenceEvidenceV1Schema>;

export const AUTOMATION_ACTION_ADMIT_HTTP_PATH_V1 = '/v1/automations/actions/admit' as const;
export const AutomationActionAdmitTriggerV1Schema = lazyZodSchema(() => z.strictObject({
    automationId: identifier,
    triggerId: AutomationTriggerIdSchema,
    triggerRevision: AutomationTriggerRevisionSchema,
}));
export const AutomationActionAdmitRequestV1Schema = lazyZodSchema(() => z.strictObject({
    evidence: AutomationActionOccurrenceEvidenceV1Schema,
    triggers: z.array(AutomationActionAdmitTriggerV1Schema),
}));
export type AutomationActionAdmitRequestV1 = z.infer<typeof AutomationActionAdmitRequestV1Schema>;

export const AutomationActionAdmitResultV1Schema = lazyZodSchema(() => z.strictObject({
    results: z.array(z.union([
        z.strictObject({
            automationId: identifier, triggerId: AutomationTriggerIdSchema,
            kind: z.enum(['admitted', 'rejoined']), runId: identifier,
        }),
        z.strictObject({
            automationId: identifier, triggerId: AutomationTriggerIdSchema, kind: z.literal('skipped'),
            reason: identifier,
        }),
    ])),
}));
export type AutomationActionAdmitResultV1 = z.infer<typeof AutomationActionAdmitResultV1Schema>;
