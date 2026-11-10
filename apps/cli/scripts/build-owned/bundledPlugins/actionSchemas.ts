import { normalizePluginActionInputHintsV2, type PluginActionContributionV2 } from '@happier-dev/protocol/plugins/actions/v2';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { readMachineProvisionerActionRolesV1 } from '../../../../../packages/protocol/src/plugins/contributions/machineProvisioners.js';
import { readAccessProviderActionRolesV1 } from '../../../../../packages/protocol/src/plugins/contributions/accessProviders.js';
import { readDeploymentTargetActionRolesV1 } from '../../../../../packages/protocol/src/plugins/contributions/deploymentTargets.js';
import { canonicalizeJsonValue } from '../../../src/plugins/manifest/serialize.js';
import type { PluginManifestJson } from './projectionFacts.ts';

type Schema = PluginJsonSchemaV2;

/** Visit schema positions only: properties/definitions maps and literal JSON are never candidates. */
function mapChildren(schema: Schema, visit: (child: Schema, pointer: string, field?: string) => Schema): Schema {
  const result = { ...schema };
  for (const keyword of ['properties', 'definitions', '$defs'] as const) {
    const entries = schema[keyword];
    if (entries) {
      const children = { ...entries };
      // Visit canonically for stable definition identities, but retain authored
      // insertion order: form inference uses the order of operand properties.
      for (const [key, child] of Object.entries(entries).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
        children[key] = visit(child, `${keyword}/${key.replace(/~/gu, '~0').replace(/\//gu, '~1')}`, keyword === 'properties' ? key : undefined);
      }
      result[keyword] = children;
    }
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const children = schema[keyword];
    if (children) result[keyword] = children.map((child, index) => visit(child, `${keyword}/${index}`));
  }
  for (const keyword of ['items', 'not', 'propertyNames'] as const) {
    const child = schema[keyword];
    if (child) result[keyword] = visit(child, keyword);
  }
  if (typeof schema.additionalProperties === 'object') {
    result.additionalProperties = visit(schema.additionalProperties, 'additionalProperties');
  }
  return result;
}

function compactSchema(schema: Schema, inlineFields?: ReadonlySet<string>): Schema {
  // Existing document pointers must still reach their original positions after compaction.
  const references: string[] = [];
  const collectReferences = (node: Schema): Schema => {
    if (node.$ref && node.$ref !== '#') references.push(node.$ref);
    return mapChildren(node, collectReferences);
  };
  collectReferences(schema);
  const counts = new Map<string, number>();
  const signatures = new WeakMap<Schema, string>();
  const pinned = new WeakSet<Schema>();
  const collect = (node: Schema, pointer: string, inField = false, belowProperty = false): boolean => {
    // Form inference discovers fields through root object/union arms, before
    // it encounters an operand. Keep that presentation structure reachable.
    if (inlineFields && !belowProperty) pinned.add(node);
    const retainPosition = references.some(ref => ref === pointer || ref.startsWith(`${pointer}/`) || pointer.startsWith(`${ref}/`));
    let containsWalkedField = inField;
    mapChildren(node, (child, suffix, field) => {
      // Inferred JSON controls still read their top-level title/description.
      if (inlineFields && !belowProperty && field !== undefined && (child.title !== undefined || child.description !== undefined)) pinned.add(child);
      const childContainsWalkedField = collect(child, `${pointer}/${suffix}`,
        inField || (!belowProperty && field !== undefined && inlineFields?.has(field) === true),
        belowProperty || field !== undefined || suffix.startsWith('definitions/') || suffix.startsWith('$defs/'));
      containsWalkedField ||= childContainsWalkedField;
      return child;
    });
    if (pointer === '#' || containsWalkedField || retainPosition || node.$ref) pinned.add(node);
    const signature = JSON.stringify(canonicalizeJsonValue(node));
    signatures.set(node, signature);
    if (!pinned.has(node)) counts.set(signature, (counts.get(signature) ?? 0) + 1);
    return containsWalkedField;
  };
  collect(schema, '#');
  const definitions: Record<string, Schema> = { ...schema.definitions };
  const names = new Map<string, string>();
  let index = 0;
  const emit = (node: Schema): Schema => {
    const signature = signatures.get(node)!;
    const count = counts.get(signature) ?? 0;
    // Compare actual JSON representation costs, not a guessed schema-size threshold.
    let name = names.get(signature);
    if (!name) {
      while (Object.hasOwn(definitions, `schema${index}`)) index += 1;
      name = `schema${index}`;
    }
    const ref = { $ref: `#/definitions/${name}` };
    const savesBytes = count * signature.length > signature.length + name.length + 4 + count * JSON.stringify(ref).length;
    if (pinned.has(node) || count < 2 || !savesBytes) return mapChildren(node, emit);
    if (!names.has(signature)) {
      names.set(signature, name);
      index += 1;
      definitions[name] = mapChildren(node, emit);
    }
    return ref;
  };
  const result = emit(schema);
  // New definitions are demand-created, so descendants hidden by a shared parent
  // do not leave unused entries behind. Existing definitions keep their names.
  if (names.size > 0) result.definitions = { ...result.definitions, ...definitions };
  return JSON.stringify(result).length < JSON.stringify(schema).length ? result : schema;
}

