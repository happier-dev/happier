import { PublicProfilePolicyV1Schema, PublicProfileSnapshotV1Schema, PublicProfileMetadataV1Schema, PublicProfileIdentityV1Schema,
  type PublicProfilePolicyV1, type PublicProfileSnapshotV1, type PublicProfileField, type PublicUsageFactsV1,
  type PublicProfileMetadataV1, type PublicProfileIdentityV1 } from './publicProfile.js';
import { PublicProfileViewV1Schema, PublicProfileContextV1Schema, type PublicProfileViewV1, type PublicProfileContextV1, type PublicProfileAppearanceV1,
  type PublicProfilePreparedAppearanceV1, PublicProfileLocalPreviewViewV1Schema,
  type PublicProfileLocalPreviewViewV1 } from './publicProfilePublication.js';
import { PublicProfileLayoutV1Schema, type PublicProfileLayoutV1, type WidgetPublicSnapshotDocumentV1 } from '../widgets/widgetPublicSnapshotV1.js';
import { zodSchemaToJsonSchemaObject, type JsonSchemaObject } from '../actions/actionInputJsonSchema.js';
import { freezePluginDeclarativeDataNodeV1, isPluginDeclarativeDataNodeV1, validatePluginDeclarativeDataNodeFieldTypesV1, type PluginDeclarativeDataNodeV1,
  type PluginDeclarativeDataFieldV1 } from '../plugins/contributions/ui/declarativeDataV1.js';
import type { PluginDeclarativeNodeV2 } from '../plugins/contributions/ui/v2.js';
import type { BuiltinUsagePublicPresentationV1 } from '../widgets/builtinWidgetDescriptorV1.js';
import type { UsageRelativePeriod } from '../inputs/usageQuery.js';
import { isUnattributedUsageAgentId } from '../usage/usageFormatting.js';

/** Which consent field discloses each public fact: the one map projection, figure eyes and demand read. */
export const PUBLIC_PROFILE_FACT_FIELDS_V1 = { tokens: 'tokens', tokensFromParts: 'tokens', activeDays: 'activeDays', agentTimeMs: 'agentTime', mergedPrs: 'mergedPrs',
  currentStreakDays: 'currentStreak', bestStreakDays: 'bestStreak', peakParallel: 'peakParallel', calendar: 'calendar',
  agentMix: 'agentMix', sourceSplit: 'sourceSplit', punch: 'punch', highlights: 'highlights', footprint: 'footprint',
  agentActiveDays: 'agentActiveDays', weeklyAgentMix: 'weeklyAgentMix', weeklyPeakParallel: 'weeklyPeakParallel',
  sessionDurations: 'sessionDurations', machineKinds: 'machineKinds', dayNightActivity: 'dayNightActivity',
} satisfies Record<keyof PublicUsageFactsV1, PublicProfileField>;

