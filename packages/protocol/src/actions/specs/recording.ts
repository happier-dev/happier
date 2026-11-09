import { createRecordingResultSchemas } from '../../recording/results.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { BrowserRecordingOutcomeReasonV1Schema, DaemonBrowserRecordingUnavailableReasonV1Schema,
  DaemonBrowserRecordingCleanupResultV1Schema } from '../../browser/recording/v1.js';

type Operation = 'start' | 'stop' | 'cancel' | 'status' | 'list' | 'discard' | 'cleanupExpired' | 'attachToComposer';
function byId<const I extends Record<Operation, string>, const V extends Record<Operation, unknown>>(ids: I, values: V) {
  return Object.fromEntries(Object.entries(ids).map(([operation, id]) => [id, values[operation as Operation]])) as {
    readonly [K in Operation as I[K]]: V[K];
  };
}

export function createRecordingActionSpecFamily<const I extends Record<Operation, string>,
  const Inputs extends Record<Operation, z.ZodMiniType>, R extends z.ZodMiniType>(input: {
  ids: I; inputs: Inputs; session: R; subject: 'browser' | 'computer';
}) {
  const results = createRecordingResultSchemas(input.session, BrowserRecordingOutcomeReasonV1Schema,
    DaemonBrowserRecordingUnavailableReasonV1Schema);
  return {
    inputSchemas: byId(input.ids, input.inputs),
    outputSchemas: byId(input.ids, {
      start: results.start, stop: results.stop,
      cancel: results.terminal, discard: results.terminal,
      status: lazyZodSchema(() => z.nullable(input.session)),
      list: lazyZodSchema(() => z.array(input.session)),
      cleanupExpired: DaemonBrowserRecordingCleanupResultV1Schema,
      attachToComposer: lazyZodSchema(() => z.strictObject({ ok: z.literal(true), attachmentId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)) })),
    }),
    titles: byId(input.ids, {
      start: `Start ${input.subject} recording`, stop: `Stop ${input.subject} recording`, cancel: `Cancel ${input.subject} recording`,
      status: `Get ${input.subject} recording status`, list: `List ${input.subject} recordings for ${input.subject === 'browser' ? 'view' : 'target'}`,
      discard: `Discard ${input.subject} recording`, cleanupExpired: `Clean up expired ${input.subject} recordings`,
      attachToComposer: `Attach ${input.subject} recording to composer`,
    }),
    approvalPolicies: byId(input.ids, {
      start: input.subject === 'computer' ? { agentDefault: 'egress' as const, computerConsent: true as const } : {},
      attachToComposer: { agentDefault: 'egress' as const },
      stop: {}, cancel: {}, status: {}, list: {}, discard: {}, cleanupExpired: {},
    }),
    confirmationFacts: byId(input.ids, { start: {}, stop: {}, cancel: {}, status: {}, list: {}, cleanupExpired: {}, attachToComposer: {},
      discard: { confirmVerb: { key: 'common.discard', fallback: 'Discard' }, irreversible: true },
    }),
  };
}
