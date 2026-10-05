import { z } from 'zod';
import { normalizeStrictJsonValue, StrictJsonValueSchema, type JsonValue } from '../json/strictJsonValue.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import type { InputFieldHint } from '../inputs/inputFields.js';
import { InputPathSchema } from '../inputs/inputPredicates.js';
import { resolveEffectiveInputFields, writeInputPath } from '../inputs/inputFieldRuntime.js';
import { ConnectedAccountPurposeIdSchema } from '../connect/connectedAccountPurposeIdentity.js';
import { WidgetDefinitionV1Schema } from './widgetDefinitionV1.js';

const id = z.string().trim().min(1);
export const WidgetDefinitionRefV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('installed'), surface: asProtocolZod(PluginContributionIdentityV1Schema) }).strict(),
  z.object({ kind: z.literal('builtin'), id }).strict(),
  z.object({ kind: z.literal('artifact'), artifactId: id }).strict(),
  // Explicit Session audience copy. It never makes an Account-private Artifact readable.
  z.object({ kind: z.literal('inline'), definition: z.lazy(() => WidgetDefinitionV1Schema) }).strict(),
]);
export type WidgetDefinitionRefV1 = z.infer<typeof WidgetDefinitionRefV1Schema>;
export const WidgetInputBindingV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('value'), value: StrictJsonValueSchema }).strict(),
  z.object({ kind: z.literal('context'), slot: id }).strict(),
  z.object({ kind: z.literal('viewer'), purpose: ConnectedAccountPurposeIdSchema }).strict(),
]);
export type WidgetInputBindingV1 = z.infer<typeof WidgetInputBindingV1Schema>;
export const WidgetInputBindingsV1Schema = z.record(InputPathSchema, WidgetInputBindingV1Schema);
export type WidgetInputBindingsV1 = z.infer<typeof WidgetInputBindingsV1Schema>;
export const WidgetInstanceV1Schema = z.object({
  v: z.literal(1), id, definition: WidgetDefinitionRefV1Schema,
  bindings: WidgetInputBindingsV1Schema, displayName: id.optional(),
}).strict();
export type WidgetInstanceV1 = z.infer<typeof WidgetInstanceV1Schema>;

/** Identity only: a surface reference never supplies data access or an executable target. */
export const WidgetSurfaceRefV1Schema = z.object({
  serverId: id, accountId: id,
  owner: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('home') }).strict(),
    z.object({ kind: z.literal('sessionBoard'), sessionId: id }).strict(),
    z.object({ kind: z.literal('companion'), sessionId: id }).strict(),
    z.object({ kind: z.literal('workBoard'), boardId: id }).strict(),
    z.object({ kind: z.literal('project'), projectId: id }).strict(),
    z.object({ kind: z.literal('pluginArea'), pluginId: id, pageId: id, area: id }).strict(),
  ]),
}).strict();
export type WidgetSurfaceRefV1 = z.infer<typeof WidgetSurfaceRefV1Schema>;
export const WidgetInstanceRefV1Schema = z.object({ surface: WidgetSurfaceRefV1Schema, instanceId: id }).strict();
export type WidgetInstanceRefV1 = z.infer<typeof WidgetInstanceRefV1Schema>;

export type WidgetInputIssueV1 = Readonly<{
  path: string; status: 'selection_required' | 'invalid' | 'unavailable' | 'denied'; reasonCode: string;
}>;
export type WidgetBindingResolutionV1 =
  | Readonly<{ status: 'ready'; input: Readonly<Record<string, JsonValue>> }>
  | Readonly<{ status: WidgetInputIssueV1['status']; fields: readonly WidgetInputIssueV1[] }>;
export type WidgetBindingResolutionInputV1 = Readonly<{
  instance: WidgetInstanceV1; fields: readonly InputFieldHint[];
  context: Readonly<Record<string, readonly JsonValue[]>>;
  viewerValues: Readonly<Record<string, JsonValue>>;
  /** Read-only intent projection for discovering an exact target; never full execution admission. */
  resolvePaths?: readonly string[];
  validateValue(field: InputFieldHint, value: JsonValue): Readonly<{ status: 'valid' }> | Readonly<{
    status: 'invalid' | 'unavailable' | 'denied'; reasonCode: string;
  }>;
}>;

/** Resolve intent, never credentials or authority. Host admission runs again for every effect. */
export function resolveWidgetBindingsV1(options: WidgetBindingResolutionInputV1): WidgetBindingResolutionV1 {
  const instance = WidgetInstanceV1Schema.parse(options.instance);
  const paths = options.resolvePaths ? new Set(options.resolvePaths) : null;
  const fields = paths ? options.fields.filter(field => paths.has(field.path)) : options.fields;
  let input: Record<string, unknown> = {};
  const values = new Map<string, JsonValue>();
  const unresolved = new Map<string, string>();
  const issues: WidgetInputIssueV1[] = [];
  const declared = new Set(fields.map((field) => field.path));
  for (const path of paths ?? []) {
    if (!declared.has(path)) issues.push({ path, status: 'invalid', reasonCode: 'widget_input_undeclared' });
  }
  for (const field of fields) {
    const binding = instance.bindings[field.path];
    if (!binding) { unresolved.set(field.path, 'widget_input_missing'); continue; }
    if (field.widget === 'secret') {
      issues.push({ path: field.path, status: 'invalid', reasonCode: 'widget_secret_binding_forbidden' });
      continue;
    }
    let value: JsonValue | undefined;
    if (binding.kind === 'value') value = binding.value;
    else if (binding.kind === 'viewer') value = options.viewerValues[field.path];
    else {
      const candidates = options.context[binding.slot] ?? [];
      if (candidates.length === 1) value = candidates[0];
      else unresolved.set(field.path, candidates.length ? 'widget_context_ambiguous' : 'widget_context_missing');
    }
    if (value === undefined) {
      if (!unresolved.has(field.path)) unresolved.set(field.path, 'widget_viewer_selection_missing');
      continue;
    }
    values.set(field.path, value);
    input = writeInputPath(input, field.path, value);
    // Visibility controls the form, not admission of values forwarded to execution.
    const validation = options.validateValue(field, value);
    if (validation.status !== 'valid') issues.push({ path: field.path, ...validation });
  }
  for (const field of resolveEffectiveInputFields({ inputHints: { fields: [...fields] } }, input)) {
    const binding = instance.bindings[field.path];
    if (field.widget === 'secret' && binding) continue;
    const value = values.get(field.path);
    if (value === undefined) {
      if (field.required || binding) issues.push({ path: field.path, status: 'selection_required', reasonCode: unresolved.get(field.path) ?? 'widget_input_missing' });
      continue;
    }
  }
  for (const path of Object.keys(instance.bindings)) {
    if (paths && !paths.has(path)) continue;
    if (!declared.has(path)) issues.push({ path, status: 'invalid', reasonCode: 'widget_input_undeclared' });
  }
  if (issues.length) {
    const status = (['denied', 'invalid', 'unavailable', 'selection_required'] as const)
      .find((candidate) => issues.some((issue) => issue.status === candidate))!;
    return { status, fields: issues };
  }
  return { status: 'ready', input: normalizeStrictJsonValue(input) as Readonly<Record<string, JsonValue>> };
}
