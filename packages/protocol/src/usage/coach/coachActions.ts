import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { UsageQuerySchema } from '../../inputs/usageQuery.js';
import { SettingsDeclarationMutationReversalV1Schema, SettingsDeclarationValueV1Schema } from '../../actions/settingsDeclarationActionFamily.js';
import { SessionModelMutationReversalV1Schema } from '../../sessions/control/modelTransitionV1.js';
import { McpServerBindingEnabledReversalV1Schema } from '../../mcp/servers/catalogSchemasV1.js';
import { UsageCoachRemedySchema } from './coachRemedy.js';

const identity = lazyZodSchema(() => z.string().trim().min(1));
const reference = lazyZodSchema(() => z.object({ query: UsageQuerySchema, evidenceKey: identity }).strict());
/** Stateless owner results; each owner validates its own atomic restore contract. */
export const UsageCoachReversalSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('setting'), anchor: identity, appliedValue: SettingsDeclarationValueV1Schema,
        owner: SettingsDeclarationMutationReversalV1Schema }).strict(),
    z.object({ kind: z.literal('model'), sessionId: identity, owner: SessionModelMutationReversalV1Schema }).strict(),
    z.object({ kind: z.literal('mcp_binding'), owner: McpServerBindingEnabledReversalV1Schema }).strict(),
]));
export type UsageCoachReversal = z.infer<typeof UsageCoachReversalSchema>;
export const UsageCoachApplyInputSchema = reference;
export const UsageCoachUndoInputSchema = lazyZodSchema(() => reference.extend({ reversal: UsageCoachReversalSchema }).strict());
export const UsageCoachDismissInputSchema = lazyZodSchema(() => reference.extend({ dismissed: z.boolean() }).strict());
export const UsageCoachSnoozeInputSchema = lazyZodSchema(() => reference.extend({ untilMs: z.number().int().nonnegative().safe().nullable() }).strict());
export const UsageCoachApplyResultSchema = lazyZodSchema(() => z.object({
    kind: z.literal('applied'), evidenceKey: identity, remedy: UsageCoachRemedySchema,
    reversal: UsageCoachReversalSchema.optional(),
    spawnedSessionId: identity.optional(),
    reversalUnavailableReason: z.enum(['not_reversible', 'no_change']).optional(),
}).strict());
export const UsageCoachUndoResultSchema = lazyZodSchema(() => z.object({ kind: z.literal('undone'), evidenceKey: identity }).strict());
export const UsageCoachPreferenceResultSchema = lazyZodSchema(() => z.object({
    kind: z.literal('preference_updated'), evidenceKey: identity,
    dismissed: z.boolean().optional(), untilMs: z.number().int().nonnegative().safe().nullable().optional(),
}).strict());
