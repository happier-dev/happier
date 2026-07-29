import { z } from 'zod';

import { SessionIdSchema } from '../idsV1.js';

export const EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1 = 'external-session-status-demand-v1' as const;

// Native session lists currently keep all rendered row subscriptions through 200 rows.
// This ceiling admits that existing collector shape while bounding work independently of history size.
export const EXTERNAL_SESSION_STATUS_DEMAND_MAX_ENTRIES_V1 = 256;

const ExternalSessionStatusDemandRevisionV1Schema = z.number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const ExternalSessionStatusDemandMachineIdV1Schema = z.string().trim().min(1).max(256);
const ExternalSessionStatusDemandLinkGenerationV1Schema = z.string().trim().min(1).max(256);
const ExternalSessionStatusDemandClientConnectionIdV1Schema = z.string().trim().min(1).max(256);

export const ExternalSessionStatusDemandLevelV1Schema = z.enum(['loaded', 'visible', 'open']);
export type ExternalSessionStatusDemandLevelV1 = z.infer<typeof ExternalSessionStatusDemandLevelV1Schema>;

export const ExternalSessionStatusDemandEntryV1Schema = z.object({
  sessionId: SessionIdSchema,
  machineId: ExternalSessionStatusDemandMachineIdV1Schema,
  linkGeneration: ExternalSessionStatusDemandLinkGenerationV1Schema,
  demand: ExternalSessionStatusDemandLevelV1Schema,
}).strict();
export type ExternalSessionStatusDemandEntryV1 = z.infer<typeof ExternalSessionStatusDemandEntryV1Schema>;

function statusDemandEntryKey(entry: ExternalSessionStatusDemandEntryV1): string {
  return JSON.stringify([entry.machineId, entry.sessionId, entry.linkGeneration]);
}

function rejectDuplicateStatusDemandEntries(
  value: Readonly<{ entries: ReadonlyArray<ExternalSessionStatusDemandEntryV1> }>,
  context: z.RefinementCtx,
): void {
  const keys = new Set<string>();
  value.entries.forEach((entry, index) => {
    const key = statusDemandEntryKey(entry);
    if (keys.has(key)) {
      context.addIssue({
        code: 'custom',
        message: 'Duplicate external-session status-demand link',
        path: ['entries', index],
      });
      return;
    }
    keys.add(key);
  });
}

export const ExternalSessionStatusDemandReplaceV1Schema = z.object({
  v: z.literal(1),
  type: z.literal('replace'),
  revision: ExternalSessionStatusDemandRevisionV1Schema,
  entries: z.array(ExternalSessionStatusDemandEntryV1Schema)
    .max(EXTERNAL_SESSION_STATUS_DEMAND_MAX_ENTRIES_V1),
}).strict().superRefine(rejectDuplicateStatusDemandEntries);
export type ExternalSessionStatusDemandReplaceV1 = z.infer<typeof ExternalSessionStatusDemandReplaceV1Schema>;

const EXTERNAL_SESSION_STATUS_DEMAND_PRIORITY_V1 = {
  loaded: 0,
  visible: 1,
  open: 2,
} as const satisfies Record<ExternalSessionStatusDemandLevelV1, number>;

export function buildExternalSessionStatusDemandReplaceV1(input: Readonly<{
  revision: number;
  entries: ReadonlyArray<ExternalSessionStatusDemandEntryV1>;
}>): ExternalSessionStatusDemandReplaceV1 {
  const byLink = new Map<string, ExternalSessionStatusDemandEntryV1>();
  for (const rawEntry of input.entries) {
    const entry = ExternalSessionStatusDemandEntryV1Schema.parse(rawEntry);
    const key = statusDemandEntryKey(entry);
    const current = byLink.get(key);
    if (
      !current
      || EXTERNAL_SESSION_STATUS_DEMAND_PRIORITY_V1[entry.demand]
        > EXTERNAL_SESSION_STATUS_DEMAND_PRIORITY_V1[current.demand]
    ) {
      byLink.set(key, entry);
    }
  }

  return ExternalSessionStatusDemandReplaceV1Schema.parse({
    v: 1,
    type: 'replace',
    revision: input.revision,
    entries: [...byLink.values()].sort((left, right) => {
      const leftKey = statusDemandEntryKey(left);
      const rightKey = statusDemandEntryKey(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
  });
}

const ExternalSessionStatusDemandDaemonEntryV1Schema = ExternalSessionStatusDemandEntryV1Schema.omit({
  machineId: true,
});

const ExternalSessionStatusDemandDaemonReplaceV1Schema = z.object({
  v: z.literal(1),
  type: z.literal('replace'),
  clientConnectionId: ExternalSessionStatusDemandClientConnectionIdV1Schema,
  revision: ExternalSessionStatusDemandRevisionV1Schema,
  entries: z.array(ExternalSessionStatusDemandDaemonEntryV1Schema)
    .max(EXTERNAL_SESSION_STATUS_DEMAND_MAX_ENTRIES_V1),
}).strict();

const ExternalSessionStatusDemandDaemonDisconnectV1Schema = z.object({
  v: z.literal(1),
  type: z.literal('disconnect'),
  clientConnectionId: ExternalSessionStatusDemandClientConnectionIdV1Schema,
}).strict();

export const ExternalSessionStatusDemandDaemonMessageV1Schema = z.discriminatedUnion('type', [
  ExternalSessionStatusDemandDaemonReplaceV1Schema,
  ExternalSessionStatusDemandDaemonDisconnectV1Schema,
]);
export type ExternalSessionStatusDemandDaemonMessageV1 = z.infer<
  typeof ExternalSessionStatusDemandDaemonMessageV1Schema
>;

export function isExternalSessionStatusDemandRevisionNewerV1(
  currentRevision: number | null,
  nextRevision: number,
): boolean {
  const next = ExternalSessionStatusDemandRevisionV1Schema.parse(nextRevision);
  if (currentRevision === null) return true;
  const current = ExternalSessionStatusDemandRevisionV1Schema.parse(currentRevision);
  return next > current;
}
