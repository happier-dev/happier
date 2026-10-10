import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';

const Id = lazyZodSchema(() => z.string().min(1));
const Count = lazyZodSchema(() => z.number().int().nonnegative().safe());
/** Native names stay transient; retained evidence contains catalog ids and numbers. */
export const UsageMcpBindingIdentitySchema = lazyZodSchema(() => z.object({
    serverId: Id, bindingId: Id,
    /** Entry updatedAt values, distinct from the catalog row's mutation revision. */
    serverRevision: Count, bindingRevision: Count,
    /** Exact catalog row CAS observed when the host materialized this binding. */
    catalogRevision: Count,
}).strict());
export type UsageMcpBindingIdentity = z.infer<typeof UsageMcpBindingIdentitySchema>;
export const UsageMcpBindingUsageSchema = lazyZodSchema(() => z.object({
    v: z.literal(1), evidenceId: Id, sessionId: Id, turnId: Id, observedAtMs: Count,
    window: z.object({ startMs: Count, endMs: Count }).strict(),
    coverage: z.enum(['complete', 'partial']),
    bindings: z.array(UsageMcpBindingIdentitySchema.extend({ toolCallCount: Count, schemaBytes: Count.nullable() }).strict()),
}).strict().superRefine((value, context) => {
    if (value.window.startMs > value.window.endMs || value.window.endMs !== value.observedAtMs) {
        context.addIssue({ code: 'custom', path: ['window'], message: 'Usage must identify its complete observed window' });
    }
    if (new Set(value.bindings.map(row => row.bindingId)).size !== value.bindings.length) {
        context.addIssue({ code: 'custom', path: ['bindings'], message: 'Binding usage identities must be unique' });
    }
    if (new Set(value.bindings.map(row => row.catalogRevision)).size > 1) {
        context.addIssue({ code: 'custom', path: ['bindings'], message: 'One invocation observes one catalog row revision' });
    }
}));
export type UsageMcpBindingUsage = z.infer<typeof UsageMcpBindingUsageSchema>;
