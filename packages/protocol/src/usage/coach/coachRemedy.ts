import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SettingsDeclarationValueV1Schema } from '../../actions/settingsDeclarationActionFamily.js';
import { ProviderConnectionIdSchema } from '../../providers/ids.js';
import { SessionSpawnNewInitialInputV1Schema, SessionSpawnNewInputV2BaseSchema } from '../../sessions/creation/sessionSpawnNewInputV2.js';
import { requireSessionInputContent } from '../../sessions/messages/sessionInputAuthoringV1.js';
import { SessionModelMutationExpectedV1Schema } from '../../sessions/control/modelTransitionV1.js';

const identity = lazyZodSchema(() => z.string().trim().min(1));
/** A Coach proposal prepares a review prompt, not an arbitrary Session birth request. */
const preparedReview = lazyZodSchema(() => SessionSpawnNewInputV2BaseSchema.pick({
    executionTarget: true, directory: true, agentTarget: true,
}).extend({
    initialInput: z.object({ text: SessionSpawnNewInitialInputV1Schema.shape.text.unwrap() })
        .strict().superRefine(requireSessionInputContent),
}).strict());
/** A supported remedy is supplied by its admitted owner, never invented by a detector. */
export const UsageCoachRemedySchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('setting'), anchor: identity, value: SettingsDeclarationValueV1Schema }).strict(),
    z.object({ kind: z.literal('model'), sessionId: identity, modelId: identity,
        providerConnectionId: ProviderConnectionIdSchema.nullable().optional(), expected: SessionModelMutationExpectedV1Schema.optional() }).strict(),
    z.object({ kind: z.literal('mcp_binding'), bindingId: identity, enabled: z.boolean(),
        expectedRevision: z.union([z.number().int().nonnegative().safe(), z.literal('absent')]) }).strict(),
    z.object({ kind: z.literal('prepared_session'), input: preparedReview }).strict(),
    z.object({ kind: z.literal('recovery'), sessionId: identity,
        actionId: z.enum(['session.usageLimit.waitResume.enable', 'session.usageLimit.waitResume.cancel',
            'session.usageLimit.checkNow', 'session.usageLimit.consumeResetCredit']) }).strict(),
]));
export type UsageCoachRemedy = z.infer<typeof UsageCoachRemedySchema>;
