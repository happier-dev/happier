import { z } from 'zod';

import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { MachinePoolIdV1Schema } from '../machines/pools/v1.js';
import { ProjectServicePlacementV1Schema } from './projectServicePlacementV1.js';

const IdentifierSchema = lazyZodSchema(() => z.string().trim().min(1));
// Manifest declaration names are exact identities; trimming dictionary keys can merge two entries.
const DeclarationNameSchema = lazyZodSchema(() => z.string().min(1));

/** Account is supplied by the authenticated Home transport, never this address. */
export const WorkspaceExecutionConfigAddressV1Schema = lazyZodSchema(() => z.object({
  serverId: IdentifierSchema,
  refId: IdentifierSchema,
}).strict());
export type WorkspaceExecutionConfigAddressV1 = z.infer<typeof WorkspaceExecutionConfigAddressV1Schema>;

export const WorkerDestinationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('machine'), machineId: IdentifierSchema }).strict(),
  z.object({ kind: z.literal('pool'), poolId: MachinePoolIdV1Schema, selection: z.enum(['automatic', 'ask']) }).strict(),
]));
export type WorkerDestinationV1 = z.infer<typeof WorkerDestinationV1Schema>;

export const ProjectExecutionChoiceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('primary') }).strict(),
  z.object({ kind: z.literal('workers'), destination: WorkerDestinationV1Schema }).strict(),
]));
export type ProjectExecutionChoiceV1 = z.infer<typeof ProjectExecutionChoiceV1Schema>;

const PreferenceFieldsSchema = lazyZodSchema(() => z.object({
  unavailable: z.enum(['ask', 'primary', 'fail']),
  allowAdHoc: z.boolean(),
  scriptOverrides: z.record(DeclarationNameSchema, z.enum(['primary', 'workers'])),
}));
const DisabledPreferenceSchema = lazyZodSchema(() => PreferenceFieldsSchema.extend({
  enabled: z.literal(false), destination: WorkerDestinationV1Schema.optional(),
}).strict());
const EnabledPreferenceSchema = lazyZodSchema(() => PreferenceFieldsSchema.extend({
  enabled: z.literal(true), destination: WorkerDestinationV1Schema,
}).strict());

/** Finite preference mutation inputs deliberately have no service field. */
export const WorkspaceWorkerPreferenceV1Schema = lazyZodSchema(() => z.discriminatedUnion('enabled', [
  DisabledPreferenceSchema, EnabledPreferenceSchema,
]));
export type WorkspaceWorkerPreferenceV1 = z.infer<typeof WorkspaceWorkerPreferenceV1Schema>;
export const WorkspaceWorkerPreferenceV1StoredSchema = createStoredReadSchema(WorkspaceWorkerPreferenceV1Schema);

const ServicesSchema = lazyZodSchema(() => z.record(DeclarationNameSchema, ProjectServicePlacementV1Schema));
export const WorkspaceExecutionSettingsV1Schema = lazyZodSchema(() => z.discriminatedUnion('enabled', [
  DisabledPreferenceSchema.extend({ services: ServicesSchema }),
  EnabledPreferenceSchema.extend({ services: ServicesSchema }),
]));
export type WorkspaceExecutionSettingsV1 = z.infer<typeof WorkspaceExecutionSettingsV1Schema>;
export const WorkspaceExecutionSettingsV1StoredSchema = createStoredReadSchema(WorkspaceExecutionSettingsV1Schema);

export function createDefaultWorkspaceWorkerPreferenceV1(): WorkspaceWorkerPreferenceV1 {
  return { enabled: false, unavailable: 'ask', allowAdHoc: false, scriptOverrides: {} };
}

export function createDefaultWorkspaceExecutionSettingsV1(): WorkspaceExecutionSettingsV1 {
  return { ...createDefaultWorkspaceWorkerPreferenceV1(), services: {} };
}

