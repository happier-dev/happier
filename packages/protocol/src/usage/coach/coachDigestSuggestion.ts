import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { getUsageQueryKey, normalizeUsageQuery, UsageQuerySchema, type UsageQuery } from '../../inputs/usageQuery.js';
import { projectNativeJsonValueForTransport } from '../../json/strictJsonValue.js';
import { WorkflowDefinitionV1Schema } from '../../workflows/workflowV1.js';
import { agent, literal, result } from '../../workflows/builtins/definitionParts.js';

/** A read-only recipe, not a schedule, assignment or grant to create an Automation. */
export const UsageCoachDigestSuggestionSchema = lazyZodSchema(() => z.object({
    kind: z.literal('recurring_automation'), queryKey: z.string().min(1), query: UsageQuerySchema,
    lookbackMs: z.number().int().positive(), actionId: z.literal('workflow.trigger.add'),
    requiredInputs: z.tuple([z.literal('project'), z.literal('trigger')]),
    target: z.object({ kind: z.literal('inline'), definition: WorkflowDefinitionV1Schema }).strict(),
}).strict().refine(value => value.queryKey === getUsageQueryKey(value.query), {
    message: 'The digest must use the admitted usage query', path: ['queryKey'],
}));
export type UsageCoachDigestSuggestion = z.infer<typeof UsageCoachDigestSuggestionSchema>;

/** Existing Automation/Workflow owners choose destinations, cadence, admission and delivery. */
export function createUsageCoachDigestSuggestion(
    value: UsageQuery, period: Readonly<{ startMs: number; endMs: number }>,
): UsageCoachDigestSuggestion | undefined {
    const lookbackMs = period.endMs - period.startMs;
    if (lookbackMs <= 0) return undefined;
    const query = normalizeUsageQuery(value);
    return UsageCoachDigestSuggestionSchema.parse({
        kind: 'recurring_automation', queryKey: getUsageQueryKey(query), query, lookbackMs,
        actionId: 'workflow.trigger.add', requiredInputs: ['project', 'trigger'],
        target: { kind: 'inline', definition: {
            version: 1, defaults: {}, inputs: [],
            blocks: [
                agent('digest', 'Review recent usage', 'scout',
                    'Read the supplied usage query and lookbackMs. At execution time, query usage.query with the same filters and clauses, '
                    + 'replacing only period with { startMs: nowMs - lookbackMs, endMs: nowMs }, where nowMs is the current time. '
                    + 'Summarize the returned Coach findings, evidence and coverage. Keep reported, estimated, API-equivalent and invoice costs distinct. '
                    + 'State unavailable or insufficient evidence honestly. Do not infer model quality or guaranteed savings, inspect prompt content, '
                    + 'apply remedies or change settings. Return a concise usage digest.',
                    [literal(projectNativeJsonValueForTransport({ query, lookbackMs }))], true),
                { kind: 'action', id: 'notify', name: 'Notify me', actionId: 'notifications.notify_me',
                    input: { title: literal('Usage digest'), message: result('digest') } },
            ],
            finalOutput: result('digest'),
        } },
    });
}