/** Dependencies belong to the disclosure owner, never to a block's asserted requirements. */
function enabled(policy: PublicProfilePolicyV1, field: PublicProfileField): boolean {
  return policy.fields[field] === true && (field !== 'weeklyPeakParallel' || policy.fields.peakParallel === true);
}
/** Source demand follows the same admitted fields as the public disclosure mask. */
export function resolvePublicProfileUsageDemand(policy: PublicProfilePolicyV1) {
  const selected = (...fields: PublicProfileField[]) => fields.some(field => enabled(policy, field));
  return {
    includeComparison: false,
    includeAccounting: selected(...Object.values(PUBLIC_PROFILE_FACT_FIELDS_V1)),
    includeActivity: selected('activeDays', 'currentStreak', 'bestStreak', 'calendar', 'punch', 'agentActiveDays'),
    includeSessionEvidence: selected('agentTime', 'peakParallel', 'weeklyPeakParallel', 'sessionDurations', 'dayNightActivity'),
    includeWorkEvidence: selected('mergedPrs'),
    includeQuota: false,
    includeCoach: false,
  };
}
/** Identity and metadata edits do not need a new Usage snapshot. */
export function hasWiderPublicProfileUsageFields(current: PublicProfilePolicyV1, next: PublicProfilePolicyV1): boolean {
  return Object.values(PUBLIC_PROFILE_FACT_FIELDS_V1).some(field => enabled(next, field) && !enabled(current, field));
}
function projectFacts(facts: PublicUsageFactsV1, policy: PublicProfilePolicyV1): PublicUsageFactsV1 {
  const result = Object.fromEntries(Object.entries(facts).filter(([key]) => enabled(policy, PUBLIC_PROFILE_FACT_FIELDS_V1[key as keyof PublicUsageFactsV1]))) as PublicUsageFactsV1;
  // Bridge ids describe missing attribution, not public Agents. Keep the original
  // denominator: omitting those rows must not inflate the named Agents' shares.
  const attributed = (row: { agentId: string }) => !isUnattributedUsageAgentId(row.agentId);
  if (result.agentMix) result.agentMix = result.agentMix.filter(attributed);
  if (result.agentActiveDays) result.agentActiveDays = result.agentActiveDays.filter(attributed);
  if (result.weeklyAgentMix) result.weeklyAgentMix = result.weeklyAgentMix.map(week => ({ ...week, mix: week.mix.filter(attributed) }));
  if (result.sessionDurations) result.sessionDurations = result.sessionDurations.filter(attributed);
  if (!enabled(policy, 'tokens')) {
    if (result.agentMix) result.agentMix = result.agentMix.map(({ tokens: _tokens, tokensFromParts: _tokensFromParts, ...entry }) => entry);
    if (result.sourceSplit) result.sourceSplit = result.sourceSplit.map(({ tokens: _tokens, tokensFromParts: _tokensFromParts, ...entry }) => entry);
  }
  if (result.highlights) result.highlights = result.highlights.filter(highlight => enabled(policy,
    highlight.kind === 'active_days' ? 'activeDays' : highlight.kind === 'peak_parallel' ? 'peakParallel' : 'mergedPrs'));
  return result;
}
function admitSnapshot(input: PublicProfileSnapshotV1): PublicProfileSnapshotV1 {
  const snapshot = PublicProfileSnapshotV1Schema.parse(input);
  const orderDurations = (facts: PublicUsageFactsV1): PublicUsageFactsV1 => facts.sessionDurations ? {
    ...facts, sessionDurations: [...facts.sessionDurations].sort((left, right) =>
      left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : left.durationMs - right.durationMs),
  } : facts;
  return { ...snapshot, facts: orderDurations(snapshot.facts),
    ...(snapshot.lenses ? { lenses: snapshot.lenses.map(lens => ({ ...lens, facts: orderDurations(lens.facts) })) } : {}) };
}
/** Acceptance and reads both apply this mask, so late facts cannot restore narrowed consent. */
export function projectPublicProfileSnapshot(input: PublicProfileSnapshotV1, rawPolicy: PublicProfilePolicyV1): PublicProfileSnapshotV1 {
  const snapshot = admitSnapshot(input);
  const policy = PublicProfilePolicyV1Schema.parse(rawPolicy);
  return projectAdmittedSnapshot(snapshot, policy);
}
function projectAdmittedSnapshot(snapshot: PublicProfileSnapshotV1, policy: PublicProfilePolicyV1): PublicProfileSnapshotV1 {
  const { lenses: _lenses, ...rest } = snapshot;
  return { ...rest, facts: projectFacts(snapshot.facts, policy),
    fieldCoverage: Object.fromEntries(Object.entries(snapshot.fieldCoverage).filter(([field]) => enabled(policy, field as PublicProfileField))),
    ...(enabled(policy, 'sourceSplit') && snapshot.lenses ? { lenses: snapshot.lenses.map(lens => ({ ...lens, facts: projectFacts(lens.facts, policy) })) } : {}),
  };
}
export function projectPublicProfileMetadata(input: PublicProfileMetadataV1, policy: PublicProfilePolicyV1): PublicProfileMetadataV1 {
  const metadata = PublicProfileMetadataV1Schema.parse(input);
  return Object.fromEntries(Object.entries(metadata).filter(([field]) => enabled(policy, field as PublicProfileField)));
}
export function projectPublicProfileIdentity(input: PublicProfileIdentityV1, policy: PublicProfilePolicyV1): PublicProfileIdentityV1 {
  const identity = PublicProfileIdentityV1Schema.parse(input);
  const avatarEnabled = enabled(policy, 'avatar');
  return { ...(enabled(policy, 'name') && identity.name !== undefined ? { name: identity.name } : {}),
    ...(enabled(policy, 'since') && identity.sinceMs !== undefined ? { sinceMs: identity.sinceMs } : {}),
    ...(avatarEnabled && identity.avatarUrl !== undefined ? { avatarUrl: identity.avatarUrl } : {}),
    ...(avatarEnabled && identity.avatar !== undefined ? { avatar: identity.avatar } : {}) };
}