export const WorkspaceExecutionConfigRevisionV1Schema = lazyZodSchema(() => z.union([
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.literal('absent'),
]));
export type WorkspaceExecutionConfigRevisionV1 = z.infer<typeof WorkspaceExecutionConfigRevisionV1Schema>;
export const WorkspaceWorkerPreferenceExpectationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('absent') }).strict(),
  z.object({ kind: z.literal('value'), value: WorkspaceWorkerPreferenceV1Schema }).strict(),
]));
export type WorkspaceWorkerPreferenceExpectationV1 = z.infer<typeof WorkspaceWorkerPreferenceExpectationV1Schema>;

const PreferenceObservationSchema = lazyZodSchema(() => z.object({
  preference: WorkspaceWorkerPreferenceV1Schema,
  revision: WorkspaceExecutionConfigRevisionV1Schema,
  provenance: z.enum(['default', 'saved']),
}));
export const WorkspaceWorkerPreferenceReadResultV1Schema = lazyZodSchema(() => z.union([
  PreferenceObservationSchema.extend({ status: z.literal('ready') }).strict(),
  z.object({ status: z.enum(['locked', 'invalid', 'unavailable']) }).strict(),
]));
export type WorkspaceWorkerPreferenceReadResultV1 = z.infer<typeof WorkspaceWorkerPreferenceReadResultV1Schema>;
export const WorkspaceWorkerPreferenceMutationResultV1Schema = lazyZodSchema(() => z.union([
  PreferenceObservationSchema.extend({ status: z.enum(['applied', 'satisfied', 'unchanged', 'conflict']) }).strict(),
  z.object({ status: z.enum(['outcomeUnknown', 'cancelled', 'locked', 'invalid', 'unavailable']) }).strict(),
]));
export type WorkspaceWorkerPreferenceMutationResultV1 = z.infer<typeof WorkspaceWorkerPreferenceMutationResultV1Schema>;

/** Extract only the finite preference; service intents retain their separate namespace. */
export function projectWorkspaceWorkerPreferenceV1(value: WorkspaceExecutionSettingsV1): WorkspaceWorkerPreferenceV1 {
  const { services: _services, ...preference } = value;
  return preference;
}

function destinationEqual(left: WorkerDestinationV1 | undefined, right: WorkerDestinationV1 | undefined): boolean {
  if (!left || !right) return left === right;
  if (left.kind !== right.kind) return false;
  return left.kind === 'machine'
    ? right.kind === 'machine' && left.machineId === right.machineId
    : right.kind === 'pool' && left.poolId === right.poolId && left.selection === right.selection;
}

export function workspaceWorkerPreferencesEqualV1(left: WorkspaceWorkerPreferenceV1, right: WorkspaceWorkerPreferenceV1): boolean {
  return left.enabled === right.enabled && left.unavailable === right.unavailable && left.allowAdHoc === right.allowAdHoc
    && destinationEqual(left.destination, right.destination)
    && Object.keys(left.scriptOverrides).length === Object.keys(right.scriptOverrides).length
    && Object.entries(left.scriptOverrides).every(([key, value]) => Object.hasOwn(right.scriptOverrides, key) && right.scriptOverrides[key] === value);
}

export function projectExecutionChoicesEqualV1(left: ProjectExecutionChoiceV1, right: ProjectExecutionChoiceV1): boolean {
  return left.kind === 'primary' ? right.kind === 'primary'
    : right.kind === 'workers' && destinationEqual(left.destination, right.destination);
}

export type WorkspaceWorkerPreferenceComparisonV1 = Readonly<{
  status: 'apply'; value: WorkspaceExecutionSettingsV1;
}> | Readonly<{ status: 'unchanged' | 'satisfied' | 'conflict'; value: WorkspaceExecutionSettingsV1 | null }>;

