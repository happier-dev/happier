import {
  seedInputByFieldHints, readInputPath, writeInputPath,
  type ActionFormFieldHint, type ActionFormHints,
} from '@happier-dev/plugin-sdk/actions';
import type { ForgeCiTriggerDefinitionV1, ForgeCiTriggerInputV1, ForgeCiTriggerValuesV1 } from '@happier-dev/triage-protocol/ci/v1';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

export type ForgeCiTriggerOptionsV1 = Readonly<{ kind: 'available'; values: readonly string[] }>
  | Readonly<{ kind: 'loading' }> | Readonly<{ kind: 'unavailable'; failure: TriageSourceFailureV1 }>;
export type ForgeCiTriggerFieldIssueV1 = Readonly<{
  name: string;
  reason: 'options_empty' | 'options_loading' | 'options_unavailable' | 'removed_field' | 'changed_options' | 'changed_type' | 'invalid_value' | 'required_value' | 'not_dispatchable';
  failure?: TriageSourceFailureV1;
}>;
export type ForgeCiTriggerFieldBindingV1 = Readonly<{ name: string; path: string; type: ForgeCiTriggerInputV1['type'] }>;
export type ForgeCiTriggerFieldsV1 = Readonly<{
  definition: ForgeCiTriggerDefinitionV1; formHints: ActionFormHints;
  bindings: readonly ForgeCiTriggerFieldBindingV1[]; unavailable: readonly ForgeCiTriggerFieldIssueV1[]; nextSlot: number;
}>;
export type ForgeCiTriggerDraftV1 = Readonly<{
  projection: ForgeCiTriggerFieldsV1; input: Readonly<Record<string, unknown>>;
  /** Explicit native values only. Displaying a default never turns it into a dispatch operand. */
  values: Readonly<Record<string, unknown>>; issues: readonly ForgeCiTriggerFieldIssueV1[];
}>;

function sameArray<T>(left: readonly T[] | undefined, right: readonly T[] | undefined, equal: (a: T, b: T) => boolean = Object.is): boolean {
  return left === right || left !== undefined && right !== undefined && left.length === right.length && left.every((value, i) => equal(value, right[i]!));
}
function sameField(left: ActionFormFieldHint, right: ActionFormFieldHint): boolean {
  return left.path === right.path && left.widget === right.widget && left.title === right.title && left.required === right.required
    && left.description === right.description && left.defaultValue === right.defaultValue
    && sameArray(left.options, right.options, (a, b) => a.value === b.value && a.label === b.label);
}
function sameDefinition(left: ForgeCiTriggerDefinitionV1, right: ForgeCiTriggerDefinitionV1): boolean {
  return left.workflowId === right.workflowId && left.ref === right.ref && left.revision === right.revision
    && left.dispatchable === right.dispatchable && left.description === right.description && left.path === right.path
    && sameArray(left.jobs, right.jobs, (a, b) => a.id === b.id && sameArray(a.needs, b.needs)
      && (a.runsOn === 'dynamic' || b.runsOn === 'dynamic' ? a.runsOn === b.runsOn : sameArray(a.runsOn, b.runsOn)))
    && sameArray(left.triggers, right.triggers) && sameArray(left.inputs, right.inputs, (a, b) => a.name === b.name && a.type === b.type
      && a.required === b.required && a.description === b.description && a.default === b.default && sameArray(a.options, b.options));
}

