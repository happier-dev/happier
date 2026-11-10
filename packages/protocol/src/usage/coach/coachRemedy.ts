import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SettingsDeclarationValueV1Schema } from '../../actions/settingsDeclarationActionFamily.js';
import { ProviderConnectionIdSchema } from '../../providers/ids.js';
import { SessionSpawnNewInitialInputV1Schema, SessionSpawnNewInputV2BaseSchema } from '../../sessions/creation/sessionSpawnNewInputV2.js';
import { requireSessionInputContent } from '../../sessions/messages/sessionInputAuthoringV1.js';
import { SessionModelMutationExpectedV1Schema } from '../../sessions/control/modelTransitionV1.js';
import { ReachPlaceV1Schema } from '../../reach/reachPlaceV1.js';

const identity = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
/** A Coach proposal prepares a review prompt, not an arbitrary Session birth request. */
const preparedReview = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.pick(SessionSpawnNewInputV2BaseSchema, {
    executionTarget: true, directory: true, agentTarget: true,
}), {
    initialInput: z.strictObject({ text: SessionSpawnNewInitialInputV1Schema.shape.text._zod.def.innerType }).check(z.superRefine(requireSessionInputContent)),
})));
/** A supported remedy is supplied by its admitted owner, never invented by a detector. */
export const UsageCoachRemedySchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('setting'), anchor: identity, value: SettingsDeclarationValueV1Schema }),
    z.strictObject({ kind: z.literal('model'), sessionId: identity, modelId: identity,
        providerConnectionId: z.optional(z.nullable(ProviderConnectionIdSchema)), expected: z.optional(SessionModelMutationExpectedV1Schema) }),
    z.strictObject({ kind: z.literal('mcp_binding'), bindingId: identity, serverId: identity,
        target: ReachPlaceV1Schema, agentId: z.optional(identity), enabled: z.boolean(),
        expectedRevision: z.union([z.number().check(z.int(), z.nonnegative(), z.int()), z.literal('absent')]) }),
    z.strictObject({ kind: z.literal('prepared_session'), input: preparedReview }),
    z.strictObject({ kind: z.literal('recovery'), sessionId: identity,
        actionId: z.enum(['session.usageLimit.waitResume.enable', 'session.usageLimit.waitResume.cancel',
            'session.usageLimit.checkNow', 'session.usageLimit.consumeResetCredit']) }),
]));
export type UsageCoachRemedy = z.infer<typeof UsageCoachRemedySchema>;