/** Compare one semantic field against current row content, preserving every service sibling. */
export function compareWorkspaceWorkerPreferenceMutationV1(input: Readonly<{
  current: WorkspaceExecutionSettingsV1 | null;
  expected: WorkspaceWorkerPreferenceExpectationV1;
  next: WorkspaceWorkerPreferenceV1 | null;
}>): WorkspaceWorkerPreferenceComparisonV1 {
  const current = input.current === null ? createDefaultWorkspaceWorkerPreferenceV1() : projectWorkspaceWorkerPreferenceV1(input.current);
  const next = input.next ?? createDefaultWorkspaceWorkerPreferenceV1();
  const matchesExpected = input.expected.kind === 'absent'
    ? workspaceWorkerPreferencesEqualV1(current, createDefaultWorkspaceWorkerPreferenceV1())
    : input.current !== null && workspaceWorkerPreferencesEqualV1(current, input.expected.value);
  if (workspaceWorkerPreferencesEqualV1(current, next)) {
    return { status: matchesExpected ? 'unchanged' : 'satisfied', value: input.current };
  }
  if (!matchesExpected) return { status: 'conflict', value: input.current };
  return { status: 'apply', value: { ...next, services: input.current?.services ?? {} } };
}

export type ProjectWorkerPreferenceAvailabilityV1 = Readonly<{ status: 'ready'; value: WorkspaceWorkerPreferenceV1 }>
  | Readonly<{ status: 'absent' | 'locked' | 'invalid' | 'unavailable' }>;
export type ProjectExecutionChoiceResolutionV1 = Readonly<{
  status: 'resolved'; choice: ProjectExecutionChoiceV1;
  provenance: 'declaration' | 'invocation' | 'script' | 'workspace' | 'workflow' | 'default';
}> | Readonly<{ status: 'refused'; reason: 'primary_only' | 'preferences_unavailable' | 'ad_hoc_disabled' | 'destination_missing' | 'override_requires_review' }>;

/** Placement precedence is advisory. Exact target acceptance and Action approval stay with their owners. */
export function resolveProjectExecutionChoiceV1(input: Readonly<{
  execution: 'primary' | 'portable'; scriptName?: string; adHoc?: boolean;
  invocation?: ProjectExecutionChoiceV1; sourceMachineId?: string; acceptedMachineId?: string; reviewedOverride?: boolean;
  preference: ProjectWorkerPreferenceAvailabilityV1;
}>): ProjectExecutionChoiceResolutionV1 {
  if (input.execution === 'primary' && input.invocation?.kind === 'workers') return { status: 'refused', reason: 'primary_only' };
  if (input.preference.status !== 'ready' && input.preference.status !== 'absent') return { status: 'refused', reason: 'preferences_unavailable' };
  const preference = input.preference.status === 'ready' ? input.preference.value : createDefaultWorkspaceWorkerPreferenceV1();
  if (input.adHoc && !preference.allowAdHoc) return { status: 'refused', reason: 'ad_hoc_disabled' };
  if (input.execution === 'primary') return { status: 'resolved', choice: { kind: 'primary' }, provenance: 'declaration' };
  if (input.acceptedMachineId !== undefined && !input.reviewedOverride) {
    const baseline: ProjectExecutionChoiceV1 = input.acceptedMachineId === input.sourceMachineId
      ? { kind: 'primary' }
      : { kind: 'workers', destination: { kind: 'machine', machineId: input.acceptedMachineId } };
    if (input.invocation && !projectExecutionChoicesEqualV1(input.invocation, baseline)) {
      return { status: 'refused', reason: 'override_requires_review' };
    }
    return { status: 'resolved', choice: baseline, provenance: 'workflow' };
  }
  if (input.invocation) return { status: 'resolved', choice: input.invocation, provenance: 'invocation' };
  const override = input.scriptName === undefined ? undefined : Object.hasOwn(preference.scriptOverrides, input.scriptName)
    ? preference.scriptOverrides[input.scriptName] : undefined;
  if (override === 'primary') return { status: 'resolved', choice: { kind: 'primary' }, provenance: 'script' };
  if (override === 'workers' || preference.enabled) {
    if (preference.destination === undefined) return { status: 'refused', reason: 'destination_missing' };
    return { status: 'resolved', choice: { kind: 'workers', destination: preference.destination }, provenance: override === 'workers' ? 'script' : 'workspace' };
  }
  return { status: 'resolved', choice: { kind: 'primary' }, provenance: 'default' };
}
