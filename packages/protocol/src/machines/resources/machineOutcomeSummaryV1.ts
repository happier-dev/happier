import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { computeCanonicalDomainSeparatedDigest } from '../../crypto/canonicalDigest.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { BackupOutcomeEventV1Schema, MachinePressureEventV1Schema,
  type BackupOutcomeEventV1, type MachinePressureEventV1 } from '../../plugins/events/machineServiceObservationV1.js';
import { ACCOUNT_JSON_KV_PREFIXES } from '../../account/accountJsonKv.js';
import type { AccountJsonKvCollectionPort } from '../../todos/todoActionOperationsV1.js';

export const MACHINE_OUTCOME_SUMMARY_PREFIX = ACCOUNT_JSON_KV_PREFIXES.workspace + 'machine-outcome:v1:';
export type MachineResourceOutcomeV1 = BackupOutcomeEventV1 | MachinePressureEventV1;
type Outcome = MachineResourceOutcomeV1;
export const MachineResourceOutcomeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [BackupOutcomeEventV1Schema, MachinePressureEventV1Schema]));
export const MachineResourcesOutcomesReadInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: z.string().check(z.trim(), z.minLength(1)), keys: z.optional(z.array(z.string())),
}));
export const MachineResourcesOutcomesReadResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ready'), outcomes: z.array(MachineResourceOutcomeV1Schema) }),
  z.strictObject({ status: z.literal('unavailable') }),
]));
const summary = lazyZodSchema(() => createStoredReadSchema(z.strictObject({ v: z.literal(1),
  outcomes: z.array(MachineResourceOutcomeV1Schema),
})));
const time = (outcome: Outcome) => outcome.kind === 'backup' ? outcome.occurredAt : outcome.episode.at;
const slot = (outcome: Outcome) => outcome.kind === 'backup' ? 'backup'
  : createCanonicalJsonSigningInput([outcome.episode.rule, outcome.episode.volumeId ?? null]);
const summaryKey = (outcome: Outcome) => MACHINE_OUTCOME_SUMMARY_PREFIX + outcome.kind + ':'
  + computeCanonicalDomainSeparatedDigest('happier.machine.outcome-summary.v1', [outcome.serverId, outcome.machineId,
    ...(outcome.kind === 'backup' ? [outcome.environmentId] : [])]);
/** The KV projection and its readers share physical row and native slot identity. */
export function machineOutcomeSummaryAddress(outcome: Outcome): Readonly<{ key: string; slot: string }> {
  return { key: summaryKey(outcome), slot: slot(outcome) };
}
/** Recovery folds retained native history before touching the Account transport. */
export function latestMachineOutcomeSummaries(outcomes: readonly Outcome[]): readonly Outcome[] {
  const latest = new Map<string, Outcome>();
  for (const outcome of outcomes) {
    const key = createCanonicalJsonSigningInput([summaryKey(outcome), slot(outcome)]);
    const previous = latest.get(key);
    if (!previous || time(previous) < time(outcome)) latest.set(key, outcome);
  }
  return [...latest.values()];
}
const open = (value: unknown): readonly Outcome[] => value === null ? [] : summary.parse(value).outcomes;

/** A refreshable latest-fact projection; the native operation/alert owns history.
 * The Account-mode KV transport owns encryption and storage admission. */
export async function retainMachineOutcomeSummary(transport: AccountJsonKvCollectionPort, outcome: Outcome): Promise<void> {
  const key = summaryKey(outcome);
  let row = await transport.read(key);
  for (;;) {
    const outcomes = open(row.value);
    const previous = outcomes.find(candidate => slot(candidate) === slot(outcome));
    if (previous && time(previous) >= time(outcome)) return;
    const next = [...outcomes.filter(candidate => slot(candidate) !== slot(outcome)), outcome];
    const result = await transport.mutate([{ key, version: row.version, value: { v: 1, outcomes: next } }]);
    if (result.success) return;
    const conflict = result.errors.find(candidate => candidate.key === key);
    if (!conflict) throw new Error('Account KV mutation omitted the conflicting Machine summary');
    row = conflict;
  }
}

/** Adoption reads this one prefix once; subsequent pushes name exact changed keys. */
export async function readMachineOutcomeSummaries(transport: Pick<AccountJsonKvCollectionPort, 'read' | 'list'>,
  keys?: readonly string[]): Promise<readonly Outcome[]> {
  const rows = keys === undefined ? await transport.list(MACHINE_OUTCOME_SUMMARY_PREFIX)
    : await Promise.all([...new Set(keys.filter(key => key.startsWith(MACHINE_OUTCOME_SUMMARY_PREFIX)))]
      .map(async key => ({ key, ...await transport.read(key) })));
  return rows.flatMap(row => open(row.value));
}