/** Pure mapping to the canonical Form vocabulary. The native name never enters an input path. */
export function projectForgeCiTriggerFieldsV1(input: Readonly<{
  definition: ForgeCiTriggerDefinitionV1; environmentOptions?: ForgeCiTriggerOptionsV1; baseline?: ForgeCiTriggerFieldsV1;
}>): ForgeCiTriggerFieldsV1 {
  const { definition } = input;
  const baseline = input.baseline?.definition.workflowId === definition.workflowId ? input.baseline : undefined;
  const oldBindings = new Map(baseline?.bindings.map(binding => [binding.name, binding]));
  const oldFields = new Map(baseline?.formHints.fields.map(field => [field.path, field]));
  const bindings: ForgeCiTriggerFieldBindingV1[] = [];
  const fields: ActionFormFieldHint[] = [];
  const unavailable: ForgeCiTriggerFieldIssueV1[] = [];
  let nextSlot = baseline?.nextSlot ?? 0;
  for (const native of definition.inputs) {
    const oldBinding = oldBindings.get(native.name);
    const binding = oldBinding?.type === native.type ? oldBinding : { name: native.name, type: native.type, path: oldBinding?.path ?? `fields.f${nextSlot++}` };
    bindings.push(binding);
    let options: readonly string[] | undefined;
    if (native.type === 'choice') options = native.options ?? [];
    if (native.type === 'environment') {
      const source = input.environmentOptions;
      if (native.options !== undefined) options = native.options;
      else if (!source || source.kind === 'loading') { unavailable.push({ name: native.name, reason: 'options_loading' }); continue; }
      else if (source.kind === 'unavailable') { unavailable.push({ name: native.name, reason: 'options_unavailable', failure: source.failure }); continue; }
      else options = source.values;
    }
    if (options?.length === 0) { unavailable.push({ name: native.name, reason: 'options_empty' }); continue; }
    const field: ActionFormFieldHint = {
      path: binding.path, title: native.name,
      widget: native.type === 'string' ? 'text' : native.type === 'choice' || native.type === 'environment' ? 'select' : native.type,
      ...(native.description === undefined ? {} : { description: native.description }),
      ...(native.required === undefined ? {} : { required: native.required }),
      ...(native.default === undefined ? {} : { defaultValue: native.default }),
      ...(options === undefined ? {} : { options: options.map(value => ({ value, label: value })) }),
    };
    const old = oldFields.get(field.path);
    fields.push(old && sameField(old, field) ? old : field);
  }
  const sameFields = baseline !== undefined && sameArray(baseline.formHints.fields, fields);
  const sameBindings = baseline !== undefined && sameArray(baseline.bindings, bindings);
  const sameIssues = baseline !== undefined && sameArray(baseline.unavailable, unavailable, (a, b) => a.name === b.name && a.reason === b.reason && a.failure === b.failure);
  if (baseline && sameFields && sameIssues && sameDefinition(baseline.definition, definition)) return baseline;
  return { definition, formHints: sameFields ? baseline.formHints : { fields }, bindings: sameBindings ? baseline.bindings : bindings,
    unavailable: sameIssues ? baseline.unavailable : unavailable, nextSlot };
}

function optionsFor(projection: ForgeCiTriggerFieldsV1, name: string): readonly string[] | undefined {
  const binding = projection.bindings.find(value => value.name === name);
  const field = projection.formHints.fields.find(value => value.path === binding?.path);
  return field?.options?.flatMap(option => typeof option.value === 'string' ? [option.value] : []);
}