function record(value: unknown): JsonSchemaObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonSchemaObject : undefined;
}
let bindingSchema: JsonSchemaObject | undefined;
function bindingRoot(): JsonSchemaObject {
  return bindingSchema ??= { type: 'object', properties: {
    snapshot: zodSchemaToJsonSchemaObject(PublicProfileSnapshotV1Schema),
    metadata: zodSchemaToJsonSchemaObject(PublicProfileMetadataV1Schema),
    identity: zodSchemaToJsonSchemaObject(PublicProfileIdentityV1Schema), handle: { type: 'string' },
  } };
}
function schemaAt(path: readonly string[]): JsonSchemaObject | undefined {
  let schema: JsonSchemaObject | undefined = bindingRoot();
  for (const key of path) schema = key === '*' ? record(schema?.items) : record(record(schema?.properties)?.[key]);
  return schema;
}
function pathDependencies(path: readonly string[]): readonly PublicProfileField[] | null {
  if (path[0] === 'snapshot' && path[1] === 'lenses') {
    const nested = path[2] === '*' ? pathDependencies(['snapshot', ...path.slice(3)]) : [];
    return nested ? ['sourceSplit', ...nested] : null;
  }
  if (path[0] === 'snapshot' && path[1] === 'facts') {
    const field = PUBLIC_PROFILE_FACT_FIELDS_V1[path[2] as keyof PublicUsageFactsV1];
    return field ? [field, ...(path.slice(3).some(key => key === 'tokens' || key === 'tokensFromParts') ? ['tokens' as const] : [])] : null;
  }
  if (path[0] === 'snapshot' && path[1] === 'fieldCoverage') return [path[2] as PublicProfileField];
  if (path[0] === 'identity') return [path[1] === 'sinceMs' ? 'since' : path[1] === 'avatarUrl' || path[1] === 'avatar' ? 'avatar' : 'name'];
  if (path[0] === 'metadata') return [path[1] as PublicProfileField];
  return [];
}
function permitted(path: readonly string[], policy: PublicProfilePolicyV1): boolean {
  const dependencies = pathDependencies(path);
  return dependencies !== null && dependencies.every(field => enabled(policy, field));
}
type UsageDependencies = Readonly<{ anyOf: readonly (readonly PublicProfileField[])[]; fields: readonly PublicProfileField[] }>;
/** Admission and placement explanations share the body's actual inputs, including optional encodings. */
function usageDependencies(presentation: BuiltinUsagePublicPresentationV1): UsageDependencies {
  const uses = (...fields: PublicProfileField[]): UsageDependencies => ({ anyOf: [fields], fields });
  const optional = (required: UsageDependencies, ...fields: PublicProfileField[]): UsageDependencies =>
    ({ ...required, fields: [...required.fields, ...fields] });
  switch (presentation.widgetId) {
    case 'usage_rhythm': return presentation.inputs.style === 'daylight' ? uses('punch', 'dayNightActivity')
      : presentation.inputs.style === 'weekdayHour' || presentation.inputs.style === 'weekTide' ? uses('punch')
        : presentation.inputs.style === 'sky'
          ? optional(uses('calendar'), 'currentStreak', 'bestStreak') : uses('calendar');
    case 'usage_daily': return uses('calendar');
    case 'usage_period_summary': return uses('tokens', 'activeDays', 'agentTime', 'mergedPrs', 'currentStreak', 'bestStreak', 'peakParallel');
    case 'usage_breakdowns': return presentation.inputs.style === 'crew' ? uses('agentMix', 'agentActiveDays') : uses('agentMix', 'sourceSplit');
    case 'usage_constellation': return optional(uses('agentMix'), 'agentActiveDays');
    case 'usage_orbit': return presentation.inputs.style === 'moons' ? uses('agentMix', 'agentActiveDays') : optional(uses('agentMix'), 'agentActiveDays');
    case 'usage_machines': return uses('machineKinds');
    case 'usage_projects': return uses('projects');
    case 'usage_atmosphere': return optional(uses('weeklyPeakParallel'), 'peakParallel');
    case 'usage_flow': return uses('weeklyAgentMix');
    case 'usage_parallel': return uses('peakParallel');
    case 'usage_outcomes': return uses('mergedPrs');
    case 'usage_recap': {
      const values = presentation.inputs.style === 'personalRecords'
        ? uses('activeDays', 'currentStreak', 'bestStreak', 'peakParallel', 'sessionDurations') : uses('activeDays', 'peakParallel', 'mergedPrs');
      return { anyOf: [['highlights'], ...values.anyOf], fields: ['highlights', ...values.fields] };
    }
    case 'usage_footprint': return optional(uses('footprint'), 'tokens');
    case 'usage_source_coverage': return { anyOf: [Object.values(PUBLIC_PROFILE_FACT_FIELDS_V1)], fields: [] };
    case 'usage_run_length': return uses('sessionDurations');
    // Every encoding is independently masked; the neutral portrait carries no hidden fact.
    case 'usage_planet': return { anyOf: [], fields: ['activeDays', 'peakParallel', 'currentStreak', 'bestStreak'] };
  }
}
/** Built-in bodies receive only masked facts; placements cannot grant their own disclosure. */
function permittedUsage(presentation: BuiltinUsagePublicPresentationV1, policy: PublicProfilePolicyV1): boolean {
  return usageDependencies(presentation).anyOf.every(group => group.some(field => enabled(policy, field)));
}
function assertField(field: PluginDeclarativeDataFieldV1, prefix: readonly string[] = []) {
  const schema = schemaAt([...prefix, ...field.path]);
  if (!schema || schema.type !== field.type && !(schema.type === 'integer' && field.type === 'number')) throw new Error('public_profile_binding_invalid');
}
function fields(node: PluginDeclarativeDataNodeV1): readonly PluginDeclarativeDataFieldV1[] {
  return node.kind === 'metric' ? [node.value, ...(node.comparison ? [node.comparison.value] : [])]
    : node.kind === 'chart' ? [node.x, ...('y' in node ? [node.y] : [node.series, node.value])]
    : [...node.columns.map(column => column.field), ...(node.mark ? [node.mark.field] : [])];
}
/** Symbolic dependencies need only the layout, never a counterfactual snapshot or model rebuild. */
export function resolvePublicProfileFieldDependencies(input: PublicProfileLayoutV1): ReadonlyMap<string, ReadonlySet<PublicProfileField>> {
  const layout = validatePublicProfileLayout(input);
  const dependencies = new Map<string, ReadonlySet<PublicProfileField>>();
  for (const item of layout.items) for (const widget of item.kind === 'widget' ? [item] : item.children) {
    const used = new Set<PublicProfileField>();
    const addPath = (path: readonly string[]) => {
      for (const field of pathDependencies(path) ?? []) used.add(field);
    };
    if (widget.presentation.kind === 'usage') for (const field of usageDependencies(widget.presentation).fields) used.add(field);
    else {
      const pending = [widget.presentation.document.root];
      while (pending.length) {
        const node = pending.pop()!;
        if (isPluginDeclarativeDataNodeV1(node)) {
          const prefix = node.kind === 'metric' ? [] : [...node.rows, '*'];
          if (node.kind !== 'metric') addPath(node.rows);
          for (const field of fields(node)) addPath([...prefix, ...field.path]);
        }
        if ('children' in node) pending.push(...node.children);
      }
    }
    if (used.has('weeklyPeakParallel')) used.add('peakParallel');
    dependencies.set(widget.id, used);
  }
  return dependencies;
}
/** Field vocabulary and semantics remain here; admission delegates to this owner. */
export function validatePublicProfileDocumentBindings(document: WidgetPublicSnapshotDocumentV1): void {
  const pending = [document.root];
  while (pending.length) {
    const node = pending.pop()!;
    if (isPluginDeclarativeDataNodeV1(node)) {
      validatePluginDeclarativeDataNodeFieldTypesV1(node);
      if (node.kind !== 'metric' && schemaAt(node.rows)?.type !== 'array') throw new Error('public_profile_binding_invalid');
      for (const field of fields(node)) assertField(field, node.kind === 'metric' ? [] : [...node.rows, '*']);
    }
    if ('children' in node) pending.push(...node.children);
  }
}
/** Validate symbolic paths even when current facts are absent. */
export function validatePublicProfileLayout(input: PublicProfileLayoutV1): PublicProfileLayoutV1 {
  return PublicProfileLayoutV1Schema.parse(input);
}
function compileNode(node: PluginDeclarativeNodeV2, view: Readonly<{ snapshot: PublicProfileSnapshotV1; metadata: PublicProfileMetadataV1; identity: PublicProfileIdentityV1; handle: string }>, policy: PublicProfilePolicyV1): PluginDeclarativeNodeV2 | null {
  if (isPluginDeclarativeDataNodeV1(node)) {
    const prefix = node.kind === 'metric' ? [] : [...node.rows, '*'];
    if (node.kind !== 'metric' && !permitted(node.rows, policy)) return null;
    const allowed = (field: PluginDeclarativeDataFieldV1) => permitted([...prefix, ...field.path], policy);
    let selected = node;
    if (node.kind === 'table' || node.kind === 'rows') {
      const columns = node.columns.filter(column => allowed(column.field));
      if (!columns.length) return null;
      const { mark, ...rest } = node;
      selected = { ...rest, columns, ...(mark && allowed(mark.field) ? { mark } : {}) };
    } else if (node.kind === 'metric') {
      if (!allowed(node.value)) return null;
      const { comparison, ...rest } = node;
      selected = { ...rest, ...(comparison && allowed(comparison.value) ? { comparison } : {}) };
    } else if (fields(node).some(field => !allowed(field))) return null;
    try { return freezePluginDeclarativeDataNodeV1({ ...selected, data: { kind: 'value', value: view } }, view); }
    catch { return null; }
  }
  if (node.kind === 'stack' || node.kind === 'group') {
    const children = node.children.map(child => compileNode(child, view, policy)).filter((child): child is PluginDeclarativeNodeV2 => child !== null);
    return children.length ? { ...node, children } : null;
  }
  return node;
}
type PublicProfileProjectionInput = Readonly<{ context: PublicProfileContextV1; policy: PublicProfilePolicyV1;
  metadata: PublicProfileMetadataV1; snapshot: PublicProfileSnapshotV1; layout: PublicProfileLayoutV1; relativePeriod?: UsageRelativePeriod }>;