function inlineInputFields(action: PluginActionContributionV2): ReadonlySet<string> {
  const paths = [
    action.sessionTarget?.field,
    ...Object.keys(action.contextualDefaults ?? {}),
    ...(action.connectedAccountPurposeBindings ?? []).flatMap(binding => [binding.path, binding.nativeServicePath]),
    ...(action.confirmation?.inputFields ?? []).map(field => field.path),
    ...(action.inputHints?.fields ?? []).map(field => field.path),
    // The canonical presentation owner decides text/select/list controls. A
    // reference would otherwise turn an inferred scalar control into JSON.
    ...(normalizePluginActionInputHintsV2(action.inputHints, action.inputSchema)?.fields ?? [])
      .filter(field => field.widget !== 'json').map(field => field.path),
  ];
  // Retain the complete operand subtree, including all union/array arms that
  // admission and form metadata inspect. Placement bindings themselves are UI slots.
  return new Set(paths.filter((path): path is string => path !== undefined).map(path => path.split('.')[0]!));
}

/** Compact the published representation without changing authored Action contracts. */
export function compactActionSchemas(manifest: PluginManifestJson): PluginManifestJson {
  if (!manifest.contributes?.actions) return manifest;
  // These declared roles require exact schema documents at manifest admission.
  // Consume their canonical role inventories rather than duplicating contracts.
  const inlineActions = new Set([
    ...(manifest.contributes.targetedPluginContributions ?? []).flatMap(contribution => Object.values(contribution.operations)),
    ...(manifest.contributes.machineProvisioners ?? []).flatMap(readMachineProvisionerActionRolesV1).map(binding => binding.action),
    ...(manifest.contributes.accessProviders ?? []).flatMap(readAccessProviderActionRolesV1).map(binding => binding.action),
    ...(manifest.contributes.deploymentTargets ?? []).flatMap(readDeploymentTargetActionRolesV1).map(binding => binding.action),
    ...(manifest.contributes.healthCheckKinds ?? []).map(kind => kind.action),
  ]);
  for (const event of manifest.contributes.events ?? []) {
    if (event.kind !== 'event') continue;
    const source = event.automation?.source;
    for (const ref of [source?.setupActionRef, source?.historyGapResetActionRef]) {
      if (ref?.pluginId === manifest.id) inlineActions.add(ref.localId);
    }
  }
  return { ...manifest, contributes: { ...manifest.contributes,
    actions: manifest.contributes.actions.map(action => inlineActions.has(action.id) ? action : ({ ...action,
      ...(action.inputSchema ? { inputSchema: compactSchema(action.inputSchema, inlineInputFields(action)) } : {}),
      ...(action.resultSchema ? { resultSchema: compactSchema(action.resultSchema) } : {}),
    })),
  } };
}