/** Reconciles only this open form. Review issues remain until a deliberate replacement/edit acknowledges them. */
export function reconcileForgeCiTriggerDraftV1(input: Readonly<{
  projection: ForgeCiTriggerFieldsV1; baseline?: ForgeCiTriggerDraftV1; values?: ForgeCiTriggerValuesV1;
}>): ForgeCiTriggerDraftV1 {
  const { projection } = input;
  if (input.baseline?.projection === projection && input.values === undefined) return input.baseline;
  const baseline = input.baseline?.projection.definition.workflowId === projection.definition.workflowId ? input.baseline : undefined;
  // Definition metadata has no authority over an open form's edited/defaulted values.
  if (baseline && input.values === undefined && projection.formHints === baseline.projection.formHints
    && projection.bindings === baseline.projection.bindings) return { ...baseline, projection };
  const explicit = input.values ?? baseline?.values ?? {};
  const values: Record<string, unknown> = {};
  const issues: ForgeCiTriggerFieldIssueV1[] = input.values === undefined ? [...(baseline?.issues ?? [])] : [];
  const definitions = new Map(projection.definition.inputs.map(field => [field.name, field]));
  for (const [name, value] of Object.entries(explicit)) {
    const field = definitions.get(name);
    if (!field) { issues.push({ name, reason: 'removed_field' }); continue; }
    const previous = baseline?.projection.definition.inputs.find(candidate => candidate.name === name);
    if (input.values === undefined && previous && previous.type !== field.type) { issues.push({ name, reason: 'changed_type' }); continue; }
    Object.defineProperty(values, name, { value, enumerable: true, configurable: true, writable: true });
    const options = optionsFor(projection, name);
    if (input.values === undefined && options !== undefined && !options.includes(typeof value === 'string' ? value : '')) issues.push({ name, reason: 'changed_options' });
  }
  let formInput = seedInputByFieldHints({ inputHints: projection.formHints }, {});
  for (const binding of projection.bindings) if (Object.hasOwn(values, binding.name)) formInput = writeInputPath(formInput, binding.path, values[binding.name]);
  return { projection, input: formInput, values, issues: issues.filter((issue, i) => issues.findIndex(other => other.name === issue.name && other.reason === issue.reason) === i) };
}

/** Form already owns numeric draft parsing; incomplete values remain drafts and cannot dispatch. */
export function updateForgeCiTriggerDraftV1(draft: ForgeCiTriggerDraftV1, input: Readonly<Record<string, unknown>>): ForgeCiTriggerDraftV1 {
  const values = { ...draft.values };
  const edited = new Set<string>();
  for (const binding of draft.projection.bindings) {
    const next = readInputPath(input, binding.path);
    if (Object.is(readInputPath(draft.input, binding.path), next)) continue;
    edited.add(binding.name);
    if (next === undefined) delete values[binding.name];
    else Object.defineProperty(values, binding.name, { value: next, enumerable: true, configurable: true, writable: true });
  }
  return edited.size === 0 ? draft : { projection: draft.projection, input, values, issues: draft.issues.filter(issue => !edited.has(issue.name)) };
}

export function readForgeCiTriggerValuesV1(draft: ForgeCiTriggerDraftV1): Readonly<{ kind: 'value'; value: ForgeCiTriggerValuesV1 }>
  | Readonly<{ kind: 'unavailable'; issues: readonly ForgeCiTriggerFieldIssueV1[] }> {
  const issues: ForgeCiTriggerFieldIssueV1[] = [...draft.issues, ...draft.projection.unavailable];
  if (!draft.projection.definition.dispatchable) issues.push({ name: '', reason: 'not_dispatchable' });
  const entries: Array<[string, string | boolean | number]> = [];
  for (const field of draft.projection.definition.inputs) {
    const value = draft.values[field.name];
    if (!Object.hasOwn(draft.values, field.name) || value === undefined) {
      if (field.required && field.default === undefined) issues.push({ name: field.name, reason: 'required_value' });
      continue;
    }
    const options = optionsFor(draft.projection, field.name);
    const valid = field.type === 'boolean' ? typeof value === 'boolean'
      : field.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : typeof value === 'string' && (options === undefined || options.includes(value));
    if (!valid) { issues.push({ name: field.name, reason: 'invalid_value' }); continue; }
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') entries.push([field.name, value]);
  }
  return issues.length > 0 ? { kind: 'unavailable', issues } : { kind: 'value', value: Object.fromEntries(entries) };
}

/** The loader supplies the exact request's ref/revision, rather than admitting a late selected-ref result. */
export function admitForgeCiTriggerDefinitionV1(
  expected: Readonly<{ workflowId: string; ref: string; revision: string }>, definition: ForgeCiTriggerDefinitionV1,
): ForgeCiTriggerDefinitionV1 | null {
  return expected.workflowId === definition.workflowId && expected.ref === definition.ref && expected.revision === definition.revision ? definition : null;
}