export type PublicProfileDataProjection = Readonly<{
  view: Omit<PublicProfileLocalPreviewViewV1, 'appearance' | 'layout'>;
  projectLayout: (input: PublicProfileLayoutV1) => PublicProfileViewV1['layout'];
}>;
export type PublicProfileProjector = Readonly<{
  project: (input: Omit<PublicProfileProjectionInput, 'snapshot' | 'layout'>) => PublicProfileDataProjection | null;
}>;
/** Snapshot admission is owned by the page/read lifetime, never by the number of placed widgets. */
export function createPublicProfileProjector(input: PublicProfileSnapshotV1): PublicProfileProjector {
  const snapshot = admitSnapshot(input);
  return {
    project(input: Omit<PublicProfileProjectionInput, 'snapshot' | 'layout'>): PublicProfileDataProjection | null {
      const context = PublicProfileContextV1Schema.parse(input.context);
      if (!context.handle) return null;
      const policy = PublicProfilePolicyV1Schema.parse(input.policy);
      const safe = { snapshot: projectAdmittedSnapshot(snapshot, policy), metadata: projectPublicProfileMetadata(input.metadata, policy),
        identity: projectPublicProfileIdentity(context.identity, policy), handle: context.handle };
      return { view: { v: 1, ...safe, ...(input.relativePeriod === undefined ? {} : { relativePeriod: input.relativePeriod }),
        indexable: policy.indexable, state: 'published', service: context.service, urls: context.urls },
        projectLayout: input => projectAdmittedLayout(validatePublicProfileLayout(input), safe, policy) };
    },
  };
}

function projectAdmittedLayout(layout: PublicProfileLayoutV1,
  safe: Pick<PublicProfileDataProjection['view'], 'snapshot' | 'metadata' | 'identity' | 'handle'>,
  policy: PublicProfilePolicyV1): PublicProfileViewV1['layout'] {
  const projectWidget = (widget: Extract<PublicProfileLayoutV1['items'][number], { kind: 'widget' }>) => {
    if (widget.presentation.kind === 'usage') return permittedUsage(widget.presentation, policy) ? widget : null;
    const root = compileNode(widget.presentation.document.root, safe, policy);
    return root ? { ...widget, presentation: { kind: 'declarative' as const, document: { version: 1 as const, root } } } : null;
  };
  const items = layout.items.flatMap<PublicProfileViewV1['layout']['items'][number]>(item => {
    if (item.kind === 'widget') { const widget = projectWidget(item); return widget ? [widget] : []; }
    const children = item.children.map(projectWidget).filter(widget => widget !== null);
    return children.length ? [{ ...item, children }] : [];
  });
  return { v: 1, items };
}
/** One compiler for current identity, consent, facts and inert placements in local and published views. */
function projectPublicProfileCore(input: PublicProfileProjectionInput): Omit<PublicProfileLocalPreviewViewV1, 'appearance'> | null {
  if (!input.context.handle) return null;
  const projection = createPublicProfileProjector(input.snapshot).project(input);
  return projection ? { ...projection.view, layout: projection.projectLayout(input.layout) } : null;
}
/** Anonymous responses retain the strict applied/publication-reference-only representation. */
export function projectPublicProfile(input: PublicProfileProjectionInput & Readonly<{ appearance: PublicProfileAppearanceV1 }>): PublicProfileViewV1 | null {
  if (!input.context.service || !input.context.urls) return null;
  const view = projectPublicProfileCore(input);
  return view ? PublicProfileViewV1Schema.parse({ ...view, appearance: input.appearance }) : null;
}
/** The exact prepared pixels remain local; only Apply can turn them into a public publication reference. */
export function projectPublicProfilePreview(input: PublicProfileProjectionInput & Readonly<{ appearance: PublicProfilePreparedAppearanceV1 }>): PublicProfileLocalPreviewViewV1 | null {
  const view = projectPublicProfileCore(input);
  return view ? PublicProfileLocalPreviewViewV1Schema.parse({ ...view, appearance: input.appearance }) : null;
}
